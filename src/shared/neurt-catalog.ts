/**
 * NeuRT (Apple Neural Engine) models — registered by URL, not through the
 * fixed-file-list `CATALOG` in `model-catalog.ts`.
 *
 * A NeuRT bundle is a Core ML `.mlpackage` directory tree with a variable,
 * coremltools-determined file count (`Manifest.json`, `Data/com.apple.CoreML/
 * model.mlmodel`, `weights/weight.bin`, …) — nothing like QHexRT's fixed 5-file
 * manifest+weights list, so it cannot be described as a `CatalogEntry`'s
 * `files: CatalogFile[]`. Instead these register the same way `RunAnywhere.
 * models.register({ url })` already does for a bare HuggingFace repo/folder
 * reference (the same mechanism iOS's `registerLLM(url:)` and this app's own
 * "Add from URL" flow use): commons resolves and downloads everything under
 * that URL, recursively, with no explicit manifest.
 *
 * Rows and metadata are copy-translated from iOS's `ModelCatalogBootstrap.swift`
 * (the org's source-of-truth app) — iOS is the only other place these exact
 * bundles are registered, and it registers them with `framework: .coreml`, not
 * a `.neurt` case (there is no such case; NeuRT is the engine identity, Core ML
 * is the framework it executes — see `@runanywhere/electron-neurt`'s README).
 */

export interface NeuRTModel {
  readonly id: string;
  readonly name: string;
  /** HuggingFace folder ref — commons resolves every file under it. */
  readonly url: string;
  readonly category: 'LANGUAGE' | 'SPEECH_TO_TEXT';
}

// Only the models whose repo is public. iOS also carries a private
// `parakeet-tdt-0.6b-v3-ane` row (org-gated access) — omitted here until this
// app has the same Hugging Face token gating iOS's Settings screen provides.
export const NEURT_MODELS: readonly NeuRTModel[] = [
  {
    id: 'lfm2.5-2.6b-ane',
    name: 'LFM2.5 2.6B (NeuRT / Neural Engine)',
    // Repo casing is exact on purpose (matches the HF tree API's 200 vs. 307
    // redirect for the lowercase spelling); `_c6` = 6 Core ML graph chunks,
    // load-bearing — a 4-chunk sibling caused non-deterministic on-device
    // SIGKILLs at the ~654 MB per-graph tier.
    url: 'https://huggingface.co/runanywhere/LFM2.5-2.6B_ANE/lut8_g32_c6',
    category: 'LANGUAGE',
  },
  {
    id: 'lfm2.5-230m-ane',
    name: 'LFM2.5 230M (NeuRT / Neural Engine)',
    url: 'https://huggingface.co/runanywhere/LFM2.5-230M_ANE/int8',
    category: 'LANGUAGE',
  },
  {
    id: 'lfm2.5-350m-ane',
    name: 'LFM2.5 350M (NeuRT / Neural Engine)',
    url: 'https://huggingface.co/runanywhere/LFM2.5-350M_ANE/int8',
    category: 'LANGUAGE',
  },
];
