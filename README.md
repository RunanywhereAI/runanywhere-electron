# RunAnywhere AI

An Electron desktop app for macOS and Windows, built on `@runanywhere/electron`.
Chat, reasoning, retrieval over your own documents, voice, and vision all run
on-device. No prompt, document, or audio is sent anywhere.

## How the SDK is installed

The SDK comes from the npm registry. There are no `file:` links and no path
aliases into an SDK checkout, so the app builds anywhere the folder is copied.
Each package carries its own native build at
`node_modules/@runanywhere/<pkg>/prebuilds/<platform>-<arch>/`: the core addon
plus shared commons in `@runanywhere/electron`, and a plugin carrier plus its
engine payload in each backend package. Nothing is compiled from source, so
`npm ci` is the whole staging step.

```jsonc
// package.json
"dependencies": {
  "@runanywhere/electron":          "^0.20.22",
  "@runanywhere/electron-llamacpp": "^0.20.22",
  "@runanywhere/electron-onnx":     "^0.20.22",
  "@runanywhere/electron-qhexrt":   "^0.20.22",
  "@runanywhere/electron-sherpa":   "^0.20.22",
  "@runanywhere/proto-ts":          "^0.20.22"
}
```

The resolved tree is pinned by the committed `package-lock.json`. Use `npm ci`
for a reproducible install. `npm install` is for deliberately moving a
dependency, and the regenerated lock file is committed with that change.

| Package | Role |
|---|---|
| `@runanywhere/electron` | Core SDK: main-process host, preload (`window.runanywhere`), the native addon |
| `@runanywhere/electron-llamacpp` | LlamaCPP backend (LLM, VLM) |
| `@runanywhere/electron-onnx` | ONNX backend (embeddings, segmentation) |
| `@runanywhere/electron-qhexrt` | QHexRT backend, Qualcomm Hexagon NPU on Snapdragon X |
| `@runanywhere/electron-sherpa` | Sherpa backend (STT, TTS, VAD) |
| `@runanywhere/proto-ts` | Generated protobuf types |

### Which platform gets which engines

| platform-arch | engines that load |
|---|---|
| `darwin-arm64` | llamacpp, onnx, sherpa |
| `win32-x64` | llamacpp, onnx, sherpa |
| `win32-arm64` | qhexrt only (Hexagon NPU) |
| linux | none published |

The two Windows lanes are mutually exclusive by construction: QAIRT ships no
Hexagon stub for x86_64, and neither ggml nor ONNX Runtime builds for
win-arm64. So the NPU is the only engine on an ARM64 Windows host, with no CPU
fallback behind it.

All four backend packages are declared unconditionally and that stays safe. A
package with no payload for the running platform records a path that does not
exist, and the SDK drops non-existent paths from `RUNANYWHERE_PLUGIN_PATHS`
before it forks the utility host. `@runanywhere/electron-qhexrt` is therefore
inert on macOS and on Windows x64, and llamacpp / onnx / sherpa are inert on
Windows ARM64. Only what a platform can run shows up in `capabilities().backends`.

`@runanywhere/electron-qhexrt` also bundles the QAIRT/QNN runtime the Hexagon
NPU loads (four DLLs, the v81 skel, and `libqnnhtpv81.cat`) flat in the same
directory. Windows has no `ADSP_LIBRARY_PATH`, so the loader resolves the stub's
dependencies through the DLL's own folder.

## Run it

```bash
git clone https://github.com/RunanywhereAI/runanywhere-electron.git
cd runanywhere-electron

npm ci             # pulls the SDK and its native prebuilds, exactly as locked
npm start          # build, then launch
npm run dev        # watch mode: vite dev server + electron
```

On Windows the two `.cmd` files in the repo root launch the built app from this
folder (they are what a desktop shortcut points at). They run `electron .`
directly, so `npm run build` has to have succeeded at least once first.

```bat
"RunAnywhere AI.cmd"
"RunAnywhere AI (GPU).cmd"
```

If the window never appears, check that `ELECTRON_RUN_AS_NODE` is not set. It
makes `electron.exe` run as plain Node. Both `.cmd` launchers clear it.

### Control-plane credentials

Optional. Copy `.env.example` to `.env` (gitignored) and fill in
`RUNANYWHERE_BASE_URL` and `RUNANYWHERE_API_KEY` to initialize the SDK in its
production environment, which sends org-scoped telemetry. With both blank the
SDK initializes keyless, in development. Either way, inference stays on the
machine. Real environment variables win over the file.

## Compute device

