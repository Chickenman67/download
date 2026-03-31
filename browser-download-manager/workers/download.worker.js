/**
 * Download Worker - Parallel Chunk Downloader
 * 
 * Runs in separate thread to download a single chunk without blocking UI
 * 
 * Message format from main thread:
 * {
 *   type: 'download',
 *   downloadId: 'dl_...',
 *   chunkIndex: 0,
 *   url: 'https://...',
 *   start: 0,
 *   end: 1024,
 *   bandwidthLimit: 0,
 *   timeout: 30000
 * }
 * 
 * Returns to main thread:
 * {
 *   type: 'progress',
 *   downloadId: 'dl_...',
 *   chunkIndex: 0,
 *   bytesReceived: 512,
 *   total: 1024
 * }
 * 
 * On complete:
 * {
 *   type: 'complete',
 *   downloadId: 'dl_...',
 *   chunkIndex: 0,
 *   bytes: Uint8Array,
 *   duration: 5000
 * }
 * 
 * On error:
 * {
 *   type: 'error',
 *   downloadId: 'dl_...',
 *   chunkIndex: 0,
 *   error: 'message'
 * }
 */

self.onmessage = async (event) => {
    const { type, data } = event.data;

    if (type === 'download') {
        await downloadChunk(data);
    } else if (type === 'ping') {
        // Keep-alive message
        self.postMessage({ type: 'pong' });
    }
};

/**
 * Download a single chunk with progress reporting
 */
async (data) => {
    const {
        downloadId,
        chunkIndex,
        url,
        start,
        end,
        bandwidthLimit = 0,
        timeout = 30000
    } = data;

    const startTime = Date.now();
    const chunkSize = end - start + 1;
    let bytesReceived = 0;
    let lastReportTime = startTime;
    let lastReportBytes = 0;

    try {
        // Create abort controller with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        // Fetch with Range header
        const response = await fetch(url, {
            headers: {
                'Range': `bytes=${start}-${end}`
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok && response.status !== 206) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Stream response
        const reader = response.body.getReader();
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            bytesReceived += value.length;

            // Apply bandwidth throttling
            if (bandwidthLimit > 0) {
                const now = Date.now();
                const elapsedSec = (now - startTime) / 1000;
                const maxBytesPerSec = bandwidthLimit * 1024 * 1024;
                const allowedBytes = elapsedSec * maxBytesPerSec;

                if (bytesReceived > allowedBytes) {
                    const overage = bytesReceived - allowedBytes;
                    const delay = (overage / maxBytesPerSec) * 1000;
                    await new Promise(r => setTimeout(r, Math.min(delay, 50)));
                }
            }

            // Report progress every 100ms
            const now = Date.now();
            if (now - lastReportTime >= 100) {
                self.postMessage({
                    type: 'progress',
                    downloadId,
                    chunkIndex,
                    bytesReceived,
                    total: chunkSize
                });

                lastReportTime = now;
                lastReportBytes = bytesReceived;
            }
        }

        // Combine chunks into single Uint8Array
        const buffer = new Uint8Array(chunkSize);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
        }

        // Final progress report
        self.postMessage({
            type: 'progress',
            downloadId,
            chunkIndex,
            bytesReceived: chunkSize,
            total: chunkSize
        });

        // Send completed chunk back
        self.postMessage({
            type: 'complete',
            downloadId,
            chunkIndex,
            bytes: buffer,
            duration: Date.now() - startTime
        }, [buffer.buffer]); // Transfer buffer ownership back to main thread

    } catch (error) {
        const errorMessage = error.name === 'AbortError' 
            ? 'Download timeout' 
            : error.message;

        self.postMessage({
            type: 'error',
            downloadId,
            chunkIndex,
            error: errorMessage,
            duration: Date.now() - startTime
        });
    }
};

// Async IIFE to handle the download
async function downloadChunk(data) {
    const {
        downloadId,
        chunkIndex,
        url,
        start,
        end,
        bandwidthLimit = 0,
        timeout = 30000
    } = data;

    const startTime = Date.now();
    const chunkSize = end - start + 1;
    let bytesReceived = 0;
    let lastReportTime = startTime;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
            headers: {
                'Range': `bytes=${start}-${end}`
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok && response.status !== 206) {
            throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            bytesReceived += value.length;

            // Bandwidth throttling
            if (bandwidthLimit > 0) {
                const now = Date.now();
                const elapsedSec = (now - startTime) / 1000;
                const maxBytesPerSec = bandwidthLimit * 1024 * 1024;
                const allowedBytes = elapsedSec * maxBytesPerSec;

                if (bytesReceived > allowedBytes) {
                    const overage = bytesReceived - allowedBytes;
                    const delay = (overage / maxBytesPerSec) * 1000;
                    await new Promise(r => setTimeout(r, Math.min(delay, 50)));
                }
            }

            // Report every 100ms
            const now = Date.now();
            if (now - lastReportTime >= 100) {
                self.postMessage({
                    type: 'progress',
                    downloadId,
                    chunkIndex,
                    bytesReceived,
                    total: chunkSize
                });
                lastReportTime = now;
            }
        }

        // Combine chunks
        const buffer = new Uint8Array(chunkSize);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
        }

        self.postMessage({
            type: 'complete',
            downloadId,
            chunkIndex,
            bytes: buffer,
            duration: Date.now() - startTime
        }, [buffer.buffer]);

    } catch (error) {
        self.postMessage({
            type: 'error',
            downloadId,
            chunkIndex,
            error: error.message,
            duration: Date.now() - startTime
        });
    }
}
