# RunAnywhere AI (Windows desktop)

The shipping desktop app built on `@runanywhere/electron`. Everything runs
**on-device** — chat, reasoning, your own knowledge base (RAG), voice, and vision.
No prompt, document, or audio leaves the machine.

This is the app we package and publish, built on the RunAnywhere Electron SDK
consumed straight from npm.

## Install the SDK

The SDK is consumed **entirely from the npm registry**. There are no `file:`
links and no path aliases into any SDK checkout, so the app builds standalone
anywhere the folder is copied. The native prebuilds ship inside the
`@runanywhere/electron` package (`node_modules/@runanywhere/electron/prebuilds/`) —
nothing is built from source, and `npm install` is the only staging step.

```jsonc
// package.json — the actual, current declarations
"dependencies": {
  "@runanywhere/electron":          "^0.20.15",
  "@runanywhere/electron-llamacpp": "^0.20.15",
  "@runanywhere/electron-onnx":     "^0.20.15",
  "@runanywhere/electron-sherpa":   "^0.20.15",
  "@runanywhere/proto-ts":          "^0.20.15"
}
```

| Package | Role |
|---|---|
| `@runanywhere/electron` | Core SDK — main-process host, preload (`window.runanywhere`), native prebuilds |
| `@runanywhere/electron-llamacpp` | LlamaCPP backend — LLM, VLM |
| `@runanywhere/electron-onnx` | ONNX backend — embeddings, segmentation |
| `@runanywhere/electron-sherpa` | Sherpa backend — STT, TTS, VAD |
| `@runanywhere/proto-ts` | Generated protobuf types |

> **Known-red build:** the four `@runanywhere/electron*` packages are not on npm
> at all yet, so `npm install` fails with `npm error code E404` on
> `@runanywhere/electron@^0.20.15`. `@runanywhere/proto-ts` does exist but tops
> out at `0.20.10`, so it will need 0.20.15 too. There is also **no
> `package-lock.json`** in this repo — the old one pinned monorepo `file:` paths
> and could not be regenerated before publish. Generate and commit one with
> `npm install` as soon as the packages land.

## Run it

```bash
git clone https://github.com/RunanywhereAI/runanywhere-electron.git
cd runanywhere-electron

npm install        # pulls the SDK + native prebuilds from npm
npm start          # build, then launch on CPU
npm run start:gpu  # launch with the CUDA prebuild (RA_GPU=1)
npm run dev        # watch mode: vite + electron
```

On Windows you can also double-click the **RunAnywhere AI** desktop shortcut, or
run the launchers in the repo root:

```bat
"RunAnywhere AI.cmd"
"RunAnywhere AI (GPU).cmd"
```

> If the window never appears, check that `ELECTRON_RUN_AS_NODE` isn't set — it makes
> `electron.exe` run as plain Node. The `.cmd` launcher clears it.

## Verify

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` across main, preload and renderer configs |
| `npm run lint` | ESLint over `src`, zero warnings tolerated |
| `npm run test` | Vitest unit tests (`test/unit/**`) |
| `npm run build` | CJS main + preload, ESM renderer bundle into `out/` |
| `npm run test:e2e` | Playwright drives the real Electron window (screenshot baselines) |

`.github/workflows/ci.yml` runs the first four on `ubuntu-latest` + Node 24 for
every push to `main` and every pull request. The Playwright e2e suite is
deliberately **not** in CI: it launches the real Electron binary with the ~43 MB
native addon and compares screenshot baselines, which belongs on a local or
self-hosted runner. CI installs with `npm install` rather than `npm ci` until a
`package-lock.json` exists (see above); the workflow comment says the same.

## Layout

TypeScript-only. Source under `src/`; build emits CommonJS main/preload and an ESM
renderer bundle under `out/`. `"main"` is `out/main/index.cjs`.

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron main: forks the utility host (native addon), owns the window + local JSON store |
| `src/preload/` | Loads the SDK preload (`window.runanywhere`) and exposes `window.appStore` |
| `src/shared/model-catalog.ts` | The app's model table. Staged into the SDK by preload and by the utility host (`catalogPath`), which is what makes a catalog id resolvable in both processes |
| `src/renderer/` | The UI — Vite entry (`index.html` / `settings.html`) + feature views |
| `assets/make-icon.ts` | Regenerates `assets/icon.ico` + `icon.png` — `npm run icon` |

Conversations, settings, and custom models persist as JSON under
`%APPDATA%\RunAnywhere AI\` (or `~/Library/Application Support/RunAnywhere AI/` on macOS).

## Compute device

CPU by default. The CUDA prebuild is used only when explicitly requested
(`--gpu` / `RA_GPU=1`) **and** present — loading it without an NVIDIA driver stack
fails, so it is never the silent default. The active device is shown in the header.

## Self-test

Runs the real code paths headlessly and exits 0/1:

```bat
set RA_SELFTEST=1 && npx electron .
```

## Packaging

electron-builder config lives in `electron-builder.yml`:

| Platform | Targets |
| --- | --- |
| macOS | `dmg` + `zip`, arm64 |
| Windows | NSIS, x64 + arm64 |

```bash
npm run package        # host platform
npm run package:mac    # dmg + zip (arm64)
npm run package:win    # nsis (x64 + arm64)
```

Native artifacts under `node_modules/@runanywhere/electron/prebuilds/` (and any
future `.node` / `.dylib` / `.dll` / `.so` / `plugins/`) are `asarUnpack`ed — they
cannot load from inside `app.asar`. They arrive with the published package, so
`npm install` is all the staging there is.

Publishing / code signing is not wired yet; local packages are unsigned.