CPU. `npm run start:gpu` and the `--gpu` flag ask for a CUDA build of the addon
first (`prebuilds/<platform>-<arch>-cuda/`) and fall back to the CPU prebuild
when it is absent. The published packages ship no CUDA prebuild, so today that
fallback is what happens: `start:gpu` runs on CPU unless you supply a CUDA addon
yourself, through `npm run sdk:local` or `RUNANYWHERE_NATIVE_PATH`. The header
shows which device is actually in use.

## Verify

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` across the main, preload and renderer configs |
| `npm run lint` | ESLint over `src`, zero warnings tolerated |
| `npm test` | Vitest unit tests (`test/unit/**`) |
| `npm run build` | CJS main and preload, ESM renderer bundle, into `out/` |
| `npm run selftest` | Headless run of the real code paths, exits 0/1 |
| `npm run test:e2e` | Playwright drives the real Electron window |

`.github/workflows/ci.yml` runs the first four on `ubuntu-latest` with Node 24
for every push to `main` and every pull request, installing with `npm ci`
against the committed lock file.

The Playwright suites are deliberately not in CI. They launch the real Electron
binary with the native addon, which belongs on a local or self-hosted runner.
There are two of them:

- `shell.spec.ts` / `screens.spec.ts` assert the portable half of visual parity:
  design tokens and motion durations read back from computed styles, sidebar
  scoping per destination, streams surviving `contextBridge`, and reduced motion
  producing a 150 ms crossfade with ambient loops stopped. There are no
  screenshot baselines, because a pixel diff is a function of the machine that
  produced it and there is no canonical runner to produce one on. Side-by-side
  comparison against the macOS Swift app stays a human review step.
- `inference.spec.ts` downloads the smallest catalog entry per modality and runs
  it through `window.runanywhere`, so a pass means the native stack computed
  something on this machine. Set `RA_PACKAGED_EXE` to point it at a built
  installer's output instead of the dev tree, which is the only way to catch a
  packaging fault such as a missing `libqnnhtpv81.cat`.

### Switching the natives to a local SDK build

Only the native layer switches. The TypeScript facade always comes from the
installed packages.

```bash
npm run sdk:local    # overlay natives from a local runanywhere-sdks build tree
npm run sdk:remote   # restore the published payload
npm run sdk:status   # report which natives are in place
```

`RA_SDK_BUILD` overrides the build tree the overlay reads from.

## Layout

TypeScript only. Source under `src/`; the build emits CommonJS main and preload
plus an ESM renderer bundle under `out/`. `"main"` is `out/main/index.cjs`.

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron main: forks the utility host, resolves natives, owns the window and the local JSON store |
| `src/preload/` | Loads the SDK preload (`window.runanywhere`) and exposes `window.appStore` |
| `src/shared/model-catalog.ts` | This app's model table. Registered by the preload and, as an emitted CommonJS file, by the utility host (`catalogPath`), which is what makes a catalog id resolvable in both processes |
| `src/renderer/` | The UI: Vite entries (`index.html`, `settings.html`) and the feature views |
| `assets/` | The icons electron-builder ships (`icon.png`, `icon.ico`) |

Conversations and settings persist as JSON under `%APPDATA%\RunAnywhere AI\`, or
`~/Library/Application Support/RunAnywhere AI/` on macOS.

## Packaging

electron-builder config lives in `electron-builder.yml`.

| Platform | Targets |
| --- | --- |
| macOS | `dmg` and `zip`, arm64 |
| Windows | NSIS, x64 and arm64 |

```bash
npm run package        # host platform
npm run package:mac    # dmg + zip (arm64)
npm run package:win    # nsis (x64 + arm64)
```

Native artifacts cannot load from inside `app.asar`, so everything under
`node_modules/@runanywhere/*/prebuilds/` is `asarUnpack`ed. The config unpacks
both by extension (`.node`, `.dylib`, `.dll`, `.so`) and by the whole
`prebuilds/**` tree, which is what covers QHexRT's `libqnnhtpv81.cat`. The
catalog is not a loadable image, but the Hexagon skel beside it fails signature
verification without it, and that failure reads as a corrupt model rather than a
packaging fault.

Unpacking is only half of it. The paths `register()` computes point inside
`app.asar`, where Electron's fs shim makes them look real to JavaScript while the
OS loader sees nothing. `src/main/paths.ts` rewrites both the addon path and each
plugin path to `app.asar.unpacked` before they are used.

Publishing and code signing are not wired up. Local packages are unsigned.
