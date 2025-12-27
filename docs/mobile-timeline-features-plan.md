---
title: Mobile Timeline Features Plan
---

# Mobile-first timeline editing: delete, split, undo/redo

This document describes the intended UX and a concrete implementation approach for adding three features to the timeline editor built on `@xzdarcy/react-timeline-editor`:

1. **Delete selected clip** via a trash icon next to the preview speed dropdown.
2. **Undo / Redo** with an in-memory history of the last **N** timeline changes (default **5**, controlled by a constant).
3. **Split selected clip** at the current **cursor/playhead** time via a split icon next to the trash icon.

Confirmed UX decisions (from chat):
- After split, **keep the left segment selected**.
- If the user triggers an edit while playing, **pause before applying the edit**.
- Undo/redo should store **clean editor data only** (no selection flags).
- The selected clip must be **visually distinct**.
- Icons are already available under `public/`: `bin.png`, `split.png`, `undo.png`, `redo.png`.

---

## Relevant library APIs

We’ll use these `Timeline` callbacks/props (see `docs/context.md`):
- Selection: `onClickActionOnly(e, { action, row, time })` (tap/click selects a clip).
- Drag/resize gesture boundaries:
  - Move: `onActionMoveStart`, `onActionMoveEnd`
  - Resize: `onActionResizeStart`, `onActionResizeEnd`
- Timeline data updates: `onChange(editorData)`

We’ll use the `TimelineState` ref API for cursor time:
- `timelineState.current?.getTime()`
- Playback control: `timelineState.current?.pause()`

---

## Current integration points in this repo

- `src/App.tsx`
  - Owns the canonical `editorData: TimelineRow[]` state.
  - Passes `editorData` into `<Timeline editorData={...} />`.
  - Handles `<Timeline onChange={...} />`.
  - Holds the `TimelineState` ref.

- `src/player.tsx`
  - Renders the **toolbar above the timeline**.
  - Contains the **preview speed dropdown**.
  - Best place to add:
    - Trash + Split icons next to speed dropdown.
    - Undo + Redo buttons on the toolbar.

---

## Data model and state design

### Canonical timeline data (“clean”)

- Keep the source of truth as **clean** `TimelineRow[]`:
  - Do **not** store `row.selected` or `action.selected` in this canonical state.
  - This prevents selection taps from polluting undo/redo history.

### Selection state

Maintain selection separately:
- `selectedActionId: string | null`

When rendering the `Timeline`, derive a view model:
- `editorDataWithSelection = markSelected(editorData, selectedActionId)`
  - Adds `action.selected = true` for the selected action only.
  - Keeps all other actions unselected.

This gives a visually distinct selected clip without changing the canonical state.

---

## Feature 1: Delete selected clip

### UX
- Tap a clip → it becomes **selected** (visually distinct).
- Trash icon near the preview speed dropdown becomes **enabled**.
- Tap trash → delete selected clip from the timeline.
- After deletion, selection is cleared.

### Implementation approach
- In `App.tsx`, implement a pure transform:

```
function deleteSelectedAction(
  editorData: TimelineRow[],
  selectedActionId: string
): TimelineRow[]
```

Behavior:
- Remove the matching action from whichever row it exists in.
- If not found, return unchanged `editorData`.

Before applying deletion:
- If playing: `timelineState.current?.pause()`.

After applying deletion:
- `setSelectedActionId(null)`.

---

## Feature 2: Undo / Redo (history of last N changes)

### Requirements
- Store last **N** timeline changes in memory. (Default N=5.)
- Undo/Redo buttons on the toolbar.
- History is based on **timeline content edits** only:
  - Drag/move
  - Resize/trim
  - Delete
  - Split
  - (Any future add/insert operations)
- Selection changes should **not** create history steps.

### Proposed history model

In `App.tsx`:
- `const MAX_HISTORY = 5` (constant)
- `past: TimelineRow[][]` (stack; older → newer)
- `future: TimelineRow[][]` (stack)
- `pendingBeforeRef: TimelineRow[] | null` (snapshot captured on gesture start)
- `isApplyingHistoryRef: boolean` (prevents re-recording history during undo/redo)

Use deep copies for snapshots to avoid shared references:
- `structuredClone(editorData)` if available (preferred)
- otherwise a safe deep clone fallback

