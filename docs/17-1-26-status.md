# 17-1-26 Status: OPFS + Proxy Plan vs Current Implementation

Date: 2026-01-17

This document captures the current state of the Melies Video Editor codebase relative to the “Local-First Proxy Architecture” idea in docs/proxy/copilot_plan.md.

The goal is to be accurate and usable as prompt context: it only describes what exists in the repo today, and explicitly avoids claiming any proxy/WebCodecs features that are not implemented.

---

## Where we started (the intended direction)

### Before adding any OPFS support (baseline)

Before any OPFS-related work existed in this repo (see the older snapshot in melies-video-editor-bak-28-12-25/):

- There was no OPFS code path (no navigator.storage.getDirectory usage, no src/dev OPFS helpers).
- The editor UI was driven by in-app demo data (mock timeline data + a built-in footage bin), rather than a host providing OPFS-backed files.
- Playback/caching relied on blob URLs and in-memory preloading:
  - The app used URL.createObjectURL for blob playback in the player path.
  - The cache helper preloaded media via fetch → response.blob() → URL.createObjectURL(blob).

This baseline explains why iOS/mobile memory pressure was a concern: the main mechanism to “make scrubbing smoother” was still to copy media into memory as Blobs.

We drafted a plan to improve mobile performance and iOS stability by:

- Storing large original media on disk using OPFS (to avoid large in-memory Blob URLs).
- Generating a lightweight, seek-friendly “proxy” video locally (e.g., 540p/720p) and playing that in the existing <video> tag.
- Uploading originals only for export.

That plan is written as a proposal in docs/proxy/copilot_plan.md.

---

## Current status (what is implemented now)

### 1) The editor runtime still uses Blob URLs + in-memory preloading

- When footage is provided as File objects, the editor converts each File to a blob URL via URL.createObjectURL(file) and uses that as the clip src.
- The media cache includes a “preloadToBlobUrl” helper that fetches a URL and converts it into a Blob + blob URL (an in-memory copy).

This means the production pipeline today is still primarily “blob URLs + optional preload-to-blob,” not “OPFS-backed originals.”

### 2) A dev-only OPFS flow exists (OPFS → File[])

There is a development harness that demonstrates OPFS usage:

- It checks OPFS availability via navigator.storage.getDirectory (secure context required).
- It writes uploaded/sample files into OPFS (using fileHandle.createWritable()).
- It reads those OPFS files back out as File objects and passes them into the editor as footageFiles.

Important: this is a development flow (in src/dev/), not a general-purpose runtime storage layer used by src/mediaCache.ts.

### 3) The player supports choosing a “preview” source, not “proxy”

- Timeline/video playback selects previewSrc if present, otherwise src.
- This is a general mechanism for “use an alternate source for playback,” but it is currently just a field in action data.
- There is no automatic generation of previewSrc from an original file.

### 4) Export is server-side FFmpeg and expects assets to be uploaded

- The Base44/Deno export handler expects multipart/form-data with a timeline payload plus uploaded assets.
- Assets are mapped by src strings (the client must upload the actual file bytes).

There is no “read originals from OPFS at export time” implemented in this repo (OPFS is browser-side storage).

---

## What OPFS integration the editor can handle today (practical guidance)

Even though the editor does not manage OPFS internally yet, it is already structured to accept media from an OPFS-aware host app.

### Supported inputs (public editor API)

The editor component accepts footage via these props:

- footageUrls?: string[]
  - Direct URLs (including blob: URLs).

- footageFiles?: File[]
  - Local Files. This is the easiest integration path for OPFS today: the host reads File objects from OPFS handles (handle.getFile()) and passes them in.

- footageFileHandles?: Array<{ getFile: () => Promise<File>; name?: string }>
  - Handle-like objects that can yield Files asynchronously. This supports FileSystemFileHandle-like objects without hard-coding DOM lib types.

### Recommended integration pattern today (host app owns OPFS)

If the host application (e.g., Base44 shell) wants OPFS storage today, the clean approach is:

1) Host writes/keeps originals in OPFS.
2) Host passes footageFiles (or footageFileHandles) into the editor.
3) The editor uses those Files by creating blob URLs for playback.

This does not eliminate in-memory blob URL usage inside the editor, but it does allow the host to persist originals in OPFS and reload them later without relying on network URLs.

### Notes about OPFS availability

- OPFS (navigator.storage.getDirectory) generally requires a secure context (HTTPS).
- Some mobile browsers may not support OPFS or may have runtime restrictions.
- The dev harness already includes a “fallback to direct File[]” behavior when OPFS is unavailable.

---

## Explicitly NOT implemented (avoid assuming these in future prompts)

The following items from the proxy plan are not present in the codebase today:

- A proxy generation worker (no src/workers/proxyWorker.ts).
- WebCodecs-based decode/encode pipeline (no VideoDecoder/VideoEncoder implementation).
- FileSystemSyncAccessHandle-based OPFS I/O.
- A runtime storage refactor where originals stay on OPFS and the player loads only small proxy blobs.
- A proxySrc field wired through CustomActionData and videoControl.

---

## Summary

- OPFS support exists as a dev-oriented utility and demonstration flow.
- The editor component is already “OPFS-friendly” in the sense that it can accept Files or handle-like objects produced by an OPFS-aware host.
- The core “Local-First Proxy + native <video> playback” pipeline (proxy generation + runtime proxy playback) has not been implemented yet.
