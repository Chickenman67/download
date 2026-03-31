/**
 * UI Manager
 * 
 * Handles:
 * - Download list rendering and updates
 * - Settings modal management
 * - Event listeners and user interactions
 * - Real-time stats display
 * 
 * OPT #2: DOM element caching + OPT #3: Event-driven UI updates
 */

class UIManager {
    constructor() {
        this.downloadItems = new Map(); // id -> DownloadItem
        this.uiRefreshInterval = null;
        
        // OPT #2: Cache DOM elements (instead of querying every time)
        this.cachedElements = {
            urlInput: document.getElementById('urlInput'),
            addBtn: document.getElementById('addBtn'),
            pasteBtn: document.getElementById('pasteBtn'),
            pauseAllBtn: document.getElementById('pauseAllBtn'),
            resumeAllBtn: document.getElementById('resumeAllBtn'),
            clearCompleted: document.getElementById('clearCompleted'),
            settingsBtn: document.getElementById('settingsBtn'),
            closeSettingsBtn: document.getElementById('closeSettingsBtn'),
            settingsModal: document.getElementById('settingsModal'),
            closeBtn: document.querySelector('.close-btn'),
            clearDataBtn: document.getElementById('clearDataBtn'),
            downloadsList: document.getElementById('downloadsList'),
            activeCount: document.getElementById('activeCount'),
            queueCount: document.getElementById('queueCount'),
            speedDisplay: document.getElementById('speedDisplay'),
            storageInfo: document.getElementById('storageInfo')
        };
        
        this.setupEventListeners();
    }

    /**
     * Initialize UI and load any persisted downloads
     */
    async init() {
        this.setupEventListeners();
        await this.loadPersistedDownloads();
        this.startUIRefresh();
        await this.updateStorageInfo();
    }

