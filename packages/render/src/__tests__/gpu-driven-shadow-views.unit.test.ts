import { existsSync, readFileSync } from 'node:fs';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import { BatchTopology, buildBatchAlignedSubmission } from '../gpu-driven/batch-topology';
import { LOD_VIEW_CONSTANTS_BYTES, writeLodViewConstants } from '../gpu-driven/lod-projection.wgsl';
import { lodViewCameraFromMatrix } from '../gpu-driven/production-raster-lod';
import { ShadowCasterClassifier } from '../gpu-driven/shadow-caster-classes';
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
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { FrameProjection } from '../scene/frame-list';
import { TreeFrame } from '../scene/frame-tree-list';
import { ShadowMaterialContent } from '../scene/material-shadow-content';
import { RenderScene } from '../scene/render-scene';
import { SkinInputs } from '../scene/skin-inputs';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';
import { updateShadowView } from './helpers/gpu-input-read-domain';

const shadowViewsPath = new URL('../gpu-driven/shadow-views.ts', import.meta.url);
const shadowViewsSource = existsSync(shadowViewsPath) ? readFileSync(shadowViewsPath, 'utf8') : '';
const recordFrameSource = readFileSync(new URL('../record/frame.ts', import.meta.url), 'utf8');
const frameGpuDrivenSource = readFileSync(
  new URL('../record/frame-gpu-driven.ts', import.meta.url),
  'utf8',
);
const viewSource = readFileSync(new URL('../gpu-driven/view-gpu.ts', import.meta.url), 'utf8');

const shadowKinds = [
  { name: 'directional cascade', token: 'directional' },
  { name: 'point cube face', token: 'point' },
  { name: 'spot atlas', token: 'spot' },
] as const;

const material = new MaterialResource({
  baseColor: new Float32Array([1, 1, 1]),
  metallic: 0,
  roughness: 1,
} as MaterialSnapshot);

const draw = {
  kind: 'indexed' as const,
  first: 0,
  count: 36,
  baseVertex: 0,
  topology: 'triangle-list' as const,
};
const geometry = {
  draw,
  deformation: 'rigid' as const,
  receipt: {
    identity: 'shadow-box',
    vertexInputs: createStandardPbrArtifactReceipt().vertexInputs,
    indexed: true,
    topology: draw.topology,
  },
};

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
        geometry,
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

async function lodShadowFixture(extra: Partial<ShadowViewUpdateInput> = {}, count = 2) {
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
  const scene = GpuScene.create(device, count).unwrap();
  if (scene.status !== 'available') throw new Error('scene unavailable');
  scene.scene
    .sync(
      projection.apply(
        Array.from({ length: count }, (_, index) => updateSnapshot(lodAt(index + 1, index * 50))),
      ),
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
    sourcePlan: topology.query(topology.sourcePlan(), undefined),
    scene: scene.scene,
    planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    ...extra,
  } as const;
  updateShadowView(pool, input).unwrap();
  pool._commitResourceReplacement();
  return {
    pool,
    input,
    identity,
    projection,
    dispose: () => {
      pool.dispose();
      scene.scene.dispose();
    },
  };
}

