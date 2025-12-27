## Plan: Mobile Timeline + UX Polish

Make timeline interactions work on mobile by replacing HTML5 drag-and-drop with Pointer Events, tuning touch/scroll behavior via `touch-action`, and enlarging hit targets for trim/drag. Then improve responsiveness and clarity with drag “ghost” previews, drop highlighting, snapping feedback, and by disabling text selection/tap highlights on the timeline to prevent accidental highlighting while editing.

### Steps
1. Audit current interactions in [src/App.tsx](src/App.tsx) and styling in [src/index.less](src/index.less); list all drag/trim entry points and CSS selectors involved.
2. Replace external “footage → timeline” HTML5 DnD in [src/App.tsx](src/App.tsx) with Pointer Events (capture pointer, track move, compute drop time, insert action).
3. Add mobile gesture CSS: apply `touch-action` and `user-select` rules to timeline/handles in [src/index.less](src/index.less) to prevent scroll conflicts and text highlighting.
4. Improve touch ergonomics: increase effective grab areas for trim handles/cursor via CSS overrides in [src/index.less](src/index.less) (keep visuals consistent, enlarge hitboxes).
5. Add responsive drag feedback: implement a floating “ghost” + insertion caret line + drop-target highlight in [src/App.tsx](src/App.tsx) with minimal new state and class toggles.
6. Validate snapping/trim UX: ensure `react-timeline-editor` snap helpers are enabled/configured; if needed, plan a small fork/patch of [node_modules/@xzdarcy/react-timeline-editor/es](node_modules/@xzdarcy/react-timeline-editor/es) behavior (or vendor a copy) for enhanced snap feedback.

### Further Considerations
1. Mobile add behavior: should footage “drag into timeline” be required, or is “tap to add at playhead” acceptable for v1?
2. Gesture priority: should swipes inside the timeline scroll the timeline (pan), scroll the page, or be disabled during edits?
3. Library constraints: are you okay forking/patching `@xzdarcy/react-timeline-editor` if app-level hooks aren’t enough for the UX you want?
