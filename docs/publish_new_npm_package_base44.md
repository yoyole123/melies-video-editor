---
title: Publish this repo as a new NPM package + use in Base44
---

# Goal

Turn this repo into a publishable NPM package that ships **only the editor GUI** (the compiled `dist/` output), and then install it in a Base44 app.

This repo’s GUI is built on top of **@xzdarcy/react-timeline-editor** (MIT).

> Important: before publishing, confirm you are allowed to publish the code in this repo under your chosen license, and keep upstream attribution.

---

# What this repo already does (after the setup)

- `pnpm build` produces a library bundle in `dist/`:
  - `dist/index.js` (ESM)
  - `dist/index.cjs` (CJS)
  - `dist/index.d.ts` (types)
  - `dist/style.css` (styles)
- The published NPM tarball includes **only**:
  - `dist/`
  - `README.md`
  - `LICENSE`
- The `server/` folder is kept for local development, but **will not be published**.

---

# Steps you can ask me to do (automatable)

1. **Pick a final package name** and I’ll update `package.json` accordingly.
   - Example unscoped: `my-video-editor-gui`
   - Example scoped: `@your-org/my-video-editor-gui`

2. Add/adjust npm metadata fields (optional but recommended):
   - `repository`, `homepage`, `bugs`, `author`

3. Run verification commands and fix issues:
   - `pnpm install`
   - `pnpm build`
   - `npm pack --dry-run` (verify published files)

4. If you want the published API to be different (e.g. export a smaller component than the full app), tell me the desired public component API and I’ll refactor the export surface.

---

# Steps you must do manually (one-time / account actions)

## A) Prepare NPM account + access

1. Create an npm account: https://www.npmjs.com/signup
2. If using an org/scope, ensure you have publish access to that scope.
3. In a terminal on your machine, login:
   - `npm login`

## B) Choose publish visibility

- **Unscoped packages** are public by default.
- **Scoped packages** (e.g. `@your-org/name`) may require:
  - `npm publish --access public`

## C) Publish

From the repo root (this folder):

1. Ensure working tree is clean (recommended):
   - `git status`
2. Build:
   - `pnpm build`
3. Confirm package contents:
   - `npm pack --dry-run`
   - You should see `dist/**` but not `server/**`.
4. Publish:
   - `npm publish` (or `npm publish --access public` for scoped public)

## D) Verify on npmjs

- Open the package page on npm and confirm:
  - README shows correctly
  - Version is correct
  - No server files are included

---

# Base44: install + use the package

## 1) Install

In your Base44 app editor AI chat:

- Ask to install your package by name (the one you published)
- Approve the installation prompt

## 2) Import and use

In your Base44 React code:

- Import the component:
   - `import { MeliesVideoEditor } from "<your-package-name>";`
- Import styles:
  - `import "<your-package-name>/style.css";`

Then render:

- `<MeliesVideoEditor />`

## 3) Provide required static assets (icons)

This GUI references some icon files by absolute URL (e.g. `/bin.png`).

In your Base44 app, add these files to the app's public/static root so they resolve correctly:

- `bin.png`
- `split.png`
- `undo.png`
- `redo.png`
- `play-button.png`
- `pause-button.png`

You can copy them from this repo’s `public/` folder.

## 4) Ensure required peer deps exist

This package declares `react` and `react-dom` as peer dependencies.

- Most Base44 React apps already have them.
- If Base44 prompts you to add them explicitly, install the requested versions.

---

# Attribution checklist (recommended)

Before publishing:

- Keep the upstream credit in the root README.
- Verify `@xzdarcy/react-timeline-editor` is listed as a dependency.
- If you copied any upstream source into your package output, ensure you comply with MIT (include their copyright notice in the distributed copies).

---

# Troubleshooting

- If `npm publish` fails with “private”: ensure `package.json` does **not** contain `"private": true`.
- If consumers can’t see styling: ensure they import `"<pkg>/style.css"`.
- If Base44 bundling complains about missing deps: add the missing dependency to the Base44 app (Base44 should prompt for approval).
