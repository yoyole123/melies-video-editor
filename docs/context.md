# @xzdarcy/react-timeline-editor — condensed reference (v0.1.8)

This file is meant to be attached to future AI prompts so the assistant can quickly find the full API surface (props, callbacks, types, and engine APIs) and jump to the exact source docs/examples.

## Where the “truth” lives (TypeScript definitions)

If anything is unclear/underdocumented in the markdown docs, use the published `.d.ts` files:

- Public exports: `node_modules/@xzdarcy/react-timeline-editor/dist/index.d.ts`
- Timeline props + ref API: `node_modules/@xzdarcy/react-timeline-editor/dist/interface/timeline.d.ts`
- Data types: 
  - `node_modules/@xzdarcy/react-timeline-editor/dist/interface/action.d.ts`
  - `node_modules/@xzdarcy/react-timeline-editor/dist/interface/effect.d.ts`
- Engine API: `node_modules/@xzdarcy/react-timeline-editor/dist/engine/engine.d.ts`
- Engine event payloads: `node_modules/@xzdarcy/react-timeline-editor/dist/engine/events.d.ts`

## Package exports

From `dist/index.d.ts`:

- `Timeline` (React component)
- `TimelineEngine` (standalone runtime/“player”)
- Types re-exported from `dist/interface/timeline.d.ts`:
  - `TimelineEditor` (props interface for `Timeline`)
  - `TimelineState` (the `ref` API)
  - `TimelineRow`, `TimelineAction`, `TimelineEffect`, `TimeLineEffectSource`, etc.

## Core data model

### `TimelineRow`
Editor “rows” (tracks). See docs + types:
- Docs: `docs/data.md` (TimelineRow)
- Types: `dist/interface/action.d.ts`

Fields:
- `id: string` (required)
- `actions: TimelineAction[]` (required)
- `rowHeight?: number` (override global `rowHeight`)
- `selected?: boolean`
- `classNames?: string[]` (extra CSS classes for the row)

### `TimelineAction`
Editor “clips/actions” inside a row. See:
- Docs: `docs/data.md` (TimelineAction)
- Types: `dist/interface/action.d.ts`

Fields:
- `id: string` (required)
- `start: number` (required)
- `end: number` (required)
- `effectId: string` (required, key into `effects`)
- `selected?: boolean`
- `flexible?: boolean` (default true) — resizable or not
- `movable?: boolean` (default true) — draggable or not
- `disable?: boolean` (default false) — prevents running in engine
- `minStart?: number` (default 0) — clamp min start when moving/resizing
- `maxEnd?: number` (default `Number.MAX_VALUE`) — clamp max end

Examples:
- movable/flexible/minStart/maxEnd: `docs/editor-demo/editor-action-config/index.md` + `docs/editor-demo/editor-action-config/mock.ts`

### `TimelineEffect` and effect runtime hooks
`effects` is a map keyed by action `effectId`. See:
- Docs: `docs/data.md` (TimelineEffect, TimeLineEffectSource)
- Types: `dist/interface/effect.d.ts`

`TimelineEffect`:
- `id: string` (required)
- `name?: string`
- `source?: TimeLineEffectSource` (runtime callbacks)

`TimeLineEffectSource` callbacks (all optional):
- `start(param)` — when play starts while inside action time range
- `enter(param)` — when time enters action range from outside
- `update(param)` — every tick while active (also on `reRender()`)
- `leave(param)` — when time leaves action range
- `stop(param)` — when paused while inside action time range

`EffectSourceParam` includes:
- `time`, `isPlaying`, `action`, `effect`, `engine`

Engine examples with audio-like effects:
- `docs/engine/engine-basic/audioControl.ts`
- `docs/engine/engine-standalone/audioControl.ts`

## `Timeline` component (UI editor)

Docs entry points:
- `docs/README.md` (quick start)
- `docs/index.md` (overview)
- Demos: `docs/editor-demo/**`

### Required props
From `dist/interface/timeline.d.ts` (`EditData`):
- `editorData: TimelineRow[]`
- `effects: Record<string, TimelineEffect>`

### Timeline scale / layout props
From `EditData`:
- `scale?: number` (default `1`) — “time range per major tick”
- `minScaleCount?: number` (default `20`) — minimum number of major ticks
- `maxScaleCount?: number` (default `Infinity`) — maximum number of major ticks
- `scaleSplitCount?: number` (default `10`) — subdivisions per major tick
- `scaleWidth?: number` (default `160`) — px width of one major tick
- `startLeft?: number` (default `20`) — left padding before the first tick
- `rowHeight?: number` (default `32`) — default row height (px)

