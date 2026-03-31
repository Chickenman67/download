/**
 * Main Application Initialization
 * 
 * Orchestrates:
 * - Database initialization
 * - UI Manager setup
 * - Event listener registration
 * - Download engine event handling
 */

class DownloadManagerApp {
    constructor() {
        this.initialized = false;
    }

    /**
     * Initialize application
     */
    async init() {
        try {
            console.log('⚡ Initializing Browser Download Manager...');

            // 1. Initialize database
            await downloadDB.init();

            // 2. Initialize UI Manager
            await uiManager.init();

            // 3. Setup clipboard monitor
            clipboardMonitor.init();

            // 4. Register download engine event listeners
            this.setupEngineListeners();

            // 5. Restore any persisted downloads
            await this.restorePersistentDownloads();

            this.initialized = true;
            console.log('✓ Browser Download Manager ready!');

        } catch (error) {
            console.error('Failed to initialize app:', error);
            uiManager.showNotification(
                'Failed to initialize: ' + error.message,
                'error'
            );
        }
    }

    /**
     * Setup event listeners for download engine
     */
    setupEngineListeners() {
        // Download created
        downloadEngine.on('download:created', (dl) => {
            console.log(`✓ Download created: ${dl.filename}`);
        });

        // Download started
        downloadEngine.on('download:started', ({ id }) => {
            const download = downloadEngine.activeDownloads.get(id);
            uiManager.updateDownloadItem(download);
        });

        // Chunk progress
        downloadEngine.on('chunk:progress', ({ downloadId, chunkIndex, bytesReceived }) => {
            const download = downloadEngine.activeDownloads.get(downloadId);
            if (download) {
                uiManager.updateDownloadItem(download);
            }
        });

        // Speed updated
        downloadEngine.on('speed:updated', ({ downloadId, speed, eta }) => {
            const download = downloadEngine.activeDownloads.get(downloadId);
            if (download) {
                download.speedBytesPerSec = speed;
                download.eta = eta;
                uiManager.updateDownloadItem(download);
            }
        });

        // Download completed
        downloadEngine.on('download:completed', ({ id, filename, size }) => {
            const download = downloadEngine.activeDownloads.get(id);
            if (download) {
                uiManager.updateDownloadItem(download);
                uiManager.showNotification(
                    `✓ Completed: ${filename} (${uiManager.downloadItems.get(id).formatBytes(size)})`,
                    'success'
                );
            }
        });

        // Download failed
        downloadEngine.on('download:failed', ({ id, error }) => {
            const download = downloadEngine.activeDownloads.get(id);
            if (download) {
                uiManager.updateDownloadItem(download);
                uiManager.showNotification(
                    `✗ Failed: ${download.filename} - ${error}`,
                    'error'
                );
            }
        });

        // Download paused
        downloadEngine.on('download:paused', ({ id }) => {
            const download = downloadEngine.activeDownloads.get(id);
            if (download) {
                uiManager.updateDownloadItem(download);
            }
        });

        // Download resumed
        downloadEngine.on('download:resumed', ({ id }) => {
            const download = downloadEngine.activeDownloads.get(id);
            if (download) {
                uiManager.updateDownloadItem(download);
            }
        });

        // Chunk error
        downloadEngine.on('chunk:error', ({ downloadId, chunkIndex, attempt, error }) => {
            console.warn(
                `Chunk ${chunkIndex} error (attempt ${attempt}): ${error}`
            );
        });
    }

    /**
     * Restore any incomplete downloads on page load
     * Only if auto-resume is enabled
     */
    async restorePersistentDownloads() {
        try {
            const autoResume = (await downloadDB.getConfig('autoResume')) !== false;
            if (!autoResume) return;

            const incompleteDownloads = await downloadDB.getDownloads('active');

            for (const download of incompleteDownloads) {
                console.log(`Restoring download: ${download.filename}`);

                // Restore to active downloads
                downloadEngine.activeDownloads.set(download.id, {
                    ...download,
                    speedWindow: [],
                    lastUpdate: Date.now()
                });

                // Create UI item and add to list
                const item = new DownloadItem(download);
                uiManager.downloadItems.set(download.id, item);
                uiManager.addItemToList(item);

                // Resume download
                await downloadEngine.startDownload(download.id);
            }
        } catch (error) {
            console.warn('Could not restore persistent downloads:', error.message);
        }
    }

    /**
     * Cleanup on page unload
     */
    destroy() {
        uiManager.destroy();
    }
}

// Initialize app on DOM ready
let app = null;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
        app = new DownloadManagerApp();
        await app.init();
    });
} else {
    (async () => {
        app = new DownloadManagerApp();
        await app.init();
    })();
}

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    if (app) app.destroy();
});
