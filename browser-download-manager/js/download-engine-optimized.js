/**
 * OPTIMIZED Download Engine - Critical Fixes Applied
 * 
 * This version implements all CRITICAL fixes from code review:
 * ✅ Fixed memory leak in speed calculation window
 * ✅ Fixed chunk size calculation (prevents OOM)
 * ✅ Fixed missing calculateTotalDownloaded function
 * ✅ Fixed unbounded active downloads map
 * ✅ Improved speed calculation accuracy
 */

class DownloadEngineOptimized {
    constructor() {
        this.activeDownloads = new Map();
        this.eventListeners = {};
        this.completedDownloadsCache = new Set(); // Track completed for cleanup
    }

    /**
     * CRITICAL FIX #1: Bounded chunk size calculation
     * Prevents OOM on large files
     */
    calculateOptimalChunkSize(fileSize) {
        const MB = 1024 * 1024;
        const GB = 1024 * MB;

        // ✅ Hard caps at each tier - prevents unbounded growth
        if (fileSize < 100 * MB) return 5 * MB;           // Small files: 5MB
        if (fileSize < 1 * GB) return 10 * MB;            // Medium files: 10MB
        if (fileSize < 10 * GB) return 20 * MB;           // Large files: 20MB
        return 50 * MB;                                    // Huge files: 50MB max

        // Alternative smart calculation if desired:
        // Aim for 100-200 chunks, max 50MB chunk
        // const targetChunks = Math.min(Math.ceil(fileSize / (50 * MB)), 200);
        // return Math.ceil(fileSize / Math.max(targetChunks, 100));
    }

    /**
     * CRITICAL FIX #2: Implement missing function
     * Calculate total bytes downloaded across all chunks
     */
    calculateTotalDownloaded(download) {
        if (!download || !download.chunks) return 0;
        
        let total = 0;
        for (const chunk of download.chunks) {
            total += chunk.bytesReceived || 0;
        }
        return total;
    }

    /**
     * CRITICAL FIX #3: Improved speed calculation with bounded window
     * Prevents memory leaks and NaN/Infinity issues
     */
    updateSpeed(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;

        const now = Date.now();
        const WINDOW_MS = 10000;          // 10 second window
        const MAX_ENTRIES = 100;           // ✅ CAP: Never exceed 100 entries

        // Record current progress point
        download.speedWindow.push({
            bytes: download.bytesDownloaded,
            time: now
        });

        // ✅ Remove entries outside window AND cap array size
        download.speedWindow = download.speedWindow
            .filter(entry => now - entry.time < WINDOW_MS)
            .slice(-MAX_ENTRIES);

        // Need at least 2 points for speed calculation
        if (download.speedWindow.length < 2) return;

        const startEntry = download.speedWindow[0];
        const endEntry = download.speedWindow[download.speedWindow.length - 1];

        // Ensure valid time span
        const timeSpan = Math.max(1, (endEntry.time - startEntry.time) / 1000);
        
        // ✅ Prevent negative bytes (window boundary condition)
        const bytesInWindow = Math.max(0, endEntry.bytes - startEntry.bytes);

        if (bytesInWindow > 0) {
            const currentSpeed = bytesInWindow / timeSpan;
            
            // ✅ Smooth large speed fluctuations with exponential moving average
            if (!download.speedBytesPerSec || download.speedBytesPerSec === 0) {
                download.speedBytesPerSec = currentSpeed;
            } else {
                // EMA (alpha = 0.3): weight new reading 30%, previous 70%
                download.speedBytesPerSec = (0.3 * currentSpeed) + (0.7 * download.speedBytesPerSec);
            }
        }

        // Calculate ETA
        if (download.speedBytesPerSec > 0) {
            const remaining = download.fileSize - download.bytesDownloaded;
            download.eta = Math.max(0, Math.ceil(remaining / download.speedBytesPerSec));
        } else {
            download.eta = 0;
        }

        this.emit('speed:updated', {
            downloadId,
            speed: download.speedBytesPerSec,
            eta: download.eta
        });
    }

    /**
     * CRITICAL FIX #4: Download completion with cleanup
     * Removes from active map to prevent unbounded memory growth
     */
    async completeDownload(downloadId) {
        const download = this.activeDownloads.get(downloadId);
        if (!download) return;

        try {
            // Verify all chunks completed
            if (!download.chunks.every(c => c.status === 'completed')) {
                throw new Error('Not all chunks completed');
            }

            // Assembly logic (unchanged)
            const blobParts = download.chunks
                .sort((a, b) => a.index - b.index)
                .map(c => c.blob);

            const finalBlob = new Blob(blobParts, { type: download.mimeType });

            // Store if IndexedDB enabled
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

            // ✅ CRITICAL FIX: Cleanup from memory to prevent accumulation
            this.activeDownloads.delete(downloadId);
            this.completedDownloadsCache.add(downloadId);
            
            // ✅ Clean up large object references
            download.chunks.forEach(c => {
                delete c.blob;
                delete c.buffer;
            });
            download.chunks = [];
            delete download.speedWindow;

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

            // ✅ Also cleanup on failure
            this.activeDownloads.delete(downloadId);
            this.completedDownloadsCache.add(downloadId);

            this.emit('download:failed', {
                id: downloadId,
                error: error.message
            });
        }
    }

    /**
     * CRITICAL FIX #5: Cancel with guaranteed cleanup
     */
    async cancelDownload(id) {
        const download = this.activeDownloads.get(id);
        if (!download) return;

        download.status = 'cancelled';

        await downloadDB.saveDownload({
            ...download,
            status: 'cancelled'
        });

        // ✅ Cleanup
        this.activeDownloads.delete(id);
        this.completedDownloadsCache.add(id);

        this.emit('download:cancelled', { id });
    }

    /**
     * Batch save chunks for improved performance
     * Reduces number of transactions from N to N/BATCH_SIZE
     */
    async saveChunksBatch(downloadId, chunks) {
        if (!chunks || chunks.length === 0) return;

        const tx = downloadDB.db.transaction(['chunks'], 'readwrite');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('chunks');
            let completed = 0;

            chunks.forEach(({ index, data }) => {
                const request = store.put({
                    downloadId,
                    index,
                    ...data,
                    updated: Date.now()
                });

                request.onsuccess = () => {
                    completed++;
                    if (completed === chunks.length) resolve();
                };

                request.onerror = () => reject(request.error);
            });

            tx.onerror = () => reject(tx.error);
        });
    }

    // Event system (unchanged)
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

    /**
     * Get memory usage statistics (for monitoring)
     */
    getMemoryProfile() {
        let totalChunks = 0;
        let totalSpeedWindowEntries = 0;
        let totalMetadataSize = 0;

        for (const download of this.activeDownloads.values()) {
            totalChunks += download.chunks?.length || 0;
            totalSpeedWindowEntries += download.speedWindow?.length || 0;
            totalMetadataSize += JSON.stringify(download).length;
        }

        return {
            activeDownloads: this.activeDownloads.size,
            completedDownloads: this.completedDownloadsCache.size,
            totalChunks,
            totalSpeedWindowEntries,
            estimatedMemoryMB: (totalMetadataSize + (totalSpeedWindowEntries * 32)) / (1024 * 1024),
            maxSpeedWindowSize: Math.max(...
                Array.from(this.activeDownloads.values()).map(d => d.speedWindow?.length || 0)
            )
        };
    }
}

// Usage: Replace 'downloadEngine' with optimized version
// const downloadEngine = new DownloadEngineOptimized();
