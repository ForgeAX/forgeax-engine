import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import {
  assemblePreparedPlan,
  filteredPlan,
  ownsAllAdmittedDrawItems,
  prepareBatchRows,
  sameBatchMeshes,
  suppressedPrimitiveWords,
} from '../gpu-driven/production-raster-prepare';
import * as shadowClaims from '../gpu-driven/shadow-claims';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_INDEX, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { worldEntityKey } from '../record/frame-snapshot';
import type {
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

async function fixture(
  instanceCount = 64,
  separateWorlds = false,
  drawCount = 1,
  sameEntity = false,
) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const artifact = standardPbrInputs(device, shader, viewLayout).standardPbrArtifact;
  const mesh: MeshGpuHandles = {
    vertexBuffer: new GpuBuffer(
      device,
      device.createBuffer({ size: 144, usage: GPU_BUFFER_USAGE_VERTEX }).unwrap(),
    ),
    indexBuffer: new GpuBuffer(
      device,
      device.createBuffer({ size: 12, usage: GPU_BUFFER_USAGE_INDEX }).unwrap(),
    ),
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: 12,
    indexCount: 6,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list',
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' },
    ],
    lodRanges: [
      Array.from({ length: drawCount }, () => ({ first: 0, count: 3, baseVertex: 0 })),
      Array.from({ length: drawCount }, () => ({ first: 3, count: 3, baseVertex: 0 })),
    ],
  };
  const projection = new RenderScene();
  projection.apply(
    [1, 2].map((entityKey, index) => {
      const world = mat4.identity(mat4.create());
      const material: MaterialSnapshot = {
        baseColor: vec3.create(1, 1, 1),
        metallic: 0,
        roughness: 1,
        materialShaderId: 'forgeax::default-standard-pbr',
      };
      const transforms = new Float32Array(instanceCount * 16);
      for (let i = 0; i < instanceCount; i += 1) transforms.set(world, i * 16);
      const source: RenderableSnapshot = {
        worldId: separateWorlds ? index : 0,
        entityKey: sameEntity ? 1 : entityKey,
        assetHandle: 3,
        transform: { world },
        localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
        material,
        materials: [material],
        materialBindingSources: ['engine-default'],
        instances: { transforms, instanceCount, cacheKey: 1, archVersion: 1 },
        lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
        gpuDrivenDraws: Array.from({ length: drawCount }, (_, drawItemIndex) => ({
          drawItemIndex,
          kind: 'indexed',
          first: 0,
          count: 3,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'standard-pbr',
          materialResourceClass: 'standard-pbr-resources',
          lodRanges: [{ first: 3, count: 3, baseVertex: 0 }],
        })),
      };
      const snapshot = preparedPbrSnapshot(source);
      return {
        kind: 'update' as const,
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        snapshot,
      };
    }),
  );
  const slots = projection.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const original = topology.plan();
  expect(original.batches).toHaveLength(1);
  const batch = original.batches[0];
  if (batch === undefined) throw new Error('Missing source batch');
  // Interleave primitives deliberately: grouping must keep the canonical order.
  const candidates = Array.from({ length: instanceCount }, (_, ordinal) =>
    (ordinal % 2 === 0 ? [...slots].reverse() : slots).flatMap((slot) =>
      Array.from({ length: drawCount }, (_, drawItemIndex) => ({
        primitiveIndex: slot.slot,
        generation: slot.generation,
        drawItemIndex,
        instanceOrdinal: ordinal,
      })),
    ),
  ).flat();
  const source = { ...original, batches: [{ ...batch, candidates }] };
  const meshes = new Map(slots.map((slot) => [slot.slot, mesh] as const));
  const slotAt = vi.fn(projection.slotAt);
  const worldKeys = [101, 202];
  const inputs = {
    slotAt,
    meshBySlot: meshes,
    worldKeys,
    materialArtifact: artifact,
    skinArtifact: undefined,
    materialArtifacts: undefined,
  };
  const rows = source.batches.map((value) => prepareBatchRows(value, inputs));
  const prepared = assemblePreparedPlan(source, rows, slots, worldKeys);
  return {
    projection,
    topology,
    slots,
    candidates,
    slotAt,
    mesh,
    meshes,
    inputs,
    rows,
    prepared,
    close() {
      mesh.vertexBuffer.destroy().unwrap();
      mesh.indexBuffer?.destroy().unwrap();
    },
  };
}