Examples:
- Scale customization: `docs/editor-demo/editor-scale-customization/index.md` + `docs/editor-demo/editor-scale-customization/index.tsx`
- Custom scale labels: `docs/editor-demo/editor-scale-customization/custom.tsx` (`getScaleRender`)

### Interaction toggles
From `EditData`:
- `gridSnap?: boolean` (default false) — snap movement/resizes to grid subdivisions
- `dragLine?: boolean` (default false) — auxiliary guide-line snapping
- `hideCursor?: boolean` (default false)
- `disableDrag?: boolean` (default false) — disables dragging actions globally

Examples:
- Grid snap: `docs/editor-demo/editor-grid-snap/index.md` + `docs/editor-demo/editor-grid-snap/index.tsx`
- Auxiliary line snap: `docs/editor-demo/editor-auxiliary-line-snap/index.md` + `docs/editor-demo/editor-auxiliary-line-snap/index.tsx`
- Disable editing: `docs/editor-demo/editor-basic/disable.tsx`
- Hide cursor: `docs/editor-demo/editor-basic/hideCursor.tsx`

### Rendering customization
- `getActionRender?: (action, row) => ReactNode`
  - Render a custom action block (e.g., custom visuals per `effectId`).
  - Examples: 
    - `docs/editor-demo/editor-custom-style/index.md` + `docs/editor-demo/editor-custom-style/index.tsx`
    - `docs/editor-demo/editor-action-config/index.tsx`
- `getScaleRender?: (scale: number) => ReactNode`
  - Render custom major tick labels.
  - Example: `docs/editor-demo/editor-scale-customization/custom.tsx`

### Action move/resize callbacks (dragging + trimming)
All are optional; returning `false` from the “moving/resizing” callbacks prevents that interaction.

Move:
- `onActionMoveStart?: ({ action, row }) => void`
- `onActionMoving?: ({ action, row, start, end }) => void | boolean`
- `onActionMoveEnd?: ({ action, row, start, end }) => void`

Resize:
- `onActionResizeStart?: ({ action, row, dir }) => void` where `dir` is `'right' | 'left'`
- `onActionResizing?: ({ action, row, start, end, dir }) => void | boolean`
- `onActionResizeEnd?: ({ action, row, start, end, dir }) => void`

Example (block right-side resize):
- `docs/editor-demo/editor-callback/index.md` + `docs/editor-demo/editor-callback/index.tsx`

### Click / gesture callbacks (rows + actions)
All optional:
- `onClickRow(e, { row, time })`
- `onClickAction(e, { action, row, time })`
- `onClickActionOnly(e, { action, row, time })` (does not fire if drag occurred)
- `onDoubleClickRow(e, { row, time })`
- `onDoubleClickAction(e, { action, row, time })`
- `onContextMenuRow(e, { row, time })`
- `onContextMenuAction(e, { action, row, time })`

Example (double-click row to add action):
- `docs/editor-demo/editor-basic-event/index.md` + `docs/editor-demo/editor-basic-event/index.tsx`

### Cursor interactions
- `onCursorDragStart?: (time: number) => void`
- `onCursorDrag?: (time: number) => void`
- `onCursorDragEnd?: (time: number) => void`

### Clicking time area
- `onClickTimeArea?: (time: number, e) => boolean | undefined`
  - Return `false` to block the editor from setting time.

### Drag-line “assist” selection
- `getAssistDragLineActionIds?: ({ action, editorData, row }) => string[]`
  - Choose which actions the guide-line snapping should consider.

### Editor-level props (scrolling, auto-scroll, re-render)
From `TimelineEditor`:
- `onScroll?: (params: OnScrollParams) => void` — observe virtualized scroll (for scroll-sync)
- `autoScroll?: boolean` (default false) — auto scroll when dragging near edges
- `autoReRender?: boolean` (default true) — automatically tick/update when time or data changes
- `style?: React.CSSProperties`
- `scrollTop?: number` (**deprecated**, use `ref.setScrollTop`) 
- `onChange?: (editorData: TimelineRow[]) => void | boolean`
  - Called after interactions update data.
  - If returns `false`, it blocks automatic engine sync (used as perf optimization).

