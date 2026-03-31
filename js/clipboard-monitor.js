/**
 * Clipboard Monitor
 * 
 * Auto-detects URLs copied to clipboard and shows suggestion
 * Helps users quickly start downloads without manual paste
 */

class ClipboardMonitor {
    constructor() {
        this.lastClipboardContent = '';
        this.suggestionBox = document.getElementById('urlSuggestions');
    }

    /**
     * Start monitoring clipboard
     * Note: Requires user interaction to read clipboard (security limitation)
     */
    init() {
        // Monitor paste event in URL input
        document.getElementById('urlInput').addEventListener('paste', (e) => {
            setTimeout(() => this.checkClipboard(), 100);
        });

        // Optional: Monitor focus on URL input for clipboard check
        document.getElementById('urlInput').addEventListener('focus', () => {
            this.checkClipboard();
        });
    }

    /**
     * Check and display clipboard content if it's a URL
     */
    async checkClipboard() {
        try {
            const text = await navigator.clipboard.readText();

            // Only process if different from last content
            if (text === this.lastClipboardContent) return;

            this.lastClipboardContent = text;

            // Check if it looks like a URL
            if (this.isValidUrl(text)) {
                this.showSuggestion(text);
            } else {
                this.hideSuggestion();
            }
        } catch (error) {
            // Suppress errors - clipboard access is restricted without user action
        }
    }

    /**
     * Check if text is a valid URL
     */
    isValidUrl(text) {
        try {
            new URL(text);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Show clipboard URL suggestion
     */
    showSuggestion(url) {
        this.suggestionBox.innerHTML = `
            <div class="suggestion-item">
                <span class="suggestion-url">${this.truncateUrl(url)}</span>
                <button class="btn btn-small" onclick="document.getElementById('urlInput').value = '${this.escapeQuotes(url)}'; document.getElementById('addBtn').click(); this.parentElement.parentElement.innerHTML = '';">Use URL</button>
            </div>
        `;
        this.suggestionBox.style.display = 'block';
    }

    /**
     * Hide suggestion
     */
    hideSuggestion() {
        this.suggestionBox.style.display = 'none';
    }

    /**
     * Truncate long URL for display
     */
    truncateUrl(url) {
        return url.length > 60 ? url.substring(0, 57) + '...' : url;
    }

    /**
     * Escape quotes in URL for HTML attribute
     */
    escapeQuotes(text) {
        return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
    }
}

// Initialize globally
const clipboardMonitor = new ClipboardMonitor();
