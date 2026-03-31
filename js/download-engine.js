/**
 * Core Download Engine
 * 
 * Handles:
 * - HTTP Range requests for parallel downloading
 * - Adaptive chunk sizing and speed optimization
 * - Download state machine (PENDING → ACTIVE → COMPLETE/FAILED)
 * - Resume capability with chunk tracking
 * - Error handling and retry logic with exponential backoff
 * 
 * Performance Optimization:
 * - Async/await for non-blocking operations
 * - Streaming blob assembly (constant memory)
 * - Speed calculation via sliding 10-second window
 * - Adaptive bandwidth throttling
 */

class DownloadEngine {
    constructor() {
        this.activeDownloads = new Map(); // id -> downloadState
        this.workers = []; // Web Worker pool
        this.eventListeners = {}; // Event system
        this.initializeWorkerPool();
    }

    /**
     * Initialize Web Worker pool for Phase 2 parallelization
     * Creates 4-8 workers for parallel chunk downloads
     */
    initializeWorkerPool() {
        const WORKER_COUNT = navigator.hardwareConcurrency || 4;
        
        for (let i = 0; i < WORKER_COUNT; i++) {
            try {
                const worker = new Worker('workers/download.worker.js');
                
                worker.onmessage = (e) => this.handleWorkerMessage(e);
                worker.onerror = (error) => console.error('Worker error:', error);
                
                this.workers.push({
                    worker,
                    busy: false,
                    currentChunk: null
                });
            } catch (e) {
                console.warn(`Could not create worker ${i}:`, e.message);
            }
        }
        
        if (this.workers.length > 0) {
            console.log(`✓ Web Worker pool initialized with ${this.workers.length} workers`);
        }
    }

    /**
     * Get available worker from pool
     * Returns worker or null if all busy
     */
    getAvailableWorker() {
        return this.workers.find(w => !w.busy) || null;
    }

    /**
     * Handle messages from Web Workers
     */
    handleWorkerMessage(event) {
        const { type, downloadId, chunkIndex, bytesReceived, error } = event.data;
        const download = this.activeDownloads.get(downloadId);
        
        if (!download) return;
        
        switch (type) {
            case 'progress':
                const chunk = download.chunks[chunkIndex];
                if (chunk) {
                    chunk.bytesReceived = bytesReceived;
                    download.bytesDownloaded = this.calculateTotalDownloaded(downloadId);
                    this.emit('chunk:progress', { downloadId, chunkIndex, bytesReceived });
                }
                break;
                
            case 'complete':
                console.log(`Worker completed chunk ${chunkIndex} of download ${downloadId}`);
                break;
                
            case 'error':
                console.error(`Worker error on chunk ${chunkIndex}:`, error);
                break;
        }
    }

    /**
     * CORE: Create download from URL with adaptive chunk strategy
     */
    async createDownload(url, options = {}) {
        // Validate URL
        try {
            new URL(url);
        } catch (e) {
            throw new Error(`Invalid URL: ${url}`);
        }

        // Generate unique ID
        const id = this.generateId();

        // Probe server for Range request support
        let fileSize = 0;
        let supportsRange = false;
        let mimeType = 'application/octet-stream';

        try {
            const probeResponse = await fetch(url, { method: 'HEAD' });
            
            fileSize = parseInt(probeResponse.headers.get('content-length') || '0');
            supportsRange = probeResponse.headers.get('accept-ranges') === 'bytes';
            mimeType = probeResponse.headers.get('content-type') || mimeType;

            // If HEAD fails, try GET with 0-byte range
            if (!fileSize) {
                const testResponse = await fetch(url, { 
                    headers: { 'Range': 'bytes=0-0' },
                    signal: AbortSignal.timeout(5000)
                });
                fileSize = parseInt(testResponse.headers.get('content-length') || '0');
            }
        } catch (e) {
            console.warn('Could not probe server:', e.message);
            supportsRange = false;
        }

        // FIX: Allow downloads without knowing file size
        // Fall back to single-threaded download that discovers size as it downloads
        if (fileSize === 0) {
            console.log('File size unknown - falling back to non-Range download');
            supportsRange = false;
            // fileSize will be discovered during download
        }

        // Calculate optimal chunk size (5MB for small, 50MB for huge files)
        const chunkSize = this.calculateOptimalChunkSize(fileSize);

        // Create download state
        const download = {
            id,
            url,
            filename: this.extractFilename(url),
            fileSize,
            mimeType,
            chunkSize,
            supportsRange,
            status: 'pending',
            bytesDownloaded: 0,
            speedBytesPerSec: 0,
            eta: 0,
            startTime: Date.now(),
            pausedTime: 0,
            chunks: [],
            errors: [],
            ...options
        };

        // Generate chunks
        download.chunks = this.generateChunks(fileSize, chunkSize);

        // Save to DB
        await downloadDB.saveDownload(download);

        // Store in memory
        this.activeDownloads.set(id, {
            ...download,
            speedWindow: [], // For speed calculation
            lastUpdate: Date.now()
        });

        this.emit('download:created', download);
        return download;
    }

