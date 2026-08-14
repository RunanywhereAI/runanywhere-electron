#!/usr/bin/env node
/**
 * use-sdk.mjs — switch the app between registry SDK natives and a local build.
 *
 *   npm run sdk:local     # overlay natives from a local runanywhere-sdks build
 *   npm run sdk:remote    # drop the overlay, back to what npm published
 *   npm run sdk:status    # report which natives are in place
 *
 * Only the NATIVE layer is switched. The TypeScript facade always comes from
 * the installed @runanywhere/* packages, because those are pure JS published in
 * lockstep with the natives — the thing worth validating locally is the binary.
 *
 * The published packages ship prebuilds/darwin-arm64 only, so on Windows and
 * Linux `sdk:remote` legitimately leaves the app with no natives at all. That
 * is the packaging gap, reported honestly rather than hidden.
 *
 * Layout mirrors the SDK's own resolver (@runanywhere/electron backend
 * plugin-registry): prebuilds/<platform>-<arch>/ holding runanywhere_native.node
 * plus rac_commons for core, and runanywhere_<id> + rac_backend_<id> +
 * rac_commons for each backend package.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE_MARKER = path.join(APP_ROOT, 'node_modules', '.ra-sdk-mode');

const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/**
 * Default CMake build tree; override with RA_SDK_BUILD.
 *
 * Windows has two mutually exclusive lanes and the arch decides which: x64
 * carries llamacpp/onnx/sherpa (QAIRT ships no Hexagon stub for x64), ARM64
 * carries QHexRT alone (ggml rejects MSVC for ARM, and ONNX Runtime has no
 * win-arm64 build).
 */
const DEFAULT_BUILD = path.resolve(
  APP_ROOT,
  '..',
  'runanywhere-sdks',
  'build',
  IS_WIN
    ? process.arch === 'arm64'
      ? 'electron-win-arm64'
      : 'electron-windows'
    : IS_MAC
      ? 'electron-macos'
      : 'electron-linux'
);
const BUILD_ROOT = process.env.RA_SDK_BUILD || DEFAULT_BUILD;
const SDKS_ROOT = process.env.RA_SDK_ROOT || path.resolve(BUILD_ROOT, '..', '..');

const BACKENDS = ['llamacpp', 'onnx', 'sherpa', 'qhexrt'];

/** npm package directory for a backend id, or core. */
function packageDir(id) {
  const name = id === 'core' ? 'electron' : `electron-${id}`;
  return path.join(APP_ROOT, 'node_modules', '@runanywhere', name);
}

function dynamicLibName(stem) {
  if (IS_WIN) return `${stem}.dll`;
  if (IS_MAC) return `lib${stem}.dylib`;
  return `lib${stem}.so`;
}

/** First existing candidate path, else null. Mirrors bundle-native's probing. */
function findFirst(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const MULTI_CONFIG = ['Release', '']; // VS generators nest under Release/

function inBuild(...segments) {
  return MULTI_CONFIG.map((config) =>
    path.join(BUILD_ROOT, ...segments.slice(0, -1), config, segments.at(-1))
  );
}

function addonPath() {
  return findFirst(inBuild('bindings', 'electron', 'native', 'runanywhere_native.node'));
}

function commonsPath() {
  return findFirst(inBuild('core', dynamicLibName('rac_commons')));
}

function enginePath(id, stem) {
  return findFirst(inBuild('engines', id, dynamicLibName(stem)));
}

/**
 * QAIRT runtime the Hexagon NPU needs beside the QHexRT plugin.
 *
 * All of it goes in ONE flat directory — there is no ADSP_LIBRARY_PATH on
 * Windows, so the loader finds the stub's dependencies through the DLL's own
 * folder. The `.cat` is mandatory: without it the skel fails signature
 * verification and the failure is opaque.
 */
function qnnRuntimeFiles() {
  const root = process.env.RA_QNN_SDK_ROOT || process.env.QNN_SDK_ROOT;
  if (!root || !fs.existsSync(root)) return [];
  const dspArch = process.env.RA_HEXAGON_ARCH || 'v81';
  const hostDir = path.join(root, 'lib', 'aarch64-windows-msvc');
  const skelDir = path.join(root, 'lib', `hexagon-${dspArch}`, 'unsigned');
  const wanted = [
    path.join(hostDir, 'QnnHtp.dll'),
    path.join(hostDir, 'QnnSystem.dll'),
    path.join(hostDir, 'QnnHtpPrepare.dll'),
    path.join(hostDir, `QnnHtp${dspArch.toUpperCase()}Stub.dll`),
    path.join(skelDir, `libQnnHtp${dspArch.toUpperCase()}Skel.so`),
    path.join(skelDir, `libqnnhtp${dspArch}.cat`),
  ];
  const missing = wanted.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    console.log(`  warn  QAIRT ${dspArch} incomplete, NPU will not run:`);
    for (const file of missing) console.log(`          missing ${file}`);
    return [];
  }
  return wanted;
}

