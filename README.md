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
its engine payload in each backend package. Nothing is built from source, and
`npm ci` is the only staging step.

```jsonc
// package.json — the actual, current declarations
"dependencies": {
  "@runanywhere/electron":          "^0.20.21",
  "@runanywhere/electron-llamacpp": "^0.20.21",
  "@runanywhere/electron-onnx":     "^0.20.21",
  "@runanywhere/electron-qhexrt":   "^0.20.21",
  "@runanywhere/electron-sherpa":   "^0.20.21",
  "@runanywhere/proto-ts":          "^0.20.21"
}
```

### Which platform gets which engines

`0.20.21` is the first release carrying Windows natives, and the two Windows
lanes are mutually exclusive by construction — QAIRT ships no Hexagon stub for
x86_64, and neither ggml nor ONNX Runtime builds for win-arm64.

| platform-arch | engines that load |
|---|---|
| `darwin-arm64` | llamacpp, onnx, sherpa |
| `win32-x64` | llamacpp, onnx, sherpa |
| `win32-arm64` | qhexrt only (Hexagon NPU) |
| linux | none published yet |

Every backend package is declared unconditionally and that stays safe: a package
with no payload for the running platform records a path that does not exist, the
SDK's existence filter drops it from `RUNANYWHERE_PLUGIN_PATHS` before the
utility host is forked, and it never loads. So `@runanywhere/electron-qhexrt` is
inert on macOS and on Windows x64, and `-llamacpp` / `-onnx` / `-sherpa` are
inert on Windows ARM64. Only what a platform can actually run appears in
`capabilities().backends`.

`@runanywhere/electron-qhexrt` additionally bundles the QAIRT/QNN runtime the
Hexagon NPU loads (four DLLs, the v81 skel, and `libqnnhtpv81.cat`) flat in the
same directory, because Windows has no `ADSP_LIBRARY_PATH` and the loader
resolves the stub's dependencies through the DLL's own folder.

| Package | Role |
|---|---|
| `@runanywhere/electron` | Core SDK — main-process host, preload (`window.runanywhere`), native prebuilds |
| `@runanywhere/electron-llamacpp` | LlamaCPP backend — LLM, VLM |
| `@runanywhere/electron-onnx` | ONNX backend — embeddings, segmentation |
| `@runanywhere/electron-qhexrt` | QHexRT backend — Qualcomm Hexagon NPU, `win32-arm64` only (Snapdragon X / X2 Elite); inert elsewhere |
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
unpacks them by extension (`.node` / `.dylib` / `.dll` / `.so`) **and** by the whole
`@runanywhere/*/prebuilds/**` tree, so the core addon, each backend's plugin carrier
and QHexRT's `libqnnhtpv81.cat` are all covered — the catalog is not a loadable
image but the Hexagon skel beside it fails signature verification without it, and
that failure names a corrupt model rather than the packaging. They arrive with the
published packages, so `npm ci` is all the staging there is.

Publishing / code signing is not wired yet; local packages are unsigned.
