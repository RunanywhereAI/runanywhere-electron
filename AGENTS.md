# AGENTS.md

RunAnywhere AI, the Electron desktop app, built on the published
`@runanywhere/electron` SDK. `CLAUDE.md` is a symlink to this file.

This repo is standalone. It consumes the SDK from the npm registry and has no
checkout of, or path into, the `RunanywhereAI/runanywhere-sdks` monorepo. Where a
rule below cites a monorepo path, read it as "in the `runanywhere-sdks` repo",
not as a directory you will find here. Since the 0.20.17 restructure that repo's
layout is `core/`, `bindings/`, `rcli/`, `idl/`, `engines/`, `runtimes/`. The
consumer apps for iOS, Android, and Web live in their own repositories
(`runanywhere-ios`, `runanywhere-android`, `runanywhere-web`).

Everything runs on-device: chat, reasoning, retrieval over your own documents,
voice, and vision. No prompt, document, or audio leaves the machine.

## The two rules that govern this app

### 1. TypeScript only, strictly typed

Every authored file is TypeScript: main process, preload, renderer, shared
modules, build config, tests. There is no JavaScript in `src/`. The conventions
match the Electron SDK itself (`bindings/electron/AGENTS.md` in the monorepo) and
the Web SDK, so one habit set covers all three.

- `strict: true` in all three tsconfigs (main, preload, renderer), never weakened
  per-file.
- No `any`. `@typescript-eslint/no-explicit-any` is an error. Use `unknown` and
  narrow.
- No `@ts-ignore` or `@ts-expect-error` to silence a real error, and no non-null
  `!` to paper over a maybe. Narrow it, or handle the absence.
- No raw JSON assumptions. Anything read from disk, IPC, or the network is
  decoded into a declared type first. The IPC contract lives in exactly one
  place, `src/shared/ipc-contract.ts`, and both sides import it, so a channel
  cannot drift between main and renderer.
- `consistent-type-imports`, `no-floating-promises`, `no-misused-promises`,
  unused vars are errors (`^_` to opt out), and `no-console` (use the app logger,
  which routes to a main-side file log).
- Proto types are the source of truth. Model categories, error codes, stream
  event shapes, audio formats, voice events all come from the SDK's re-exported
  generated types. Never hand-write an enum or string union the IDL defines.
- Discriminated unions for state, `readonly` for anything the caller must not
  mutate, `as const` for literal tables, exhaustive `switch` with a `never`
  fallthrough.
- The renderer may not import `electron`. Enforced by `no-restricted-imports`.
  Everything the renderer needs arrives through the typed `window.runanywhere`
  and `window.appStore` bridges.

Output format differs by target even though the source language does not. Main
and preload emit CommonJS (Electron loads them that way), the renderer emits an
ESM bundle, and the model catalog additionally emits a CommonJS file on disk
because the SDK's utility host `require()`s it by path.

```bash
npm run typecheck   # all three projects
npm run lint        # --max-warnings 0
npm run build       # production bundle
npm test            # vitest, test/unit/** only
```

`npm run selftest` and `npm run test:e2e` are the heavier gates. See the README.

### 2. Almost no logic lives here

Per the monorepo's root `AGENTS.md`, logic belongs at the lowest layer that can
serve all consumers:

```text
C++ commons  ->  owns ALL AI logic (inference, lifecycle, registry, download, RAG, routing)
     SDK     ->  thin bridge: platform I/O, process plumbing, typed API
   this app  ->  UI rendering, navigation, copy, thin SDK calls.  That is all.
```

Swift is the canonical reference. When behaviour is ambiguous, read the
`runanywhere-ios` app and copy its logic exactly, adapting syntax only. This app
should be visually and functionally indistinguishable from that app's macOS
target.

If you find yourself writing any of the following, stop. It is a bug one layer
down:

- a multi-step bootstrap sequence before a feature works
- a hardcoded model id, framework, or filesystem path pattern
- post-processing of model output
- a workaround for an SDK or commons defect
- a re-implementation of something the SDK already does privately
- a hand-maintained copy of an SDK-internal mapping

Fix it in the SDK, or in commons if it is cross-platform, so every SDK benefits.
That means the fix lands in the `runanywhere-sdks` monorepo and reaches this app
as a published version bump, not as a patch here.

What legitimately belongs here: the model catalog table (every platform app owns
its own, which is what lets two apps ship different model lists against one SDK
build), copy strings and prompt suggestions, the local JSON store for
conversations and settings, the demo tool implementations, cosine similarity in
the embeddings demo, and pure presentation helpers like the segmentation mask
painter.

## Design parity is a gate

Tokens were transcribed from the Swift design system (the macOS branch of every
`#if os(macOS)` in `runanywhere-ios`) into `src/renderer/design/tokens.css`,
which is the one theme file here. No component invents a value.

Two things are easy to get wrong:

1. Use the Swift cool blue-ink neutrals (`#FBFAF8`, `#0C0E17`, `#131620`,
   `#10182B`), which match the shared design guideline
   (`docs/DESIGN_GUIDELINE.md` §2 in the monorepo). The Web app ships warm
   neutrals that appear in neither the guideline nor the Swift app. Do not copy
   them.
2. Use the macOS column wherever iOS and macOS differ. Composer radius is 16,
   not the iOS 28; `hitTarget` is 28, not 44.

Parity is checked two ways. Side-by-side screenshot comparison against the Swift
app is a human review step, done when chrome changes. There is deliberately no
committed pixel baseline: a `toHaveScreenshot` diff is a function of the machine
that produced it, this suite has no canonical runner, and the app ships on both
macOS and Windows. What `test/e2e/screens.spec.ts` and `test/e2e/shell.spec.ts`
assert instead is everything portable: tokens and motion resolved from computed
styles against the Motion table, sidebar scoping per destination, and
`prefers-reduced-motion` producing a 150 ms crossfade rather than a 0 ms blink,
with ambient loops stopped.

`test/e2e/inference.spec.ts` is the other half. It runs a real model per modality
through `window.runanywhere`, and with `RA_PACKAGED_EXE` it runs against a built
installer instead of the dev tree, which is the only way packaging faults surface
as packaging faults.

## Architecture

Three processes. Inference never runs in main or renderer.

```text
MAIN (CJS)                      forks
  ├─ window, menu, security, theme, store, .env, native resolution
  ├─ SDK bootstrap ──────────────────────►  UTILITY HOST ── native addon ── C++ commons
  └─ brokers a MessagePort main never reads
        │
     RENDERER (ESM bundle)  ── preload (CJS) ──►  window.runanywhere / window.appStore
```

Streaming: an `AsyncIterable` cannot cross `contextBridge`. Streams arrive on a
per-request channel and a renderer-side adapter re-exposes an `AsyncIterable`
whose `return()` sends a cancel, which keeps `iterator.return?.()` working as the
Stop button at every call site.

Packaged builds: the paths `register()` computes point inside `app.asar`, where
Electron's fs shim makes them look real to JavaScript while the OS loader sees
nothing. `src/main/paths.ts` rewrites the addon path and every plugin path to
`app.asar.unpacked` before use.

## Non-negotiables

- `app.setName('RunAnywhere AI')` before any `app.getPath('userData')`.
- The catalog is registered before the SDK preload is required. Registration is
  per-process.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (the
  preload requires SDK modules).
- All four security handlers: permission allowlist (`media` and `audioCapture`
  only), `setWindowOpenHandler`, `will-navigate`, `will-attach-webview`.
- The menu is replaced, not hidden. Hiding it leaves DevTools accelerators live
  in a shipped build. On macOS `{ role: 'appMenu' }` must be first, or there is
  no Cmd-Q, About, or Preferences.
- Test IPC channels are registered only under `RA_SELFTEST=1`. One of them calls
  `app.exit`.
