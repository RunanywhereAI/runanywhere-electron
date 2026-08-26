/**
 * THIS APP's model table.
 *
 * The catalog lives here, not in the SDK. The SDK owns the entry SHAPE and the
 * lookup surface (`registerCatalog` / `isCatalogId` in its `catalog.ts`); the app
 * owns WHICH models it offers. Every other platform in this repo does the same —
 * iOS `ModelCatalogBootstrap.swift`, Android `ModelCatalog.kt`, web
 * `model-catalog.ts`, Flutter `model_catalog_bootstrap.dart`, RN
 * `ModelCatalogBootstrap.ts` — all in `examples/`, none in an SDK. That split is
 * what lets two apps ship different model lists against one SDK build.
 *
 * Registration is PER PROCESS, and this app has two processes that resolve
 * models: the renderer preload and the forked utility host. The host receives it
 * from the main process, so both see the same table.
 *
 * Rows are grouped BY FAMILY (matching the Swift catalog's organization), so a
 * family's chat model and its vision variant sit together.
 */

// TYPE-only, and it has to stay that way. This table is imported by the
// renderer, and a value import would pull real code into the browser bundle:
// `@runanywhere/electron`'s barrel drags the Node-flavoured SDK, and
// `@runanywhere/proto-ts/model_types` drags `@bufbuild/protobuf/wire`, which
// cannot even resolve here (proto-ts is a linked dependency, so resolution
// realpaths out of this app's node_modules). A `import type` is erased, and the
// literals below are still checked against the SDK's enum — a typo or a renamed
// engine is a compile error, not a silent bad row.
import type { InferenceFramework } from '@runanywhere/electron';

/** What a model is for. Drives which SDK namespace loads it. */
export type ModelType =
  | 'llm'
  | 'vlm'
  | 'embedder'
  | 'stt'
  | 'tts'
  | 'diarization'
  | 'segmentation';

/** One file a catalog entry needs on disk. */
export interface CatalogFile {
  readonly url: string;
  /** Filename to save as. `primary`/`mmproj` refer to these names. */
  readonly as: string;
}

export interface CatalogEntry {
  readonly type: ModelType;
  readonly files: readonly CatalogFile[];
  /** The file (or, for archives, the extracted directory) to load. */
  readonly primary: string;
  /** Vision projector filename, for VLM entries. */
  readonly mmproj?: string;
  /** The download is an archive that must be extracted. */
  readonly archive?: boolean;
  readonly label: string;
  readonly params?: string;
  readonly sizeMB: number;
  /** Wants more RAM than a small machine has; the UI badges it "heavy · CPU". */
  readonly heavy?: boolean;
  readonly license?: string;
  readonly licenseUrl?: string;
  /** Chat template family, when the model needs one commons cannot infer. */
  readonly chatTemplate?: string;
  /**
   * Pin the engine instead of inferring it from `type`. Needed for weights only
   * one backend can read — a QHexRT bundle is a prebuilt QNN context binary, and
   * the `llm` default would hand it to llama.cpp.
   *
   * The generated proto enum, never a hand-written string: the SDK writes this
   * value straight onto the `ModelInfo` commons stores.
   */
  readonly framework?: InferenceFramework;
}

export type Catalog = Readonly<Record<string, CatalogEntry>>;

interface LicenseInfo {
  readonly name: string;
  readonly url: string;
}

