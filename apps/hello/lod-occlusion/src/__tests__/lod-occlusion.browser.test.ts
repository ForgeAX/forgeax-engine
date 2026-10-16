import { describe, expect, it } from 'vitest';
import { parseGltf } from '@forgeax/engine-gltf';

import documentText from '../../assets/lod-scene.gltf?raw';
import meta from '../../assets/lod-scene.gltf.meta.json' with { type: 'json' };

describe('hello-lod-occlusion asset closure', () => {
  it('uses MSFT_lod source nodes and producer sidecar coverage', async () => {
    const documentJson = JSON.parse(documentText) as unknown;
    const parsed = await parseGltf(documentJson, async () => {
      throw new Error('embedded fixture must not request an external buffer');
    }, 'lod-scene.gltf');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.lod?.lodNodeIds).toEqual([1, 2]);
    expect(meta.sourceOverrides.mesh.lods.map((level) => level.screenCoverage)).toEqual([0.5, 0.2]);
  });
});
