Update our app to be “local-first” for user footage using OPFS, and integrate with the external melies-video-editor package using its new OPFS-friendly API.

Goal

Stop uploading raw footage to cloud storage by default.
Store footage bytes in OPFS.
Store only OPFS references/metadata in our Movie entity.
When entering the editor, pass local File[] via footageFiles (preferred), not streaming URLs.
Constraints

Do not modify the external melies-video-editor package internals in this app.
Maintain backward compatibility: existing movies that already reference cloud URLs should continue to work.
1) Implement OPFS storage module
Create src/opfs.ts (or equivalent) with:

isOpfsSupported(): boolean (check navigator.storage?.getDirectory)
getRootDir(): Promise<FileSystemDirectoryHandle> using await navigator.storage.getDirectory()
Directory layout: movies/<movieId>/footage/
Functions:

writeFootage(movieId: string, file: File): Promise<{ key: string; name: string; type: string; size: number }>
Create a unique filename/key (avoid collisions)
const dir = await ensureDir('movies/<movieId>/footage')
const handle = await dir.getFileHandle(key, { create: true })
const writable = await handle.createWritable(); await writable.write(file); await writable.close();
listFootageHandles(movieId): Promise<Array<{ key: string; name: string; handle: FileSystemFileHandle }>>
readFootageFiles(movieId): Promise<File[]> (loop handles → await handle.getFile())
Optional: deleteFootage(movieId, key)
2) Update “Import footage” flow (pre-edit)
Where we currently call Base44 upload (cloud):

Replace default behavior with OPFS write:
User selects files → for each file call writeFootage(movieId, file)
Persist references in Movie entity (NOT URLs):
Example: movie.footage = [{ key, name, type, size }]
Keep cloud upload only as fallback when OPFS is unsupported or fails, and mark those entries as cloud-based (e.g. movie.cloudFootageUrls or movie.footage[i].url).
3) Update playback/preview UI before editing
For previews (thumbnails, quick playback):

Resolve OPFS → File → set <video src={URL.createObjectURL(file)} />
Revoke URLs when done (URL.revokeObjectURL) to avoid leaks.
4) Update the editor screen integration (this is the key change)
When opening a movie for editing:

If the movie has OPFS footage references:
const footageFiles = await opfs.readFootageFiles(movieId)
Render:
<MeliesVideoEditor footageFiles={footageFiles} />
If the movie only has legacy cloud URLs:
Render:
<MeliesVideoEditor footageUrls={cloudUrls} />
If both exist, prefer OPFS (footageFiles) unless user explicitly chooses cloud.
5) UX + reliability
Show a small “Loading footage…” state while readFootageFiles() runs.
If OPFS fails at runtime, show an error and fall back to cloud URLs if available.
Do not load entire files into ArrayBuffers unnecessarily; pass File objects through.
Acceptance

New imports do not upload to cloud by default.
Refresh/reopen preserves footage (via OPFS keys).
The editor uses local OPFS-derived File[] via footageFiles.
Existing movies with cloud URLs still work via footageUrls.