describe('GPU-driven shadow view owner contract', () => {
  it('refreshes active Skin depth from current data even when retired root addresses are reused', async () => {
    const f = await lodShadowFixture();
    const skin = new SkinInputs(f.input.scene.inputs.arena);
    const source = skin.source();
    const topology = new BatchTopology();
    const value = preparedPbrSnapshot(snapshot(1));
    topology.apply(
      f.projection.apply([
        updateSnapshot({
          ...value,
          gpuDrivenDraws: (value.gpuDrivenDraws ?? []).map((draw) => ({
            ...draw,
            geometry: { ...draw.geometry, deformation: 'skin' },
            ...(draw.prepared === undefined
              ? {}
              : {
                  prepared: {
                    ...draw.prepared,
                    identity: { ...draw.prepared.identity, deformation: 'skin' },
                  },
                }),
          })),
        }),
      ]),
    );
    const plan = topology.query(topology.sourcePlan(), undefined);
    const prepared = value.gpuDrivenDraws?.[0]?.prepared;
    if (prepared === undefined) throw new Error('Missing prepared Skin fixture');
    const sourcePlan = {
      ...plan,
      batches: plan.batches.map((batch) => ({
        ...batch,
        prepared: { ...prepared, identity: { ...prepared.identity, deformation: 'skin' as const } },
      })),
    };
    expect(sourcePlan.batches.length).toBeGreaterThan(0);
    const matrix = mat4.identity(mat4.create());
    skin.setJoint(source, 7, matrix);
    const capture = () => ({
      slots: f.projection.slotsSnapshot(),
      current: skin.capture(),
      previous: undefined,
    });
    let frame = capture();
    const update = () =>
      updateShadowView(f.pool, { ...f.input, sourcePlan, skin: frame }, sourcePlan).unwrap();
    try {
      expect(update().cache).toBe('invalidated');
      f.pool._commitResourceReplacement();
      expect(update().cache).toBe('invalidated');
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      expect(f.pool.project(graph, f.identity).unwrap().passNames.length).toBeGreaterThan(0);
      const root = frame.current.inputRoot();
      frame.current.release();
      matrix[12] = 1;
      skin.setJoint(source, 7, matrix);
      frame = capture();
      // A physical root/address is not a content identity once its leases end.
      expect(frame.current.inputRoot()).toBe(root);
      expect(update().cache).toBe('invalidated');
      f.pool._commitResourceReplacement();
      expect(update().cache).toBe('invalidated');
      const replacement = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      expect(
        f.pool.project(replacement, f.identity, true).unwrap().passNames.length,
      ).toBeGreaterThan(0);
      f.pool._commitResourceReplacement();
      skin.setJoint(source, 7, matrix);
      frame.current.release();
      frame = capture();
      expect(update().cache).toBe('invalidated');
      const unknown = {
        ...frame,
        current: { root: frame.current.root, jointCapacity: 0 } as typeof frame.current,
      };
      expect(
        updateShadowView(f.pool, { ...f.input, sourcePlan, skin: unknown }, sourcePlan).unwrap()
          .cache,
      ).toBe('invalidated');
      f.pool._commitResourceReplacement();
      expect(update().cache).toBe('invalidated');
    } finally {
      frame.current.release();
      skin.dispose();
      f.dispose();
    }
  });

  it('derives keys from current identity values, including mutable Terrain receiver fields', () => {
    const identity: {
      kind: 'directional';
      index: number;
      face?: number;
      layer?: 'static';
      terrainReceiver?: { worldId: number; entityKey: number };
    } = { kind: 'directional', index: 0 };
    const base = shadowViewIdentityKey(identity);
    expect(shadowViewIdentityKey(identity)).toBe(base);
    identity.layer = 'static';
    expect(shadowViewIdentityKey(identity)).not.toBe(base);
    delete identity.layer;
    expect(shadowViewIdentityKey(identity)).toBe(base);
    identity.terrainReceiver = { worldId: 1, entityKey: 2 };
    const terrain = shadowViewIdentityKey(identity);
    identity.terrainReceiver.entityKey = 3;
    expect(shadowViewIdentityKey(identity)).not.toBe(terrain);
    identity.terrainReceiver.worldId = 2;
    expect(shadowViewIdentityKey(identity)).toBe(shadowViewIdentityKey({ ...identity }));
    identity.face = 5;
    identity.index = 99;
    expect(shadowViewIdentityKey(identity)).toBe(shadowViewIdentityKey({ ...identity }));
  });

  it('reads the owner submission directly and retains older values across transitions', async () => {
    const f = await lodShadowFixture();
    try {
      const first = f.pool.submission(f.identity);
      expect(first).toBeDefined();
      const repeated = f.pool.submission(f.identity);
      expect(repeated).toEqual(first);
      expect(repeated).toBe(first);
      expect(Object.isFrozen(first?.identity)).toBe(true);
      if (first === undefined) throw new Error('Missing submission');
      const borrowed = { ...structuredClone(first.identity) };
      expect(shadowViewIdentityKey(borrowed)).toBe(shadowViewIdentityKey(f.identity));
      borrowed.index++;
      expect(shadowViewIdentityKey(borrowed)).not.toBe(shadowViewIdentityKey(f.identity));
      const topology = f.pool.topologySignature();
      expect(f.pool.activeIdentities()).toEqual([f.identity]);
      updateShadowView(f.pool, f.input).unwrap();
      const hit = f.pool.submission(f.identity);
      expect(hit?.cache).toBe('hit');
      expect(hit).not.toBe(first);
      expect(first?.cache).toBe('invalidated');
      expect(f.pool.submission(f.identity)).toBe(hit);
      expect(f.pool.topologySignature()).toBe(topology);
      f.pool.retain([]);
      expect(f.pool.submission(f.identity)).toBeUndefined();
      expect(f.pool.topologySignature()).toBe('');
      expect(f.pool.activeIdentities()).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it('refreshes topology signatures for resource generations and equal-sized roster changes', async () => {
    const f = await lodShadowFixture();
    try {
      const original = f.pool.topologySignature();
      expect(f.pool.topologySignature()).toBe(original);
      const view = f.pool.submission(f.identity)?.view;
      if (view === undefined) throw new Error('Missing fixture view');
      const generation = view.graphResourceGeneration;
      const observed = vi.spyOn(view, 'graphResourceGeneration', 'get');
      observed.mockReturnValue(generation + 1);
      const resized = f.pool.topologySignature();
      expect(resized).not.toBe(original);
      expect(f.pool.topologySignature()).toBe(resized);
      observed.mockRestore();
      expect(f.pool.topologySignature()).toBe(original);
      const other = { ...f.identity, index: 1 };
      updateShadowView(f.pool, { ...f.input, identity: other }).unwrap();
      f.pool.retain([other]);
      const replaced = f.pool.topologySignature();
      expect(replaced).not.toBe(resized);
      expect(replaced).toContain(shadowViewIdentityKey(other));
      expect(replaced).not.toContain(`${shadowViewIdentityKey(f.identity)}:`);
      expect(f.pool.topologySignature()).toBe(replaced);
      f.pool.retain([]);
      expect(f.pool.topologySignature()).toBe('');
      updateShadowView(f.pool, f.input).unwrap();
      expect(f.pool.topologySignature()).not.toBe('');
    } finally {
      f.dispose();
    }
  });

  it.each([
    'outside',
    'partial',
  ] as const)('preserves retained depth across raw canonical class transitions (%s)', async (mode) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const available = GpuScene.create(device, 4).unwrap();
    if (available.status !== 'available') throw Error('Missing scene');
    const scene = available.scene;
    const topology = new BatchTopology();
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const classifier = new ShadowCasterClassifier();
    const identity = { kind: 'directional', index: 0, layer: 'static' } as const;
    const matrix =
      mode === 'outside'
        ? undefined
        : mat4.multiply(
            mat4.create(),
            mat4.orthographic(mat4.create(), -32, 32, -32, 32, 0.1, 100),
            mat4.lookAt(mat4.create(), [0, 50, 0], [0, 0, 0], [0, 0, -1]),
          );
    const planes = frustum.fromViewProjection(
      frustum.create(),
      matrix ?? mat4.identity(mat4.create()),
    );
    const apply = (entity: number, x: number) => {
      const value = preparedPbrSnapshot({ ...placed(entity, x), assetHandle: entity + 3 });
      scene
        .sync(projection.apply([updateSnapshot(value)]), undefined, (slot) =>
          projection.cullingWorldBoundsAt(slot),
        )
        .unwrap();
    };
    const frame = () => {
      const classes = classifier.update(
        { slots: projection.slotsSnapshot(), slotAt: (slot) => projection.slotAt(slot) },
        scene,
      );
      const sourcePlan = topology.query(topology.sourcePlan(), undefined);
      const result = updateShadowView(pool, {
        identity,
        sourcePlan,
        scene,
        planes,
        ...(matrix === undefined ? {} : { matrix }),
        candidatePrimitiveIndices: classes.staticSlots,
        ignoredChangeSlots: classes.dynamicSlots,
      }).unwrap();
      updateShadowView(pool, {
        identity: { kind: 'directional', index: 0 },
        sourcePlan,
        scene,
        planes,
        candidatePrimitiveIndices: classes.dynamicSlots,
      }).unwrap();
      pool._commitResourceReplacement();
      return result;
    };
    try {
      apply(1, mode === 'outside' ? 0 : -10);
      apply(2, mode === 'outside' ? 50 : 10);
      topology.rebuild(projection.slotsSnapshot());
      frame();
      const baseline = frame();
      const resourceGeneration = baseline.view.computeResourceGeneration;
      const visibleBuffer = baseline.view.visibleBuffer;
      const sceneBuffers = [scene.primitiveBuffer, scene.instanceBuffer, scene.transformBuffer];
      const capacity = scene.rowCapacity;
      apply(mode === 'outside' ? 2 : 1, mode === 'outside' ? 60 : -12);
      const changed = frame();
      expect(changed.view.visibleBuffer).toBe(visibleBuffer);
      expect(scene.rowCapacity).toBe(capacity);
      expect(scene.primitiveBuffer).toBe(sceneBuffers[0]);
      expect(scene.instanceBuffer).toBe(sceneBuffers[1]);
      expect(scene.transformBuffer).toBe(sceneBuffers[2]);
      const detail = JSON.stringify({
        reason: pool.invalidationReason(identity),
        before: resourceGeneration,
        after: changed.view.computeResourceGeneration,
      });
      if (mode === 'outside') expect(changed.cache, detail).toBe('hit');
      else {
        expect(changed.cache).toBe('invalidated');
        expect(pool.dirtyRects(identity), detail).toHaveLength(1);
      }
    } finally {
      pool.dispose();
      scene.dispose();
    }
  });
  it.each([
    'mesh',
    'material',
  ] as const)('captures raw binding facts for a held view when %s changes in place', async (kind) => {
    const f = await lodShadowFixture();
    try {
      const batch = f.input.sourcePlan.batches.at(0);
      if (batch?.binding === undefined) throw new Error('Missing fixture binding');
      const binding = { ...batch.binding };
      const original = { assetHandle: binding.assetHandle, material: binding.material };
      const raw = { ...f.input.sourcePlan, batches: [{ ...batch, binding }] };
      const input = { ...f.input, identity: { ...f.identity, index: 31 }, sourcePlan: raw };
      const first = updateShadowView(f.pool, input).unwrap();
      f.pool._commitResourceReplacement();
      if (kind === 'mesh') binding.assetHandle = 999;
      else
        binding.material = new MaterialResource({
          baseColor: new Float32Array([0, 1, 0]),
          metallic: 0,
          roughness: 1,
        } as MaterialSnapshot);
      expect(first.plan.batches.at(0)?.binding?.assetHandle).toBe(original.assetHandle);
      expect(first.plan.batches.at(0)?.binding?.material).toBe(original.material);
      const next = updateShadowView(f.pool, input).unwrap();
      expect(next.cache).toBe('invalidated');
      expect(next.plan.batches.at(0)?.binding?.assetHandle).toBe(binding.assetHandle);
      expect(next.plan.batches.at(0)?.binding?.material).toBe(binding.material);
      expect(first.plan.batches.at(0)?.binding?.assetHandle).toBe(original.assetHandle);
      expect(first.plan.batches.at(0)?.binding?.material).toBe(original.material);
    } finally {
      f.dispose();
    }
  });

  it('reobserves mutable candidate values without changing an already prepared view', async () => {
    const f = await lodShadowFixture();
    try {
      const batch = f.input.sourcePlan.batches.at(0);
      const original = batch?.candidates.at(0);
      if (batch === undefined || original === undefined)
        throw new Error('Missing fixture candidate');
      const mutable = { ...original };
      const raw = buildBatchAlignedSubmission(
        f.input.sourcePlan,
        new Map([[batch.batchId, [mutable]]]),
      );
      const input = { ...f.input, identity: { ...f.identity, index: 30 }, sourcePlan: raw };
      const first = updateShadowView(f.pool, input).unwrap();
      expect(first.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
      mutable.primitiveIndex = 1;
      expect(first.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
      f.pool._commitResourceReplacement();
      const next = updateShadowView(f.pool, input).unwrap();
      expect(next.cache).toBe('invalidated');
      expect(next.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(1);
      expect(first.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it.each([
    'candidate',
    'entry',
  ] as const)('detaches a raw candidate %s alias from an already prepared view', async (kind) => {
    const f = await lodShadowFixture();
    try {
      const batch = f.input.sourcePlan.batches.at(0);
      const original = batch?.candidates.at(0);
      if (batch === undefined || original === undefined) throw Error('Missing fixture candidate');
      const mutable = { ...original };
      const entry = {
        member: { ...original, entityKey: 1, instanceCount: 1 },
        candidates: mutable,
      };
      const candidates = new FrameProjection(
        new TreeFrame<typeof entry>().with(entry, 0, 0),
        (entry) => entry.candidates,
      );
      expect(MemberCandidates.is(candidates)).toBe(false);
      const sourcePlan = {
        ...f.input.sourcePlan,
        batches: [{ ...batch, candidates }],
        candidateCount: 1,
      };
      const input = { ...f.input, identity: { ...f.identity, index: 35 }, sourcePlan };
      const first = updateShadowView(f.pool, input).unwrap();
      expect(first.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
      if (kind === 'candidate') mutable.primitiveIndex = 1;
      else entry.candidates = { ...mutable, primitiveIndex: 1 };
      expect(candidates.at(0)?.primitiveIndex).toBe(1);
      expect(first.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
      f.pool._commitResourceReplacement();
      const next = updateShadowView(f.pool, input).unwrap();
      expect(next.cache).toBe('invalidated');
      expect(next.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(1);
      expect(first.plan.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('detaches a generic aligned list from a raw mutable root', async () => {
    const f = await lodShadowFixture();
    try {
      const batch = f.input.sourcePlan.batches.at(0);
      const original = batch?.candidates.at(0);
      if (batch === undefined || original === undefined) throw Error('Missing fixture candidate');
      const entry = {
        member: { ...original, entityKey: 1, instanceCount: 1 },
        candidates: { ...original },
      };
      const candidates = new FrameProjection(
        new TreeFrame<typeof entry>().with(entry, 0, 0),
        (entry) => entry.candidates,
      );
      const source = {
        ...f.input.sourcePlan,
        batches: [{ ...batch, candidates }],
        candidateCount: 1,
      };
      const aligned = buildBatchAlignedSubmission(source, new Map([[batch.batchId, candidates]]));
      entry.candidates = { ...original, primitiveIndex: 1 };
      expect(candidates.at(0)?.primitiveIndex).toBe(1);
      expect(aligned.batches.at(0)?.candidates.at(0)?.primitiveIndex).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it('rebinds shared submesh executions without reading 10,000 retained candidate members', async () => {
    const f = await lodShadowFixture({}, 10_000);
    const cleanup: (() => void)[] = [];
    try {
      const batch = f.input.sourcePlan.batches.at(0);
      if (batch === undefined) throw new Error('Missing batch');
      let reads = 0;
      const candidates = batch.candidates;
      const at = MemberCandidates.prototype.at;
      const iterate = MemberCandidates.prototype[Symbol.iterator];
      const lookup = vi.spyOn(MemberCandidates.prototype, 'at').mockImplementation(function (
        this: MemberCandidates,
        index,
      ) {
        reads++;
        return at.call(this, index);
      });
      const iterator = vi
        .spyOn(MemberCandidates.prototype, Symbol.iterator)
        .mockImplementation(function* (this: MemberCandidates) {
          for (const value of iterate.call(this)) {
            reads++;
            yield value;
          }
        });
      cleanup.push(
        () => lookup.mockRestore(),
        () => iterator.mockRestore(),
      );
      expect([...candidates]).toHaveLength(10_000);
      expect(reads).toBe(10_000); // Authenticate actual candidate reads before the quiet controls.
      reads = 0;
      const { lod: _lod, ...withoutLod } = batch;
      const shared = Object.freeze({ ...withoutLod, candidates });
      const source = Object.freeze({ ...f.input.sourcePlan, batches: Object.freeze([shared]) });
      const input = {
        ...f.input,
        sourcePlan: source,
        identity: { ...f.identity, index: 11 },
        shadowMaterials: new ShadowMaterialContent(),
      };
      updateShadowView(f.pool, input, source).unwrap();
      f.pool._commitResourceReplacement();
      reads = 0;
      const numeric = { ...source, batches: [Object.freeze({ ...shared, materialAddress: 128 })] };
      expect(
        updateShadowView(f.pool, { ...input, sourcePlan: numeric }, numeric).unwrap().cache,
      ).toBe('hit');
      expect(reads).toBe(0);
      const structural = {
        ...source,
        batches: [
          shared,
          Object.freeze({
            ...shared,
            batchId: shared.batchId + 1,
            key: { ...shared.key, first: 3, count: 3 },
            visibleBase: 16_384,
            indirectOffset: 20,
          }),
        ],
        visibleCapacity: 26_384,
        candidateCount: 20_000,
      };
      const next = updateShadowView(
        f.pool,
        { ...input, sourcePlan: structural },
        structural,
      ).unwrap();
      expect(next.cache).toBe('invalidated');
      expect(next.plan.batches).toHaveLength(2);
      expect(reads).toBe(0);
      expect(next.plan.batches.at(0)?.candidates).toBe(candidates);
      expect(next.plan.batches.at(1)?.candidates).toBe(candidates);
      expect(source.batches).toHaveLength(1);
    } finally {
      for (const restore of cleanup) restore();
      f.dispose();
    }
  });

  it.each([
    1, 2,
  ])('keeps submitted depth when %i members are selected and only an unselected batch changes', async (selectedCount) => {
    const f = await lodShadowFixture({}, 3);
    try {
      const batch = f.input.sourcePlan.batches.at(0);
      if (batch === undefined) throw new Error('Missing source batch');
      const source = {
        ...f.input.sourcePlan,
        visibleCapacity: 65,
        batches: [batch.candidates.slice(0, 2), batch.candidates.slice(2)].map(
          (candidates, index) =>
            Object.freeze({
              ...batch,
              batchId: index,
              candidates: Object.freeze(candidates),
              visibleCapacity: candidates.length,
              visibleBase: index * 64,
              indirectOffset: index * 20,
            }),
        ),
      };
      const input = {
        ...f.input,
        sourcePlan: source,
        identity: { ...f.identity, index: 10 },
        candidatePrimitiveIndices: Array.from({ length: selectedCount }, (_, index) => index),
      };
      const first = updateShadowView(f.pool, input, source).unwrap();
      f.pool._commitResourceReplacement();
      expect(updateShadowView(f.pool, input, source).unwrap().cache).toBe('hit');
      const changed = {
        ...source,
        batches: source.batches.map((row, index) =>
          index === 0
            ? row
            : Object.freeze({ ...row, materialAddress: (row.materialAddress ?? 0) + 1 }),
        ),
      };
      const next = updateShadowView(f.pool, { ...input, sourcePlan: changed }, changed).unwrap();
      expect(next.cache).toBe('hit');
      expect(next.plan).toBe(first.plan);
    } finally {
      f.dispose();
    }
  });

  it('rejects retained depth after a physical view replacement without external invalidation', async () => {
    const f = await lodShadowFixture({ candidatePrimitiveIndices: [0] });
    try {
      const first = updateShadowView(f.pool, f.input, f.input.sourcePlan).unwrap();
      f.pool._commitResourceReplacement();
      first.view._recoverFromOverflow().unwrap();
      const next = updateShadowView(f.pool, f.input, f.input.sourcePlan).unwrap();
      expect(next.cache).toBe('invalidated');
      expect(f.pool.invalidationReason(f.identity)).toBe('source-changed');
      expect(next.plan).not.toBe(first.plan);
      expect(Reflect.get(next.view, 'bindGroup')).toBeDefined();
      expect(next.view.inspect().batchUploadBytes).toBeGreaterThan(0);
    } finally {
      f.dispose();
    }
  });

  it('borrows complete captured batches while detaching partial and permuted projections', async () => {
    const f = await lodShadowFixture();
    try {
      const source = f.input.sourcePlan;
      const full = updateShadowView(
        f.pool,
        {
          ...f.input,
          identity: { ...f.identity, index: 10 },
          candidatePrimitiveIndices: [1, 0, 1],
        },
        source,
      ).unwrap();
      expect(full.plan).not.toBe(source);
      expect(full.plan.batches.at(0)).toBe(source.batches.at(0));
      expect(full.plan.batches.at(0)?.candidates).toBe(source.batches.at(0)?.candidates);
      const partial = updateShadowView(
        f.pool,
        { ...f.input, identity: { ...f.identity, index: 11 }, candidatePrimitiveIndices: [1] },
        source,
      ).unwrap();
      expect(
        partial.plan.batches.at(0)?.candidates.map((candidate) => candidate.primitiveIndex),
      ).toEqual([1]);
      expect(partial.plan.batches.at(0)?.candidates).not.toBe(source.batches.at(0)?.candidates);
      expect(source.batches.at(0)?.candidates.map((candidate) => candidate.primitiveIndex)).toEqual(
        [0, 1],
      );
      const permuted = buildBatchAlignedSubmission(
        source,
        new Map(source.batches.map((batch) => [batch.batchId, [...batch.candidates].reverse()])),
      );
      const reordered = updateShadowView(
        f.pool,
        {
          ...f.input,
          sourcePlan: permuted,
          identity: { ...f.identity, index: 12 },
          candidatePrimitiveIndices: [0, 1],
        },
        permuted,
      ).unwrap();
      expect(
        reordered.plan.batches.at(0)?.candidates.map((candidate) => candidate.primitiveIndex),
      ).toEqual([0, 1]);
      expect(reordered.plan.batches.at(0)?.candidates).not.toBe(permuted.batches.at(0)?.candidates);
      const raw = updateShadowView(f.pool, {
        ...f.input,
        identity: { ...f.identity, index: 13 },
        candidatePrimitiveIndices: [0, 1],
      }).unwrap();
      expect(raw.plan.batches.at(0)).not.toBe(source.batches.at(0));
    } finally {
      f.dispose();
    }
  });
  it('matches raw projection for overlapping batches, empty selections and sparse slot domains', async () => {
    const f = await lodShadowFixture();
    try {
      const batch = f.input.sourcePlan.batches.at(0);
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
        const raw = updateShadowView(f.pool, {
          ...input,
          identity: { ...f.identity, index: 20 + index * 2 },
        }).unwrap();
        f.pool._commitResourceReplacement();
        const owned = updateShadowView(
          f.pool,
          { ...input, identity: { ...f.identity, index: 21 + index * 2 } },
          source,
        ).unwrap();
        const facts = (plan: typeof raw.plan) => ({
          ...plan,
          batches: [...plan.batches].map((value) => ({
            ...value,
            materialAddress:
              value.materialAddress ??
              (value.binding === undefined
                ? 0
                : (f.input.scene.materialIndexForResource(value.binding.material) ?? 0)),
            geometryAddress:
              value.geometryAddress ??
              (value.binding === undefined
                ? 0
                : (f.input.scene.geometryIndexForResource(
                    value.binding.worldId,
                    value.binding.assetHandle,
                  ) ?? 0)),
            candidates: [...value.candidates],
            ...(value.members === undefined ? {} : { members: [...value.members] }),
          })),
        });
        expect(facts(owned.plan)).toEqual(facts(raw.plan));
        expect(owned.plan).not.toBe(raw.plan);
      }
      expect(source.batches.map((value) => value.batchId)).toEqual([2, 0, 1]);
      expect(source.batches.at(0)?.candidates).toBe(batch.candidates);
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
      updateShadowView(
        f.pool,
        {
          ...f.input,
          sourcePlan: source,
          identity: { ...f.identity, index: 1 },
          candidatePrimitiveIndices: [0],
        },
        owner,
      ).unwrap();
      armed = true;
      let thrown: unknown;
      try {
        updateShadowView(
          f.pool,
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
      const first = updateShadowView(
        f.pool,
        { ...f.input, identity: identity(1), candidatePrimitiveIndices: [0] },
        f.input.sourcePlan,
      ).unwrap();
      const equal = updateShadowView(
        f.pool,
        { ...f.input, identity: identity(2), candidatePrimitiveIndices: new Set([0]) },
        f.input.sourcePlan,
      ).unwrap();
      expect(equal.plan).toBe(first.plan);
      const other = updateShadowView(
        f.pool,
        { ...f.input, identity: identity(3), candidatePrimitiveIndices: [1] },
        f.input.sourcePlan,
      ).unwrap();
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
      const replaced = updateShadowView(
        f.pool,
        {
          ...f.input,
          identity: identity(4),
          sourcePlan: source,
          candidatePrimitiveIndices: [0],
        },
        source,
      ).unwrap();
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
      const first = updateShadowView(f.pool, { ...f.input, ...moved }, f.input.sourcePlan).unwrap();
      const second = updateShadowView(f.pool, other, f.input.sourcePlan).unwrap();
      expect(second.plan).toBe(first.plan);
      f.pool._commitResourceReplacement();

      updateShadowView(f.pool, { ...other, ...moved }, f.input.sourcePlan).unwrap();
      f.pool._abortResourceReplacement();
      const pending = updateShadowView(f.pool, f.input, f.input.sourcePlan).unwrap();
      expect(pending.plan).toBe(first.plan);
      const retry = updateShadowView(f.pool, { ...other, ...moved }, f.input.sourcePlan).unwrap();
      expect(retry.plan).not.toBe(first.plan);
      expect(retry.plan.batches).toEqual(first.plan.batches);
      expect(retry.view.visibleBuffer).toBe(second.view.visibleBuffer);
      // The aborted view needs a fresh plan and redraw, while the accepted
      // task bytes remain identical. Its member subset stays encoded while
      // the view holds it, so neither member nodes nor task words re-upload.
      expect(retry.view.inspect().sharedInputUploadBytes).toBe(0);
      expect(retry.view.inspect().batchUploadBytes).toBe(0);
      expect(retry.view.inspect().viewConstantsUploadBytes).toBeGreaterThan(0);
      expect(f.pool.invalidationReason(other.identity)).toBe('submit-aborted');
      f.pool._commitResourceReplacement();
      expect(
        updateShadowView(f.pool, { ...other, ...moved }, f.input.sourcePlan).unwrap().cache,
      ).toBe('hit');

      const visible = retry.view.visibleBuffer;
      retry.view._recoverFromOverflow().unwrap();
      f.pool.invalidate('artifact-changed', other.identity);
      const recovered = updateShadowView(
        f.pool,
        { ...other, ...moved },
        f.input.sourcePlan,
      ).unwrap();
      expect(recovered.view.visibleBuffer).not.toBe(visible);
      expect(recovered.plan).not.toBe(retry.plan);
      // Replacement storage re-uploads the view's task words; its held member
      // encoding in the shared scene input stays valid.
      expect(recovered.view.inspect().sharedInputUploadBytes).toBe(0);
      expect(recovered.view.inspect().batchUploadBytes).toBeGreaterThan(0);
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
    expect(frameGpuDrivenSource).not.toMatch(/cacheToken|shadowViewToken/);
    expect(recordFrameSource).toMatch(/graphShadowMapSize,\s*frameState\.graphGeneration,/);
    expect(frameGpuDrivenSource).toMatch(/targetSize,\s*graphGeneration,/);
    expect(shadowViewsSource).not.toMatch(/cacheToken/);
  });

  it('reuses each view on a cache hit and invalidates only that view', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const sceneAvailability = GpuScene.create(device, 8).unwrap();
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
      let input = {
        identity,
        sourcePlan: topology.query(topology.sourcePlan(), undefined),
        scene: sceneAvailability.scene,
        planes,
        targetSize: 1024,
        graphGeneration: 1,
        candidatePrimitiveIndices: [0],
      } as const;
      const first = updateShadowView(pool, input).unwrap();
      expect(first.cache).toBe('invalidated');
      expect(first.plan.candidateCount).toBe(1);
      expect(pool.invalidationReason(identity)).toBe('first-publication');
      const firstInspection = first.view.inspect();

      // Cache reuse is published only after the frame's successful submit
      // commit. The unit fixture explicitly advances that transaction before
      // asking the pool for a hit.
      pool._commitResourceReplacement();

      const hit = updateShadowView(pool, input).unwrap();
      expect(hit.cache).toBe('hit');
      expect(hit.generation).toBe(first.generation);
      expect(pool.invalidationReason(identity)).toBeUndefined();
      expect(hit.view.inspect().updateCount).toBe(firstInspection.updateCount);
      const equalCopy = updateShadowView(pool, {
        ...input,
        planes: new Float32Array(planes),
        candidatePrimitiveIndices: [0],
      }).unwrap();
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

      const movedPlanes = frustum.create();
      movedPlanes.set(planes);
      movedPlanes[0] = (movedPlanes[0] ?? 0) + 0.01;
      const payloadOnly = updateShadowView(pool, {
        ...input,
        planes: movedPlanes,
      }).unwrap();
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
      // This raw subset captures a fresh member node, its one record and its root word.
      expect(payloadOnly.view.inspect()).toMatchObject({
        sharedInputUploadBytes: 52,
        batchUploadBytes: 4,
      });
      pool._commitResourceReplacement();
      input = { ...input, planes: movedPlanes };

      // Parameter-only adoption keeps the accepted source binding. Replacing
      // the resource would require a new topology publication and may grow its
      // physical table, which is a distinct source-change invalidation.
      material.adopt({
        ...material.snapshot,
        baseColor: vec3.create((material.snapshot.baseColor[0] ?? 1) * 0.5, 1, 1),
      });
      sceneAvailability.scene
        .sync({
          ...projection.apply([]),
          materialUpdates: [material],
        })
        .unwrap();
      expect(updateShadowView(pool, input).unwrap().cache).toBe('hit');
      const movedWorld = mat4.identity(mat4.create());
      movedWorld[12] = 0.01 + (projection.slotAt(0)?.snapshot.transform.world[12] ?? 0);
      sceneAvailability.scene
        .sync(projection.apply([{ kind: 'update', worldId: 0, entityKey: 1, world: movedWorld }]))
        .unwrap();
      const contentInvalidated = updateShadowView(pool, input).unwrap();
      expect(contentInvalidated.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('content-changed');
      pool._commitResourceReplacement();
      const membershipChanged = updateShadowView(pool, {
        ...input,
        candidatePrimitiveIndices: [],
      }).unwrap();
      expect(membershipChanged.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('membership-changed');
      pool._abortResourceReplacement();
      expect(pool.invalidationReason(identity)).toBe('submit-aborted');
      expect(
        pool.inspect().find((view) => view.identity.kind === identity.kind)?.invalidationReason,
      ).toBe('submit-aborted');
      expect(updateShadowView(pool, input).unwrap().cache).toBe('invalidated');
      pool._commitResourceReplacement();

      const regenerated = updateShadowView(pool, { ...input, graphGeneration: 2 }).unwrap();
      expect(regenerated.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('graph-compiled');
      pool._commitResourceReplacement();
      expect(updateShadowView(pool, { ...input, graphGeneration: 2 }).unwrap().cache).toBe('hit');
      const resized = updateShadowView(pool, { ...input, targetSize: 2048 }).unwrap();
      expect(resized.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('configuration-changed');
      pool._commitResourceReplacement();

      pool.invalidate('artifact-changed', identity);
      const invalidated = updateShadowView(pool, input).unwrap();
      expect(invalidated.cache).toBe('invalidated');
      expect(pool.invalidationReason(identity)).toBe('artifact-changed');
      expect(invalidated.generation).toBe(first.generation + 7);
      // The earlier forced graph projection refreshed its compute inputs once.
      expect(invalidated.view.inspect().updateCount).toBe(firstInspection.updateCount + 8);
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
    const sceneAvailability = GpuScene.create(device, 8).unwrap();
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
      const result = updateShadowView(pool, {
        identity,
        sourcePlan: topology.query(topology.sourcePlan(), undefined),
        scene,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
        matrix,
        cameraCull,
      }).unwrap();
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
    const sceneAvailability = GpuScene.create(device, 8).unwrap();
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
      sourcePlan: topology.query(topology.sourcePlan(), undefined),
      scene,
      planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    } as const;
    updateShadowView(pool, input).unwrap();
    pool._commitResourceReplacement();

    // Entity 2 moves from x=50 to x=60: both boxes lie outside the unit clip volume.
    scene.sync(projection.apply([updateSnapshot(at(2, 60))]), undefined, boundsOf).unwrap();
    expect(updateShadowView(pool, input).unwrap().cache).toBe('hit');
    expect(scene.changedBoundsSince(scene.contentRevision)).toHaveLength(0);

    // Moving into the view is a new box inside it.
    scene.sync(projection.apply([updateSnapshot(at(2, 0.5))]), undefined, boundsOf).unwrap();
    expect(updateShadowView(pool, input).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('content-changed');
    pool._commitResourceReplacement();

    // Leaving the view is an old box inside it.
    scene.sync(projection.apply([updateSnapshot(at(2, 80))]), undefined, boundsOf).unwrap();
    expect(updateShadowView(pool, input).unwrap().cache).toBe('invalidated');
    pool._commitResourceReplacement();

    // A change without a conservative box stays a miss.
    scene.sync(projection.apply([updateSnapshot(at(2, 90))])).unwrap();
    expect(updateShadowView(pool, input).unwrap().cache).toBe('invalidated');
    pool._commitResourceReplacement();

    pool.dispose();
    scene.dispose();
  });

  it.each([
    true,
    false,
  ])('writes the shadow LOD cap flag only for a light-matrix view (matrix: %s)', async (lightView) => {
    const matrix = new Float32Array(
      mat4.orthographic(mat4.create(), -400, 400, -400, 400, 0.1, 100),
    );
    const lodCamera = lodViewCameraFromMatrix(matrix);
    const f = await lodShadowFixture(lightView ? { matrix, lodCamera } : { lodCamera });
    try {
      const { view } = updateShadowView(f.pool, f.input).unwrap();
      const uploaded = (view as unknown as { viewUpload: Uint8Array }).viewUpload;
      const row = (clamp: boolean) => {
        const bytes = new Uint8Array(LOD_VIEW_CONSTANTS_BYTES);
        writeLodViewConstants(new DataView(bytes.buffer), 0, lodCamera, clamp);
        return Buffer.from(bytes);
      };
      // The light-matrix view is the only producer of the clamp flag; no
      // main-camera height or level reaches its constants.
      expect(Buffer.from(uploaded).indexOf(row(lightView))).toBeGreaterThanOrEqual(0);
      expect(Buffer.from(uploaded).indexOf(row(!lightView))).toBe(-1);
    } finally {
      f.dispose();
    }
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
        sourcePlan: topology.query(topology.sourcePlan(), undefined),
        scene: scene.scene,
        planes,
        candidatePrimitiveIndices: candidates,
        ignoredChangeSlots: dynamic,
      }) as const;
    updateShadowView(pool, staticInput([0, 1], new Set())).unwrap();
    pool._commitResourceReplacement();

    // The out-of-view caster moves and flips to dynamic: no static redraw.
    scene.scene
      .sync(projection.apply([updateSnapshot(placed(2, 60))]), undefined, boundsOf)
      .unwrap();
    const flippedOut = updateShadowView(pool, staticInput([0], new Set([1]))).unwrap();
    expect(flippedOut.cache).toBe('hit');
    expect(flippedOut.plan.candidateCount).toBe(1);
    // It settles and returns to the static layer while still out of view.
    expect(updateShadowView(pool, staticInput([0, 1], new Set())).unwrap().cache).toBe('hit');

    // Spawns are dynamic: new plans and new slots, same static members.
    for (let spawn = 3; spawn <= 6; spawn += 1) {
      scene.scene
        .sync(projection.apply([updateSnapshot(placed(spawn, 0.25))]), undefined, boundsOf)
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const spawned = new Set<number>();
      for (const slot of projection.slotsSnapshot()) if (slot.slot > 1) spawned.add(slot.slot);
      expect(updateShadowView(pool, staticInput([0, 1], spawned)).unwrap().cache).toBe('hit');
    }

    // The in-view caster flips to dynamic: its static shadow must disappear.
    const flippedIn = updateShadowView(pool, staticInput([1], new Set([0]))).unwrap();
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
    const scene = GpuScene.create(device, 8).unwrap();
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
      sourcePlan: topology.query(topology.sourcePlan(), undefined),
      scene: scene.scene,
      planes: frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      candidatePrimitiveIndices: [0],
      ignoredChangeSlots: dynamicSlots,
    } as const;
    updateShadowView(pool, input).unwrap();
    pool._commitResourceReplacement();
    expect(shadowViewIdentityKey(identity)).not.toBe(
      shadowViewIdentityKey({ kind: 'directional', index: 0 }),
    );

    // The dynamic caster moves inside the view: the static layer stays cached.
    scene.scene.sync(projection.apply([updateSnapshot(at(2, 0.5))]), undefined, boundsOf).unwrap();
    expect(updateShadowView(pool, input).unwrap().cache).toBe('hit');
    expect(scene.scene.changedSlotsSince(scene.scene.contentRevision - 1)).toEqual([1]);

    // The static caster moves inside the view: the static layer re-rasters.
    scene.scene.sync(projection.apply([updateSnapshot(at(1, 0.5))]), undefined, boundsOf).unwrap();
    expect(updateShadowView(pool, input).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('content-changed');

    expect(
      updateShadowView(pool, {
        ...input,
        identity: { kind: 'spot', index: 0, layer: 'final' as never },
      }).ok,
    ).toBe(false);
    pool.dispose();
    scene.scene.dispose();
  });

  it('keeps the plan identity across transform-only source edits', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1)), updateSnapshot(snapshot(2))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const sourcePlan = topology.query(topology.sourcePlan(), undefined);
    const moved = new Float32Array(mat4.identity(mat4.create()));
    moved[12] = 4;
    const delta = projection.apply([{ kind: 'update', worldId: 0, entityKey: 1, world: moved }]);
    expect(topology.apply(delta)).toBe(false);
    expect(topology.query(topology.sourcePlan(), undefined)).toBe(sourcePlan);
    expect(topology.query(topology.sourcePlan(), undefined).batches.at(0)).toBe(
      sourcePlan.batches.at(0),
    );
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
        sourcePlan: topology.query(topology.sourcePlan(), undefined),
        scene: scene.scene,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
        matrix,
        targetSize: 1024,
        graphGeneration: 1,
        candidatePrimitiveIndices: candidates,
        ignoredChangeSlots: new Set<number>(),
        ...extra,
      }) as const;
    updateShadowView(pool, input([0, 1])).unwrap();
    expect(pool.dirtyRects(identity)).toBeUndefined();
    pool._commitResourceReplacement();

    // One static caster moves: only its old and new footprint re-rasters.
    scene.scene
      .sync(projection.apply([updateSnapshot(placed(1, -12))]), undefined, boundsOf)
      .unwrap();
    expect(updateShadowView(pool, input([0, 1])).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('content-changed');
    const moved = pool.dirtyRects(identity);
    expect(moved).toHaveLength(1);
    const [rect] = moved ?? [];
    expect(rect?.x1).toBeLessThan(0.5);
    expect(pool.inspect().find((v) => v.identity.layer === 'static')?.dirtyRects).toEqual(moved);
    pool._commitResourceReplacement();

    // A caster leaves the static layer: its footprint is cleared.
    expect(updateShadowView(pool, input([0])).unwrap().cache).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('membership-changed');
    const left = pool.dirtyRects(identity);
    expect(left).toHaveLength(1);
    expect(left?.[0]?.x0).toBeGreaterThan(0.5);
    pool._commitResourceReplacement();

    // A changed matrix redraws the layer; graph replacement retains its external depth.
    const shifted = new Float32Array(matrix);
    shifted[12] = (shifted[12] as number) + 0.1;
    expect(updateShadowView(pool, input([0], { matrix: shifted })).unwrap().cache).toBe(
      'invalidated',
    );
    expect(pool.invalidationReason(identity)).toBe('view-changed');
    expect(pool.dirtyRects(identity)).toBeUndefined();
    pool._commitResourceReplacement();
    expect(
      updateShadowView(pool, { ...input([0], { matrix: shifted }), graphGeneration: 2 }).unwrap()
        .cache,
    ).toBe('hit');
    expect(pool.dirtyRects(identity)).toBeUndefined();
    // Content changes still use dirty rectangles across a graph replacement.
    scene.scene
      .sync(projection.apply([updateSnapshot(placed(1, -14))]), undefined, boundsOf)
      .unwrap();
    expect(
      updateShadowView(pool, { ...input([0], { matrix: shifted }), graphGeneration: 3 }).unwrap()
        .cache,
    ).toBe('invalidated');
    expect(pool.dirtyRects(identity)).toHaveLength(1);
    pool._commitResourceReplacement();
    expect(
      updateShadowView(pool, {
        ...input([0], { matrix: shifted }),
        targetSize: 2048,
        graphGeneration: 4,
      }).unwrap().cache,
    ).toBe('invalidated');
    expect(pool.dirtyRects(identity)).toBeUndefined();
    pool._abortResourceReplacement();
    expect(
      updateShadowView(pool, {
        ...input([0], { matrix: shifted }),
        targetSize: 2048,
        graphGeneration: 4,
      }).unwrap().cache,
    ).toBe('invalidated');
    expect(pool.invalidationReason(identity)).toBe('submit-aborted');
    pool.dispose();
    scene.scene.dispose();
  });
});