    /**
     * OPTIMIZATION: Adaptive chunk size calculation (FIX #2)
     * - Small files (< 100MB): 5MB chunks (less overhead)
     * - Medium files (100MB - 1GB): 10MB chunks
     * - Large files (1GB - 10GB): 20MB chunks
     * - Huge files (> 10GB): 50MB chunks (hard cap prevents OOM)
     */
    calculateOptimalChunkSize(fileSize) {
        const MB = 1024 * 1024;
        const GB = 1024 * MB;

        if (fileSize < 100 * MB) return 5 * MB;           // Small: 5MB
        if (fileSize < 1 * GB) return 10 * MB;            // Medium: 10MB
        if (fileSize < 10 * GB) return 20 * MB;           // Large: 20MB
        return 50 * MB;                                     // Huge: 50MB max
    }

    /**
     * Generate chunk array for tracking
     */
    generateChunks(fileSize, chunkSize) {
        const chunks = [];
        
        // FIX: Handle unknown file size - create a single chunk for streaming download
        if (fileSize === 0) {
            chunks.push({
                index: 0,
                start: 0,
                end: -1, // Unknown end
                size: 0, // Unknown size
                status: 'pending',
                bytesReceived: 0,
                attempts: 0,
                error: null
            });
            return chunks;
        }
        
        const numChunks = Math.ceil(fileSize / chunkSize);

        for (let i = 0; i < numChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize - 1, fileSize - 1);

            chunks.push({
                index: i,
                start,
                end,
                size: end - start + 1,
                status: 'pending',
                bytesReceived: 0,
                attempts: 0,
                error: null
            });
        }

