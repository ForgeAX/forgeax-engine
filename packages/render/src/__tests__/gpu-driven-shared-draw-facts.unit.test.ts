import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { assert, describe, expect, it } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { type BatchExecution, prepareBatchExecution } from '../gpu-driven/batch-execution';
import {
  BatchTopology,
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
} from '../gpu-driven/batch-topology';
import { prepareLodProjectionPlan } from '../gpu-driven/production-raster-lod';
import {
  assembleFilteredBatch,
  assembleFilteredGroups,
  assemblePreparedPlan,
  groupForPartition,
  partitionBatch,
  prepareBatchRows,
  suppressedPrimitiveWords,
} from '../gpu-driven/production-raster-prepare';
import { MaterialResource } from '../material-resource';
import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import {
  mesh as fixtureMesh,
  preparedSnapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';

async function fixture(
  instanceCount = 64,
  separateWorlds = false,
  drawCount = 1,
  sameEntity = false,
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const artifact = standardPbrInputs(device, shader, viewLayout).materialArtifact;
  assert(artifact);
  const mesh: MeshGpuHandles = {
    ...fixtureMesh(device, true, true),
    lodRanges: [
      Array.from({ length: drawCount }, (_, index) => ({
        first: index * 3,
        count: 3,
        baseVertex: 0,
      })),
      Array.from({ length: drawCount }, (_, index) => ({
        first: 9 + index * 3,
        count: 3,
        baseVertex: 0,
      })),
    ],
  };
  const projection = new RenderScene();
  const topology = new BatchTopology();
  const template = preparedSnapshot(1, 3);
  const originalDraw = template.gpuDrivenDraws?.[0];
  assert(originalDraw);
  const materials = Array.from(
    { length: drawCount },
    () => new MaterialResource(template.material.snapshot),
  );
  const snapshots = [0, 1].map((index): RenderableSnapshot => {
    const transforms = new Float32Array(instanceCount * 16);
    for (let i = 0; i < instanceCount; i++) transforms.set(mat4.identity(mat4.create()), i * 16);
    return {
      ...template,
      worldId: separateWorlds ? index : 0,
      entityKey: sameEntity ? 1 : index + 1,
      material: materials[0] ?? template.material,
      materials,
      materialBindingSources: materials.map(() => 'engine-default'),
      instances: { transforms, instanceCount, cacheKey: index + 1, archVersion: 1 },
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
      gpuDrivenDraws: Array.from({ length: drawCount }, (_, drawItemIndex) => ({
        ...originalDraw,
        drawItemIndex,
        first: drawItemIndex * 3,
        materialSlot: drawItemIndex,
        geometry: {
          ...originalDraw.geometry,
          draw: { ...originalDraw.geometry.draw, first: drawItemIndex * 3 },
        },
        lodRanges: [{ first: 9 + drawItemIndex * 3, count: 3, baseVertex: 0 }],
      })),
    };
  });
  topology.apply(
    projection.apply(
      snapshots.map((snapshot) => ({
        kind: 'update',
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    ),
  );
  const worldKeys = [101, 202];
  const prepare = (
    options: {
      meshFor?: (binding: GpuDrivenBatchBinding) => MeshGpuHandles | undefined;
      executionFor?: (batch: GpuDrivenBatch) => BatchExecution;
      bindings?: ReadonlyMap<string, string>;
    } = {},
  ) => {
    const source = topology.query(topology.sourcePlan(), undefined);
    const rows = source.batches.map((batch) => {
      const binding = batch.binding;
      assert(binding);
      const material = binding.material.snapshot;
      const execution =
        options.executionFor?.(batch) ??
        prepareBatchExecution(
          binding.geometry,
          material,
          { kind: 'forward', shaderId: artifact.material },
          () => artifact,
        ).unwrap();
      const preparedBatch =
        execution.route === 'gpu' ? { ...batch, prepared: execution.prepared } : batch;
      return prepareBatchRows(preparedBatch, {
        mesh: options.meshFor === undefined ? mesh : options.meshFor(binding),
        worldKeys,
        execution,
      });
    });
    const prepared = assemblePreparedPlan(source, rows, worldKeys);
    const batches = rows.flatMap((row) =>
      partitionBatch(row.source, options.bindings).flatMap((partition) => {
        const group = groupForPartition(row, partition);
        return group === undefined ? [] : [assembleFilteredBatch(group)];
      }),
    );
    return { ...assembleFilteredGroups(source, batches), rows, prepared };
  };
  return {
    device,
    mesh,
    artifact,
    projection,
    topology,
    worldKeys,
    snapshots,
    materials,
    prepare,
    close() {
      mesh.vertexBuffer.destroy().unwrap();
      mesh.indexBuffer?.destroy().unwrap();
    },
  };
}

describe('GPU-driven shared draw preparation', () => {
  it('projects fixed prepared rows without rereading mutable Mesh content', async () => {
    const f = await fixture(3, true, 2);
    const descriptor = Object.getOwnPropertyDescriptor(f.mesh, 'contentEpoch');
    assert(descriptor);
    try {
      const first = f.prepare();
      expect(first.rows).toHaveLength(4);
      expect(first.batches).toHaveLength(4);
      const captured = first.rows.map((row) => row.meshContentEpoch);
      expect(captured.every((epoch) => epoch !== undefined)).toBe(true);
      let reads = 0;
      Object.defineProperty(f.mesh, 'contentEpoch', {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get() {
          reads++;
          throw new Error('filter reread latest Mesh content instead of prepared rows');
        },
      });
      const projected = first.rows.flatMap((row) =>
        partitionBatch(row.source, undefined).flatMap((partition) => {
          const group = groupForPartition(row, partition);
          return group === undefined ? [] : [assembleFilteredBatch(group)];
        }),
      );
      expect(reads).toBe(0);
      expect(projected.map((batch) => batch.meshContentEpoch)).toEqual(captured);
      expect(projected.map((batch) => batch.mesh)).toEqual(
        first.batches.map((batch) => batch.mesh),
      );
      // A future admission observes the actual new residency epoch; projecting
      // the already captured rows above must not reinterpret that future state.
      Object.defineProperty(f.mesh, 'contentEpoch', { ...descriptor, value: 77 });
      expect(f.prepare().batches.map((batch) => batch.meshContentEpoch)).toEqual(
        captured.map(() => 77),
      );
      expect(first.batches.map((batch) => batch.meshContentEpoch)).toEqual(captured);
    } finally {
      Object.defineProperty(f.mesh, 'contentEpoch', descriptor);
      f.close();
    }
  });

  it.each([
    1, 64, 4096,
  ])('prepares static facts per shared draw for %i instances per primitive', async (count) => {
    const f = await fixture(count, false, 2);
    try {
      const result = f.prepare();
      expect(result.rows).toHaveLength(2);
      expect(result.batches).toHaveLength(2);
      expect(result.plan.candidateCount).toBe(count * 4);
      for (const snapshot of f.snapshots) expect(result.selection.ownsAll(snapshot)).toBe(true);
      for (const row of result.rows) {
        expect(row.fact?.mesh).toBe(f.mesh);
        expect(row.source.candidates).toHaveLength(count * 2);
        expect(row.lod?.ranges).toEqual([
          { first: 9 + (row.source.binding?.drawItemIndex ?? 0) * 3, count: 3, baseVertex: 0 },
        ]);
      }
      const slots = f.projection.slotsSnapshot();
      expect(suppressedPrimitiveWords(slots, f.worldKeys, new Set(), 64)[0]).toBe(3);
      expect(
        suppressedPrimitiveWords(slots, f.worldKeys, new Set([worldEntityKey(101, 1)]), 64)[0],
      ).toBe(2);
    } finally {
      f.close();
    }
  });

  it('reuses native membership without reading source draw arrays during material fact assembly', async () => {
    const f = await fixture(4096, true, 2, true);
    try {
      const result = f.prepare();
      const source = result.prepared.source;
      const lodPlan = prepareLodProjectionPlan(source);
      const guarded = {
        ...source,
        batches: source.batches.map((batch) => ({
          ...batch,
          get candidates(): typeof batch.candidates {
            throw new Error('material preparation expanded instances');
          },
        })),
      };
      const retained = assemblePreparedPlan(guarded, result.rows, f.worldKeys, lodPlan);
      expect(retained.batchRows).toEqual(result.rows);
      expect(retained.lodPlan).toBe(lodPlan);
      expect(result.rows).toHaveLength(4);
      for (const snapshot of f.snapshots) expect(result.selection.ownsAll(snapshot)).toBe(true);
    } finally {
      f.close();
    }
  });

  it('keeps same-entity Worlds separate through partial mesh and Pass admission', async () => {
    const f = await fixture(3, true, 2, true);
    try {
      const first = f.snapshots[0],
        second = f.snapshots[1];
      assert(first && second);
      const partial = f.prepare({
        meshFor: (binding) => (binding.worldId === 0 ? undefined : f.mesh),
      });
      expect(partial.selection.ownsAll(first)).toBe(false);
      expect(partial.selection.ownsAll(second)).toBe(true);
      expect(partial.plan.candidateCount).toBe(6);
      const denied = f.prepare({
        executionFor: (batch) => {
          assert(batch.binding);
          const material = batch.binding.material.snapshot;
          if (batch.binding.drawItemIndex === 1)
            return {
              route: 'direct',
              material,
              pass: { kind: 'forward', shaderId: f.artifact.material },
            };
          return prepareBatchExecution(
            batch.binding.geometry,
            material,
            { kind: 'forward', shaderId: f.artifact.material },
            () => f.artifact,
          ).unwrap();
        },
      });
      expect(denied.plan.candidateCount).toBe(6);
      for (const snapshot of f.snapshots) {
        expect(denied.selection.has(snapshot, 0)).toBe(true);
        expect(denied.selection.has(snapshot, 1)).toBe(false);
        expect(denied.selection.ownsAll(snapshot)).toBe(false);
      }
    } finally {
      f.close();
    }
  });

  it('keeps unique draw instances across native topology edits and rejects a retired slot generation', async () => {
    const f = await fixture(3, true, 2, true);
    try {
      const check = () => {
        const result = f.prepare();
        const candidates = result.plan.batches.flatMap((batch) =>
          batch.candidates.map(
            (candidate) =>
              `${batch.binding?.worldId}:${batch.binding?.drawItemIndex}:${candidate.primitiveIndex}:${candidate.instanceOrdinal}`,
          ),
        );
        expect(new Set(candidates).size).toBe(candidates.length);
        const slots = f.projection.slotsSnapshot();
        expect(candidates).toHaveLength(
          slots.reduce(
            (count, slot) => count + (slot.snapshot.instances?.instanceCount ?? 1) * 2,
            0,
          ),
        );
        for (const slot of slots)
          expect(result.selection.ownsAll(slot.snapshot)).toBe(
            (slot.snapshot.instances?.instanceCount ?? 1) > 0,
          );
        return result;
      };
      const initial = check();
      const first = f.projection.slotsSnapshot().at(0);
      assert(first?.snapshot.instances);
      for (const instanceCount of [5, 0, 2]) {
        f.topology.apply(
          f.projection.apply([
            {
              kind: 'update',
              worldId: first.worldId,
              entityKey: first.entityKey,
              instances: {
                ...first.snapshot.instances,
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
      const current = check();
      const reused = f.projection.slot(first.worldId, first.entityKey);
      assert(reused);
      expect(reused.slot).toBe(first.slot);
      expect(reused.generation).not.toBe(first.generation);
      expect(initial.selection.ownsSlot(reused.snapshot, 0, reused.slot, reused.generation)).toBe(
        false,
      );
      expect(current.selection.ownsSlot(reused.snapshot, 0, reused.slot, reused.generation)).toBe(
        true,
      );
    } finally {
      f.close();
    }
  });

  it('partitions object bindings without renumbering shared submesh executions', async () => {
    const f = await fixture(64, false, 2);
    try {
      const plain = f.prepare();
      const partitioned = f.prepare({
        bindings: new Map([
          ['0:1', 'binding-a'],
          ['0:2', 'binding-b'],
        ]),
      });
      expect(partitioned.batches).toHaveLength(4);
      expect(partitioned.plan.candidateCount).toBe(plain.plan.candidateCount);
      expect(
        partitioned.batches.map((batch) => [
          batch.batch.binding?.drawItemIndex,
          batch.materialBindingClass,
        ]),
      ).toEqual([
        [0, 'binding-a'],
        [0, 'binding-b'],
        [1, 'binding-a'],
        [1, 'binding-b'],
      ]);
      for (const snapshot of f.snapshots)
        expect(partitioned.selection.ownsAll(snapshot)).toBe(true);
    } finally {
      f.close();
    }
  });

  it('captures changed mesh content once per shared execution and retains prior facts', async () => {
    const f = await fixture(64, false, 2);
    try {
      const old = f.prepare();
      const epoch = f.mesh.contentEpoch;
      Object.assign(f.mesh, { contentEpoch: epoch + 1 });
      expect(old.rows.every((row) => row.meshContentEpoch === epoch)).toBe(true);
      expect(old.rows.every((row) => row.meshContentEpoch !== row.mesh?.contentEpoch)).toBe(true);
      expect(f.prepare().rows.every((row) => row.meshContentEpoch === epoch + 1)).toBe(true);
    } finally {
      f.close();
    }
  });

  it('selects physical LOD ranges independently in each World while preserving shared buffers', async () => {
    const f = await fixture(8, true, 2, true);
    try {
      const replacement = {
        ...f.mesh,
        lodRanges: [
          f.mesh.lodRanges?.[0] ?? [],
          [
            { first: 27, count: 3, baseVertex: 0 },
            { first: 30, count: 3, baseVertex: 0 },
          ],
        ],
      };
      const result = f.prepare({
        meshFor: (binding) => (binding.worldId === 0 ? replacement : f.mesh),
      });
      expect(
        result.rows.map((row) => [
          row.fact?.worldKey,
          row.source.binding?.drawItemIndex,
          row.lod?.ranges?.[0]?.first,
        ]),
      ).toEqual([
        [101, 0, 27],
        [101, 1, 30],
        [202, 0, 9],
        [202, 1, 12],
      ]);
      expect(result.rows.every((row) => row.mesh?.vertexBuffer === f.mesh.vertexBuffer)).toBe(true);
      for (const snapshot of f.snapshots) expect(result.selection.ownsAll(snapshot)).toBe(true);
    } finally {
      f.close();
    }
  });

  it.each([
    1, 8, 64,
  ])('selects rejected, hard and fading Shadow executions for %i instances', async (count) => {
    const f = await fixture(count, false, 3);
    try {
      const result = f.prepare({
        executionFor: (batch) => {
          assert(batch.binding);
          const draw = batch.binding.drawItemIndex;
          const shaderId = draw === 2 ? 'game::hard-shadow' : f.artifact.material;
          const selected: MaterialShaderArtifact = {
            ...f.artifact,
            material: shaderId,
            pass: 'shadow',
            program: createMaterialShaderProgram(shaderId),
          };
          return prepareBatchExecution(
            batch.binding.geometry,
            batch.binding.material.snapshot,
            {
              kind: 'shadow',
              shaderId,
              renderState: draw === 0 ? { depthWriteEnabled: false } : { cullMode: 'back' },
            },
            () => selected,
          ).unwrap();
        },
      });
      expect(result.plan.candidateCount).toBe(count * 4);
      expect(result.batches).toHaveLength(2);
      expect(
        result.batches.map((batch) => [
          batch.batch.binding?.drawItemIndex,
          batch.batch.lod?.crossfade ?? false,
        ]),
      ).toEqual([
        [1, true],
        [2, false],
      ]);
      for (const snapshot of f.snapshots) {
        expect(result.selection.has(snapshot, 0)).toBe(false);
        expect(result.selection.has(snapshot, 1)).toBe(true);
        expect(result.selection.has(snapshot, 2)).toBe(true);
      }
    } finally {
      f.close();
    }
  });

  it('does not claim missing meshes or direct-only Pass executions', async () => {
    const f = await fixture(16);
    try {
      const noMesh = f.prepare({ meshFor: () => undefined });
      expect(noMesh.rows.every((row) => row.mesh === undefined && row.fact === undefined)).toBe(
        true,
      );
      const direct = f.prepare({
        executionFor: (batch) => {
          assert(batch.binding);
          return prepareBatchExecution(
            batch.binding.geometry,
            batch.binding.material.snapshot,
            { kind: 'shadow', shaderId: 'game::direct-only' },
            () => undefined,
          ).unwrap();
        },
      });
      for (const result of [noMesh, direct]) {
        expect(result.plan.candidateCount).toBe(0);
        for (const snapshot of f.snapshots) expect(result.selection.ownsAll(snapshot)).toBe(false);
      }
    } finally {
      f.close();
    }
  });
});