Examples:
- Auto scroll: `docs/editor-demo/editor-auto-scroll/index.md` + `docs/editor-demo/editor-auto-scroll/index.tsx`
- Scroll sync: `docs/editor-demo/editor-scroll-sync/index.md` + `docs/editor-demo/editor-scroll-sync/index.tsx`

## `Timeline` ref API: `TimelineState`

Attach a ref: `ref={timelineState}` where `timelineState` is `useRef<TimelineState>()`.

See:
- Docs types: `docs/data.md` (TimelineState)
- TS types: `dist/interface/timeline.d.ts`
- Examples:
  - Scroll sync: `docs/editor-demo/editor-scroll-sync/index.tsx`
  - “Edit while running” player: `docs/engine/engine-basic/index.tsx` + `docs/engine/engine-basic/player.tsx`

Fields/methods:
- `target: HTMLElement`
- `listener: Emitter<EventTypes>` (engine events)
- `isPlaying: boolean`, `isPaused: boolean`
- `setTime(time)`, `getTime()`
- `setPlayRate(rate)`, `getPlayRate()`
- `reRender()`
- `play({ toTime?, autoEnd?, runActionIds? }) => boolean`
- `pause()`
- `setScrollLeft(val)`, `setScrollTop(val)`

Note: `TimelineState.play()` supports `runActionIds?: string[]` to run a subset of actions (this is a Timeline-only convenience; `TimelineEngine.play()` does not expose this option in the typings).

## Standalone runtime: `TimelineEngine`

Docs:
- Overview + examples: `docs/engine/index.md`
- API list + events: `docs/engine/api.md`
- Types: `dist/engine/engine.d.ts`, `dist/engine/events.d.ts`

### Engine state + core methods
- `isPlaying: boolean`
- `isPaused: boolean`
- `effects = Record<string, TimelineEffect>` (setter)
- `data = TimelineRow[]` (setter)
- `setPlayRate(rate: number) => boolean`
- `getPlayRate() => number`
- `setTime(time: number, isTick?: boolean) => boolean`
- `getTime() => number`
- `reRender() => void`
- `play({ toTime?, autoEnd? }) => boolean`
- `pause() => void`

### Engine events
Event payload types are in `dist/engine/events.d.ts` and are referenced in `docs/engine/api.md`.

Events:
- `beforeSetTime` (return `false` to block): `{ time, engine }`
- `afterSetTime`: `{ time, engine }`
- `setTimeByTick`: `{ time, engine }`
- `beforeSetPlayRate` (return `false` to block): `{ rate, engine }`
- `afterSetPlayRate`: `{ rate, engine }`
- `play`: `{ engine }`
- `paused`: `{ engine }`
- `ended`: `{ engine }`

Examples:
- Standalone engine wiring + listeners: `docs/engine/engine-standalone/index.tsx`
- Engine inside the editor (via `TimelineState`): `docs/engine/engine-basic/index.tsx`

## Quick “feature → where to look” map

- Basic editor + onChange: `docs/editor-demo/editor-basic/index.tsx`
- Disable dragging globally (`disableDrag`): `docs/editor-demo/editor-basic/disable.tsx`
- Hide cursor (`hideCursor`): `docs/editor-demo/editor-basic/hideCursor.tsx`
- Scale/ticks (`scale`, `scaleSplitCount`, `scaleWidth`, `startLeft`): `docs/editor-demo/editor-scale-customization/index.tsx`
- Custom tick labels (`getScaleRender`): `docs/editor-demo/editor-scale-customization/custom.tsx`
- Grid snapping (`gridSnap`): `docs/editor-demo/editor-grid-snap/index.tsx`
- Auxiliary snapping (`dragLine`): `docs/editor-demo/editor-auxiliary-line-snap/index.tsx`
- Auto-scroll on drag (`autoScroll`): `docs/editor-demo/editor-auto-scroll/index.tsx`
- Scroll sync (`onScroll` + `ref.setScrollTop`): `docs/editor-demo/editor-scroll-sync/index.tsx`
- Custom action rendering (`getActionRender`): `docs/editor-demo/editor-custom-style/index.tsx`
- Move/resize guards (`onActionResizing` returning false): `docs/editor-demo/editor-callback/index.tsx`
- Double-click row to add actions (`onDoubleClickRow`): `docs/editor-demo/editor-basic-event/index.tsx`
- Engine API + events: `docs/engine/api.md`