/** Third-party runtime sidecars that must sit beside the loading image. */
function sidecarPaths() {
  const ort = findFirst([
    path.join(BUILD_ROOT, '_deps', 'onnxruntime-src', 'lib', dynamicLibName('onnxruntime')),
    path.join(SDKS_ROOT, 'core', 'third_party', 'sherpa-onnx-windows', 'lib', 'onnxruntime.dll'),
  ]);
  const ortProviders = findFirst([
    path.join(
      BUILD_ROOT,
      '_deps',
      'onnxruntime-src',
      'lib',
      dynamicLibName('onnxruntime_providers_shared')
    ),
  ]);
  const sherpaDir = path.join(SDKS_ROOT, 'core', 'third_party', 'sherpa-onnx-windows', 'lib');
  const sherpaCApi = findFirst([path.join(sherpaDir, dynamicLibName('sherpa-onnx-c-api'))]);
  return { ort, ortProviders, sherpaCApi };
}

/**
 * Files each package needs in prebuilds/<platform>-<arch>/.
 * A backend carrier resolves rac_backend_<id> and rac_commons from its own
 * directory, so both are staged beside it rather than shared.
 */
function stagingPlan() {
  const commons = commonsPath();
  const { ort, ortProviders, sherpaCApi } = sidecarPaths();
  const plan = new Map();

  // Only ship a third-party sidecar when the engine that needs it was actually
  // built. The sherpa/onnxruntime DLLs are vendored x64-only, so an ARM64 build
  // (QHexRT alone) would otherwise get x64 binaries dropped into its prebuild
  // directory — dead weight at best, a confusing load failure at worst.
  const builtOnnx = Boolean(enginePath('onnx', 'runanywhere_onnx'));
  const builtSherpa = Boolean(enginePath('sherpa', 'runanywhere_sherpa'));
  plan.set(
    'core',
    [
      addonPath(),
      commons,
      builtOnnx || builtSherpa ? ort : null,
      builtOnnx || builtSherpa ? ortProviders : null,
      builtSherpa ? sherpaCApi : null,
    ].filter(Boolean)
  );

  for (const id of BACKENDS) {
    const carrier = enginePath(id, `runanywhere_${id}`);
    if (!carrier) continue; // engine not built for this target — not an error
    const files = [carrier, enginePath(id, `rac_backend_${id}`), commons];
    if (id === 'onnx') files.push(ort, ortProviders);
    if (id === 'sherpa') files.push(sherpaCApi, ort, ortProviders);
    if (id === 'qhexrt') files.push(...qnnRuntimeFiles());
    plan.set(id, files.filter(Boolean));
  }
  return plan;
}

function targetDir(id) {
  return path.join(packageDir(id), 'prebuilds', PLATFORM_ARCH);
}

function applyLocal() {
  if (!fs.existsSync(BUILD_ROOT)) {
    throw new Error(
      `No SDK build tree at ${BUILD_ROOT}.\n` +
        'Build the natives first, or point RA_SDK_BUILD at an existing build directory.'
    );
  }
  const addon = addonPath();
  if (!addon) {
    throw new Error(
      `runanywhere_native.node not found under ${BUILD_ROOT}.\n` +
        'Build the `runanywhere_native` target before switching to local mode.'
    );
  }

  let staged = 0;
  for (const [id, files] of stagingPlan()) {
    const dir = packageDir(id);
    if (!fs.existsSync(dir)) {
      console.log(`  skip  ${id} — @runanywhere package not installed`);
      continue;
    }
    const out = targetDir(id);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const file of files) {
      fs.copyFileSync(file, path.join(out, path.basename(file)));
      staged += 1;
    }
    console.log(`  local ${id} <- ${files.length} file(s) in prebuilds/${PLATFORM_ARCH}`);
  }
  fs.writeFileSync(MODE_MARKER, `local\n${BUILD_ROOT}\n`, 'utf8');
  console.log(`\nlocal SDK natives staged (${staged} files) from ${BUILD_ROOT}`);
}

function applyRemote() {
  for (const id of ['core', ...BACKENDS]) {
    const out = targetDir(id);
    if (fs.existsSync(out)) {
      fs.rmSync(out, { recursive: true, force: true });
      console.log(`  remote ${id} — removed overlaid prebuilds/${PLATFORM_ARCH}`);
    }
  }
  fs.rmSync(MODE_MARKER, { force: true });
  console.log('\nremote mode: only the natives npm published remain');
}

function reportStatus() {
  const marker = fs.existsSync(MODE_MARKER)
    ? fs.readFileSync(MODE_MARKER, 'utf8').split('\n')[0]
    : 'remote';
  console.log(`mode: ${marker}   platform: ${PLATFORM_ARCH}`);
  for (const id of ['core', ...BACKENDS]) {
    const out = targetDir(id);
    const files = fs.existsSync(out) ? fs.readdirSync(out) : [];
    console.log(`  ${id.padEnd(9)} ${files.length ? files.join(', ') : '(none)'}`);
  }
}

const MODES = { local: applyLocal, remote: applyRemote, status: reportStatus };
const mode = process.argv[2];
const run = MODES[mode];
if (!run) {
  console.error(`usage: node scripts/use-sdk.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(2);
}
run();
