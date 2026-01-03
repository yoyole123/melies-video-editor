# Video Editor GUI (React)

This repo builds and publishes a reusable React video timeline editor GUI.

**Upstream credit:** The timeline editor UI and data model are built on top of **@xzdarcy/react-timeline-editor** (MIT License) by **zdarcy**.
- NPM: https://www.npmjs.com/package/@xzdarcy/react-timeline-editor
- License: MIT (see the upstream package for the full text)

This project is not affiliated with the upstream author.

## Local development

- Start the UI (demo app): `pnpm dev`

### Dev host wrapper (simulate embedding)

By default, `pnpm dev` runs the standalone editor view.

To run the dev host wrapper app (header/sidebar + editor), set:

- `VITE_DEV_HOST_APP=1`

Example (PowerShell):

- `$env:VITE_DEV_HOST_APP = "1"; pnpm dev`

Or create a `.env.local` file in the repo root:

- `VITE_DEV_HOST_APP=1`

## Build (library)

- Build the npm package output into `dist/`: `pnpm build`

## Export server (local-only)

This repo also contains a simple Express + ffmpeg export server used for local development.

- Start the export server (separate terminal): `pnpm dev:server`

Notes:
- Requires `ffmpeg` available on `PATH` (or set `FFMPEG_PATH`).
- Vite dev server proxies `/export` to `http://localhost:5174` (see `vite.config.ts`).
- The `server/` folder is **not** included in the published npm package.
