import { describe, expect, it } from 'vitest';
import {
  inspectLodOcclusion,
  LOD_OCCLUSION_INSPECTION_MAX_BYTES,
  serializeLodOcclusionInspection,
} from '../scene/visibility/inspection';

const baseInput = {
  root: { guid: '018e7a4d-1234-7abc-8def-000000000001', sourceKey: 'assets/lod-scene.gltf' },
  view: { attachmentId: 'main', cameraEntity: 7, viewRole: 'main' as const, viewGeneration: 3 },
  slot: { primitiveSlot: 11, slotGeneration: 2 },
  generation: 9,
  count: { candidates: 100_000, visible: 10_000, occluded: 90_000 },
  lodHistogram: [
    { level: 0, count: 5_000 },
    { level: 1, count: 4_000 },
    { level: 2, count: 1_000 },
  ],
  samples: Array.from({ length: 80 }, (_, index) => ({
    primitiveSlot: index,
    level: index % 3,
    visible: index % 2 === 0,
  })),
};

describe('LOD occlusion inspection projection', () => {
  it('publishes bounded identity, histogram and stable samples', () => {
    const inspection = inspectLodOcclusion(baseInput);

    expect(inspection.schema).toBe('forgeax::lod-occlusion-inspection::v3');
    expect(inspection.root).toEqual(baseInput.root);
    expect(inspection.view).toEqual(baseInput.view);
    expect(inspection.slot).toEqual(baseInput.slot);
    expect(inspection.count).toEqual(baseInput.count);
    expect(inspection.samples).toHaveLength(64);
    expect(inspection.samples[0]?.primitiveSlot).toBe(0);
    expect(inspection.samples[63]?.primitiveSlot).toBe(63);
    expect(JSON.stringify(inspection).length).toBeLessThanOrEqual(
      LOD_OCCLUSION_INSPECTION_MAX_BYTES,
    );
  });

  it('serializes as detached POD without live renderer state', () => {
    const inspection = inspectLodOcclusion(baseInput);
    const serialized = serializeLodOcclusionInspection(inspection);
    expect(JSON.parse(serialized)).toEqual(inspection);
    expect(serialized).not.toMatch(/handle|encoder|queue|mutable|query/i);
  });
});
