# RunAnywhere AI (Windows desktop)

The shipping desktop app built on `@runanywhere/electron`. Everything runs
**on-device** — chat, reasoning, your own knowledge base (RAG), voice, and vision.
No prompt, document, or audio leaves the machine.

This is the app we package and publish, built on the RunAnywhere Electron SDK
consumed straight from npm.

## Install the SDK

The SDK is consumed **entirely from the npm registry**. There are no `file:`
links and no path aliases into any SDK checkout, so the app builds standalone
anywhere the folder is copied. Every package that has a published native build
ships it inside itself
(`node_modules/@runanywhere/<pkg>/prebuilds/<platform>-<arch>/`): the core addon
plus shared commons in `@runanywhere/electron`, and one thin plugin carrier plus
its engine payload in each backend package. `@runanywhere/electron-qhexrt` is the
one exception and ships no `prebuilds/` directory at all, on any platform; see
the note under the dependency block. Nothing is built from source, and `npm ci`
is the only staging step.

```jsonc
// package.json — the actual, current declarations
"dependencies": {
  "@runanywhere/electron":          "^0.20.18",
  "@runanywhere/electron-llamacpp": "^0.20.18",
  "@runanywhere/electron-onnx":     "^0.20.18",
  "@runanywhere/electron-qhexrt":   "^0.20.17",
  "@runanywhere/electron-sherpa":   "^0.20.18",
  "@runanywhere/proto-ts":          "^0.20.18"
}
```

`@runanywhere/electron-qhexrt` stays a minor behind on purpose: 0.20.17 is its
latest published version, and it is npm-deprecated because no Hexagon NPU
prebuild exists for any platform yet. Its tarball is JS, types and metadata only
(7 files, no `prebuilds/`), so `QHexRT.register()` records a path that does not
exist, the SDK's existence filter drops it from `RUNANYWHERE_PLUGIN_PATHS` before
the utility host is forked, and it never loads. That is why it can be declared
unconditionally and still never appear in `capabilities().backends`.

| Package | Role |
|---|---|
| `@runanywhere/electron` | Core SDK — main-process host, preload (`window.runanywhere`), native prebuilds |
| `@runanywhere/electron-llamacpp` | LlamaCPP backend — LLM, VLM |
| `@runanywhere/electron-onnx` | ONNX backend — embeddings, segmentation |
| `@runanywhere/electron-qhexrt` | QHexRT backend — Qualcomm Hexagon NPU (ships no prebuild on any platform today, so it never loads) |
| `@runanywhere/electron-sherpa` | Sherpa backend — STT, TTS, VAD |
| `@runanywhere/proto-ts` | Generated protobuf types |

The resolved tree is pinned by the committed `package-lock.json`. Use `npm ci`
for a reproducible install; `npm install` is only for deliberately moving a
dependency, and the regenerated lock file is committed with that change.

## Run it

```bash
git clone https://github.com/RunanywhereAI/runanywhere-electron.git
cd runanywhere-electron

npm ci             # pulls the SDK + native prebuilds from npm, exactly as locked
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
| `npm run test:e2e` | Playwright drives the real Electron window |

`.github/workflows/ci.yml` runs the first four on `ubuntu-latest` + Node 24 for
every push to `main` and every pull request, installing with `npm ci` against the
committed lock file. The Playwright e2e suite is deliberately **not** in CI: it
launches the real Electron binary with the ~43 MB native addon, which belongs on
a local or self-hosted runner.

The e2e suite carries **no screenshot baselines**. A pixel diff is a function of
the machine that produced it — font antialiasing and GPU compositing move the
bytes — and there is no canonical runner to produce one on (the suite is off CI
by design, and the app ships on both macOS and Windows), so a committed baseline
would be red for most contributors and an uncommitted one is red on every fresh
clone and green on the re-run. What the suite asserts instead is the portable
half: design tokens and motion durations resolved from computed styles, one
selected destination per route, and the reduced-motion contract. Comparing
screenshots against the macOS Swift app stays a human review step when chrome
changes.

## Layout

TypeScript-only. Source under `src/`; build emits CommonJS main/preload and an ESM
renderer bundle under `out/`. `"main"` is `out/main/index.cjs`.

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron main: forks the utility host (native addon), owns the window + local JSON store |
| `src/preload/` | Loads the SDK preload (`window.runanywhere`) and exposes `window.appStore` |
| `src/shared/model-catalog.ts` | The app's model table. Staged into the SDK by preload and by the utility host (`catalogPath`), which is what makes a catalog id resolvable in both processes |
| `src/renderer/` | The UI — Vite entry (`index.html` / `settings.html`) + feature views |
| `assets/` | The app icons electron-builder ships (`icon.png`, `icon.ico`), committed as artifacts |

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

Native artifacts under every `node_modules/@runanywhere/*/prebuilds/` are
`asarUnpack`ed, because they cannot load from inside `app.asar`. `electron-builder.yml`
unpacks them by extension (`.node` / `.dylib` / `.dll` / `.so`), so the core addon
and each backend's plugin carrier are covered by the same rule rather than by a
per-package path. They arrive with the published packages, so `npm ci` is all the
staging there is.

Publishing / code signing is not wired yet; local packages are unsigned.