- Store writes stay atomic (temp file, `fsync`, rename) and an unparseable file
  is copied aside rather than discarded. Conversations are capped at 200.
- Settings saves merge, never replace. Per-modality model choices live in the
  same object.
- `webUtils.getPathForFile` is the only `File` to path route. Electron removed
  `File.path`.
- CSP forbids `eval` and `new Function`, which is why the demo calculator has a
  hand-written arithmetic parser.
- Leaving Voice or Diarization closes the microphone.
- One generation, one RAG query, one VAD window at a time.
- Model residency is the SDK's decision. Never reintroduce an app-side unload
  policy.
- Errors surfaced to the user come from the SDK's typed `SDKException` and its
  `ErrorCode`. Do not collapse a native failure into a plain string.

## Production release requirements

A production package needs a real org-scoped API key and backend base URL — the same pair
used by `runanywhere-ios`'s `RunAnywhereLocalSecrets.plist`, `runanywhere-android`'s
`local.properties`, and `runanywhere-web`'s Vercel production env. Set them in the
gitignored `.env` (`RUNANYWHERE_API_KEY` / `RUNANYWHERE_BASE_URL`); ask a maintainer for
current production credentials. Never hardcode them in any committed file.

A production package must build against the published `@runanywhere/electron*` npm
packages only — this repo has a local-vs-npm dev switch for iterating against an unreleased
SDK build; before packaging a release, confirm it is set to the npm lane and clear any
local SDK overlay/cache so the build genuinely pulls from the registry, not a local build.

Headless e2e passing is not sufficient. Actually launch the packaged app (not just
`npm run build` output) on macOS as a real smoke test before calling it release-ready.
Windows must be validated on a real Windows machine/VM — there is no way to run or test
the Windows target on macOS; run the same dev-tree test pass, NPU benchmark, and a
packaged-`.exe` smoke test there for whatever SDK version is current. `mac.identity` and
the Windows `certificateFile`/`certificateSubjectName`
are currently unset (null) in `electron-builder.yml` — packages today are unsigned and
unnotarized; Gatekeeper and SmartScreen will warn until real Apple Developer ID +
notarization and a Windows Authenticode cert are supplied and wired in.

## Windows

macOS parity is the design target; Windows is a shipping target and must not
regress. Windows engines ship and load at SDK 0.20.22. The `.cmd` launchers
(which clear `ELECTRON_RUN_AS_NODE`), `%APPDATA%` paths, DPAPI secure storage,
the GPU opt-in (`--gpu` / `RA_GPU=1`, never the silent default), and the `.ico`
icon all stay.

Windows has two mutually exclusive lanes: x64 carries llamacpp, onnx and sherpa;
arm64 carries QHexRT alone, with no CPU engine behind it. Anything that assumes
a CPU fallback is wrong on ARM64.

Platform-specific copy must be platform-conditional. Never show "Windows DPAPI"
or a `.cmd` filename on macOS.

**This app ships for Windows only.** Developing and testing on macOS (dev tree,
`npm run build`, headless e2e) is normal and expected — macOS parity is still the
design target for UI/UX — but there is no macOS production package for this app:
do not sign, notarize, or distribute a `.dmg` built from this repo. The Mac
desktop release is `runanywhere-ios`'s native macOS target instead (see that
repo's AGENTS.md); package and ship it from there. A real Windows production
build/test pass needs an actual Windows machine — ask a maintainer for access to
the project's Windows test host rather than assuming a local VM.

## Windows NPU release lessons (v0.20.29 through v0.20.31 — read before shipping a new SDK bump)

**Every QHexRT model except the Bonsai/Maple ternary decoder (`qwen3.8-27b-1bit-npu`) can
pass a full packaged-app smoke test and still ship a broken app.** A fresh v0.20.29
Windows ARM64 package (no local overlay, clean `npm ci` against the published
`@runanywhere/electron-qhexrt`) loaded that model fine and then failed every generation
with `qhx_generate(stream) failed: HostOpFailed` — a bare error with no further detail
even at max native log verbosity. `lfm2.5-230m-npu` (a standard QNN HTP model) worked
correctly in the *same build*, which is what made this look like a full regression sweep
had passed when it hadn't.

