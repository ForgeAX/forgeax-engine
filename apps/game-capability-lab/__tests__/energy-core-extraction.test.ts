import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveExtractionProgress,
  resolveEnergyCoreContacts,
} from '../assets/plugins/energy-core-extraction.js';
import { SCENE_GUID } from '../assets/plugins/scene-runtime.js';

describe('energy-core extraction', () => {
  it('admits each authored core once and ignores wrong or duplicate contacts', () => {
    const roster = new Map([[101, 0], [102, 1], [103, 2]]);
    expect(resolveEnergyCoreContacts([700, 101, 101, 999], roster, 0)).toEqual({
      collectedMask: 1,
      admitted: [101],
    });
    expect(resolveEnergyCoreContacts([101, 102, 102, 700], roster, 1)).toEqual({
      collectedMask: 3,
      admitted: [102],
    });
    expect(resolveEnergyCoreContacts([103, 999], roster, 3)).toEqual({
      collectedMask: 7,
      admitted: [103],
    });
  });

  it('activates only at exactly three of three authored cores', () => {
    expect(deriveExtractionProgress(0, 3)).toEqual({ collected: 0, total: 3, active: false });
    expect(deriveExtractionProgress(3, 3)).toEqual({ collected: 2, total: 3, active: false });
    expect(deriveExtractionProgress(7, 3)).toEqual({ collected: 3, total: 3, active: true });
  });

  it('authors three unique cores and one beacon in the default SceneAsset', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8'));
    const scene = pack.assets['scene/main'];
    expect(SCENE_GUID).toBe('4a673a93-24b5-56d8-9413-0f2e4e82c088');
    type SceneEntity = { components: { Name?: { value?: string }; Transform?: { pos?: number[] } } };
    const entities = (scene?.payload.entities ?? {}) as Record<string, SceneEntity>;
    const named = new Map<string | undefined, SceneEntity>(
      Object.values(entities).map((entity) => [entity.components.Name?.value, entity]),
    );
    const cores = ['EnergyCoreAlpha', 'EnergyCoreBeta', 'EnergyCoreGamma'].map((name) => named.get(name));
    expect(cores).toHaveLength(3);
    expect(new Set(cores.map((core) => JSON.stringify(core?.components.Transform?.pos))).size).toBe(3);
    expect(named.get('ExtractionBeacon')).toMatchObject({
      components: {
        Name: { value: 'ExtractionBeacon' },
        Transform: { pos: [0, 0.35, -4.5] },
      },
    });
  });
});