### When to push history

**Button-based edits** (delete/split):
- Push *one* snapshot just before applying the change.

**Drag/resize edits** (to avoid dozens of entries):
- On `onActionMoveStart` / `onActionResizeStart`:
  - capture `pendingBeforeRef = clone(editorData)`
- On `onActionMoveEnd` / `onActionResizeEnd`:
  - if `pendingBeforeRef` exists and the data actually changed:
    - push it into `past` (cap to `MAX_HISTORY`)
    - clear `future`
  - clear `pendingBeforeRef`

### Undo
- If `past` empty: noop
- Pause if playing
- Move current snapshot to `future`
- Pop from `past` and set as current `editorData`
- Preserve cursor time:
  - `const t = timelineState.current?.getTime()` before applying
  - after restore: `timelineState.current?.setTime(t)` (optional but recommended)

### Redo
- Mirror undo using `future` → `past`.

---

## Feature 3: Split selected clip at cursor

### UX
- Select a clip.
- Split icon near speed dropdown becomes enabled.
- Tap split → the selected clip becomes **two clips** split at the cursor/playhead.
- Keep the **left** split segment selected.

### Preconditions
- A clip is selected.
- Cursor time `t` satisfies:
  - `action.start < t < action.end`
  - (If equal to edges, split is a no-op to avoid zero-length clips.)

### Implementation approach

In `App.tsx`, implement:

```
function splitSelectedActionAtTime(
  editorData: TimelineRow[],
  selectedActionId: string,
  time: number
): { editorData: TimelineRow[]; leftActionId: string } | null
```

Implementation notes:
- Find the selected action and its row.
- Create two actions:
  - Left keeps original `id` (to preserve selection):
    - `start = old.start`
    - `end = time`
  - Right gets a new unique id:
    - `start = time`
    - `end = old.end`
- Preserve other fields (`effectId`, `movable`, `flexible`, etc.).
- Replace the original action with `[left, right]` and keep actions sorted by `start`.

Before applying split:
- If playing: `timelineState.current?.pause()`.

After applying split:
- `selectedActionId` remains the left segment id (original).

---

## Visual distinctness for selected clip

The library supports `action.selected` and `row.selected` fields.

Approach:
- Compute `editorDataWithSelection` before rendering the Timeline.
- Add `selected: true` only to the selected action.
- Keep canonical `editorData` clean.

If existing CSS already styles `.selected`, reuse it.
Otherwise, apply a minimal style within the current design system (no new colors/tokens unless already present).

---

## Toolbar wiring (icons + enabling/disabling)

- In `player.tsx` toolbar:
  - Add `Undo` and `Redo` buttons.
  - Add Trash (`/bin.png`) and Split (`/split.png`) next to the preview speed dropdown.

Enable/disable rules:
- Trash enabled if `selectedActionId != null`.
- Split enabled if `selectedActionId != null` and cursor is strictly inside selected clip.
- Undo enabled if `past.length > 0`.
- Redo enabled if `future.length > 0`.

---

## Acceptance criteria

1. Tap a clip → clip highlights as selected.
2. Trash icon is disabled with no selection; enabled with selection.
3. Tap trash → clip is removed; selection clears; playback pauses if it was playing.
4. Split icon enabled only when cursor is inside selected clip.
5. Tap split → clip becomes two adjacent clips; left remains selected; playback pauses if it was playing.
6. Undo reverts the last structural timeline edit (drag/resize/delete/split), up to N steps.
7. Redo reapplies reverted edits.
8. Selection changes do not affect undo/redo history.

---

## Suggested implementation order

1. Add `selectedActionId` and render-time selection highlighting.
2. Add trash + split icons in toolbar and plumb handlers.
3. Implement delete + split transforms and pause-on-edit.
4. Add undo/redo stacks (button-driven edits first).
5. Add gesture-based history capture using move/resize start/end callbacks.

### Code Standards (must follow)
1. Clean, simple, easy to understand
2. Explicit variable names
3. Prefer consts/configs over hardcoded values where reuse makes sense
4. Functions have docstrings; add comments where logic is not trivial
5. Shared helpers instead of duplication
6. Split long functions/components where it improves readability