Root cause (first of two — see below): the Bonsai/Maple decoder resolves its FastRPC skel
(`librun_main_on_hexagon_skel.so`) through `ADSP_LIBRARY_PATH` on Windows — a real,
load-bearing search-path mechanism, not just an Android convention. `bridge.ts`'s
`addSidecarDirToDllSearch` already extended `PATH` for every registered plugin directory
(the standard QNN HTP graph load path) but never extended `ADSP_LIBRARY_PATH` the same
way, so it was silently unset on every real end-user launch. Fixed in
`runanywhere-sdks#803` (`addSidecarDirToDspSearchPath`, called from the same place
`addSidecarDirToDllSearch` already runs).

**Why this slipped through:** the 2026-08-19 Bonsai bring-up validation launched the app
via a script that manually set `ADSP_LIBRARY_PATH` to an external dev-staged skel
directory before starting Electron — that env var happened to mask the gap for every
interactive test run. A real user downloading the packaged installer had no such override
and would hit `HostOpFailed` on their very first message with this model.

**#803 alone was NOT enough — the SAME `HostOpFailed` recurred in the v0.20.30 release
that shipped it.** Live device tracing on a Snapdragon X2 Elite confirmed
`ADSP_LIBRARY_PATH` was in fact correctly populated at the moment of failure this time (a
debug print patched into the packaged app's `bridge.js` showed the right directory first
in the search list), which ruled out the first bug as the remaining cause. A QAIRT-version
mismatch between the shipped host DLLs and this device's on-device HTP skel was also found
and independently confirmed real, but fixing it alone (swapping in a matching QAIRT
version) did **not** fix the failure either — a second red herring. The actual second bug
was in the SDK's native layer, not this repo: `qhexrt::qnn::Backend::profile()` (called to
pick the `v75`/`v79`/`v81` manifest directory, before the manifest is even parsed) shared
its device query with the code path that opens a real QNN HTP device — so the ternary
decoder's `host_only` manifest, which has zero QNN graphs and was designed to never touch
that device at all, paid for one anyway, and that live device then contended with the
decoder's own direct FastRPC session for the same Hexagon cDSP. Fixed in `neurun` v0.20.31
(`Backend::profile()` now uses a separate, device-handle-free query) plus a complementary
`runanywhere-sdks#810`. See that repo's `qhexrt-profile-must-not-create-live-device` KB
finding for the full trace.

**A THIRD, RCLI-specific cause of this same error signature existed too** (fixed in
`RunanywhereAI/RCLI`#45: its build script only staged `*.dll` next to `rcli.exe`, never the
skel's `.so`/`.cat`) — this app's own `bindings/electron/scripts/bundle-native.ts` already
staged those correctly, so it did NOT affect Electron, but it is why the SDK fix alone did
not immediately resolve the identical error on RCLI during verification. If this exact
`HostOpFailed` signature ever reappears here despite both SDK fixes being current, do not
assume it is a re-run of either known cause — check what actually differs about this app's
own packaging first.

**How to apply:** whenever this app bumps to a new SDK version that touches the QHexRT
binding or the Bonsai/ternary decode path, do not trust a smoke test that only exercises
a standard NPU model (e.g. `lfm2.5-230m-npu`), and do not trust a fix for one previously-
found cause of `HostOpFailed` without re-running the ternary model — this exact error
string has now had two unrelated root causes. Run the ternary model specifically, from a
**freshly packaged, freshly installed** build with **no manually exported environment
variables** — that is the only way to catch a packaging or native-runtime gap like these.
Bonsai TTFT is minutes long (measured ~6-9 min on Snapdragon X2 Elite), so budget real time
for this check rather than bailing out early.
