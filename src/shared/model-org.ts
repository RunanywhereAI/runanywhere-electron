// Model organisations — the publisher behind a catalog entry, so the picker can
// group rows under the name people actually recognise instead of listing forty
// files under one category heading.
//
// The rule table is a hand-kept copy of the same table in iOS
// (`ModelOrgCatalog`), Android (`ModelTaxonomy`) and Web (`model-display.ts`).
// Four copies is a known cost; the alternative is a catalog field, which is a
// commons change. Keep them in step when a family is added.

/** A publisher. Declaration order in `ORG_MATCHERS` is the picker's order. */
export interface ModelOrg {
  /** Stable key, e.g. "nvidia". */
  key: string;
  /** Consumer-facing name, e.g. "NVIDIA". */
  name: string;
}

/**
 * Ordered matchers against the lowercased "id + name" haystack. First match
 * wins, so the specific publisher precedes the family it would otherwise be
 * swallowed by: NVIDIA before Meta so Nemotron stays NVIDIA, DeepSeek before
 * Alibaba so the R1 Qwen distills stay DeepSeek.
 */
const ORG_MATCHERS: ReadonlyArray<{ key: string; name: string; test: RegExp }> = [
  {
    key: 'nvidia',
    name: 'NVIDIA',
    test: /nemotron|nemoguard|cosmos|canary|parakeet|nv[_-]embed|nv_rerank|nvidia|sortformer/,
  },
  { key: 'deepseek', name: 'DeepSeek', test: /deepseek/ },
  { key: 'prism', name: 'Prism', test: /bonsai|prismml|prism-?ml/ },
  { key: 'deepgrove', name: 'Deepgrove', test: /maple/ },
  { key: 'ibm', name: 'IBM', test: /granite/ },
  // `fara` rides with Microsoft's `phi`: Fara1.5 ships mirrored under our own HF
  // org, so the catalog row names no upstream publisher. Filing it by its own
  // name beats guessing one into a UI label.
  { key: 'microsoft', name: 'Microsoft', test: /\bphi\b|fara/ },
  { key: 'google', name: 'Google', test: /gemma|embeddinggemma|siglip/ },
  // Muse Glimmer is Meta's, per the catalog row's own name.
  { key: 'meta', name: 'Meta', test: /llama|muse-glimmer|muse_glimmer/ },
  { key: 'alibaba', name: 'Alibaba', test: /qwen/ },
  { key: 'liquid', name: 'Liquid AI', test: /lfm2/ },
  { key: 'mistral', name: 'Mistral AI', test: /mistral|ministral/ },
  { key: 'hugging-face', name: 'Hugging Face', test: /smollm|smolvlm/ },
  { key: 'openai', name: 'OpenAI', test: /whisper/ },
  { key: 'zhipu', name: 'Zhipu AI', test: /\bglm\b|glm-/ },
  {
    key: 'open-source',
    name: 'Open source',
    test: /internvl|lama_dilated|moonshine|melo|kokoro|kitten|piper|vits|silero|vad|minilm|soprano|pocket-tts|supertonic|segformer/,
  },
];

const FALLBACK_ORG: ModelOrg = { key: 'open-source', name: 'Open source' };

/** The publisher for one entry. Never throws; unknown names read as community. */
export function modelOrg(entry: { id: string; name: string }): ModelOrg {
  const haystack = `${entry.id} ${entry.name}`.toLowerCase();
  const match = ORG_MATCHERS.find((org) => org.test.test(haystack));
  return match ? { key: match.key, name: match.name } : FALLBACK_ORG;
}

/** Position of an org in the picker's ordering. Unknown orgs sort last. */
export function orgOrder(key: string): number {
  const index = ORG_MATCHERS.findIndex((org) => org.key === key);
  return index === -1 ? ORG_MATCHERS.length : index;
}

/**
 * Group entries by publisher, orgs in declaration order and variants smallest
 * first within an org, so a card opens with the cheapest option.
 */
export function groupByOrg<T extends { id: string; name: string }>(
  entries: readonly T[],
  sizeOf: (entry: T) => number,
): Array<{ org: ModelOrg; models: T[] }> {
  const buckets = new Map<string, { org: ModelOrg; models: T[] }>();
  for (const entry of entries) {
    const org = modelOrg(entry);
    const bucket = buckets.get(org.key) ?? { org, models: [] };
    bucket.models.push(entry);
    buckets.set(org.key, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => ({
      org: bucket.org,
      models: [...bucket.models].sort((a, b) => sizeOf(a) - sizeOf(b)),
    }))
    .sort((a, b) => orgOrder(a.org.key) - orgOrder(b.org.key));
}
