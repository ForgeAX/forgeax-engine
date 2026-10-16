import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatch, GpuDrivenCandidate } from '../gpu-driven/batch-topology';
import {
  filteredPlan,
  type PreparedDrawFacts,
  type PreparedProductionPlan,
} from '../gpu-driven/production-raster-prepare';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';

/** Validated CPU facts: this pure grouping stage does not invoke the GPU handles. */
function scene(count: number): PreparedProductionPlan {
  const candidates: GpuDrivenCandidate[] = [];
  const facts = new Map<number, Map<number, PreparedDrawFacts>>();
  const material = { materialHandle: 7 } as MaterialSnapshot;
  const mesh = {} as MeshGpuHandles;
  const artifact = {} as MaterialShaderArtifact;
  const groupKey = JSON.stringify({
    assetHandle: 3,
    pipelineClass: `sha256:${'0123456789abcdef'.repeat(16)}`,
    materialResourceClass: `sha256:${'fedcba9876543210'.repeat(16)}`,
    program: `sha256:${'0123456789abcdef'.repeat(16)}`,
  });
  for (let index = 0; index < count; index++) {
    candidates.push({ primitiveIndex: index, generation: 1, drawItemIndex: 0, instanceOrdinal: 0 });
    const slot = {
      slot: index,
      generation: 1,
      snapshot: {
        worldId: 0,
        entityKey: index + 1,
        material,
        materials: [],
      } as unknown as RenderableSnapshot,
    } as PersistentGpuDrivenState['slots'][number];
    facts.set(
      index,
      new Map([
        [
          0,
          {
            drawKey: `${index + 1}:0:0`,
            activeKey: index + 1,
            slot,
            material,
            mesh,
            artifact,
            groupKey,
            recordingRasterClassKey: 'synthetic-recording-class',
            rasterClassKey: 'prepared-raster-class',
            worldKey: 0,
            lod: undefined,
            renderState: undefined,
          },
        ],
      ]),
    );
  }
  const batch = {
    batchId: 0,
    generation: 1,
    contentEpoch: 1,
    key: {
      assetHandle: 3,
      drawKind: 'indexed',
      first: 0,
      count: 3,
      baseVertex: 0,
      materialSlot: 0,
      topology: 'triangle-list',
      pipelineClass: 'standard',
      materialResourceClass: 'shared',
    },
    candidates,
    visibleBase: 0,
    visibleCapacity: count,
    indirectOffset: 0,
  } as const satisfies GpuDrivenBatch;
  return {
    source: { revision: 1, batches: [batch], candidateCount: count, visibleCapacity: count },
    batchRows: [{ source: batch, facts, draws: [], meshes: new Map() }],
    worldKeys: undefined,
    drawKeys: new Set(),
    ownership: [],
    lodPlan: [],
  } as unknown as PreparedProductionPlan;
}

describe('GPU group key projection', () => {
  it('does not serialize retained material/program identities again during view regrouping', () => {
    const prepared = scene(1024);
    const encode = JSON.stringify;
    let encodedBytes = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const text = encode(value, replacer as never, space);
      encodedBytes += text?.length ?? 0;
      return text;
    });
    let projected: ReturnType<typeof filteredPlan>;
    try {
      projected = filteredPlan(prepared);
    } finally {
      spy.mockRestore();
    }
    expect(projected.plan.batches).toHaveLength(1);
    expect(projected.plan.batches[0]?.candidates).toEqual(prepared.source.batches[0]?.candidates);
    // Reprojection may encode short binding/claim selectors, never the long
    // immutable program identity for every retained primitive in the scene.
    expect(encodedBytes).toBeLessThan(128 * 1024);
  });
});
