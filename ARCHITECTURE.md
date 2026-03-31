# Browser Download Manager - Architecture & Data Flow

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BROWSER DOWNLOAD MANAGER                             │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         PRESENTATION LAYER                            │  │
│  │                                                                        │  │
│  │  UI Manager  ←→  Download Item Components  ←→  Settings Modal        │  │
│  │  (ui-manager.js)     (download-item.js)      (modal HTML)            │  │
│  │                                                                        │  │
│  │  Updates: 500ms polling (to be optimized to event-driven)            │  │
│  │  Renders: Progress bars, stats, speed, ETA                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              ↑ ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    EVENT SYSTEM & LISTENERS                           │  │
│  │                                                                        │  │
│  │  Events emitted by DownloadEngine:                                   │  │
│  │  - download:created  → Create UI item                               │  │
│  │  - download:started  → Begin visual feedback                        │  │
│  │  - chunk:progress    → Update progress bar                          │  │
│  │  - speed:updated     → Update speed/ETA display                     │  │
│  │  - download:completed → Mark as complete, trigger download          │  │
│  │  - download:failed    → Show error message                          │  │
│  │  - chunk:error       → Log retry attempt                            │  │
│  │                                                                        │  │
│  │  ⚠️ Issue: Event listeners not cleaned up properly (Fix #3)         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              ↑ ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      DOWNLOAD ENGINE CORE                             │  │
│  │                    (download-engine.js)                              │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │ URL Input → Probing → Metadata Discovery                   │    │  │
│  │  │                                                              │    │  │
│  │  │ Actions:                                                     │    │  │
│  │  │  1. Validate URL (try...catch)                              │    │  │
│  │  │  2. HEAD request → File size, content-type                  │    │  │
│  │  │  3. Test Range support: "Accept-Ranges: bytes"              │    │  │
│  │  │  4. Calculate optimal chunk size                            │    │  │
│  │  │  5. Generate chunk array (metadata only)                    │    │  │
│  │  │                                                              │    │  │
│  │  │  ⚠️ Issue: Chunk size unbounded on large files (Fix #2)     │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  │                              ↓                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │ Download Execution → Parallel Stream Orchestration         │    │  │
│  │  │                                                              │    │  │
│  │  │ Phase 1 (CURRENT): Single-threaded sequential              │    │  │
│  │  │  - Download chunk by chunk sequentially                    │    │  │
│  │  │  - Each chunk fetched with HTTP Range header               │    │  │
│  │  │  - Stream to memory (Blob)                                 │    │  │
│  │  │  - Report progress after each chunk                        │    │  │
│  │  │                                                              │    │  │
│  │  │ Phase 2 (FUTURE): Parallel with Web Workers                │    │  │
│  │  │  - Spawn 4-8 workers                                        │    │  │
│  │  │  - Each worker downloads one chunk                         │    │  │
│  │  │  - Concurrent HTTP Range requests                          │    │  │
│  │  │  - Speed multiplier: 3-4x                                   │    │  │
│  │  │                                                              │    │  │
│  │  │  ⚠️ Issue: Missing calculateTotalDownloaded() (Fix #4)      │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  │                              ↓                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │ Download Chunk (HTTP Range Request)                         │    │  │
│  │  │                                                              │    │  │
│  │  │ fetch(url, { headers: { 'Range': 'bytes=0-1023' } })       │    │  │
│  │  │                                                              │    │  │
│  │  │ Actions:                                                     │    │  │
│  │  │  1. Send Range request                                      │    │  │
│  │  │  2. Get reader from response.body                           │    │  │
│  │  │  3. Read in chunks:                                         │    │  │
│  │  │     - Accumulate bytes                                      │    │  │
│  │  │     - Report progress every 100ms                          │    │  │
│  │  │     - Apply throttling if enabled                          │    │  │
│  │  │  4. Combine into single Blob on complete                   │    │  │
│  │  │  5. Calculate hash for integrity (SHA-256)                 │    │  │
│  │  │  6. Save to DB                                              │    │  │
│  │  │                                                              │    │  │
│  │  │ Retry Logic (Exponential Backoff):                          │    │  │
│  │  │  Attempt 1: Fail → Wait 1s + jitter                        │    │  │
│  │  │  Attempt 2: Fail → Wait 2s + jitter                        │    │  │
│  │  │  Attempt 3: Fail → Wait 4s + jitter                        │    │  │
│  │  │  Attempt 4: Fail → Wait 8s + jitter                        │    │  │
│  │  │  Max attempts: 3 (configurable)                            │    │  │
│  │  │  Max wait: 8s (hard cap)                                    │    │  │
│  │  │                                                              │    │  │
│  │  │ Bandwidth Throttling (if configured):                       │    │  │
│  │  │  If bytesDownloaded > allowedBytes:                        │    │  │
│  │  │    delay = (overage / maxBytesPerSec) * 1000               │    │  │
│  │  │    await sleep(Math.min(delay, 100))                       │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  │                              ↓                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │ Speed Calculation (Sliding 10-Second Window)                │    │  │
│  │  │                                                              │    │  │
│  │  │ Algorithm:                                                   │    │  │
│  │  │  1. Record: { bytes: totalDownloaded, time: now }          │    │  │
│  │  │  2. Filter: Keep only entries within last 10 seconds       │    │  │
│  │  │  3. Calculate:                                              │    │  │
│  │  │     speedBytesPerSec = bytesInWindow / timeSpan             │    │  │
│  │  │  4. ETA = remaining / speed                                │    │  │
│  │  │                                                              │    │  │
│  │  │  ⚠️ Issue: Unbounded array growth (Fix #1)                  │    │  │
│  │  │  ⚠️ Issue: Can produce NaN if window calculation off (Opt#4)│    │  │
│  │  │                                                              │    │  │
│  │  │  Optimization: EMA smoothing (30% new, 70% previous)       │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  │                              ↓                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │ Assembly & Completion                                       │    │  │
│  │  │                                                              │    │  │
│  │  │ When all chunks complete:                                  │    │  │
│  │  │  1. Combine all chunk blobs in order                       │    │  │
│  │  │  2. Create final Blob (streaming assembly)                │    │  │
│  │  │  3. Save to IndexedDB if enabled                          │    │  │
│  │  │  4. Create download link via  Blob URL                    │    │  │
│  │  │  5. Trigger browser download                              │    │  │
│  │  │  6. Cleanup: Delete from active downloads map             │    │  │
│  │  │  7. Emit download:completed event                         │    │  │
│  │  │                                                              │    │  │
│  │  │  ⚠️ Issue: Map not cleaned up (Fix #5)                      │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              ↑ ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    DATABASE LAYER (IndexedDB)                         │  │
│  │                         (db.js)                                       │  │
│  │                                                                        │  │
│  │  Object Stores:                                                       │  │
│  │                                                                        │  │
│  │  ┌──── downloads ────────────────────────────────────────────┐       │  │
│  │  │ Key: id (unique download ID)                             │       │  │
│  │  │ Data: { filename, size, status, created, updated, ... }  │       │  │
│  │  │ Index: status, created                                   │       │  │
│  │  └─────────────────────────────────────────────────────────┘       │  │
│  │                                                                        │  │
│  │  ┌──── chunks ───────────────────────────────────────────────┐       │  │
│  │  │ Key: [downloadId, index] (composite)                     │       │  │
│  │  │ Data: { status, bytesReceived, hash, updated }           │       │  │
│  │  │ Index: downloadId, status                                │       │  │
│  │  │ Note: Allows rapid lookup of incomplete chunks for resume│       │  │
│  │  │                                                            │       │  │
│  │  │ ⚠️ Issue: Need batch writes for performance (Opt #3)      │       │  │
│  │  └─────────────────────────────────────────────────────────┘       │  │
│  │                                                                        │  │
│  │  ┌──── blobs ────────────────────────────────────────────────┐       │  │
│  │  │ Key: downloadId                                          │       │  │
│  │  │ Data: { blob: File data, saved: timestamp }              │       │  │
│  │  │ Note: For large files, enables download recovery without │       │  │
│  │  │       re-downloading if browser crash occurs             │       │  │
│  │  └─────────────────────────────────────────────────────────┘       │  │
│  │                                                                        │  │
│  │  ┌──── config ───────────────────────────────────────────────┐       │  │
│  │  │ Key: config key name (string)                            │       │  │
│  │  │ Data: { key, value }                                     │       │  │
│  │  │ Examples: { key: 'maxWorkers', value: 4 }               │       │  │
│  │  │           { key: 'bandwidthLimit', value: 10 }          │       │  │
│  │  └─────────────────────────────────────────────────────────┘       │  │
│  │                                                                        │  │
│  │  Transaction Pattern:                                                │  │
│  │   - Single writes per chunk (inefficient)                           │  │
│  │   - Should batch: 50 chunks per transaction                         │  │
│  │   - Reduces transactions by 50x for large files                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              ↑ ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    WEB WORKERS (Phase 2)                              │  │
│  │                 (workers/download.worker.js)                          │  │
│  │                                                                        │  │
│  │  Purpose: Parallel chunk downloading without blocking UI             │  │
│  │                                                                        │  │
│  │  Message Format (from main):                                         │  │
│  │  {                                                                    │  │
│  │    type: 'download',                                                 │  │
│  │    data: {                                                           │  │
│  │      downloadId, chunkIndex, url,                                    │  │
│  │      start, end, bandwidthLimit, timeout                             │  │
│  │    }                                                                  │  │
│  │  }                                                                    │  │
│  │                                                                        │  │
│  │  Message Format (to main):                                           │  │
│  │  { type: 'progress', downloadId, chunkIndex, bytesReceived }        │  │
│  │  { type: 'complete', downloadId, chunkIndex, bytes, duration }      │  │
│  │  { type: 'error', downloadId, chunkIndex, error }                   │  │
│  │                                                                        │  │
│  │  Pool Management:                                                    │  │
│  │  - Create 4-8 workers on startup                                     │  │
│  │  - Distribute chunks across worker pool                             │  │
│  │  - Parallel downloads: 4-8 concurrent HTTP Range requests            │  │
│  │  - Expected speedup: 3-4x                                            │  │
│  │                                                                        │  │
│  │  Transfer Objects: Use transferable Uint8Arrays (zero-copy)         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              ↑ ↓                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    BROWSER NATIVE APIS                                │  │
│  │                                                                        │  │
│  │  Fetch API ..................... HTTP downloads with Range headers   │  │
│  │  Blob API ...................... File assembly & streaming           │  │
│  │  IndexedDB API ................. Persistent storage                  │  │
│  │  Web Workers API ............... Parallel downloads (Phase 2)        │  │
│  │  ClipboardAPI .................. Auto-detect URLs                    │  │
│  │  FileAPI ....................... Direct browser download             │  │
│  │  Crypto API .................... SHA-256 integrity checking          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Diagram

```
USER INPUT
    │
    ├─→ Paste URL
    │      │
    │      ├─→ Validate
    │      │      │
    │      │      └─→ Invalid? → Show error
    │      │
    │      └─→ Probe Server
    │             │
    │             ├─→ HEAD request
    │             │      └─→ Get size, content-type, accept-ranges
    │             │
    │             ├─→ Size > 0? → YES
    │             │
    │             └─→ Save download metadata to DB
    │
    ├─→ Start/Resume Download
    │      │
    │      ├─→ Load download + chunks from DB
    │      │
    │      └─→ For each pending chunk:
    │             │
    │             ├─→ HTTP Fetch (Range request)
    │             │      └─→ bytes=START-END
    │             │
    │             ├─→ Stream to memory
    │             │      ├─→ On data: report progress, apply throttle
    │             │      └─→ On complete: save chunk to DB
    │             │
    │             └─→ On error: retry with exponential backoff
    │
    ├─→ UI Updates (event-driven)
    │      │
    │      ├─→ speed:updated event
    │      │      └─→ Update speed display, ETA
    │      │
    │      └─→ chunk:progress event
    │             └─→ Update progress bar
    │
    ├─→ All chunks complete
    │      │
    │      ├─→ Assemble chunks to final Blob
    │      │
    │      ├─→ Save to IndexedDB (optional)
    │      │
    │      ├─→ Create download link
    │      │
    │      ├─→ Trigger browser download
    │      │
    │      └─→ Cleanup from memory
    │
    └─→ Pause/Resume/Cancel
           └─→ Update DB status

USER ACTIONS: Pause/Resume/Cancel
              └─→ Update download status
              └─→ Pause: Stop fetch/workers
              └─→ Resume: Continue from saved byte offset
              └─→ Cancel: Delete from DB & UI
```

## State Machine

```
              ┌──────────┐
              │ PENDING  │
              └────┬─────┘
                   │ start()
                   ▼
        ┌──────────────────────┐
        │      ACTIVE          │
        └──────────┬───────────┘
                   │
         ┌─────────┼─────────┐
         │         │         │
      pause()   error()   completed()
         │         │         │
         ▼         ▼         ▼
      PAUSED   FAILED   COMPLETED
         │         │
      resume()  retry()
         │         │
         └─────────┴──────────┐
                              │
                              ▼
                         ACTIVE (again)

Additional:
  CANCELLED ← cancel() from any state
  COMPLETE  ← all chunks assembled & downloaded
```

## Performance Optimization Path

```
CURRENT STATE (Before Fixes)
├─ Memory leak in speed window
├─ Unbounded chunk size
├─ Event listener accumulation
├─ Missing function (NaN progress)
├─ Unbounded active map
└─ Efficiency Score: 4/10

                    ⬇ CRITICAL FIXES (1-2 hours)

OPTIMIZED STATE (After Fixes)
├─ Capped speed window (100 entries max)
├─ Bounded chunk size (5-50 MB)
├─ Cleaned up event listeners
├─ Implemented missing function
├─ Cleanup downloads after completion
└─ Efficiency Score: 6/10

                    ⬇ RECOMMENDED OPTIMIZATIONS (50 minutes)

HIGHLY OPTIMIZED STATE
├─ Event-driven UI (vs polling+)
├─ DOM element caching
├─ Batch database writes
├─ Speed calculation smoothing
└─ Efficiency Score: 8/10

                    ⬇ PARALLELIZATION (Phase 2)

MAXIMUM PERFORMANCE STATE
├─ Web Workers (4-8 parallel streams)
├─ HTTP/2 multiplexing
├─ 3-4x speed improvement
├─ Constant <100MB memory
└─ Efficiency Score: 9/10
```

---

## Summary

- **Current:** Working download manager, Phase 1 complete
- **Issues:** 5 critical bugs documented with fixes
- **Optimization:** 50 min of recommended improvements
- **Testing:** Validation checklist provided
- **Future:** Web Workers for parallelization

**To get started:** Open `index.html` in your browser!