describe('GPU-driven shared draw preparation', () => {
  it('assembles ownership from admitted facts without searching source draws per instance again', async () => {
    const f = await fixture(4096, true, 2, true);
    const lookup = vi.spyOn(shadowClaims, 'sourceDrawForCandidate');
    try {
      const prepared = assemblePreparedPlan(f.prepared.source, f.rows, f.slots, f.inputs.worldKeys);
      expect(prepared.ownership).toEqual(f.prepared.ownership);
      expect(prepared.drawKeys).toEqual(f.prepared.drawKeys);
      expect(ownsAllAdmittedDrawItems(prepared, undefined)).toBe(true);
      expect(lookup.mock.calls.length).toBe(0);
    } finally {
      lookup.mockRestore();
      f.close();
    }
  });

  it('keeps same-entity Worlds separate through partial mesh and artifact admission', async () => {
    const f = await fixture(3, true, 2, true);
    try {
      const first = f.slots[0];
      const second = f.slots[1];
      if (first === undefined || second === undefined) throw Error('Missing fixture slots');
      const meshes = new Map(f.meshes);
      meshes.delete(first.slot);
      const rows = f.prepared.source.batches.map((batch) =>
        prepareBatchRows(batch, { ...f.inputs, meshBySlot: meshes }),
      );
      const partial = assemblePreparedPlan(f.prepared.source, rows, f.slots, f.inputs.worldKeys);
      expect(partial.ownership).toEqual([
        { activeKey: worldEntityKey(101, 1), ownsAllDrawItems: false },
        { activeKey: worldEntityKey(202, 1), ownsAllDrawItems: true },
      ]);
      expect(ownsAllAdmittedDrawItems(partial, undefined)).toBe(false);
      expect(ownsAllAdmittedDrawItems(partial, new Set([worldEntityKey(202, 1)]))).toBe(true);
      expect(filteredPlan(partial).plan.candidateCount).toBe(6);

      // Each source draw can have a different residency/artifact outcome.
      const root = f.prepared.source.batches[0];
      if (root === undefined) throw Error('Missing source batch');
      const source = {
        ...f.prepared.source,
        batches: [0, 1].map((drawItemIndex) => ({
          ...root,
          batchId: drawItemIndex,
          candidates: root.candidates.filter(
            (candidate) => candidate.drawItemIndex === drawItemIndex,
          ),
        })),
      };
      const missingArtifact = source.batches.map((batch, index) =>
        prepareBatchRows(batch, {
          ...f.inputs,
          materialArtifact: index === 0 ? f.inputs.materialArtifact : undefined,
        }),
      );
      const denied = assemblePreparedPlan(source, missingArtifact, f.slots, f.inputs.worldKeys);
      expect(denied.ownership.every((row) => !row.ownsAllDrawItems)).toBe(true);
      expect(filteredPlan(denied).plan.candidateCount).toBe(6);

      const incomplete = { ...source, batches: source.batches.slice(0, 1) };
      const incompleteRows = incomplete.batches.map((batch) => prepareBatchRows(batch, f.inputs));
      expect(
        ownsAllAdmittedDrawItems(
          assemblePreparedPlan(incomplete, incompleteRows, f.slots, f.inputs.worldKeys),
          undefined,
        ),
      ).toBe(false);
    } finally {
      f.close();
    }
  });

  it('receives unique source draw instances through native topology edits and slot reuse', async () => {
    const f = await fixture(3, true, 2, true);
    try {
      const check = () => {
        const source = f.topology.plan();
        const slots = f.projection.slotsSnapshot();
        const candidates = source.batches.flatMap((batch) => batch.candidates);
        const keys = candidates.map(
          (c) => `${c.primitiveIndex}:${c.drawItemIndex}:${c.instanceOrdinal}`,
        );
        expect(new Set(keys).size).toBe(candidates.length);
        expect(candidates).toHaveLength(
          slots.reduce(
            (count, slot) => count + (slot.snapshot.instances?.instanceCount ?? 1) * 2,
            0,
          ),
        );
        const meshes = new Map(slots.map((slot) => [slot.slot, f.mesh]));
        const rows = source.batches.map((batch) =>
          prepareBatchRows(batch, { ...f.inputs, slotAt: f.projection.slotAt, meshBySlot: meshes }),
        );
        const prepared = assemblePreparedPlan(source, rows, slots, f.inputs.worldKeys);
        expect(ownsAllAdmittedDrawItems(prepared, undefined)).toBe(true);
      };
      check();
      const first = f.slots[0];
      if (first === undefined) throw Error('Missing source slot');
      for (const instanceCount of [5, 0, 2]) {
        const instances = first.snapshot.instances;
        if (instances === undefined) throw Error('Missing source instances');
        f.topology.apply(
          f.projection.apply([
            {
              kind: 'update',
              worldId: first.worldId,
              entityKey: first.entityKey,
              instances: {
                ...instances,
                instanceCount,
                transforms: new Float32Array(instanceCount * 16),
                archVersion: instanceCount,
              },
            },
          ]),
        );
        check();
      }
      f.topology.apply(
        f.projection.apply([
          { kind: 'remove', worldId: first.worldId, entityKey: first.entityKey },
        ]),
      );
      check();
      f.topology.apply(
        f.projection.apply([
          {
            kind: 'update',
            worldId: first.worldId,
            entityKey: first.entityKey,
            snapshot: first.snapshot,
          },
        ]),
      );
      check();
    } finally {
      f.close();
    }
  });

  it('shares each draw independently when one primitive has multiple matching draw items', async () => {
    const f = await fixture(64, false, 2);
    try {
      expect(f.slotAt).toHaveBeenCalledTimes(4);
      const bindings = new Map<string, string>();
      const lookup = vi.spyOn(bindings, 'get');
      const result = filteredPlan(f.prepared, undefined, bindings);
      expect(lookup).toHaveBeenCalledTimes(4);
      expect(result.plan.batches).toHaveLength(1);
      expect(result.plan.batches[0]?.candidates).toEqual(f.candidates);
      expect(result.plan.candidateCount).toBe(256);
      expect(result.drawKeys.size).toBe(4);
      expect(ownsAllAdmittedDrawItems(f.prepared, undefined)).toBe(true);
    } finally {
      f.close();
    }
  });
  it.each([
    1, 64, 4096,
  ])('projects static facts once for %i instances per primitive', async (count) => {
    const f = await fixture(count);
    try {
      expect(f.slotAt).toHaveBeenCalledTimes(2);
      const bindings = new Map<string, string>();
      const bindingLookup = vi.spyOn(bindings, 'get');
      const result = filteredPlan(f.prepared, undefined, bindings);
      expect(bindingLookup).toHaveBeenCalledTimes(2);
      expect(result.plan.batches).toHaveLength(1);
      expect(result.plan.batches[0]?.candidates).toEqual(f.candidates);
      expect(result.batches[0]?.primitiveSlot).toBe(f.candidates[0]?.primitiveIndex);
      expect(result.plan.batches[0]?.lod).toMatchObject({ crossfade: true, coverages: [1, 0.5] });
      expect(ownsAllAdmittedDrawItems(f.prepared, undefined)).toBe(true);
      expect(suppressedPrimitiveWords(f.prepared, new Set(), 64)[0]).toBe(3);
      const first = f.slots[0];
      if (first === undefined) throw new Error('Missing slot');
      expect(
        suppressedPrimitiveWords(
          f.prepared,
          new Set([worldEntityKey(101, first.snapshot.entityKey)]),
          64,
        )[0],
      ).toBe(2);
      expect(f.rows.every((row) => sameBatchMeshes(row, f.meshes))).toBe(true);
    } finally {
      f.close();
    }
  });

  it('detects in-place writes for every primitive sharing a resident mesh', async () => {
    const f = await fixture(64);
    try {
      const changed = new Set<number>();
      Object.assign(f.mesh, { contentEpoch: f.mesh.contentEpoch + 1 });
      for (const row of f.rows) expect(sameBatchMeshes(row, f.meshes, changed)).toBe(false);
      expect(changed).toEqual(new Set(f.slots.map((slot) => slot.slot)));
      const rows = f.prepared.source.batches.map((batch) => prepareBatchRows(batch, f.inputs));
      expect(rows.every((row) => sameBatchMeshes(row, f.meshes))).toBe(true);
    } finally {
      f.close();
    }
  });

  it('keeps world, binding class and physical LOD ranges in the grouping identity', async () => {
    for (const separateWorlds of [false, true]) {
      const f = await fixture(8, separateWorlds);
      try {
        const bindings = new Map(
          f.slots.map((slot) => [
            materialBindingKey(slot.snapshot, -1),
            separateWorlds ? 'same-binding' : `binding-${slot.slot}`,
          ]),
        );
        expect(filteredPlan(f.prepared, undefined, bindings).plan.batches).toHaveLength(2);
        const first = f.slots[0];
        if (first === undefined) throw new Error('Missing slot');
        const differentMesh = {
          ...f.mesh,
          lodRanges: [
            [{ first: 0, count: 3, baseVertex: 0 }],
            [{ first: 9, count: 3, baseVertex: 0 }],
          ],
        };
        const meshes = new Map(f.meshes).set(first.slot, differentMesh);
        expect(f.rows.every((row) => sameBatchMeshes(row, meshes))).toBe(false);
        const rows = f.prepared.source.batches.map((batch) =>
          prepareBatchRows(batch, { ...f.inputs, meshBySlot: meshes }),
        );
        const changed = assemblePreparedPlan(f.prepared.source, rows, f.slots, [101, 202]);
        expect(filteredPlan(changed).plan.batches).toHaveLength(2);
      } finally {
        f.close();
      }
    }
  });

  it.each([
    1, 8, 64,
  ])('shares draw claims with %i instances and preserves rejected, hard and fading shadow lanes', async (instances) => {
    const f = await fixture(instances, false, 3);
    try {
      const membership: ShadowCasterMembership[] = f.slots.flatMap((slot, renderableIndex) =>
        [0, 1, 2].map((drawItemIndex) => ({
          worldEntity: worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey),
          renderableIndex,
          drawItemIndex,
          materialHandle: -1,
          passIndex: 0,
          gpuDrivenEligible: drawItemIndex !== 0,
          materialShaderId: drawItemIndex === 2 ? 'custom-shadow' : SHADOW_CASTER_SHADER_ID,
          renderState: { cullMode: drawItemIndex === 2 ? 'front' : 'back' },
        })),
      );
      const claims = new ShadowClaimTable(undefined, membership);
      const lookup = vi.spyOn(claims, 'claim');
      const result = filteredPlan(f.prepared, claims);
      // Each snapshot/draw is admitted once, including the rejected draw.
      // Instances retain their full canonical sequence below.
      expect(lookup).toHaveBeenCalledTimes(membership.length);
      expect(
        lookup.mock.calls
          .map(([slot, candidate]) => `${slot.slot}:${candidate.drawItemIndex}`)
          .sort(),
      ).toEqual(f.slots.flatMap((slot) => [0, 1, 2].map((draw) => `${slot.slot}:${draw}`)).sort());
      expect(result.shadowDrawKeys).toEqual(
        new Set(
          membership
            .filter((entry) => entry.gpuDrivenEligible)
            .map((entry) =>
              gpuDrivenShadowDrawKey(
                entry.worldEntity,
                entry.materialHandle,
                entry.drawItemIndex,
                entry.passIndex,
              ),
            ),
        ),
      );
      expect(result.plan.candidateCount).toBe(4 * instances);
      expect(result.plan.batches).toHaveLength(2);
      expect(result.plan.batches[0]?.candidates).toEqual(
        f.candidates.filter((candidate) => candidate.drawItemIndex === 1),
      );
      expect(result.plan.batches[1]?.candidates).toEqual(
        f.candidates.filter((candidate) => candidate.drawItemIndex === 2),
      );
      expect(result.plan.batches[0]?.lod?.crossfade).toBe(true);
      expect(result.plan.batches[1]?.lod?.crossfade ?? false).toBe(false);
    } finally {
      f.close();
    }
  });

  it('retains missing-mesh invalidation and refuses ownership without an admitted artifact', async () => {
    const f = await fixture(16);
    try {
      const emptyMeshes = new Map<number, MeshGpuHandles>();
      const missingRows = f.prepared.source.batches.map((batch) =>
        prepareBatchRows(batch, { ...f.inputs, meshBySlot: emptyMeshes }),
      );
      expect(missingRows.every((row) => sameBatchMeshes(row, emptyMeshes))).toBe(true);
      expect(missingRows.every((row) => sameBatchMeshes(row, f.meshes))).toBe(false);
      const noArtifact = f.prepared.source.batches.map((batch) =>
        prepareBatchRows(batch, { ...f.inputs, materialArtifact: undefined }),
      );
      const denied = assemblePreparedPlan(f.prepared.source, noArtifact, f.slots, [101, 202]);
      expect(filteredPlan(denied).plan.candidateCount).toBe(0);
      expect(ownsAllAdmittedDrawItems(denied, undefined)).toBe(false);
    } finally {
      f.close();
    }
  });
});