    /**
     * Setup all DOM event listeners (OPT #2: Use cached elements)
     */
    setupEventListeners() {
        // OPT #2: Use cached elements instead of querying
        this.cachedElements.addBtn.addEventListener('click', () => this.addDownload());
        this.cachedElements.pasteBtn.addEventListener('click', () => this.pasteFromClipboard());
        this.cachedElements.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addDownload();
        });

        // Queue Controls
        this.cachedElements.pauseAllBtn.addEventListener('click', () => this.pauseAll());
        this.cachedElements.resumeAllBtn.addEventListener('click', () => this.resumeAll());
        this.cachedElements.clearCompleted.addEventListener('click', () => this.clearCompleted());

        // Settings
        this.cachedElements.settingsBtn.addEventListener('click', () => this.openSettings());
        this.cachedElements.closeSettingsBtn.addEventListener('click', () => this.closeSettings());
        this.cachedElements.closeBtn.addEventListener('click', () => this.closeSettings());
        this.cachedElements.clearDataBtn.addEventListener('click', () => this.clearAllData());

        // Settings modal background click
        this.cachedElements.settingsModal.addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') this.closeSettings();
        });
        
        // OPT #3: Subscribe to download engine events for event-driven updates
        downloadEngine.on('download:created', () => this.updateStats());
        downloadEngine.on('download:started', () => this.updateStats());
        downloadEngine.on('chunk:progress', (data) => {
            const item = this.downloadItems.get(data.downloadId);
            if (item) {
                const download = downloadEngine.activeDownloads.get(data.downloadId);
                if (download) item.update(download);
            }
        });
        downloadEngine.on('speed:updated', (data) => {
            this.updateStats();
        });
        downloadEngine.on('download:completed', () => this.updateStats());
        downloadEngine.on('download:paused', () => this.updateStats());
        downloadEngine.on('download:resumed', () => this.updateStats());
        downloadEngine.on('download:cancelled', () => this.updateStats());
    }

    /**
     * Add new download (OPT #2: Use cached elements)
     */
    async addDownload() {
        const url = this.cachedElements.urlInput.value.trim();

        if (!url) {
            this.showNotification('Please enter a download URL', 'error');
            return;
        }

        try {
            // Create download
            const download = await downloadEngine.createDownload(url, {
                bandwidthLimit: parseFloat(await downloadDB.getConfig('bandwidthLimit')) || 0,
                enableIndexedDB: (await downloadDB.getConfig('enableIndexedDB')) !== false
            });

            // Create UI item
            const item = new DownloadItem(download);
            this.downloadItems.set(download.id, item);
            this.addItemToList(item);

            // Clear input
            this.cachedElements.urlInput.value = '';

            this.showNotification(`Added: ${download.filename}`, 'success');

            // Auto-start first download or add to queue
            await downloadEngine.startDownload(download.id);

        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    /**
     * Paste URL from clipboard (OPT #2: Use cached element)
     */
    async pasteFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            this.cachedElements.urlInput.value = text.trim();
            this.cachedElements.urlInput.focus();
        } catch (error) {
            this.showNotification('Could not paste from clipboard', 'error');
        }
    }

    /**
     * Add download item to UI list (OPT #2: Use cached element)
     */
    addItemToList(item) {
        // Remove empty state if present
        const emptyState = this.cachedElements.downloadsList.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        this.cachedElements.downloadsList.appendChild(item.getDom());
    }

    /**
     * Update existing download item
     */
    updateDownloadItem(download) {
        const item = this.downloadItems.get(download.id);
        if (item) {
            item.update(download);
        }
    }

    /**
     * Pause all downloads
     */
    async pauseAll() {
        for (const download of downloadEngine.activeDownloads.values()) {
            if (download.status === 'active') {
                await downloadEngine.pauseDownload(download.id);
            }
        }
    }

    /**
     * Resume all downloads
     */
    async resumeAll() {
        for (const download of downloadEngine.activeDownloads.values()) {
            if (download.status === 'paused') {
                await downloadEngine.resumeDownload(download.id);
            }
        }
    }

    /**
     * Clear completed downloads from UI (OPT #2: Use cached element)
     */
    async clearCompleted() {
        const items = this.cachedElements.downloadsList.querySelectorAll('.download-item.status-completed');
        
        for (const item of items) {
            const downloadId = item.dataset.downloadId;
            await downloadDB.deleteDownload(downloadId);
            this.downloadItems.delete(downloadId);
            item.remove();
        }

        // Show empty state if no downloads
        if (this.cachedElements.downloadsList.children.length === 0) {
            this.cachedElements.downloadsList.innerHTML = '<div class="empty-state"><p>No downloads yet. Add a URL to get started.</p></div>';
        }
    }

    /**
     * Open settings modal
     */
    async openSettings() {
        const modal = document.getElementById('settingsModal');
        
        // Load current settings
        const maxWorkers = await downloadDB.getConfig('maxWorkers') || 4;
        const chunkSize = await downloadDB.getConfig('chunkSize') || 10;
        const bandwidthLimit = await downloadDB.getConfig('bandwidthLimit') || 0;
        const retryAttempts = await downloadDB.getConfig('retryAttempts') || 3;
        const autoResume = await downloadDB.getConfig('autoResume') !== false;
        const enableIndexedDB = await downloadDB.getConfig('enableIndexedDB') !== false;

        document.getElementById('maxWorkers').value = maxWorkers;
        document.getElementById('chunkSize').value = chunkSize;
        document.getElementById('bandwidthLimit').value = bandwidthLimit;
        document.getElementById('retryAttempts').value = retryAttempts;
        document.getElementById('autoResume').checked = autoResume;
        document.getElementById('enableIndexedDB').checked = enableIndexedDB;

        // Setup save handlers
        const saveSettings = async () => {
            await downloadDB.setConfig('maxWorkers', parseInt(document.getElementById('maxWorkers').value));
            await downloadDB.setConfig('chunkSize', parseInt(document.getElementById('chunkSize').value));
            await downloadDB.setConfig('bandwidthLimit', parseFloat(document.getElementById('bandwidthLimit').value));
            await downloadDB.setConfig('retryAttempts', parseInt(document.getElementById('retryAttempts').value));
            await downloadDB.setConfig('autoResume', document.getElementById('autoResume').checked);
            await downloadDB.setConfig('enableIndexedDB', document.getElementById('enableIndexedDB').checked);
            
            this.showNotification('Settings saved', 'success');
        };

        // Override close button to save
        document.getElementById('closeSettingsBtn').onclick = async () => {
            await saveSettings();
            this.closeSettings();
        };

        modal.classList.remove('hidden');
    }

    /**
     * Close settings modal
     */
    closeSettings() {
        document.getElementById('settingsModal').classList.add('hidden');
    }

    /**
     * Clear all data
     */
    async clearAllData() {
        if (!confirm('Are you sure? This will delete all downloads and settings.')) return;

        await downloadDB.clearAll();
        this.downloadItems.clear();
        document.getElementById('downloadsList').innerHTML = 
            '<div class="empty-state"><p>No downloads yet. Add a URL to get started.</p></div>';
        
        this.showNotification('All data cleared', 'success');
        this.closeSettings();
    }

    /**
     * Update storage info display (OPT #2: Use cached element)
     */
    async updateStorageInfo() {
        const info = await downloadDB.getStorageInfo();
        const text = info.available !== 'unknown' ?
            `Available: ${info.available}GB | Used: ${info.used}GB (${info.percent}%)` :
            'Storage info unavailable';
        
        if (this.cachedElements.storageInfo) {
            this.cachedElements.storageInfo.textContent = text;
        }
    }

    /**
     * Start UI refresh loop to update stats and progress
     */
    startUIRefresh() {
        this.uiRefreshInterval = setInterval(() => {
            this.updateStats();
        }, 500); // Update every 500ms for smooth animation
    }

    /**
     * Update queue stats display (OPT #2: Use cached elements)
     */
    updateStats() {
        let activeCount = 0;
        let queueCount = 0;
        let totalSpeed = 0;

        for (const download of downloadEngine.activeDownloads.values()) {
            if (download.status === 'active') activeCount++;
            if (download.status === 'pending') queueCount++;
            totalSpeed += download.speedBytesPerSec || 0;
        }

        this.cachedElements.activeCount.textContent = `Active: ${activeCount}`;
        this.cachedElements.queueCount.textContent = `Queued: ${queueCount}`;
        
        // Format total speed
        const speedText = totalSpeed > 0 ?
            totalSpeed > 1024 * 1024 ?
                ((totalSpeed / (1024 * 1024)).toFixed(1)) + ' MB/s' :
                ((totalSpeed / 1024).toFixed(1)) + ' KB/s' :
            '-- MB/s';
        
        this.cachedElements.speedDisplay.textContent = `Speed: ${speedText}`;
    }

    /**
     * Show notification toast
     */
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.classList.add('show');
        }, 10);

        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    /**
     * Load persisted downloads from DB
     */
    async loadPersistedDownloads() {
        const downloads = await downloadDB.getDownloads();

        if (downloads.length === 0) return;

        for (const download of downloads) {
            // Restore to active downloads
            downloadEngine.activeDownloads.set(download.id, download);

            // Create UI item
            const item = new DownloadItem(download);
            this.downloadItems.set(download.id, item);
            this.addItemToList(item);

            // Auto-resume if not completed/failed
            if (download.status === 'active' || download.status === 'paused') {
                if ((await downloadDB.getConfig('autoResume')) !== false) {
                    downloadEngine.startDownload(download.id);
                }
            }
        }
    }

    /**
     * Stop UI refresh
     */
    destroy() {
        if (this.uiRefreshInterval) {
            clearInterval(this.uiRefreshInterval);
        }
    }
}

// Initialize globally
const uiManager = new UIManager();
