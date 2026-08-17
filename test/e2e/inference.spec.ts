/**
 * End-to-end inference gate.
 *
 * Launches the real app and drives the SDK the way the renderer does — through
 * `window.runanywhere`, over the RPC bridge into the utility host — so a pass
 * means the packaged native stack actually computed something on this machine.
 * Nothing here stubs a backend or asserts on a mock.
 *
 * Each modality is its own test and downloads the smallest catalog entry that
 * exercises it, so a missing engine fails one row instead of the whole file.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEURT_MODELS } from '../../src/shared/neurt-catalog';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Downloads dominate; inference itself is seconds. */
const DOWNLOAD_TIMEOUT = 15 * 60_000;

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // Deliberately NOT RA_E2E=1. That flag pins the SDK's base/secure dirs under
  // an isolated userData, which is right for the visual gate (it must never
  // discover a developer's models) but wrong here: this suite has to see the
  // real model store, and the NPU bundles cannot be re-downloaded because their
  // repos are private.
  // RA_PACKAGED_EXE runs the suite against a built installer's output instead of
  // the dev tree. Packaging is its own failure surface — asarUnpack decides
  // whether the QAIRT catalog reaches disk at all, and a missing
  // libqnnhtpv81.cat surfaces as an opaque model error, not a packaging one.
  //
  // Always say which binary is under test. The variable is read unconditionally,
  // so one left in a shell silently redirects the whole suite: a stale ARM64
  // packaged path made an x64 run report backends: ["QHEXRT"] and fail every
  // engine with "Backend initialization failed", which reads exactly like a
  // native regression rather than a mis-set environment.
  const packagedExe = process.env.RA_PACKAGED_EXE;
  // eslint-disable-next-line no-console
  console.log(
    packagedExe
      ? `launching PACKAGED app (RA_PACKAGED_EXE): ${packagedExe}`
      : `launching DEV tree: ${appRoot}`
  );

  // Fail on the real cause instead of a 60s timeout waiting for a window that
  // was never going to open. Electron resolves `main` from package.json, so a
  // tree that has not been built yet launches *something* and then hangs in
  // `waitForFunction`, which reads as a broken SDK rather than a missing build.
  // A fresh clone or a fresh `npm ci` both leave you here: neither produces out/.
  if (!packagedExe) {
    const mainEntry = path.join(appRoot, 'out', 'main', 'index.cjs');
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `${mainEntry} does not exist — the app has not been built.\n` +
          'Run `npm start` (or `npm run build`) before this suite. Nothing in ' +
          '`npm ci` produces out/; it only reinstalls node_modules.'
      );
    }
  }
  app = packagedExe
    ? await electron.launch({ executablePath: packagedExe, env: { ...process.env } })
    : await electron.launch({ args: [appRoot], env: { ...process.env } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.runanywhere !== undefined, null, { timeout: 60_000 });

  // Surface whatever the app logs while booting; a failed `initialize()` is
  // otherwise invisible from here and shows up much later as the misleading
  // "RunAnywhere not initialized" on the first real call.
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[renderer ${message.type()}] ${message.text()}`);
    }
  });

  // The renderer brings the SDK up behind the shell, so the facade exists long
  // before `initialize()` has resolved — and `models.list()` answers from the
  // preload-registered catalog even when it never resolved at all. Drive
  // initialization here instead of racing the app's boot, and treat an
  // already-initialized SDK as success.
  const init = await page.evaluate(async () => {
    try {
      await window.runanywhere.initialize(undefined, undefined, {});
      return 'initialized';
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return /already/i.test(text) ? 'initialized' : text;
    }
  });
  // eslint-disable-next-line no-console
  console.log('sdk init:', init);
  expect(init, 'SDK failed to initialize').toBe('initialized');

  // NeuRT models register by URL from the renderer's own boot(), AFTER its own
  // `initialize()` call resolves — a step this harness does not wait on above
  // (see the comment there: driving init here races the app's own boot(),
  // deliberately). Register them again here, synchronously, for the same
  // reason: `models.register` for an id already registered is a no-op, not an
  // error, so doing it twice is safe and makes the models available before any
  // test body runs rather than at some later, non-deterministic point.
  if (process.platform === 'darwin') {
    await page.evaluate(async (models) => {
      for (const model of models) {
        try {
          await window.runanywhere.models.register({
            id: model.id,
            name: model.name,
            url: model.url,
            category: model.category,
            framework: 'COREML',
          });
        } catch {
          // best-effort, matching main.ts's own registration loop
        }
      }
    }, NEURT_MODELS);
  }
});

test.afterAll(async () => {
  await app?.close();
});

/** Pull a catalog model and wait for the transfer to finish. */
async function download(id: string): Promise<void> {
  await page.evaluate(async (modelId) => {
    for await (const event of window.runanywhere.models.download(modelId)) {
      if (event.type === 'completed' || event.type === 'failed') break;
    }
  }, id);
}

test('the engines this platform ships are actually loaded', async () => {
  const caps = await page.evaluate(async () => window.runanywhere.capabilities());
  // eslint-disable-next-line no-console
  console.log('capabilities:', JSON.stringify(caps, null, 2));

  const unavailable = (caps.unavailable ?? []).filter((u) => u.name.startsWith('backend:'));
  expect(
    unavailable,
    `backends failed to load: ${unavailable.map((u) => `${u.name} (${u.reason})`).join('; ')}`,
  ).toEqual([]);
  expect(caps.backends.length).toBeGreaterThan(0);
});

test('llamacpp generates text', async () => {
  test.setTimeout(DOWNLOAD_TIMEOUT);
  await download('lfm2.5-230m');
  const result = await page.evaluate(async () => {
    await window.runanywhere.models.load('lfm2.5-230m');
    return window.runanywhere.llm.generate('Name one colour. Answer with one word.', {
      maxTokens: 24,
    });
  });
  // eslint-disable-next-line no-console
  console.log('llm result:', JSON.stringify(result));
  expect(result.text.trim().length).toBeGreaterThan(0);
});

test('onnx embeds text', async () => {
  test.setTimeout(DOWNLOAD_TIMEOUT);
  await download('minilm');
  const vectors = await page.evaluate(async () => {
    await window.runanywhere.models.load('minilm');
    const out = await window.runanywhere.embeddings.embed(['cat', 'kitten']);
    return out.map((e) => e.vector.length);
  });
  // eslint-disable-next-line no-console
  console.log('embedding dims:', vectors);
  expect(vectors[0]).toBeGreaterThan(0);
  expect(vectors[0]).toBe(vectors[1]);
});

test('sherpa synthesises speech', async () => {
  test.setTimeout(DOWNLOAD_TIMEOUT);
  await download('piper-amy');
  const spoken = await page.evaluate(async () => {
    await window.runanywhere.models.load('piper-amy');
    const out = await window.runanywhere.tts.synthesize('Hello from on device speech.');
    return { samples: out.data.length, sampleRate: out.sampleRate, durationMs: out.durationMs };
  });
  // eslint-disable-next-line no-console
  console.log('tts:', JSON.stringify(spoken));
  expect(spoken.samples).toBeGreaterThan(0);
  expect(spoken.durationMs).toBeGreaterThan(0);
});

/**
 * Hexagon NPU. ARM64-only by construction: QAIRT ships no `QnnHtpV*Stub.dll`
 * for x86_64, so an x64 process has no path to the DSP at all — this is skipped
 * rather than failed there.
 *
 * The bundle is registered from disk instead of the catalog because the NPU
 * repos are private; point RA_NPU_MODEL_DIR at a `v81/` directory.
 */
test('qhexrt generates text on the Hexagon NPU', async () => {
  test.skip(process.arch !== 'arm64', 'NPU requires an ARM64 host and ARM64 Electron');
  test.setTimeout(DOWNLOAD_TIMEOUT);
  // The NPU repos are private, so this row cannot auto-download. It is already
  // in the SDK's model store when the bundle was fetched out of band; refresh()
  // is what makes commons notice artifacts that arrived outside the SDK.
  const modelId = process.env.RA_NPU_MODEL_ID ?? 'lfm2.5-230m-npu';

  const present = await page.evaluate(async (id) => {
    await window.runanywhere.models.refresh();
    const info = await window.runanywhere.models.get(id);
    return info?.downloaded === true;
  }, modelId);
  test.skip(!present, `${modelId} is not in the model store; fetch the bundle first`);

  const result = await page.evaluate(async (id) => {
    await window.runanywhere.models.load(id);
    const out = await window.runanywhere.llm.generate('Name one colour. Answer with one word.', {
      maxTokens: 24,
    });
    return { text: out.text, model: out.model, tokensPerSecond: out.tokensPerSecond };
  }, modelId);

  // eslint-disable-next-line no-console
  console.log('npu result:', JSON.stringify(result));
  expect(result.text.trim().length).toBeGreaterThan(0);
});

/**
 * Apple Neural Engine, via NeuRT/Core ML. macOS-only by construction: there is
 * no ANE anywhere else, and `main.ts` only registers these rows on `darwin`.
 *
 * Unlike QHexRT's private NPU bundles, these repos are public, so the model
 * downloads through the normal catalog flow rather than requiring an
 * out-of-band placement.
 */
test('neurt generates text on the Apple Neural Engine', async () => {
  test.skip(process.platform !== 'darwin', 'NeuRT requires macOS');
  test.setTimeout(DOWNLOAD_TIMEOUT);
  const modelId = process.env.RA_ANE_MODEL_ID ?? 'lfm2.5-230m-ane';

  await page.evaluate(async (id) => {
    for await (const event of window.runanywhere.models.download(id)) {
      if (event.type === 'completed' || event.type === 'failed') break;
    }
  }, modelId);

  const result = await page.evaluate(async (id) => {
    await window.runanywhere.models.load(id);
    const out = await window.runanywhere.llm.generate('Name one colour. Answer with one word.', {
      maxTokens: 24,
    });
    return { text: out.text, model: out.model, tokensPerSecond: out.tokensPerSecond };
  }, modelId);

  // eslint-disable-next-line no-console
  console.log('ane result:', JSON.stringify(result));
  expect(result.text.trim().length).toBeGreaterThan(0);
});

test('sherpa transcribes speech', async () => {
  test.setTimeout(DOWNLOAD_TIMEOUT);
  await download('whisper-tiny');
  const text = await page.evaluate(async () => {
    // Transcribe what TTS just produced, so the audio is real speech rather than
    // synthetic noise — this exercises both sherpa paths against each other.
    await window.runanywhere.models.load('piper-amy');
    const spoken = await window.runanywhere.tts.synthesize('The quick brown fox.');
    await window.runanywhere.models.load('whisper-tiny');
    const result = await window.runanywhere.stt.transcribe(
      window.runanywhere.audio.float32(spoken.data, spoken.sampleRate),
    );
    return result.text;
  });
  // eslint-disable-next-line no-console
  console.log('stt:', text);
  expect(text.trim().length).toBeGreaterThan(0);
});