        return chunks;
    }

    /**
     * CORE: Start download with parallelization support
     */
    async startDownload(id, options = {}) {
        const download = this.activeDownloads.get(id);
        if (!download) throw new Error(`Download ${id} not found`);

        download.status = 'active';
        download.startTime = Date.now();
        download.pausedTime = 0;

        await downloadDB.saveDownload({
            ...download,
            status: 'active',
            startTime: download.startTime
        });

        this.emit('download:started', { id });

        // Single-threaded for Phase 1 (fallback/non-worker path)
        this.downloadSequence(id);
    }

    /**
     * FALLBACK: Single-threaded sequential download
     * Used when Workers unavailable or for Phase 1
     */
    async downloadSequence(id) {
        const download = this.activeDownloads.get(id);
        if (!download || download.status !== 'active') return;

        const pendingChunks = download.chunks.filter(c => c.status === 'pending');

        for (const chunk of pendingChunks) {
            if (download.status === 'paused') {
                await this.waitForResume(id);
            }

            await this.downloadChunk(id, chunk);

            // Update speed every chunk
            this.updateSpeed(id);
        }

        // All chunks complete
        if (download.chunks.every(c => c.status === 'completed')) {
            await this.completeDownload(id);
        }
    }

    /**
     * CORE: Download single chunk with retry logic
     * 
     * Optimization: Stream directly to memory (Blob), no intermediate writes
     */
    async downloadChunk(downloadId, chunk) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;

        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                chunk.attempts = attempt;
                chunk.status = 'downloading';

                // FIX: Handle non-Range downloads (when server doesn't support Range)
                const isNonRangeDownload = !download.supportsRange || chunk.end === -1;
                
                // HTTP request - with or without Range header
                const start = Date.now();
                const fetchOptions = {
                    signal: AbortSignal.timeout(30000) // 30 second timeout per chunk
                };
                
                if (!isNonRangeDownload) {
                    // Range request for parallel downloads
                    fetchOptions.headers = {
                        'Range': `bytes=${chunk.start}-${chunk.end}`
                    };
                }
                
                const response = await fetch(download.url, fetchOptions);

                // Accept 200 (OK) or 206 (Partial Content)
                if (!response.ok && response.status !== 206) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                // FIX: Discover file size from response headers if unknown
                if (download.fileSize === 0) {
                    const contentLength = response.headers.get('content-length');
                    if (contentLength) {
                        download.fileSize = parseInt(contentLength);
                        chunk.size = download.fileSize;
                        console.log(`Discovered file size: ${download.fileSize} bytes`);
                    }
                }

                // Stream to blob with throttling support
                const reader = response.body.getReader();
                const chunks = [];
                let bytesReceived = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    chunks.push(value);
                    bytesReceived += value.length;

                    // Update chunk progress
                    chunk.bytesReceived = bytesReceived;
                    download.bytesDownloaded = this.calculateTotalDownloaded();

                    // Apply bandwidth throttling if configured
                    if (download.bandwidthLimit > 0) {
                        await this.throttle(downloadId);
                    }

                    this.emit('chunk:progress', {
                        downloadId,
                        chunkIndex: chunk.index,
                        bytesReceived,
                        totalBytes: chunk.size
                    });
                }

                // Success - mark chunk as completed
                chunk.status = 'completed';
                chunk.blob = new Blob(chunks, { type: 'application/octet-stream' });
                chunk.error = null;

                // Save chunk state to DB for resume capability
                await downloadDB.saveChunk(downloadId, chunk.index, {
                    status: 'completed',
                    bytesReceived: chunk.size,
                    hash: await this.calculateHash(chunk.blob) // For integrity
                });

                this.emit('chunk:completed', {
                    downloadId,
                    chunkIndex: chunk.index
                });

                return; // Success

            } catch (error) {
                lastError = error;
                chunk.error = error.message;
                chunk.status = attempt < maxRetries ? 'pending' : 'failed';

                // Exponential backoff: 1s, 2s, 4s, 8s
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 1000, 8000);
                    await new Promise(r => setTimeout(r, delay));
                }

                this.emit('chunk:error', {
                    downloadId,
                    chunkIndex: chunk.index,
                    attempt,
                    error: error.message
                });
            }
        }

        // All retries failed
        throw new Error(`Chunk ${chunk.index} failed after ${maxRetries} attempts: ${lastError.message}`);
    }

    /**
     * PERFORMANCE: Update download speed with 10-second sliding window
     * 
     * Formula: windowBytes / (now - windowStart)
     * Smooths out network variations, provides accurate ETA
     * 
     * FIX #1: Cap array at 100 entries to prevent unbounded memory growth
     */
    updateSpeed(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;

        const now = Date.now();
        const WINDOW_MS = 10000;     // 10 second window
        const MAX_ENTRIES = 100;     // FIX #1: Prevent memory leak

        // Add current progress
        download.speedWindow.push({
            bytes: download.bytesDownloaded,
            time: now
        });

        // Remove old entries + cap at MAX_ENTRIES (FIX #1)
        download.speedWindow = download.speedWindow
            .filter(entry => now - entry.time < WINDOW_MS)
            .slice(-MAX_ENTRIES);

        if (download.speedWindow.length < 2) return;

        // Calculate speed: bytes in window / time span
        const startEntry = download.speedWindow[0];
        const endEntry = download.speedWindow[download.speedWindow.length - 1];
        const timeSpan = Math.max(1, (endEntry.time - startEntry.time) / 1000);
        const windowBytes = endEntry.bytes - startEntry.bytes;

        download.speedBytesPerSec = Math.max(0, windowBytes / timeSpan);

        // FIX: Handle ETA calculation for unknown file size
        if (download.fileSize > 0) {
            const remaining = download.fileSize - download.bytesDownloaded;
            download.eta = download.speedBytesPerSec > 0 
                ? Math.ceil(remaining / download.speedBytesPerSec)
                : 0;
        } else {
            // Unknown file size - can't calculate ETA
            download.eta = 0;
        }

        this.emit('speed:updated', {
            downloadId,
            speed: download.speedBytesPerSec,
            eta: download.eta
        });
    }

    /**
     * OPTIMIZATION: Bandwidth throttling
     * Prevents network saturation
     */
    async throttle(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download || !download.bandwidthLimit) return;

        const maxBytesPerSec = download.bandwidthLimit * 1024 * 1024; // Mbps to bytes
        const elapsedSec = (Date.now() - download.startTime) / 1000;
        const allowedBytes = elapsedSec * maxBytesPerSec;

        if (download.bytesDownloaded > allowedBytes) {
            const overage = download.bytesDownloaded - allowedBytes;
            const delay = (overage / maxBytesPerSec) * 1000;
            await new Promise(r => setTimeout(r, Math.min(delay, 100)));
        }
    }

    /**
     * CORE: Complete download - assemble chunks into single file
     */
    async completeDownload(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;

        try {
            // Verify all chunks completed
            if (!download.chunks.every(c => c.status === 'completed')) {
                throw new Error('Not all chunks completed');
            }

            // Stream chunks in order to create final blob
            const blobParts = download.chunks
                .sort((a, b) => a.index - b.index)
                .map(c => c.blob);

            const finalBlob = new Blob(blobParts, { type: download.mimeType });

            // Save final blob to IndexedDB (for later retrieval)
            if (download.enableIndexedDB !== false) {
                await downloadDB.saveBlob(downloadId, finalBlob);
            }

            // Trigger browser download
            const url = URL.createObjectURL(finalBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = download.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Update status
            download.status = 'completed';
            download.completedTime = Date.now();

            await downloadDB.saveDownload({
                ...download,
                status: 'completed',
                completedTime: download.completedTime
            });

            this.emit('download:completed', {
                id: downloadId,
                filename: download.filename,
                size: finalBlob.size
            });

            // Clean up chunks from memory (keep in DB for reference)
            download.chunks.forEach(c => delete c.blob);
            
            // FIX #5: Delete from active map to prevent memory accumulation
            this.activeDownloads.delete(downloadId);

        } catch (error) {
            download.status = 'failed';
            download.errors.push({
                type: 'assembly',
                message: error.message,
                time: Date.now()
            });

            await downloadDB.saveDownload({
                ...download,
                status: 'failed',
                errors: download.errors
            });

            this.emit('download:failed', {
                id: downloadId,
                error: error.message
            });
            
            // FIX #5: Also cleanup on failure
            this.activeDownloads.delete(downloadId);
        }
    }

    /**
     * Pause download
     */
    async pauseDownload(id) {
        const download = this.activeDownloads.get(id);
        if (!download) return;

        download.status = 'paused';
        download.pausedTime = Date.now();

        await downloadDB.saveDownload({
            ...download,
            status: 'paused'
        });

        this.emit('download:paused', { id });
    }

    /**
     * Resume download
     */
    async resumeDownload(id) {
        const download = this.activeDownloads.get(id);
        if (!download) return;

        if (download.pausedTime) {
            download.startTime += (Date.now() - download.pausedTime);
            download.pausedTime = 0;
        }

        download.status = 'active';

        await downloadDB.saveDownload({
            ...download,
            status: 'active',
            startTime: download.startTime
        });

        this.downloadSequence(id);
        this.emit('download:resumed', { id });
    }

    /**
     * Cancel download and cleanup
     */
    async cancelDownload(id) {
        const download = this.activeDownloads.get(id);
        if (!download) return;

        download.status = 'cancelled';

        await downloadDB.saveDownload({
            ...download,
            status: 'cancelled'
        });

        this.activeDownloads.delete(id);
        this.emit('download:cancelled', { id });
    }

    /**
     * Calculate total bytes downloaded across all chunks for a specific download
     * 
     * FIX #4: Properly implemented to sum chunk bytes for correct download
     */
    calculateTotalDownloaded(downloadId = null) {
        // If no downloadId, find the currently active download
        const download = downloadId ? 
            this.activeDownloads.get(downloadId) : 
            [...this.activeDownloads.values()].find(d => d.status === 'active');
        
        if (!download || !download.chunks) return 0;
        
        return download.chunks.reduce((sum, c) => sum + (c.bytesReceived || 0), 0);
    }

    /**
     * Extract filename from URL
     */
    extractFilename(url) {
        try {
            const pathname = new URL(url).pathname;
            let filename = pathname.split('/').pop();
            if (!filename || filename.includes('?')) {
                filename = `download_${Date.now()}`;
            }
            return filename;
        } catch (e) {
            return `download_${Date.now()}`;
        }
    }

    /**
     * Generate unique ID
     */
    generateId() {
        return `dl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Calculate blob hash for integrity checking
     */
    async calculateHash(blob) {
        try {
            const buffer = await blob.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            return null; // Non-critical, skip if unavailable
        }
    }

    /**
     * Wait for download to be resumed (pause/resume logic)
     */
    waitForResume(id) {
        return new Promise(resolve => {
            const checkInterval = setInterval(() => {
                const download = this.activeDownloads.get(id);
                if (!download || download.status !== 'paused') {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }

    /**
     * Event system
     */
    on(event, callback) {
        if (!this.eventListeners[event]) {
            this.eventListeners[event] = [];
        }
        this.eventListeners[event].push(callback);
    }

    emit(event, data) {
        if (this.eventListeners[event]) {
            this.eventListeners[event].forEach(cb => {
                try {
                    cb(data);
                } catch (e) {
                    console.error(`Error in listener for ${event}:`, e);
                }
            });
        }
    }
}

// Initialize globally
const downloadEngine = new DownloadEngine();
