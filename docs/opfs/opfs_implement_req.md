Implement OPFS-backed local media caching for MeliesVideoEditor in our Base44 app.

Context (Melies constraints — do not assume beyond this)

We import the editor as import { MeliesVideoEditor } from "melies-video-editor";
The editor supports footageUrls?: string[], footageFiles?: File[], and footageFileHandles?: Array<{ getFile: () => Promise<File>; name?: string }>
When given footageFiles, the editor immediately converts each File to a blob: URL via URL.createObjectURL(file) and uses that for playback (App.tsx:286-317).
When given footageFileHandles, the editor eagerly calls getFile() for every handle and then creates blob URLs (App.tsx:320-366).
The editor’s mediaCache will fetch(src) for non-blob: URLs (mediaCache.ts:36-85), so if we keep passing cloud URLs, we remain network-bound during playback/scrubbing.
There is an existing OPFS dev harness pattern we can mirror: OPFS supported? → write files to OPFS → list handles → getFile() → pass File[] (opfs.ts, DevRoot.tsx).
Goal

Keep our current “upload immediately to cloud” behavior.
Additionally cache each uploaded asset locally in OPFS, and for editing prefer OPFS-backed Files (so playback is local, eliminating network seek lag).
Persist project state (“save and reopen later”) in Base44 Movie entity, including a media manifest that maps storyboard takes to OPFS/local cache + cloud.
Non-goals (for this implementation slice)

No proxy generation, no WebCodecs pipeline, no special streaming from OPFS (Melies still uses blob URLs).
No multi-device syncing of OPFS (per-device cache is fine).
Deliverables
1) New module: OPFS storage helper (JavaScript)
Create `src/lib/opfsStorage.js` with a small, robust API.

Important: Base44 environment is JS-only (no TypeScript). Do not use TS syntax, TS types, or `.ts` files.
Use JSDoc comments for clarity and editor autocomplete, and use duck-typing for OPFS handles.

isOpfsSupported(): { supported: boolean, reason?: string }
check `navigator.storage.getDirectory` and `isSecureContext`
getAppRootDir(): Promise<DirectoryHandle>
root dir name constant: "melies-media" (or similar)
ensureDir(pathParts: string[]): Promise<DirectoryHandle>
writeFile(dirParts: string[], fileName: string, blob: Blob): Promise<void>
use `createWritable()`, `write()`, `close()`
readFile(dirParts: string[], fileName: string): Promise<File | null>
return null on NotFound
listFiles(dirParts: string[]): Promise<FileHandle[]>
iterate directory entries with duck-typing (`values()` OR `entries()`), do NOT rely on TS DOM types
removeFile(dirParts: string[], fileName: string): Promise<void>
clearDir(dirParts: string[]): Promise<void>

Where `DirectoryHandle` and `FileHandle` are conceptual (JSDoc-only), not TS types.
Keep it similar in spirit to the proven dev helper in opfs.ts.

2) Movie schema change: media manifest
Update Movie entity schema to add mediaLibrary:

Each item should include:

assetId: string (UUID)
originalName: string
mimeType: string
size: number
createdAt: string
cloudUrl?: string (public URL or Base44 file_uri)
opfsFileName?: string (e.g. ${assetId}.${ext})
status: "local_only" | "cloud_only" | "synced" | "downloading" | "uploading" | "error" | "missing"
Also add a simple feature flag:

movie.settings?.enableOpfsCache?: boolean (default true)
or a global env/config flag if that’s the Base44 pattern.
3) New module: media library orchestrator
Create `src/lib/mediaLibraryStore.js`:

Core functions (JS-only; JSDoc ok):

addMediaAsset({ movieId, file, shouldUploadToCloud }): Promise<MediaAsset>
Generate assetId
Derive opfsFileName
If OPFS supported + enabled: write file to OPFS under ["movies", movieId]
Upload to cloud immediately (existing Base44 flow) and store cloudUrl/file_uri
Append asset entry into Movie.mediaLibrary and persist
resolveAssetToFile({ movieId, asset }): Promise<File | null>
If OPFS supported + enabled and opfsFileName exists, try readFile()
If missing locally but has cloudUrl/file_uri, treat as cache miss and **rehydrate**:
- download from signed/public URL
- write to OPFS under the same dirParts/opfsFileName
- then return the OPFS File (editing should be local-first)
If OPFS unavailable, return null (we’ll fall back separately)
getSignedOrPublicUrl(cloudUrlOrFileUri: string): Promise<string>
If it’s a Base44 private file_uri, call signing API; else return as-is
getEditorFootageFiles(movieId): Promise<File[]>
Primary path: prefer OPFS Files
Fallback path (OPFS unsupported): fetch from signed/public URLs, build File objects (network-bound but consistent API to Melies)
Use bounded concurrency (e.g. 3) to avoid freezing iOS Safari
Return File[] in stable order (storyboard order or mediaLibrary order)
Important: base compatibility/migration.

Today storyboard references are in Movie.storyboard[i].selected_take_url (could be HTTP URL or Base44 file_uri).
We must not break old movies.
Implement a take reference resolver that can handle:
selected_take_url is a URL/file_uri → look up/create a mediaLibrary entry keyed by that source
optionally support “assetId stored in selected_take_url” if we choose that migration
Recommended: add a new field `selected_take_asset_id` instead of overloading `selected_take_url`, unless Base44 strongly prefers otherwise.
4) Update FilmingManager: on capture/upload, also cache locally
In the component that handles new take uploads:

After user captures/selects a file:
Call addMediaAsset(movieId, file, true)
Update the storyboard shot to reference the new asset:
Prefer selected_take_asset_id = asset.assetId
Keep selected_take_url as the cloud URL/file_uri for backwards compatibility and for recovery
5) Update EditingSuite: feed Melies with footageFiles, not footageUrls
In EditingSuite:

Load editor footage via getEditorFootageFiles(movie.id)
Pass into editor:
<MeliesVideoEditor autoPlaceFootage={true} footageFiles={editorFiles} />
Add UI states:
Loading: “Preparing media for editing…”
OPFS unsupported (iOS Safari or insecure context): “Offline cache unavailable; using cloud media.”
Partial availability: show progress (“12/24 cached locally”), allow editing to start once first N files are ready.
6) Runtime behavior requirements (UX / responsiveness)
Prefer OPFS Files for playback whenever possible (this is the main responsiveness win).
Do not block the UI on caching all assets:
Load minimal set first (e.g., only assets referenced by storyboard), then optionally hydrate the rest.
Use bounded concurrency for network fetch + OPFS writes to reduce iOS Safari memory spikes.
Handle and persist status transitions in Movie.mediaLibrary (downloading, synced, error, etc.).
Acceptance criteria
Existing movies still open (even if they only have selected_take_url URLs and no mediaLibrary).
After first open, assets get cached to OPFS (where supported) and subsequent opens use OPFS without re-downloading.
EditingSuite feeds Melies via footageFiles (local-first). Network is only used when OPFS is unavailable or the local file is missing.
Upload-immediately behavior remains intact (no waiting until export), but OPFS caching can be disabled via a flag.
Works on iOS Safari with graceful fallback when OPFS is unavailable/restricted.
Implementation order (do these steps)
Add `opfsStorage.js`
Add mediaLibrary to Movie schema + minimal migration logic scaffolding
Implement `mediaLibraryStore.js` with addMediaAsset() and getEditorFootageFiles()
Wire FilmingManager to create manifest entries + OPFS cache at upload time
Wire EditingSuite to load footageFiles and show progress/fallback UI
Add lightweight logging + error handling for OPFS quota/permission issues