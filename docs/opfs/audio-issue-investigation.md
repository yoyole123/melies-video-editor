Problem Summary: When returning to edit an existing movie, video clips play correctly, but audio clips (even those associated with the playing video) are silent. Newly added clips in the same session play sound without issue.

Key Clues & Observations:

    EditingSuite.jsx is correctly updating Blob URLs: Our debug logs confirm that EditingSuite successfully extracts filenames from the timelineSnapshot and replaces old blob URLs with freshly generated ones from the fileBlobUrls map during restoration. This means the MeliesVideoEditor is receiving a initialTimelineSnapshot with valid, current blob: URLs for all media.
    allSnapshotMediaLoaded is true before editor renders: The [DEBUG_LOAD] logs show that allSnapshotMediaLoaded correctly becomes true after all media files referenced in the snapshot have had their blob URLs generated. This ensures the MeliesVideoEditor should be initialized with all media ready.
    Stale blob: URLs from previous session: When EditingSuite unmounts, it calls URL.revokeObjectURL() on all previously generated blob URLs. If the internal audioControl within melies-video-editor is holding onto references to these revoked URLs (even if EditingSuite provides fresh ones), it could explain the silence.
    Newly added clips work: This is critical. It implies that the mechanism melies-video-editor uses to process and play audio for newly added content works correctly, but the re-initialization path for restored content is flawed.
    audioControl singleton: The App.jsx in melies-video-editor imports audioControl as a singleton. This strongly suggests that audioControl might retain state between different mounted instances of the editor if not explicitly reset or re-initialized.

Hypothesis: The audioControl module within melies-video-editor is failing to properly re-initialize or reset its internal state (e.g., Web Audio API contexts, decoded buffers, source nodes) when a timeline is restored. It likely attempts to use stale or invalidated references, leading to silent playback for previously added tracks, while new tracks trigger a fresh and successful initialization path.

Research Questions for melies-video-editor's Internal Files (especially audioControl.js/.ts and App.js/.ts):

    State Management & Lifecycle:
        How does audioControl manage its internal state (e.g., AudioContext, AudioBufferSourceNodes, AudioBuffers)?
        Is there a clear reset() or dispose() method in audioControl that should be called when the editor (or EditingSuite) detects a complete re-initialization or unmount?
        When audioControl.setTimelineData() is called with an initialTimelineSnapshot, does it dispose of all previous audio sources and re-create them from scratch using the new URLs, or does it try to re-use existing ones?

    useLayoutEffect vs. useEffect in App.jsx:
        The useLayoutEffect for audioControl.setTimelineData runs synchronously after DOM mutations but before useEffect. Does audioControl's setTimelineData rely on any asynchronous operations (like media decoding or fetching) that might not be complete by the time useLayoutEffect fires?
        Could the issue be that audioControl tries to bind to the blob: URLs before mediaCache has fully processed them and made them available in a way that audioControl expects?

    Blob URL Handling & Revocation:
        Does audioControl keep its own cache of blob: URLs, or does it rely entirely on what's passed in the timeline data?
        Is there any scenario where audioControl might attempt to use a blob: URL that EditingSuite already called URL.revokeObjectURL() on, especially during a fast remount/restore cycle?

    Difference in "New" vs. "Restored" Clip Processing:
        Trace the code path for how a newly added clip (from footageBin) gets its audio processed and made playable by audioControl.
        Compare this to the code path for how an existing clip from initialTimelineSnapshot is processed. Are there any divergences that might explain the different behaviors? Specifically, does the "new clip" path trigger a more complete audio resource setup that the "restored clip" path misses?
