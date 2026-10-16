import { existsSync, readFileSync } from 'node:fs';
import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { BatchTopology, buildBatchAlignedSubmission } from '../gpu-driven/batch-topology';
import type { LodViewCamera } from '../gpu-driven/lod-projection.wgsl';
import {
  type ShadowViewIdentity,
  ShadowViewStatePool,
  type ShadowViewUpdateInput,
  shadowDirtyRects,
  shadowMinCasterDiameter,
  shadowViewHasStaticLayer,
  shadowViewIdentityKey,
} from '../gpu-driven/shadow-views';
import { GpuScene } from '../gpu-scene';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const shadowViewsPath = new URL('../gpu-driven/shadow-views.ts', import.meta.url);
const shadowViewsSource = existsSync(shadowViewsPath) ? readFileSync(shadowViewsPath, 'utf8') : '';
const recordFrameSource = readFileSync(new URL('../record/frame.ts', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../gpu-driven/view-gpu.ts', import.meta.url), 'utf8');

const shadowKinds = [
  { name: 'directional cascade', token: 'directional' },
  { name: 'point cube face', token: 'point' },
  { name: 'spot atlas', token: 'spot' },
] as const;

const material = {
  baseColor: new Float32Array([1, 1, 1]),
  metallic: 0,
  roughness: 1,
} as MaterialSnapshot;

function snapshot(entityKey: number): RenderableSnapshot {
  return {
    assetHandle: 3,
    transform: { world: new Float32Array(mat4.identity(mat4.create())) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque',
        materialResourceClass: 'plain',
      },
    ],
  };
}

function placed(entityKey: number, x: number): RenderableSnapshot {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = x;
  return { ...snapshot(entityKey), transform: { world } };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

async function lodShadowFixture(extra: Partial<ShadowViewUpdateInput> = {}) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const projection = new RenderScene();
  const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
    projection.cullingWorldBoundsAt(slot);
  const lodAt = (entityKey: number, x: number): RenderableSnapshot => {
    const value = placed(entityKey, x);
    const draw = value.gpuDrivenDraws?.[0];
    if (draw === undefined) throw new Error('fixture draw missing');
    return {
      ...value,
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.3 }],
      gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 0, count: 12, baseVertex: 0 }] }],
    };
  };
  const scene = GpuScene.create(device, 2).unwrap();
  if (scene.status !== 'available') throw new Error('scene unavailable');
  scene.scene
    .sync(
      projection.apply([updateSnapshot(lodAt(1, 0)), updateSnapshot(lodAt(2, 50))]),
      undefined,
      boundsOf,
    )
    .unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const pool = ShadowViewStatePool.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const identity: ShadowViewIdentity = { kind: 'directional', index: 0, layer: 'static' };
  const input = {
    identity,
    sourcePlan: topology.plan(),
    scene: scene.scene,
    planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    lodProjectedHeights: new Map([
      [0, 0.5],
      [1, 0.5],
    ]),
    lodSelection: 'near/near',
    ...extra,
  } as const;
  pool.update(input).unwrap();
  pool._commitResourceReplacement();
  return {
    pool,
    input,
    identity,
    dispose: () => {
      pool.dispose();
      scene.scene.dispose();
    },
  };
}

