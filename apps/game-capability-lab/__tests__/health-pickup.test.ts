import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveHealthPickupContact } from '../assets/plugins/health-pickup.js';
import { sceneAssetGuid } from '../assets/plugins/scene-runtime.js';

describe('game-default authored health pickup', () => {
  it('restores exactly one missing heart and refuses full health', () => {
    expect(resolveHealthPickupContact({ current: 2, max: 3 })).toEqual({
      health: 3,
      admitted: true,
    });
    expect(resolveHealthPickupContact({ current: 3, max: 3 })).toEqual({
      health: 3,
      admitted: false,
    });
  });

  it('keeps the pickup identity and presentation in the authored SceneAsset', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Record<string, {
        kind: string;
        refs: string[];
        payload: { entities?: Record<string, { components: Record<string, Record<string, unknown>> }> };
      }>;
    };
    const scene = pack.assets['scene/main'];
    const pickup = scene?.payload.entities?.healthpickup;

    expect(scene?.kind).toBe('scene');
    expect(pickup).toMatchObject({
      components: {
        Name: { value: 'HealthPickup' },
        Transform: { pos: [2.5, 0.55, 0], scale: [0.45, 0.45, 0.45] },
        MeshFilter: { assetHandle: 4 },
      },
    });
    const materialIndex = (pickup?.components.MeshRenderer?.materials as number[] | undefined)?.[0];
    expect(typeof materialIndex).toBe('number');
    expect(scene?.refs[materialIndex ?? -1]).toBe(sceneAssetGuid('material/health-pickup'));
    expect(pack.assets['material/health-pickup']?.kind).toBe('material');
  });
});
