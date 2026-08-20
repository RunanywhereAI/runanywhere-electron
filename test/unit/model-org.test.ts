/**
 * The publisher taxonomy behind the model picker's grouping.
 *
 * The rule table is a hand-kept copy of the same table in iOS, Android and Web,
 * while the catalog moves on its own schedule in its own PR. The property worth
 * pinning is therefore coverage rather than any single mapping: nothing should
 * reach the picker filed under an unnamed publisher.
 */
import { describe, expect, it } from 'vitest';

import { CATALOG } from '../../src/shared/model-catalog';
import { groupByOrg, modelOrg } from '../../src/shared/model-org';

describe('modelOrg', () => {
  it('keeps the specific publisher ahead of the family it derives from', () => {
    expect(modelOrg({ id: 'nemotron_nano_8b', name: 'Llama 3.1 Nemotron Nano 8B' }).name).toBe(
      'NVIDIA',
    );
    expect(modelOrg({ id: 'llama-3.2-3b', name: 'Llama 3.2 3B' }).name).toBe('Meta');
    expect(modelOrg({ id: 'deepseek_r1_distill_qwen', name: 'DeepSeek R1 Distill Qwen' }).name).toBe(
      'DeepSeek',
    );
  });

  it('files the publishers the catalog rebuild added', () => {
    expect(modelOrg({ id: 'granite-4.1-3b-q4_k_m', name: 'IBM Granite 4.1 3B' }).name).toBe('IBM');
    expect(modelOrg({ id: 'maple-preview-tq1_0', name: 'Maple Preview 20B-A1B' }).name).toBe(
      'Deepgrove',
    );
    expect(modelOrg({ id: 'muse-glimmer-30b-q4_k_xl', name: 'Meta Muse Glimmer 30B' }).name).toBe(
      'Meta',
    );
    expect(modelOrg({ id: 'fara1.5-4b-q4_k_m', name: 'Fara1.5 4B Computer-Use Agent' }).name).toBe(
      'Microsoft',
    );
  });

  it('orders variants smallest first inside a publisher', () => {
    const grouped = groupByOrg(
      [
        { id: 'qwen3.5-9b', name: 'Qwen3.5 9B', size: 6 },
        { id: 'qwen3.5-2b', name: 'Qwen3.5 2B', size: 2 },
      ],
      (entry) => entry.size,
    );
    expect(grouped[0]?.models.map((model) => model.id)).toEqual(['qwen3.5-2b', 'qwen3.5-9b']);
  });

  it('leaves nothing in the catalog without a named publisher', () => {
    const community = /piper|silero|minilm|supertonic|vits|kokoro|segformer|sherpa|whisper|nemo/;
    const unnamed = Object.entries(CATALOG)
      .map(([id, entry]) => ({ id, name: entry.label }))
      .filter((entry) => !community.test(entry.id))
      .filter((entry) => modelOrg(entry).key === 'open-source')
      .map((entry) => entry.id);
    expect(unnamed).toEqual([]);
  });
});
