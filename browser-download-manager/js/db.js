/**
 * IndexedDB Layer - Persistent Storage for Downloads
 * 
 * Schema:
 * - downloads: metadata store with status tracking
 * - chunks: per-chunk state for resume logic
 * - config: user preferences
 * - blobs: assembled file data
 * 
 * Optimization: Non-blocking async I/O, minimal writes
 */

class DownloadDB {
    constructor() {
        this.db = null;
        this.dbName = 'BrowserDownloadManager';
        this.version = 1;
        this.stores = {
            downloads: { keyPath: 'id' },
            chunks: { keyPath: ['downloadId', 'index'] },
            config: { keyPath: 'key' },
            blobs: { keyPath: 'downloadId' }
        };
    }

    /**
     * Initialize IndexedDB with schema
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(new Error('IndexedDB open failed'));
            request.onsuccess = () => {
                this.db = request.result;
                console.log('✓ IndexedDB initialized');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create object stores
                if (!db.objectStoreNames.contains('downloads')) {
                    const downloadStore = db.createObjectStore('downloads', { keyPath: 'id' });
                    downloadStore.createIndex('status', 'status');
                    downloadStore.createIndex('created', 'created');
                }

                if (!db.objectStoreNames.contains('chunks')) {
                    const chunkStore = db.createObjectStore('chunks', 
                        { keyPath: ['downloadId', 'index'] });
                    chunkStore.createIndex('downloadId', 'downloadId');
                    chunkStore.createIndex('status', ['downloadId', 'status']);
                }

                if (!db.objectStoreNames.contains('config')) {
                    db.createObjectStore('config', { keyPath: 'key' });
                }

                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'downloadId' });
                }

                console.log('✓ IndexedDB schema created');
            };
        });
    }

    /**
     * Save download metadata
     * @param {Object} download - Download metadata
     */
    async saveDownload(download) {
        const tx = this.db.transaction(['downloads'], 'readwrite');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('downloads');
            const request = store.put({
                ...download,
                updated: Date.now()
            });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Get download by ID
     */
    async getDownload(id) {
        const tx = this.db.transaction(['downloads'], 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('downloads');
            const request = store.get(id);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Get all downloads filtered by status
     */
    async getDownloads(status = null) {
        const tx = this.db.transaction(['downloads'], 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('downloads');
            const index = status ? store.index('status') : store;
            const request = status ? index.getAll(status) : store.getAll();
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Delete download and all associated data
     */
    async deleteDownload(id) {
        const tx = this.db.transaction(['downloads', 'chunks', 'blobs'], 'readwrite');
        
        return new Promise((resolve, reject) => {
            // Delete download metadata
            tx.objectStore('downloads').delete(id);
            
            // Delete associated chunks
            const chunkStore = tx.objectStore('chunks');
            const chunkIndex = chunkStore.index('downloadId');
            const chunkRequest = chunkIndex.openCursor(IDBKeyRange.only(id));
            
            chunkRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };

            // Delete blob if exists
            tx.objectStore('blobs').delete(id);

            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
        });
    }

    /**
     * Save chunk state for resume capability
     */
    async saveChunk(downloadId, index, data) {
        const tx = this.db.transaction(['chunks'], 'readwrite');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('chunks');
            const request = store.put({
                downloadId,
                index,
                ...data,
                updated: Date.now()
            });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * Get all chunks for a download
     */
    async getChunks(downloadId) {
        const tx = this.db.transaction(['chunks'], 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('chunks');
            const index = store.index('downloadId');
            const request = index.getAll(downloadId);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Get incomplete chunks (for resume)
     */
    async getIncompleteChunks(downloadId) {
        const tx = this.db.transaction(['chunks'], 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('chunks');
            const index = store.index('status');
            const range = IDBKeyRange.only([downloadId, 'pending']);
            const request = index.getAll(range);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Update chunk status in batch (efficient bulk update)
     */
    async updateChunksStatus(downloadId, updates) {
        const tx = this.db.transaction(['chunks'], 'readwrite');
        const store = tx.objectStore('chunks');

        return new Promise((resolve, reject) => {
            let processed = 0;
            const total = updates.length;

            updates.forEach(({ index, status, bytesReceived }) => {
                const key = [downloadId, index];
                const getRequest = store.get(key);
                
                getRequest.onsuccess = () => {
                    const chunk = getRequest.result || {};
                    const putRequest = store.put({
                        downloadId,
                        index,
                        ...chunk,
                        status,
                        bytesReceived: bytesReceived || chunk.bytesReceived || 0,
                        updated: Date.now()
                    });

                    putRequest.onsuccess = () => {
                        processed++;
                        if (processed === total) resolve();
                    };
                };
            });

            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Save config setting
     */
    async setConfig(key, value) {
        const tx = this.db.transaction(['config'], 'readwrite');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('config');
            const request = store.put({ key, value });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * Get config setting
     */
    async getConfig(key) {
        const tx = this.db.transaction(['config'], 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('config');
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.value : null);
            };
        });
    }

    /**
     * Save blob data (file chunks for assembly)
     */
    async saveBlob(downloadId, blob) {
        const tx = this.db.transaction(['blobs'], 'readwrite');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('blobs');
            const request = store.put({
                downloadId,
                blob,
                saved: Date.now()
            });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * Get blob data
     */
    async getBlob(downloadId) {
        const tx = this.db.transaction(['blobs'], 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('blobs');
            const request = store.get(downloadId);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.blob : null);
            };
        });
    }

    /**
     * Delete blob data
     */
    async deleteBlob(downloadId) {
        const tx = this.db.transaction(['blobs'], 'readwrite');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore('blobs');
            const request = store.delete(downloadId);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * Get storage quota usage and availability
     */
    async getStorageInfo() {
        if (!navigator.storage) return { available: 'unknown', used: 0 };

        try {
            const estimate = await navigator.storage.estimate();
            return {
                available: Math.round(estimate.quota / (1024 * 1024 * 1024)), // GB
                used: Math.round(estimate.usage / (1024 * 1024 * 1024)),       // GB
                percent: Math.round((estimate.usage / estimate.quota) * 100)
            };
        } catch (e) {
            return { available: 'unknown', used: 0 };
        }
    }

    /**
     * Clear all data
     */
    async clearAll() {
        const tx = this.db.transaction(
            ['downloads', 'chunks', 'config', 'blobs'], 
            'readwrite'
        );

        return new Promise((resolve, reject) => {
            tx.objectStore('downloads').clear();
            tx.objectStore('chunks').clear();
            tx.objectStore('config').clear();
            tx.objectStore('blobs').clear();

            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => {
                console.log('✓ All data cleared');
                resolve();
            };
        });
    }
}

// Initialize globally
const downloadDB = new DownloadDB();
