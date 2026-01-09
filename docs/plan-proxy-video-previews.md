## Plan: Video Proxy Architecture with OPFS

We will implement a system that intercepts video loading to generate and cache "proxies" (low-res versions) in the browser's persistent storage (OPFS). This trades initial loading time for guaranteed smooth editing.

### Steps
1.  **Configure Environment**: Update [vite.config.ts](vite.config.ts) to add `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (required for high-performance FFmpeg types).
2.  **Add Transcoding Engine**: Install `@ffmpeg/ffmpeg` and `@ffmpeg/util` to enable client-side video processing.
3.  **Create Services**:
    *   `services/opfs.ts`: Handle saving/retrieving files from the persistent Origin Private File System.
    *   `services/transcoder.ts`: specific logic to convert 1080p+ Video -> 540p Proxy (preserving audio).
    *   `services/proxyManager.ts`: Coordinates the "Check OPFS -> If missing, Transcode -> Update Cache" workflow.
4.  **Implement `AssetLoader` UI**: Create a blocking/overlay component that runs on app initialization. It will:
    *   Iterate through the `FOOTAGE_BIN`.
    *   Show a progress UI ("Optimizing assets 1/5...").
    *   Map the *original* source URLs in `mediaCache` to the local OPFS proxy URLs.
5.  **Integrate**: Wrap the main editor content in [src/App.tsx](src/App.tsx) with the `AssetLoader` to ensure no heavy assets are loaded before optimization is complete.

### Further Considerations
1.  **Audio Sync**: We will transcode with audio included (`-c:a aac`). This ensures the "clip" stays a single synced unit in the timeline, simplifying drag-and-drop.
2.  **Fallback**: If FFmpeg fails (e.g. browser incompatibility), the `proxyManager` will catch the error and map the URL to the original source file so the app remains usable.
3.  **Storage**: We will not implement auto-clearing logic (as requested), but files in OPFS are persistent. Browsers manage this quota well, but we should be mindful of it eventually.