describe('GPU-driven shadow view owner contract', () => {
  it('borrows complete captured batches while detaching partial and permuted projections', async () => {
    const f = await lodShadowFixture();
    try {
      const source = f.input.sourcePlan;
      const full = f.pool
        .update(
          {
            ...f.input,
            identity: { ...f.identity, index: 10 },
            candidatePrimitiveIndices: [1, 0, 1],
          },
          source,
        )
        .unwrap();
      expect(full.plan).not.toBe(source);
      expect(full.plan.batches[0]).toBe(source.batches[0]);
      expect(full.plan.batches[0]?.candidates).toBe(source.batches[0]?.candidates);
      const partial = f.pool
        .update(
          { ...f.input, identity: { ...f.identity, index: 11 }, candidatePrimitiveIndices: [1] },
          source,
        )
        .unwrap();
      expect(
        partial.plan.batches[0]?.candidates.map((candidate) => candidate.primitiveIndex),
      ).toEqual([1]);
      expect(partial.plan.batches[0]?.candidates).not.toBe(source.batches[0]?.candidates);
      expect(source.batches[0]?.candidates.map((candidate) => candidate.primitiveIndex)).toEqual([
        0, 1,
      ]);
      const permuted = buildBatchAlignedSubmission(
        source,
        new Map(source.batches.map((batch) => [batch.batchId, [...batch.candidates].reverse()])),
      );
      const reordered = f.pool
        .update(
          {
            ...f.input,
            sourcePlan: permuted,
            identity: { ...f.identity, index: 12 },
            candidatePrimitiveIndices: [0, 1],
          },
          permuted,
        )
        .unwrap();
      expect(
        reordered.plan.batches[0]?.candidates.map((candidate) => candidate.primitiveIndex),
      ).toEqual([0, 1]);
      expect(reordered.plan.batches[0]?.candidates).not.toBe(permuted.batches[0]?.candidates);
      const raw = f.pool
        .update({
          ...f.input,
          identity: { ...f.identity, index: 13 },
          candidatePrimitiveIndices: [0, 1],
        })
        .unwrap();
      expect(raw.plan.batches[0]).not.toBe(source.batches[0]);
    } finally {
      f.dispose();
    }
  });
  it('matches raw projection for overlapping batches, empty selections and sparse slot domains', async () => {
    const f = await lodShadowFixture();
    try {
      const batch = f.input.sourcePlan.batches[0];
      if (batch === undefined) throw Error('fixture batch missing');
      const source = Object.freeze({
        ...f.input.sourcePlan,
        batches: Object.freeze(
          [2, 0, 1].map((batchId) =>
            Object.freeze({
              ...batch,
              batchId,
              visibleBase: batchId * 64,
              indirectOffset: batchId * 40,
            }),
          ),
        ),
        candidateCount: 6,
        visibleCapacity: 256,
      });
      const selections = [[], [0], [1], [0, 1], [0, 1_000_000_000]];
      for (let index = 0; index < selections.length; index++) {
        const candidates = selections[index];
        if (candidates === undefined) throw Error('fixture selection missing');
        const input = {
          ...f.input,
          sourcePlan: source,
          candidatePrimitiveIndices: candidates,
        };
        const raw = f.pool
          .update({ ...input, identity: { ...f.identity, index: 20 + index * 2 } })
          .unwrap();
        f.pool._commitResourceReplacement();
        const owned = f.pool
          .update({ ...input, identity: { ...f.identity, index: 21 + index * 2 } }, source)
          .unwrap();
        expect(owned.plan).toEqual(raw.plan);
        expect(owned.plan).not.toBe(raw.plan);
      }
      expect(source.batches.map((value) => value.batchId)).toEqual([2, 0, 1]);
      expect(source.batches[0]?.candidates).toBe(batch.candidates);
    } finally {
      f.dispose();
    }
  });
  it.each([
    'revision',
    'batch-field',
    'lod',
    'wrong-owner',
  ] as const)('preserves a raw %s getter failure in the next view of one submission', async (kind) => {
    const f = await lodShadowFixture();
    const fault = Error('second view revision');
    let armed = false;
    const source = { ...f.input.sourcePlan };
    if (kind === 'revision' || kind === 'wrong-owner') {
      Object.defineProperty(source, 'revision', {
        get() {
          if (armed) throw fault;
          return f.input.sourcePlan.revision;
        },
      });
    } else {
      const batches = source.batches.map((batch) => {
        const copied = { ...batch };
        Object.defineProperty(copied, kind === 'lod' ? 'lod' : 'observation', {
          enumerable: true,
          get() {
            if (armed) throw fault;
            return kind === 'lod' ? batch.lod : 1;
          },
        });
        return copied;
      });
      Object.defineProperty(source, 'batches', { value: batches });
    }
    const owner = kind === 'wrong-owner' ? f.input.sourcePlan : undefined;
    try {
      f.pool
        .update(
          {
            ...f.input,
            sourcePlan: source,
            identity: { ...f.identity, index: 1 },
            candidatePrimitiveIndices: [0],
          },
          owner,
        )
        .unwrap();
      armed = true;
      let thrown: unknown;
      try {
        f.pool.update(
          {
            ...f.input,
            sourcePlan: source,
            identity: { ...f.identity, index: 2 },
            candidatePrimitiveIndices: [0],
          },
          owner,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(fault);
    } finally {
      f.dispose();
    }
  });

  it('shares equal memberships but separates candidate subsets and source objects', async () => {
    const f = await lodShadowFixture();
    const identity = (index: number) => ({ ...f.identity, index });
    try {
      const first = f.pool
        .update(
          { ...f.input, identity: identity(1), candidatePrimitiveIndices: [0] },
          f.input.sourcePlan,
        )
        .unwrap();
      const equal = f.pool
        .update(
          { ...f.input, identity: identity(2), candidatePrimitiveIndices: new Set([0]) },
          f.input.sourcePlan,
        )
        .unwrap();
      expect(equal.plan).toBe(first.plan);
      const other = f.pool
        .update(
          { ...f.input, identity: identity(3), candidatePrimitiveIndices: [1] },
          f.input.sourcePlan,
        )
        .unwrap();
      expect(other.plan).not.toBe(first.plan);
      expect(
        other.plan.batches.flatMap((batch) =>
          batch.candidates.map((candidate) => candidate.primitiveIndex),
        ),
      ).toEqual([1]);

      const source = buildBatchAlignedSubmission(
        f.input.sourcePlan,
        new Map(f.input.sourcePlan.batches.map((batch) => [batch.batchId, batch.candidates])),
      );
      expect(source.revision).toBe(f.input.sourcePlan.revision);
      const replaced = f.pool
        .update(
          {
            ...f.input,
            identity: identity(4),
            sourcePlan: source,
            candidatePrimitiveIndices: [0],
          },
          source,
        )
        .unwrap();
      expect(replaced.plan).not.toBe(first.plan);
      expect(replaced.sourcePlan).toBe(source);
    } finally {
      f.dispose();
    }
  });

  it('does not lend an aborted view its own old plan from another pending view', async () => {
    const matrix = mat4.identity(mat4.create());
    const shifted = mat4.identity(mat4.create());
    shifted[12] = 0.1;
    const f = await lodShadowFixture({ matrix, candidatePrimitiveIndices: [0] });
    const moved = {
      matrix: shifted,
      planes: frustum.fromViewProjection(frustum.create(), shifted),
    };
    const other = { ...f.input, identity: { ...f.identity, index: 1 } };
    try {
      const first = f.pool.update({ ...f.input, ...moved }, f.input.sourcePlan).unwrap();
      const second = f.pool.update(other, f.input.sourcePlan).unwrap();
      expect(second.plan).toBe(first.plan);
      f.pool._commitResourceReplacement();

      f.pool.update({ ...other, ...moved }, f.input.sourcePlan).unwrap();
      f.pool._abortResourceReplacement();
      const pending = f.pool.update(f.input, f.input.sourcePlan).unwrap();
      expect(pending.plan).toBe(first.plan);
      const retry = f.pool.update({ ...other, ...moved }, f.input.sourcePlan).unwrap();
      expect(retry.plan).not.toBe(first.plan);
      expect(retry.plan.batches).toEqual(first.plan.batches);
      expect(retry.view.visibleBuffer).toBe(second.view.visibleBuffer);
      // The aborted view needs a fresh plan and redraw, while the accepted
      // queue writes already hold these identical candidate and batch rows.
      expect(retry.view.inspect().candidateUploadBytes).toBe(0);
      expect(retry.view.inspect().batchUploadBytes).toBe(0);
      expect(retry.view.inspect().viewConstantsUploadBytes).toBeGreaterThan(0);
      expect(f.pool.invalidationReason(other.identity)).toBe('submit-aborted');
      f.pool._commitResourceReplacement();
      expect(f.pool.update({ ...other, ...moved }, f.input.sourcePlan).unwrap().cache).toBe('hit');

      const visible = retry.view.visibleBuffer;
      retry.view._recoverFromOverflow().unwrap();
      f.pool.invalidate('artifact-changed', other.identity);
      const recovered = f.pool.update({ ...other, ...moved }, f.input.sourcePlan).unwrap();
      expect(recovered.view.visibleBuffer).not.toBe(visible);
      expect(recovered.plan).not.toBe(retry.plan);
      expect(recovered.view.inspect().candidateUploadBytes).toBeGreaterThan(0);
    } finally {
      f.dispose();
    }
  });

  it('publishes a single shared shadow view state pool', () => {
    expect(existsSync(shadowViewsPath)).toBe(true);
    expect(shadowViewsSource).toMatch(/GpuDrivenView/);
    expect(shadowViewsSource).toMatch(/SubmissionPlan|BatchTopology/);
    expect(shadowViewsSource).toMatch(/Map/);
    expect(shadowViewsSource).not.toMatch(/new\s+BatchTopology/);
  });

  it.each(shadowKinds)('$name has a cache-hit and invalidation decision', ({ token }) => {
    expect(shadowViewsSource).toContain(token);
    expect(shadowViewsSource).toMatch(/cache|Cache|reuse|Reuse/);
    expect(shadowViewsSource).toMatch(/invalidat|Invalidat|generation|Generation/);
  });

  it('keeps visibility, counters, and indirect arguments view-local', () => {
    expect(viewSource).toMatch(/visible|visibility/);
    expect(viewSource).toMatch(/counter|Counter/);
    expect(viewSource).toMatch(/indirect|Indirect/);
    expect(viewSource).toMatch(/labelPrefix|viewPrefix|viewId/);
  });

  it('fences shadow view cache identity at accepted graph generations', () => {
    expect(recordFrameSource).not.toMatch(/cacheToken|shadowViewToken/);
    expect(recordFrameSource).toMatch(/targetSize:\s*graphShadowMapSize/);
    expect(recordFrameSource).toMatch(/graphGeneration:\s*frameState\.graphGeneration/);
    expect(shadowViewsSource).not.toMatch(/cacheToken/);
  });

  it('reuses each view on a cache hit and invalidates only that view', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const sceneAvailability = GpuScene.create(device, 1).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const identities: readonly ShadowViewIdentity[] = [
      { kind: 'directional', index: 0 },
      { kind: 'point', index: 0 },
      { kind: 'spot', index: 0 },
    ];
    for (const identity of identities) {
      const input = {
        identity,
        sourcePlan: topology.plan(),
        scene: sceneAvailability.scene,
        planes,
        targetSize: 1024,
        graphGeneration: 1,
        candidatePrimitiveIndices: [0],
      } as const;
      const first = pool.update(input).unwrap();
      expect(first.cache).toBe('invalidated');
      expect(first.plan.candidateCount).toBe(1);
      expect(pool.invalidationReason(identity)).toBe('first-publication');
      const firstInspection = first.view.inspect();

      // Cache reuse is published only after the frame's successful submit
      // commit. The unit fixture explicitly advances that transaction before
      // asking the pool for a hit.
      pool._commitResourceReplacement();

      const hit = pool.update(input).unwrap();
      expect(hit.cache).toBe('hit');
      expect(hit.generation).toBe(first.generation);
      expect(pool.invalidationReason(identity)).toBeUndefined();
      expect(hit.view.inspect().updateCount).toBe(firstInspection.updateCount);
      const equalCopy = pool
        .update({ ...input, planes: new Float32Array(planes), candidatePrimitiveIndices: [0] })
        .unwrap();
      expect(equalCopy.cache).toBe('hit');
      expect(equalCopy.plan).toBe(hit.plan);
      const acceptedCounters = pool
        .inspect()
        .find((row) => row.identity.kind === identity.kind)?.preparation;
      expect(acceptedCounters).toMatchObject({
        cacheHits: 2,
        cacheRebuilds: 1,
        cacheRebuildReasons: { 'first-publication': 1 },
      });

      const hitGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      const skipped = pool.project(hitGraph, identity).unwrap();
      expect(skipped.cache).toBe('hit');
      expect(skipped.passNames).toEqual([]);
      expect(
        hitGraph
          .compile({ device, surfaceSize: { width: 1, height: 1 } })
          .unwrap()
          .inspect().passes,
      ).toHaveLength(0);

      const replacementGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      const forced = pool.project(replacementGraph, identity, true).unwrap();
      expect(forced.cache).toBe('hit');
      expect(forced.passNames.length).toBeGreaterThan(0);

      const movedPlanes = new Float32Array(planes);
      movedPlanes[0] = (movedPlanes[0] ?? 0) + 0.01;
      const payloadOnly = pool
        .update({
          ...input,
          planes: movedPlanes,
          lodProjectedHeights: new Map([[0, 0.25]]),
        })
        .unwrap();
      expect(payloadOnly.cache).toBe('invalidated');
      expect(payloadOnly.plan).toBe(first.plan);
      expect(pool.invalidationReason(identity)).toBe('view-changed');
      expect(
        pool.inspect().find((row) => row.identity.kind === identity.kind)?.preparation,
      ).toMatchObject({
        cacheHits: 2,
        cacheRebuilds: 2,
        cacheRebuildReasons: { 'first-publication': 1, 'view-changed': 1 },
      });
      expect(acceptedCounters?.cacheRebuilds).toBe(1);
      expect(payloadOnly.view.inspect()).toMatchObject({
        candidateUploadBytes: 0,
        batchUploadBytes: 0,
      });
      pool._commitResourceReplacement();

      const changedMaterial = {
        ...material,
        baseColor: new Float32Array([0.25, 1, 1]),
      } as MaterialSnapshot;
      const changedDelta = projection.apply([
        updateSnapshot({
          ...snapshot(1),
          material: changedMaterial,
          materials: [changedMaterial],
        }),
      ]);
      sceneAvailability.scene.sync(changedDelta).unwrap();
      const contentInvalidated = pool.update(input).unwrap();
      expect(contentInvalidated.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('content-changed');
      pool._commitResourceReplacement();
      const membershipChanged = pool.update({ ...input, candidatePrimitiveIndices: [] }).unwrap();
      expect(membershipChanged.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('membership-changed');
      pool._abortResourceReplacement();
      expect(pool.invalidationReason(identity)).toBe('submit-aborted');
      expect(
        pool.inspect().find((view) => view.identity.kind === identity.kind)?.invalidationReason,
      ).toBe('submit-aborted');
      expect(pool.update(input).unwrap().cache).toBe('invalidated');
      pool._commitResourceReplacement();

      const regenerated = pool.update({ ...input, graphGeneration: 2 }).unwrap();
      expect(regenerated.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('graph-compiled');
      pool._commitResourceReplacement();
      expect(pool.update({ ...input, graphGeneration: 2 }).unwrap().cache).toBe('hit');
      const resized = pool.update({ ...input, targetSize: 2048 }).unwrap();
      expect(resized.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('configuration-changed');
      pool._commitResourceReplacement();

      pool.invalidate('artifact-changed', identity);
      const invalidated = pool.update(input).unwrap();
      expect(invalidated.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('artifact-changed');
      expect(invalidated.generation).toBe(first.generation + 7);
      expect(invalidated.view.inspect().updateCount).toBe(firstInspection.updateCount + 7);
    }
    expect(pool.invalidationReason({ kind: 'spot', index: 7 })).toBe('uncached');

    pool.dispose();
    sceneAvailability.scene.dispose();
  });
  it('never reuses camera-culled depth, but keeps culling views that miss anyway', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
      projection.cullingWorldBoundsAt(slot);
    const moveCaster = (x: number) => {
      const value = snapshot(1);
      const world = new Float32Array(mat4.identity(mat4.create()));
      world[12] = x;
      scene
        .sync(
          projection.apply([updateSnapshot({ ...value, transform: { world } })]),
          undefined,
          boundsOf,
        )
        .unwrap();
    };
    const sceneAvailability = GpuScene.create(device, 1).unwrap();
    if (sceneAvailability.status !== 'available') throw new Error('scene unavailable');
    const scene = sceneAvailability.scene;
    moveCaster(0);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const matrix = mat4.identity(mat4.create());
    const cameraCull = {
      camera: {
        viewProjection: mat4.identity(mat4.create()),
        near: 0.1,
        far: 100,
        orthographic: true,
        historyKey: 'main',
      },
      ndcDilation: 0.01,
      worldDilation: 0,
    };
    const frame = (identity: ShadowViewIdentity) => {
      const result = pool
        .update({
          identity,
          sourcePlan: topology.plan(),
          scene,
          planes: frustum.fromViewProjection(frustum.create(), matrix),
          matrix,
          cameraCull,
        })
        .unwrap();
      // A graph that binds the camera pyramid; point views never create the pipeline.
      result.view.cameraCullBound = identity.kind !== 'point';
      pool._commitResourceReplacement();
      return { cache: result.cache, reason: pool.invalidationReason(identity) };
    };
    const spot: ShadowViewIdentity = { kind: 'spot', index: 0 };
    expect(frame(spot)).toEqual({ cache: 'invalidated', reason: 'first-publication' });
    expect(frame(spot)).toEqual({ cache: 'hit', reason: undefined });
    // A moving caster misses every frame, and each miss rasters under the cull.
    moveCaster(0.1);
    expect(frame(spot)).toEqual({ cache: 'invalidated', reason: 'content-changed' });
    moveCaster(0.2);
    expect(frame(spot)).toEqual({ cache: 'invalidated', reason: 'content-changed' });
    // Once it rests, the would-be hit re-rasters every caster once.
    expect(frame(spot)).toEqual({ cache: 'invalidated', reason: 'camera-culled' });
    expect(frame(spot)).toEqual({ cache: 'hit', reason: undefined });

    const point: ShadowViewIdentity = { kind: 'point', index: 0 };
    frame(point);
    moveCaster(0.3);
    frame(point);
    expect(frame(point)).toEqual({ cache: 'hit', reason: undefined });
    pool.dispose();
    scene.dispose();
  });

  it('keeps a view cached while changed slots stay outside its retained frustum', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
      projection.cullingWorldBoundsAt(slot);
    const at = (entityKey: number, x: number): RenderableSnapshot => {
      const value = snapshot(entityKey);
      const world = new Float32Array(mat4.identity(mat4.create()));
      world[12] = x;
      return { ...value, transform: { world } };
    };
    const delta = projection.apply([updateSnapshot(at(1, 0)), updateSnapshot(at(2, 50))]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    if (sceneAvailability.status !== 'available') throw new Error('scene unavailable');
    const scene = sceneAvailability.scene;
    scene.sync(delta, undefined, boundsOf).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const identity: ShadowViewIdentity = { kind: 'spot', index: 0 };
    const input = {
      identity,
      sourcePlan: topology.plan(),
      scene,
      planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    } as const;
    pool.update(input).unwrap();
    pool._commitResourceReplacement();

    // Entity 2 moves from x=50 to x=60: both boxes lie outside the unit clip volume.
    scene.sync(projection.apply([updateSnapshot(at(2, 60))]), undefined, boundsOf).unwrap();
    expect(pool.update(input).unwrap().cache).toBe('hit');
    expect(scene.changedBoundsSince(scene.contentRevision)).toHaveLength(0);

    // Moving into the view is a new box inside it.
    scene.sync(projection.apply([updateSnapshot(at(2, 0.5))]), undefined, boundsOf).unwrap();
    expect(pool.update(input).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('content-changed');
    pool._commitResourceReplacement();

    // Leaving the view is an old box inside it.
    scene.sync(projection.apply([updateSnapshot(at(2, 80))]), undefined, boundsOf).unwrap();
    expect(pool.update(input).unwrap().cache).toBe('invalidated');
    pool._commitResourceReplacement();

    // A change without a conservative box stays a miss.
    scene.sync(projection.apply([updateSnapshot(at(2, 90))])).unwrap();
    expect(pool.update(input).unwrap().cache).toBe('invalidated');
    pool._commitResourceReplacement();

    pool.dispose();
    scene.dispose();
  });

  it('re-rasters only for LOD level changes of casters inside the retained frustum', async () => {
    const { pool, input, identity, dispose } = await lodShadowFixture();

    // Heights within one level move only the cross-fade.
    const nearer = new Map([
      [0, 0.45],
      [1, 0.45],
    ]);
    expect(
      pool.update({ ...input, lodProjectedHeights: nearer, lodSelection: 'near/near*' }).unwrap()
        .cache,
    ).toBe('hit');
    // The out-of-view caster drops a level: its shadow texels are outside this view.
    const farOutside = new Map([
      [0, 0.45],
      [1, 0.05],
    ]);
    expect(
      pool.update({ ...input, lodProjectedHeights: farOutside, lodSelection: 'near/far' }).unwrap()
        .cache,
    ).toBe('hit');
    // The in-view caster drops a level: the retained raster is stale.
    const farInside = new Map([
      [0, 0.05],
      [1, 0.05],
    ]);
    expect(
      pool.update({ ...input, lodProjectedHeights: farInside, lodSelection: 'far/far' }).unwrap()
        .cache,
    ).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('lod-changed');
    dispose();
  });

  it('keeps finer retained levels of a clamped static layer', async () => {
    const clamp = {
      position: new Float32Array(3),
      projection: 'orthographic',
      fov: 0,
      orthoTop: 1,
      orthoBottom: -1,
    } as unknown as LodViewCamera;
    const { pool, input, dispose } = await lodShadowFixture({ lodClampCamera: clamp });
    const heights = (value: number) =>
      new Map([
        [0, value],
        [1, value],
      ]);
    // The reference camera coarsens: the finer retained raster still serves.
    expect(
      pool
        .update({ ...input, lodProjectedHeights: heights(0.05), lodSelection: 'far/far' })
        .unwrap().cache,
    ).toBe('hit');
    // Returning to the retained levels stays a hit.
    expect(
      pool
        .update({ ...input, lodProjectedHeights: heights(0.5), lodSelection: 'near/near' })
        .unwrap().cache,
    ).toBe('hit');
    dispose();

    // Built coarse, a finer selection is too fine for the retained raster.
    const coarse = await lodShadowFixture({
      lodClampCamera: clamp,
      lodProjectedHeights: heights(0.05),
      lodSelection: 'far/far',
    });
    expect(
      coarse.pool
        .update({ ...coarse.input, lodProjectedHeights: heights(0.5), lodSelection: 'near/near' })
        .unwrap().cache,
    ).toBe('invalidated');
    expect(coarse.pool.invalidationReason(coarse.identity)).toBe('lod-changed');
    coarse.dispose();
  });

  it('keeps a static layer cached across out-of-view flips and every spawn', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
      projection.cullingWorldBoundsAt(slot);
    const scene = GpuScene.create(device, 8).unwrap();
    if (scene.status !== 'available') throw new Error('scene unavailable');
    scene.scene
      .sync(
        projection.apply([updateSnapshot(placed(1, 0)), updateSnapshot(placed(2, 50))]),
        undefined,
        boundsOf,
      )
      .unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const identity: ShadowViewIdentity = { kind: 'directional', index: 0, layer: 'static' };
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const staticInput = (candidates: readonly number[], dynamic: ReadonlySet<number>) =>
      ({
        identity,
        sourcePlan: topology.plan(),
        scene: scene.scene,
        planes,
        candidatePrimitiveIndices: candidates,
        ignoredChangeSlots: dynamic,
      }) as const;
    pool.update(staticInput([0, 1], new Set())).unwrap();
    pool._commitResourceReplacement();

    // The out-of-view caster moves and flips to dynamic: no static redraw.
    scene.scene
      .sync(projection.apply([updateSnapshot(placed(2, 60))]), undefined, boundsOf)
      .unwrap();
    const flippedOut = pool.update(staticInput([0], new Set([1]))).unwrap();
    expect(flippedOut.cache).toBe('hit');
    expect(flippedOut.plan.candidateCount).toBe(1);
    // It settles and returns to the static layer while still out of view.
    expect(pool.update(staticInput([0, 1], new Set())).unwrap().cache).toBe('hit');

    // Spawns are dynamic: new plans and new slots, same static members.
    for (let spawn = 3; spawn <= 6; spawn += 1) {
      scene.scene
        .sync(projection.apply([updateSnapshot(placed(spawn, 0.25))]), undefined, boundsOf)
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const spawned = new Set<number>();
      for (const slot of projection.slotsSnapshot()) if (slot.slot > 1) spawned.add(slot.slot);
      expect(pool.update(staticInput([0, 1], spawned)).unwrap().cache).toBe('hit');
    }

    // The in-view caster flips to dynamic: its static shadow must disappear.
    const flippedIn = pool.update(staticInput([1], new Set([0]))).unwrap();
    expect(flippedIn.cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('membership-changed');
    pool.dispose();
    scene.scene.dispose();
  });

  it('ignores changes of slots the view never draws', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
      projection.cullingWorldBoundsAt(slot);
    const at = (entityKey: number, x: number): RenderableSnapshot => {
      const world = new Float32Array(mat4.identity(mat4.create()));
      world[12] = x;
      return { ...snapshot(entityKey), transform: { world } };
    };
    const scene = GpuScene.create(device, 2).unwrap();
    if (scene.status !== 'available') throw new Error('scene unavailable');
    scene.scene
      .sync(
        projection.apply([updateSnapshot(at(1, 0)), updateSnapshot(at(2, 0.25))]),
        undefined,
        boundsOf,
      )
      .unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const identity: ShadowViewIdentity = { kind: 'directional', index: 0, layer: 'static' };
    const dynamicSlots = new Set([1]);
    const input = {
      identity,
      sourcePlan: topology.plan(),
      scene: scene.scene,
      planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      candidatePrimitiveIndices: [0],
      ignoredChangeSlots: dynamicSlots,
    } as const;
    pool.update(input).unwrap();
    pool._commitResourceReplacement();
    expect(shadowViewIdentityKey(identity)).not.toBe(
      shadowViewIdentityKey({ kind: 'directional', index: 0 }),
    );

    // The dynamic caster moves inside the view: the static layer stays cached.
    scene.scene.sync(projection.apply([updateSnapshot(at(2, 0.5))]), undefined, boundsOf).unwrap();
    expect(pool.update(input).unwrap().cache).toBe('hit');
    expect(scene.scene.changedSlotsSince(scene.scene.contentRevision - 1)).toEqual([1]);

    // The static caster moves inside the view: the static layer re-rasters.
    scene.scene.sync(projection.apply([updateSnapshot(at(1, 0.5))]), undefined, boundsOf).unwrap();
    expect(pool.update(input).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('content-changed');

    expect(
      pool.update({ ...input, identity: { kind: 'spot', index: 0, layer: 'final' as never } }).ok,
    ).toBe(false);
    pool.dispose();
    scene.scene.dispose();
  });

  it('keeps the plan identity across transform-only source edits', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1)), updateSnapshot(snapshot(2))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const sourcePlan = topology.plan();
    const moved = new Float32Array(mat4.identity(mat4.create()));
    moved[12] = 4;
    const delta = projection.apply([{ kind: 'update', worldId: 0, entityKey: 1, world: moved }]);
    expect(topology.apply(delta)).toBe(false);
    expect(topology.plan()).toBe(sourcePlan);
    expect(topology.plan().batches[0]).toBe(sourcePlan.batches[0]);
  });

  it('retains a static layer for every light kind', () => {
    expect(shadowViewHasStaticLayer({ kind: 'directional', index: 0 })).toBe(true);
    expect(shadowViewHasStaticLayer({ kind: 'spot', index: 1 })).toBe(true);
    expect(shadowViewHasStaticLayer({ kind: 'point', index: 0, face: 2 })).toBe(true);
    expect(shadowViewHasStaticLayer({ kind: 'spot', index: 1, layer: 'static' })).toBe(false);
  });

  it('uses one texel threshold independently of caster cache classification', () => {
    const ortho = mat4.orthographic(mat4.create(), -32, 32, -32, 32, 0.1, 100);
    const view = mat4.lookAt(mat4.create(), [0, 50, 0], [0, 0, 0], [0, 0, -1]);
    const matrix = new Float32Array(mat4.multiply(mat4.create(), ortho, view));
    const texel = 64 / 2048;
    expect(shadowMinCasterDiameter(matrix, 2048)).toBeCloseTo(texel, 6);
    const perspective = new Float32Array(mat4.perspective(mat4.create(), 1, 1, 0.1, 100));
    expect(shadowMinCasterDiameter(perspective, 2048)).toBe(0);
    expect(shadowMinCasterDiameter(matrix, undefined)).toBe(0);
  });

  it('merges changed boxes into at most four dirty rects and falls back to full', () => {
    const ortho = mat4.orthographic(mat4.create(), -32, 32, -32, 32, 0.1, 100);
    const view = mat4.lookAt(mat4.create(), [0, 50, 0], [0, 0, 0], [0, 0, -1]);
    const matrix = new Float32Array(mat4.multiply(mat4.create(), ortho, view));
    const box = (x: number, z: number, r = 1) => [x - r, -r, z - r, x + r, r, z + r];
    const one = shadowDirtyRects(matrix, [new Float32Array(box(0, 0))]);
    expect(one).toHaveLength(1);
    const [rect] = one ?? [];
    expect(rect?.x0).toBeCloseTo(0.5 - 1 / 64 - 1 / 256, 5);
    expect(rect?.x1).toBeCloseTo(0.5 + 1 / 64 + 1 / 256, 5);
    // Overlapping boxes merge; distant boxes stay separate.
    expect(
      shadowDirtyRects(matrix, [new Float32Array([...box(0, 0), ...box(0.5, 0)])]),
    ).toHaveLength(1);
    expect(
      shadowDirtyRects(matrix, [new Float32Array(box(-20, -20)), new Float32Array(box(20, 20))]),
    ).toHaveLength(2);
    // Off-target boxes contribute nothing.
    expect(shadowDirtyRects(matrix, [new Float32Array(box(500, 0))])).toEqual([]);
    // More than four separated regions merge down to four rects or fall back.
    const scattered = [-24, -8, 8, 24].flatMap((x) => [-24, 24].flatMap((z) => box(x, z)));
    const merged = shadowDirtyRects(matrix, [new Float32Array(scattered)]);
    expect(merged === undefined || merged.length <= 4).toBe(true);
    // Large coverage falls back to a full redraw.
    expect(shadowDirtyRects(matrix, [new Float32Array(box(0, 0, 30))])).toBeUndefined();
    // Too many changed boxes fall back without projecting.
    const many = Array.from({ length: 65 }, (_, i) => box(-30 + i * 0.01, 0, 0.01)).flat();
    expect(shadowDirtyRects(matrix, [new Float32Array(many)])).toBeUndefined();
    // A box behind a perspective eye plane cannot be bounded.
    const perspective = new Float32Array(mat4.perspective(mat4.create(), 1, 1, 0.1, 100));
    expect(shadowDirtyRects(perspective, [new Float32Array(box(0, 0, 0.5))])).toBeUndefined();
  });

  it('redraws only the dirty rects of a static layer with an unchanged matrix', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
      projection.cullingWorldBoundsAt(slot);
    const scene = GpuScene.create(device, 4).unwrap();
    if (scene.status !== 'available') throw new Error('scene unavailable');
    scene.scene
      .sync(
        projection.apply([updateSnapshot(placed(1, -10)), updateSnapshot(placed(2, 10))]),
        undefined,
        boundsOf,
      )
      .unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const ortho = mat4.orthographic(mat4.create(), -32, 32, -32, 32, 0.1, 100);
    const lookAt = mat4.lookAt(mat4.create(), [0, 50, 0], [0, 0, 0], [0, 0, -1]);
    const matrix = new Float32Array(mat4.multiply(mat4.create(), ortho, lookAt));
    const identity: ShadowViewIdentity = { kind: 'directional', index: 0, layer: 'static' };
    const input = (candidates: readonly number[], extra: Partial<{ matrix: Float32Array }> = {}) =>
      ({
        identity,
        sourcePlan: topology.plan(),
        scene: scene.scene,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
        matrix,
        targetSize: 1024,
        graphGeneration: 1,
        candidatePrimitiveIndices: candidates,
        ignoredChangeSlots: new Set<number>(),
        ...extra,
      }) as const;
    pool.update(input([0, 1])).unwrap();
    expect(pool.dirtyRects(identity)).toBeUndefined();
    pool._commitResourceReplacement();

    // One static caster moves: only its old and new footprint re-rasters.
    scene.scene
      .sync(projection.apply([updateSnapshot(placed(1, -12))]), undefined, boundsOf)
      .unwrap();
    expect(pool.update(input([0, 1])).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('content-changed');
    const moved = pool.dirtyRects(identity);
    expect(moved).toHaveLength(1);
    const [rect] = moved ?? [];
    expect(rect?.x1).toBeLessThan(0.5);
    expect(pool.inspect().find((v) => v.identity.layer === 'static')?.dirtyRects).toEqual(moved);
    pool._commitResourceReplacement();

    // A caster leaves the static layer: its footprint is cleared.
    expect(pool.update(input([0])).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('membership-changed');
    const left = pool.dirtyRects(identity);
    expect(left).toHaveLength(1);
    expect(left?.[0]?.x0).toBeGreaterThan(0.5);
    pool._commitResourceReplacement();

    // A changed matrix redraws the layer; graph replacement retains its external depth.
    const shifted = new Float32Array(matrix);
    shifted[12] = (shifted[12] as number) + 0.1;
    expect(pool.update(input([0], { matrix: shifted })).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('view-changed');
    expect(pool.dirtyRects(identity)).toBeUndefined();
    pool._commitResourceReplacement();
    expect(
      pool.update({ ...input([0], { matrix: shifted }), graphGeneration: 2 }).unwrap().cache,
    ).toBe('hit');
    expect(pool.dirtyRects(identity)).toBeUndefined();
    // Content changes still use dirty rectangles across a graph replacement.
    scene.scene
      .sync(projection.apply([updateSnapshot(placed(1, -14))]), undefined, boundsOf)
      .unwrap();
    expect(
      pool.update({ ...input([0], { matrix: shifted }), graphGeneration: 3 }).unwrap().cache,
    ).toBe('invalidated');
    expect(pool.dirtyRects(identity)).toHaveLength(1);
    pool._commitResourceReplacement();
    expect(
      pool
        .update({ ...input([0], { matrix: shifted }), targetSize: 2048, graphGeneration: 4 })
        .unwrap().cache,
    ).toBe('invalidated');
    expect(pool.dirtyRects(identity)).toBeUndefined();
    pool._abortResourceReplacement();
    expect(
      pool
        .update({ ...input([0], { matrix: shifted }), targetSize: 2048, graphGeneration: 4 })
        .unwrap().cache,
    ).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('submit-aborted');
    pool.dispose();
    scene.scene.dispose();
  });
});
