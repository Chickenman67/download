/**
 * Download Item - UI Component for Individual Download
 * 
 * Represents a single download in the list with progress tracking,
 * state management, and user interaction handlers
 * 
 * FIX #3: Cache DOM elements + listener management
 */

class DownloadItem {
    constructor(download) {
        this.download = download;
        this.dom = null;
        this.cachedElements = {};  // FIX #3: Cache DOM references
        this.eventHandler = null;  // FIX #3: Store reference to event handler
        this.render();
    }

    /**
     * Render download item DOM
     */
    render() {
        const container = document.createElement('div');
        container.className = `download-item status-${this.download.status}`;
        container.dataset.downloadId = this.download.id;

        const progress = Math.round((this.download.bytesDownloaded / this.download.fileSize) * 100);

        container.innerHTML = `
            <div class="item-header">
                <div class="item-info">
                    <h3 class="item-filename">${this.escapeHtml(this.download.filename)}</h3>
                    <div class="item-details">
                        <span class="item-size">${this.formatBytes(this.download.fileSize)}</span>
                        <span class="item-status" data-status>${this.download.status}</span>
                    </div>
                </div>
                <div class="item-actions">
                    <button class="item-btn action-pause" data-action="pause" title="Pause" style="display: ${this.download.status === 'active' ? 'block' : 'none'}">⏸</button>
                    <button class="item-btn action-resume" data-action="resume" title="Resume" style="display: ${this.download.status === 'paused' ? 'block' : 'none'}">▶</button>
                    <button class="item-btn action-cancel" data-action="cancel" title="Cancel">✕</button>
                </div>
            </div>

            <div class="progress-container">
                <div class="progress-bar" data-progress style="width: ${progress}%"></div>
            </div>

            <div class="item-footer">
                <span class="progress-text" data-progress-text>${progress}% (${this.formatBytes(this.download.bytesDownloaded)} / ${this.formatBytes(this.download.fileSize)})</span>
                <span class="speed-text" data-speed-text>${this.formatSpeed(this.download.speedBytesPerSec)}</span>
                <span class="eta-text" data-eta-text>${this.formatETA(this.download.eta)}</span>
            </div>

            ${this.download.errors.length > 0 ? `
                <div class="error-message">
                    ⚠️ ${this.escapeHtml(this.download.errors[this.download.errors.length - 1].message)}
                </div>
            ` : ''}
        `;

        this.dom = container;
        this.cachedElements = {};  // FIX #3: Reset cache on render
        this.setupEventListeners();
    }

    /**
     * Get cached DOM element (FIX #3: Optimize querySelector calls)
     */
    getCachedElement(selector) {
        if (!this.cachedElements[selector]) {
            this.cachedElements[selector] = this.dom.querySelector(selector);
        }
        return this.cachedElements[selector];
    }

    /**
     * Setup click handlers for action buttons (FIX #3: Single event handler)
     */
    setupEventListeners() {
        // Remove old handler if exists (FIX #3: Prevent listener accumulation)
        if (this.eventHandler) {
            this.dom.removeEventListener('click', this.eventHandler);
        }
        
        // Create single delegation handler (FIX #3: Only one listener per item)
        this.eventHandler = async (e) => {
            const action = e.target.dataset.action;
            if (!action) return;

            switch (action) {
                case 'pause':
                    await downloadEngine.pauseDownload(this.download.id);
                    break;
                case 'resume':
                    await downloadEngine.resumeDownload(this.download.id);
                    break;
                case 'cancel':
                    await downloadEngine.cancelDownload(this.download.id);
                    await downloadDB.deleteDownload(this.download.id);
                    this.dom.remove();
                    break;
            }
        };
        
        this.dom.addEventListener('click', this.eventHandler);
    }

    /**
     * Update download item with new state (FIX #3: Use cached elements)
     */
    update(download) {
        this.download = download;
        
        const progress = Math.round((download.bytesDownloaded / download.fileSize) * 100);

        // Update progress bar (FIX #3: Use cached element)
        const progressBar = this.getCachedElement('[data-progress]');
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }

        // Update status (FIX #3: Use cached element)
        const statusSpan = this.getCachedElement('[data-status]');
        if (statusSpan) {
            statusSpan.textContent = download.status;
            statusSpan.className = `item-status status-${download.status}`;
        }

        // Update progress text (FIX #3: Use cached element)
        const progressText = this.getCachedElement('[data-progress-text]');
        if (progressText) {
            progressText.textContent = 
                `${progress}% (${this.formatBytes(download.bytesDownloaded)} / ${this.formatBytes(download.fileSize)})`;
        }

        // Update speed (FIX #3: Use cached element)
        const speedText = this.getCachedElement('[data-speed-text]');
        if (speedText) {
            speedText.textContent = this.formatSpeed(download.speedBytesPerSec);
        }

        // Update ETA (FIX #3: Use cached element)
        const etaText = this.getCachedElement('[data-eta-text]');
        if (etaText) {
            etaText.textContent = this.formatETA(download.eta);
        }

        // Update action buttons (FIX #3: Use cached elements)
        const pauseBtn = this.getCachedElement('.action-pause');
        const resumeBtn = this.getCachedElement('.action-resume');
        if (pauseBtn && resumeBtn) {
            pauseBtn.style.display = download.status === 'active' ? 'block' : 'none';
            resumeBtn.style.display = download.status === 'paused' ? 'block' : 'none';
        }

        // Update status class
        this.dom.className = `download-item status-${download.status}`;

        // Update error display
        let errorDiv = this.getCachedElement('.error-message');
        if (download.errors.length > 0 && !errorDiv) {
            const error = download.errors[download.errors.length - 1];
            const errorElement = document.createElement('div');
            errorElement.className = 'error-message';
            errorElement.textContent = `⚠️ ${error.message}`;
            this.dom.appendChild(errorElement);
            this.cachedElements['.error-message'] = errorElement;
        }
    }

    /**
     * Format bytes to human readable
     */
    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Format speed to human readable (Mbps)
     */
    formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec === 0) return '-- Mbps';
        const mbps = (bytesPerSec * 8) / (1024 * 1024); // Convert bytes/sec to Mbps
        return mbps > 1000 ? 
            (mbps / 1000).toFixed(1) + ' Gbps' : 
            mbps.toFixed(1) + ' Mbps';
    }

    /**
     * Format ETA to human readable
     */
    formatETA(seconds) {
        if (!seconds || seconds <= 0) return '--';
        
        if (seconds < 60) return `${Math.ceil(seconds)}s`;
        if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.ceil((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }

    /**
     * Escape HTML to prevent injection
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Get DOM element
     */
    getDom() {
        return this.dom;
    }
}
