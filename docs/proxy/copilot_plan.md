# Plan: Local-First Proxy Architecture for Melies Video Editor

## Recommendation: Specialized Local-First (Proxy + Native Player)
Given the constraint of **"Ready Fast"** + **"Mobile/iOS"** + **"Base44 Hosting"**, this plan outlines a specialized **Local-First** approach.

**Why?**
*   **Mobile Experience:** Uploading 200MB+ for a 60s clips is a UX killer on mobile networks. The "Upload & Wait" latency of the Server path is unacceptable for short-form video creators.
*   **Speed of Implementation:** Building a full "Game Engine" style renderer (WebCodecs → Canvas) is risky and time-consuming (audio sync is hard).
*   **The "Sweet Spot" Solution:** Use **OPFS for storage** (fixes crashes) + **Local Proxies** (fixes scrubbing lag) + **Standard `<video>` Tag** (production-ready features).

**Core Concept:**
Instead of rewriting the rendering engine, we modify the **Data Pipeline**. We will use WebCodecs *only* to generate a lightweight "Proxy" (540p/720p) locally. We then feed this small, safe file to your existing `<video>` player logic.

---

## Implementation Roadmap

### 1. Refactor Storage (`src/mediaCache.ts`)
*   **Goal:** Stop crashing iOS by loading 1GB files into RAM Blobs.
*   **Action:** Implement `FileSystemSyncAccessHandle` (OPFS) for the "Original" file.
*   **Changes:**
    *   Replace `preloadToBlobUrl()` memory logic.
    *   On file selection, stream the `File` object directly to an OPFS file handle (e.g., `/projects/video_1_original.mp4`).

### 2. Implement Proxy Worker (`src/workers/proxyWorker.ts`)
*   **Goal:** Create a "Scrubbable" version of the video locally.
*   **Action:** Create a Web Worker that uses `VideoDecoder` (read from OPFS) and `VideoEncoder` (write to OPFS).
*   **Logic:**
    *   Downscale 1080p/4K → 540p (Mobile optimized).
    *   Enforce frequent Keyframes (GOP = 30) for smooth seeking.
    *   Output file: `/projects/video_1_proxy.mp4` (~30MB for 1 min).

### 3. Update Player Source (`src/videoControl.ts`)
*   **Goal:** Feed the lightweight proxy to the player.
*   **Action:**
    *   Update `CustomActionData` to accept `proxySrc` alongside `src`.
    *   In `attachPrimary`/`preload`, load the **Proxy Blob** (small enough for RAM) into the `<video>` tag.
    *   The main `<video>` tag now plays the 540p butter-smooth version.

### 4. Handling "Export" (Base44 Context)
*   **Goal:** High Quality Output.
*   **Action:** Keep the existing server-side flow, but upload the **Original** from OPFS only when the user clicks "Export", or lazily in the background while they edit.

---

## Architecture Comparison

| Feature | Local-First (Recommended) | Hybrid-Server |
| :--- | :--- | :--- |
| **Start Time** | **< 5 seconds**. Edit immediately while proxy builds. | **> 30-60 seconds**. Dependent on upload speed + queue. |
| **Mobile Memory** | **Safe**. 4K file stays on Disk (OPFS). Only 540p blob in RAM. | **Safe**. App only handles the downloaded proxy. |
| **Cost** | **Free**. Uses user's phone CPU. | **High**. Requires GPU servers for acceptable speeds. |
| **Effort** | **Medium**. Requires writing the OPFS/WebCodecs worker. | **Low**. Standard API logic, if server exists. |

**Verdict:** Go **Local-First with Proxies**. It aligns perfectly with the "1080p / 1-2 min" constraint (modern phones handle this transcoding in seconds) and avoids the poor UX of waiting for uploads.