export const LICENSES = {
  apache2: { name: 'Apache 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  mit: { name: 'MIT', url: 'https://opensource.org/license/mit' },
  gemma: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
  // Every LiquidAI LFM2.5 repo declares `license: other` + `license_name: lfm1.0`
  // and ships the full text as a LICENSE file. Apache-based, but not Apache: it
  // adds a commercial-revenue threshold, so it must not be labelled Apache 2.0.
  lfm1: { name: 'LFM Open License v1.0', url: 'https://www.liquid.ai/lfm-license' },
  llama32: {
    name: 'Llama 3.2 Community License',
    url: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE',
  },
  nvidiaOpen: {
    name: 'NVIDIA Open Model License',
    url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
  },
  // BigScience Open RAIL-M: open, but with use-based restrictions (unlike a
  // plain permissive license), so it must not be folded into `apache2`/`mit`.
  openrailM: {
    name: 'OpenRAIL-M',
    url: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE',
  },
} as const satisfies Record<string, LicenseInfo>;

type LicenseKey = keyof typeof LICENSES;

const HF = 'https://huggingface.co';
const K2 = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

function llm(
  repo: string,
  file: string,
  label: string,
  params: string,
  sizeMB: number,
  heavy = false,
  license: LicenseKey = 'apache2',
  chatTemplate = 'chatml',
): CatalogEntry {
  const l = LICENSES[license];
  return {
    type: 'llm',
    files: [{ url: `${HF}/${repo}/resolve/main/${file}`, as: 'model.gguf' }],
    primary: 'model.gguf',
    label,
    params,
    sizeMB,
    heavy,
    license: l.name,
    licenseUrl: l.url,
    chatTemplate,
  };
}

function vlm(
  repo: string,
  file: string,
  mm: string,
  label: string,
  params: string,
  sizeMB: number,
  heavy = false,
  license: LicenseKey = 'apache2',
  chatTemplate = 'chatml',
): CatalogEntry {
  const l = LICENSES[license];
  return {
    type: 'vlm',
    files: [
      { url: `${HF}/${repo}/resolve/main/${file}`, as: 'model.gguf' },
      { url: `${HF}/${repo}/resolve/main/${mm}`, as: 'mmproj.gguf' },
    ],
    primary: 'model.gguf',
    mmproj: 'mmproj.gguf',
    label,
    params,
    sizeMB,
    heavy,
    license: l.name,
    licenseUrl: l.url,
    chatTemplate,
  };
}

/**
 * A QHexRT bundle — prebuilt QNN context binaries for the Hexagon NPU.
 *
 * Different in kind from every row above, in three ways that all matter:
 *
 *  - **The engine is pinned on the row.** A `.bin` context binary is readable by
 *    exactly one backend, so the modality default (`llm` -> llama.cpp) would be
 *    wrong. Pinning also makes a fallback visible: `actualBackend` after load is
 *    what commons routed to, so a QHEXRT row that comes back LLAMA_CPP is a bug
 *    you can see rather than a slow CPU run you cannot.
 *  - **It is a folder, not a file.** `primary` is the bundle manifest; the
 *    weights sit beside it and the manifest names them relatively.
 *  - **It is arch-pinned.** `arch` selects the per-arch directory in the HF repo
 *    (`v75`/`v79`/`v81`). A `v79` binary does not *load* on a `v81` device — a
 *    load failure, not wrong output — so this is part of the row's identity, not
 *    a tuning knob. `v81` is Snapdragon X / X2 Elite and 8-Gen-class phones.
 */
function npu(
  repo: string,
  arch: string,
  manifest: string,
  weights: readonly string[],
  label: string,
  params: string,
  sizeMB: number,
  license: LicenseKey = 'apache2',
): CatalogEntry {
  const l = LICENSES[license];
  const files = [manifest, ...weights].map((name) => ({
    url: `${HF}/${repo}/resolve/main/${arch}/${name}`,
    as: name,
  }));
  return {
    type: 'llm',
    framework: 'QHEXRT',
    files,
    primary: manifest,
    label,
    params,
    sizeMB,
    license: l.name,
    licenseUrl: l.url,
  };
}

function whisper(size: string, label: string, sizeMB: number): CatalogEntry {
  return {
    type: 'stt',
    files: [{ url: `${K2}/asr-models/sherpa-onnx-whisper-${size}.tar.bz2`, as: 'whisper.tar.bz2' }],
    archive: true,
    primary: `sherpa-onnx-whisper-${size}`,
    label,
    sizeMB,
  };
}

function piper(voice: string, label: string, sizeMB: number): CatalogEntry {
  return {
    type: 'tts',
    files: [{ url: `${K2}/tts-models/vits-piper-en_US-${voice}-medium.tar.bz2`, as: 'piper.tar.bz2' }],
    archive: true,
    primary: `vits-piper-en_US-${voice}-medium`,
    label,
    sizeMB,
  };
}

// Every URL below was HTTP-verified (200 + "GGUF" magic bytes) on 2026-07-27,
// the LFM2.5 230M row on 2026-08-05, the LFM2.5 VL 3B row on 2026-08-13, the
// Gemma 4 12B/26B-A4B/31B and Qwen3.6/Qwen3.8 rows against the HF API on
// 2026-08-15, and the Muse Glimmer 30B, Granite 4.1, Nemotron 3 Nano Omni, and
// Supertonic 3 rows (also 2026-08-15, same pass).
// Sizes are the real content-length, not estimates.
export const CATALOG: Catalog = {
  'qwen3.5-0.8b': llm('unsloth/Qwen3.5-0.8B-GGUF', 'Qwen3.5-0.8B-Q4_K_M.gguf', 'Qwen3.5 0.8B', '0.8B', 508),
  'qwen3.5-0.8b-vl': vlm('unsloth/Qwen3.5-0.8B-GGUF', 'Qwen3.5-0.8B-Q4_K_M.gguf', 'mmproj-F16.gguf', 'Qwen3.5 0.8B Vision', '0.8B', 738),
  'qwen3.5-2b': llm('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf', 'Qwen3.5 2B', '2B', 1222),
  'qwen3.5-2b-vl': vlm('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf', 'mmproj-F16.gguf', 'Qwen3.5 2B Vision', '2B', 1949, true),
  'qwen3.5-4b': llm('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf', 'Qwen3.5 4B', '4B', 2614, true),
  'qwen3.5-4b-vl': vlm('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf', 'mmproj-F16.gguf', 'Qwen3.5 4B Vision', '4B', 3413, true),
  'qwen3.5-9b': llm('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf', 'Qwen3.5 9B', '9B', 5417, true),

  // ---- Qwen3.6 / Qwen3.8 (newer Qwen releases; MoE + dense) ----
  'qwen3.6-35b-a3b': llm('unsloth/Qwen3.6-35B-A3B-GGUF', 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', 'Qwen3.6 35B-A3B', '35B-A3B', 21112, true),
  'qwen3.8-27b': llm('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q4_K_M.gguf', 'Qwen3.8 27B', '27B', 16314, true),

  // ---- LFM2.5 (Liquid AI) — chat, a reasoning variant that emits <think>…</think>
  //      (the app splits it out), and vision ----
  'lfm2.5-230m': llm('LiquidAI/LFM2.5-230M-GGUF', 'LFM2.5-230M-Q4_K_M.gguf', 'LFM2.5 230M', '230M', 146, false, 'lfm1'),
  'lfm2.5-1.2b': llm('LiquidAI/LFM2.5-1.2B-Instruct-GGUF', 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf', 'LFM2.5 1.2B', '1.2B', 697, false, 'lfm1'),
  'lfm2.5-1.2b-thinking': llm('LiquidAI/LFM2.5-1.2B-Thinking-GGUF', 'LFM2.5-1.2B-Thinking-Q4_K_M.gguf', 'LFM2.5 1.2B Thinking', '1.2B', 697, false, 'lfm1'),
  'lfm2.5-vl-1.6b': vlm('LiquidAI/LFM2.5-VL-1.6B-GGUF', 'LFM2.5-VL-1.6B-Q4_K_M.gguf', 'mmproj-LFM2.5-VL-1.6b-F16.gguf', 'LFM2.5 VL 1.6B', '1.6B', 1585, false, 'lfm1'),
  // The 3B projector filename capitalizes the B (`-3B-`) where the 1.6B one does
  // not (`-1.6b-`). That is upstream's spelling, not a typo to normalize.
  'lfm2.5-vl-3b': vlm('LiquidAI/LFM2.5-VL-3B-GGUF', 'LFM2.5-VL-3B-Q4_K_M.gguf', 'mmproj-LFM2.5-VL-3B-F16.gguf', 'LFM2.5 VL 3B', '3B', 2528, true, 'lfm1'),

  // ---- Qwen3.8 27B at 1 bit, on the Hexagon NPU ----
  // NOT a QNN context bundle like the LFM2.5 rows below. Windows on ARM64 refuses
  // external op-package registration, and every decode shard of this model is built
  // around custom IQ*Linear ops - so instead the manifest is `host_only`, the
  // published GGUF is read in place, and only the matmuls cross to the cDSP over
  // direct FastRPC. One 6.3 GB weights file, its manifest, and a tokenizer.
  'qwen3.8-27b-1bit-npu': npu(
    'runanywhere/qwen3_8_27b_HNPU', 'v81', 'qwen3.8-27b-ud-iq1m-512.json',
    ['Qwen3.8-27B-UD-IQ1_M.gguf', 'tokenizer.json'],
    'Qwen3.8 27B 1-bit (NPU)', '27B', 6417,
  ),
  // ---- LFM2.5 on the Hexagon NPU (QHexRT) ----
  // Same weights family as the GGUF rows above, compiled to QNN context binaries.
  // These load only on a Hexagon v81 device (Snapdragon X / X2 Elite on Windows
  // ARM64); on any other machine the engine reports BACKEND_UNAVAILABLE and the
  // router never selects them, so the rows are safe to ship everywhere.
  // The repos are private — resolving them needs a Hugging Face token.
  'lfm2.5-350m-npu': npu(
    'runanywhere/lfm2_5_350m_HNPU', 'v81', 'lfm2-5-350m-2048.json',
    ['lfm_pf_f16.bin', 'lfm_dec_f16.bin', 'lfm_lmh_f16.bin', 'lfm_embed_f16.bin', 'tokenizer.json'],
    'LFM2.5 350M (NPU)', '350M', 1430, 'lfm1',
  ),
  'lfm2.5-230m-npu': npu(
    'runanywhere/lfm2_5_230m_HNPU', 'v81', 'lfm2-5-230m.json',
    ['lfm230_pf_512_w8.bin', 'lfm230_dec_512_w8.bin', 'lfm230_lmh_w8.bin', 'lfm_embed_f16.bin', 'tokenizer.json'],
    'LFM2.5 230M (NPU)', '230M', 539, 'lfm1',
  ),
  // A REASONING bundle: it opens <think> itself and answers only after closing
  // it, so nothing is emitted for the first few seconds of a request (measured:
  // 4.6 s to the first visible token on a short prompt, at 21.3 ms/tok). It also
  // ships decode + lmhead only — no prefill graph — so the prompt is run through
  // decode and TTFT grows with prompt length (268 ms at 14 tokens, 779 ms at 41).
  // Decode throughput is unaffected.
  'lfm2.5-1.2b-thinking-npu': npu(
    'runanywhere/lfm2_5_1_2b_thinking_HNPU', 'v81', 'lfm2-5-1.2b-thinking.json',
    ['lfm2512bthinking_decode_w8.bin', 'lfm2512bthinking_lmhead_w8.bin', 'lfm2512bthinking_embed_f16.bin', 'tokenizer.json'],
    'LFM2.5 1.2B Thinking (NPU)', '1.2B', 1454, 'lfm1',
  ),

  // ---- Gemma 4 (Google) — weights carry use restrictions, see LICENSES.gemma ----
  'gemma-4-e2b': llm('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf', 'Gemma 4 E2B', '2B eff.', 2963, true, 'gemma', 'gemma'),
  'gemma-4-e2b-vl': vlm('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf', 'mmproj-F16.gguf', 'Gemma 4 E2B Vision', '2B eff.', 4092, true, 'gemma', 'gemma'),
  'gemma-4-e4b': llm('unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf', 'Gemma 4 E4B', '4B eff.', 4747, true, 'gemma', 'gemma'),
  'gemma-4-12b': llm('unsloth/gemma-4-12b-it-GGUF', 'gemma-4-12b-it-Q4_K_M.gguf', 'Gemma 4 12B', '12B', 6791, true, 'gemma', 'gemma'),
  'gemma-4-26b-a4b': llm('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf', 'Gemma 4 26B-A4B', '26B-A4B', 16225, true, 'gemma', 'gemma'),
  // The 31B dense row ships two quants: the standard Q4_K_M and a smaller
  // 2-bit UD-Q2_K_XL for machines that cannot fit the 4-bit file.
  'gemma-4-31b': llm('unsloth/gemma-4-31B-it-GGUF', 'gemma-4-31B-it-Q4_K_M.gguf', 'Gemma 4 31B', '31B', 17475, true, 'gemma', 'gemma'),
  'muse-glimmer-30b': vlm('unsloth/Muse-Glimmer-30B-GGUF', 'Muse-Glimmer-30B-UD-Q4_K_XL.gguf', 'mmproj-Muse-Glimmer-30B-Q8_0.gguf', 'Muse Glimmer 30B', '30B', 17099, true),

  // ---- Ministral (Mistral AI) ----
  'ministral-3-3b': llm('mistralai/Ministral-3-3B-Instruct-2512-GGUF', 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf', 'Ministral 3 3B', '3B', 2048, true, 'apache2', 'mistral'),

  // ---- Granite 4.1 (IBM) — Apache 2.0 ----
  'granite-4.1-3b': llm('unsloth/granite-4.1-3b-GGUF', 'granite-4.1-3b-Q4_K_M.gguf', 'Granite 4.1 3B', '3B', 2002),
  'granite-4.1-8b': llm('unsloth/granite-4.1-8b-GGUF', 'granite-4.1-8b-Q4_K_M.gguf', 'Granite 4.1 8B', '8B', 5100, true),
  'granite-4.1-30b': llm('unsloth/granite-4.1-30b-GGUF', 'granite-4.1-30b-Q4_K_M.gguf', 'Granite 4.1 30B', '30B', 16680, true),

  // ---- Phi (Microsoft) ----
  'phi-4-mini': llm('unsloth/Phi-4-mini-instruct-GGUF', 'Phi-4-mini-instruct-Q4_K_M.gguf', 'Phi-4 mini', '3.8B', 2376, true),

  // ---- Nemotron (NVIDIA) — NVIDIA Open Model License ----
  'nemotron3-nano-4b': llm('nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF', 'NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf', 'Nemotron 3 Nano 4B', '4B', 2706, true, 'nvidiaOpen'),
  // MoE (31B total / 3B active) reasoning model with a real image mmproj. The
  // upstream model is marketed "Omni" (audio + video + image), but llama.cpp's
  // mmproj here is image-only — the label deliberately says "Vision", not
  // "Omni", so it does not overclaim what this backend can actually do.
  'nemotron3-nano-omni-30b-a3b-reasoning': vlm(
    'unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF',
    'NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf',
    'mmproj-F16.gguf',
    'Nemotron 3 Nano 30B-A3B Vision (Reasoning)', '30B-A3B', 24294, true, 'nvidiaOpen',
  ),

  // ---- GLM (Zhipu) — vision only ----
  'glm-4.6v-flash': vlm('ggml-org/GLM-4.6V-Flash-GGUF', 'GLM-4.6V-Flash-Q4_K_M.gguf', 'mmproj-GLM-4.6V-Flash-Q8_0.gguf', 'GLM-4.6V Flash', '9B', 7147, true),

  // ---- Embeddings (ONNX) ----
  minilm: {
    type: 'embedder',
    files: [
      { url: `${HF}/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx`, as: 'model.onnx' },
      { url: `${HF}/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt`, as: 'vocab.txt' },
    ],
    primary: 'model.onnx',
    label: 'all-MiniLM-L6-v2',
    params: '22M',
    sizeMB: 90,
  },

  // ---- Speech-to-text (Whisper via sherpa-onnx) ----
  'whisper-tiny': whisper('tiny.en', 'Whisper tiny (en)', 75),
  'whisper-base': whisper('base.en', 'Whisper base (en)', 142),
  'whisper-small': whisper('small.en', 'Whisper small (en)', 466),

  // ---- Text-to-speech (Piper via sherpa-onnx) ----
  'piper-lessac': piper('lessac', 'Piper · Lessac', 64),
  'piper-amy': piper('amy', 'Piper · Amy', 64),
  'piper-ryan': piper('ryan', 'Piper · Ryan', 64),

  // ---- Text-to-speech (Supertonic 3 via sherpa-onnx) ----
  // NOT the raw `Supertone/supertonic-3` HF repo: its files (per-voice JSON
  // styles, a `unicode_indexer.json`) do not match what this app's packaged
  // sherpa-onnx build actually loads (a single `voice.bin` covering every
  // speaker and a `unicode_indexer.bin`). k2-fsa's own pre-converted int8
  // archive below carries exactly those files, confirmed by extracting it.
  'supertonic-3': {
    type: 'tts',
    files: [
      {
        url: `${K2}/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
        as: 'supertonic.tar.bz2',
      },
    ],
    archive: true,
    primary: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    label: 'Supertonic 3',
    params: '99M',
    sizeMB: 123,
    license: LICENSES.openrailM.name,
    licenseUrl: LICENSES.openrailM.url,
  },

  // ---- Speaker diarization (NVIDIA Sortformer, ONNX) ----
  sortformer: {
    type: 'diarization',
    files: [
      {
        url: `${HF}/cgus/diar_streaming_sortformer_4spk-v2.1-onnx/resolve/main/diar_streaming_sortformer_4spk-v2.1.onnx`,
        as: 'model.onnx',
      },
    ],
    primary: 'model.onnx',
    label: 'Sortformer 4-speaker',
    params: '4 spk',
    sizeMB: 492,
    license: LICENSES.nvidiaOpen.name,
    licenseUrl: LICENSES.nvidiaOpen.url,
  },

  // ---- Semantic segmentation (SegFormer B0, ADE20K classes) ----
  // Revision-pinned: the repo's `main` has been re-exported with different
  // opset/IO names before, and commons reads the graph's output names.
  'segformer-b0-ade-512': {
    type: 'segmentation',
    files: [
      {
        url: `${HF}/Xenova/segformer-b0-finetuned-ade-512-512/resolve/d3e5499fa8701ff0453ca940a8dfeae39b2f1504/onnx/model.onnx`,
        as: 'model.onnx',
      },
    ],
    primary: 'model.onnx',
    label: 'SegFormer B0 · ADE20K',
    params: 'B0',
    sizeMB: 15,
  },

  // ---- Added from the verified model list ----
  'lfm2.5-2.6b-q4_k_m': llm('LiquidAI/LFM2.5-2.6B-GGUF', 'LFM2.5-2.6B-Q4_K_M.gguf', 'LFM2.5 2.6B Q4_K_M', '2.6B', 1674, false, 'lfm1'),
  'bonsai-1.7b-q1_0': llm('prism-ml/Bonsai-1.7B-gguf', 'Bonsai-1.7B-Q1_0.gguf', 'PrismML Bonsai 1.7B (1-bit)', '1.7B', 248, false, 'apache2'),
  'bonsai-4b-q1_0': llm('prism-ml/Bonsai-4B-gguf', 'Bonsai-4B-Q1_0.gguf', 'PrismML Bonsai 4B (1-bit)', '4B', 572, false, 'apache2'),
  'bonsai-8b-q1_0': llm('prism-ml/Bonsai-8B-gguf', 'Bonsai-8B-Q1_0.gguf', 'PrismML Bonsai 8B (1-bit)', '8B', 1159, false, 'apache2'),
  'maple-preview-tq1_0': llm('deepgrove/maple-preview-GGUF', 'maple-preview-TQ1_0-head-Q4_K.gguf', 'Maple Preview 20B-A1B TQ1_0 (1-bit)', '20B-A1B', 4984, false, 'mit'),
  'bonsai-27b-q1_0': llm('prism-ml/Bonsai-27B-gguf', 'Bonsai-27B-Q1_0.gguf', 'PrismML Bonsai 27B (1-bit)', '27B', 3803, false, 'apache2'),
};

/** Human label for a modality, as the model picker and chips show it. */
export const MODALITY_LABEL: Readonly<Record<ModelType, string>> = Object.freeze({
  llm: 'Language model',
  vlm: 'Vision model',
  embedder: 'Embedding model',
  stt: 'Speech-to-text',
  tts: 'Text-to-speech',
  diarization: 'Diarization model',
  segmentation: 'Segmentation model',
});

/** Section headings on the Models screen, in display order. */
export const GROUP_ORDER: readonly (readonly [ModelType, string])[] = [
  ['llm', 'Language models'],
  ['vlm', 'Vision-language'],
  ['stt', 'Speech-to-text'],
  ['tts', 'Text-to-speech'],
  ['embedder', 'Embeddings'],
  ['diarization', 'Diarization'],
  ['segmentation', 'Segmentation'],
];

/**
 * Default model per modality.
 *
 * `llm` is 2B rather than 0.8B deliberately: at 0.8B the model absorbs the
 * user's facts but re-attributes them to itself ("I am 21 years old"). Measured
 * 1/3 vs 3/3 on a multi-fact recall probe.
 */
export const DEFAULT_MODELS: Readonly<Record<ModelType, string>> = Object.freeze({
  llm: 'qwen3.5-2b',
  vlm: 'qwen3.5-0.8b-vl',
  embedder: 'minilm',
  stt: 'whisper-tiny',
  tts: 'piper-lessac',
  diarization: 'sortformer',
  segmentation: 'segformer-b0-ade-512',
});

/** Catalog ids of a given modality, in catalog order. */
export function catalogIdsOfType(type: ModelType): string[] {
  return Object.entries(CATALOG)
    .filter(([, entry]) => entry.type === type)
    .map(([id]) => id);
}
