import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { GpuInputArena } from '../gpu-input-arena';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { shadowViewContains } from '../record/shadow-culling';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
  RenderScene,
} from '../scene/render-scene';
import { SkinInputs } from '../scene/skin-inputs';
import { SkinSceneInputs } from '../scene/skin-scene-inputs';
import { StableRangeAllocator } from '../stable-range-allocator';
import { testAssets } from './helpers/runtime-assets';

function matrix(x = 0) {
  const out = mat4.identity(mat4.create());
  out[12] = x;
  return out;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixed Scene fact');
  return value;
}
function fixture() {
  const world = new World();
  testAssets(world);
  const arena = new GpuInputArena(),
    scene = new RenderScene([worldRenderResources(world)]);
  const attributes = {
    position: new Float32Array([0, 0, 0.3, 0.2, 0, 0.3, 0, 0.2, 0.3]),
    skinIndex: new Uint16Array(12),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const mesh: MeshAsset = {
    kind: 'mesh',
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    indices: new Uint16Array([0, 1, 2]),
    aabb: new Float32Array([0, 0, 0.3, 0.2, 0.2, 0.3]),
    materialSlots: [{ slotName: 'surface' }],
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
  };
  const handle = testAssets(world).create(mesh).unwrap();
  const material = MaterialResource.from(defaultMaterialSnapshot());
  const source: RenderableSnapshot = {
    worldId: 0,
    entityKey: 17,
    assetHandle: handle,
    transform: { world: matrix(100) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    // This deliberately has no per-Skin local AABB or materialized palette.
    skinBinding: { skeleton: 7, joints: [19] },
  };
  const skin = new SkinSceneInputs(arena, () => ({
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: matrix(),
  }));
  const before = scene.slotsSnapshot();
  skin.apply(
    before,
    scene.apply([{ kind: 'update', worldId: 0, entityKey: 17, snapshot: source }]),
  );
  skin.joint(0, 19, matrix());
  return { arena, scene, skin, source, mesh };
}

it('uses the fixed pose and shared Mesh for actual light culling without a per-Skin AABB', () => {
  const { arena, scene, skin, source } = fixture();
  const frame = required(skin.prepareFrame(scene.slotsSnapshot())),
    slot = required(frame.slots.lookup(0, 17));
  const out = box3.create(),
    matrixRead = vi.spyOn(SkinInputs.prototype, 'bind');
  const bounds = (row: RenderableSnapshot, destination: box3.Box3) => {
    const selected = frame.slots.lookup(row.worldId, row.entityKey);
    return (
      selected !== undefined &&
      scene.writeCullingWorldBoundsAt(selected, destination, scene.meshFrame(), undefined, frame)
    );
  };
  const planes = frustum.fromViewProjection(frustum.create(), matrix());
  try {
    expect(scene.cullingWorldBoundsAt(slot)).toBeUndefined();
    expect(scene.writeCullingWorldBoundsAt(slot, out, scene.meshFrame(), undefined, frame)).toBe(
      true,
    );
    expect(out[0]).toBeLessThanOrEqual(0);
    expect(out[3]).toBeGreaterThanOrEqual(0.2);
    expect(out[3]).toBeLessThan(1); // Renderable world x=100 is not applied twice.
    skin.joint(0, 19, matrix(8));
    for (let view = 0; view < 4; view++)
      expect(shadowViewContains(source, planes, bounds)).toBe(true);
    expect(matrixRead).not.toHaveBeenCalled();
    skin.discardFrame();
    const next = required(skin.prepareFrame(scene.slotsSnapshot()));
    const nextBounds = (row: RenderableSnapshot, destination: box3.Box3) => {
      const selected = next.slots.lookup(row.worldId, row.entityKey);
      return (
        selected !== undefined &&
        scene.writeCullingWorldBoundsAt(selected, destination, scene.meshFrame(), undefined, next)
      );
    };
    expect(shadowViewContains(source, planes, nextBounds)).toBe(false);
  } finally {
    matrixRead.mockRestore();
    skin.dispose();
    arena.dispose();
  }
});

it('never substitutes bind pose for missing current input, a foreign Scene slot, or unknown geometry', () => {
  const { arena, scene, skin, source, mesh } = fixture();
  const frame = required(skin.prepareFrame(scene.slotsSnapshot())),
    slot = required(frame.slots.lookup(0, 17)),
    out = box3.create();
  try {
    out.fill(123);
    expect(scene.writeCullingWorldBoundsAt(slot, out)).toBe(false);
    expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
    const before = scene.slotsSnapshot();
    skin.apply(
      before,
      scene.apply([
        { kind: 'remove', worldId: 0, entityKey: 17 },
        { kind: 'update', worldId: 0, entityKey: 17, snapshot: source },
      ]),
    );
    const replacement = required(scene.slot(0, 17));
    expect(replacement.generation).not.toBe(slot.generation);
    expect(
      scene.writeCullingWorldBoundsAt(replacement, out, scene.meshFrame(), undefined, frame),
    ).toBe(false);
    expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
    const unsupported = scene.meshFrame().with(0, source.assetHandle as number, {
      ...mesh,
      morphTargets: [],
      attributes: { ...mesh.attributes, skinWeight: new Float32Array(12) },
    });
    expect(scene.writeCullingWorldBoundsAt(slot, out, unsupported, undefined, frame)).toBe(false);
    expect(Array.from(out)).toEqual([123, 123, 123, 123, 123, 123]);
    // The held old Scene/root pair remains readable after slot recreation.
    expect(scene.writeCullingWorldBoundsAt(slot, out, scene.meshFrame(), undefined, frame)).toBe(
      true,
    );
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('never grants a custom vertex program the stock Skin position enclosure from its input layout', () => {
  const { arena, scene, skin, source } = fixture();
  const custom = MaterialResource.from({
    ...source.material.snapshot,
    positionBounds: undefined,
    materialShaderId: 'game::arbitrary-vertex',
  });
  const before = scene.slotsSnapshot();
  skin.apply(
    before,
    scene.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 17,
        snapshot: { ...source, material: custom, materials: [custom] },
      },
    ]),
  );
  const fixed = required(skin.prepareFrame(scene.slotsSnapshot())),
    slot = required(fixed.slots.lookup(0, 17)),
    out = box3.create();
  try {
    out.fill(123);
    expect(scene.writeCullingWorldBoundsAt(slot, out, scene.meshFrame(), undefined, fixed)).toBe(
      false,
    );
    expect([...out]).toEqual([123, 123, 123, 123, 123, 123]);
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

function persistentFixture() {
  const f = fixture(),
    world = new World();
  registerPropagateTransforms(world);
  const mesh = testAssets(world).create(f.mesh).unwrap();
  const skeleton = testAssets(world)
    .create({ kind: 'skeleton', jointCount: 1, inverseBindMatrices: matrix() })
    .unwrap();
  f.skin.dispose();
  f.arena.dispose();
  const joint = world.spawn({ component: Transform, data: {} }).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [100, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
      { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1 } },
    )
    .unwrap();
  world.update(0).unwrap();
  const scene = new PersistentRenderScene(),
    lease = createRenderReadLease(world),
    assets = testAssets(world);
  const source: RenderableSnapshot = {
    ...f.source,
    entityKey: entity,
    assetHandle: mesh,
    skinBinding: { skeleton, joints: [joint] },
  };
  const requests: PersistentRenderCandidateRequest[] = [];
  const build = (request: PersistentRenderCandidateRequest) => {
    requests.push(request);
    const metadata = extractFrames([world], 0, assets, undefined, {
      renderables: 'none',
      cull: 'none',
    });
    const selected =
      request === 'none' ? false : request === 'full' || request.entitiesByWorld[0]?.has(entity);
    return { ...metadata, renderables: selected ? [source] : [], dispatch: [] };
  };
  const extract = () =>
    scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, assets, build, [lease]);
  const x = (frame: ReturnType<PersistentRenderScene['skinRecordingFrame']>) => {
    const fixed = required(frame),
      slot = required(fixed.slots.lookup(0, entity)),
      out = mat4.create();
    expect(fixed.current.matrix(slot.slot, 0, out, mat4.create())).toBe(true);
    return out[12];
  };
  return { world, scene, lease, joint, entity, requests, extract, x };
}

it('admits local static Scene edits once and reads changed joints before actual camera and shadow culling', () => {
  const f = persistentFixture(),
    binds = vi.spyOn(SkinInputs.prototype, 'bind');
  try {
    const first = f.extract(),
      fixed = required(f.scene.skinRecordingFrame());
    expect(first.renderables.length).toBe(1);
    expect(f.x(fixed)).toBe(0);
    const slot = f.scene.compositionSlot(0, f.entity);
    binds.mockClear();
    f.requests.length = 0;
    f.world.set(f.joint, Transform, { pos: [8, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const changed = f.extract(),
      next = required(f.scene.skinRecordingFrame());
    expect(f.x(next)).toBe(8);
    expect(f.scene.compositionSlot(0, f.entity)).toBe(slot);
    expect(binds).not.toHaveBeenCalled();
    expect(f.requests).toEqual(['none']); // No Skin consumer extraction for a changed joint.
    expect(changed.renderables.length).toBe(0);
    const caster = required(f.scene.shadowCasterProjection()),
      source = required(caster.renderables.at(0)),
      out = box3.create();
    expect(caster.worldBoundsOf(source, out)).toBe(true);
    expect(out[0]).toBeGreaterThan(7);
    f.scene.discardSkinFrame();
    expect(() => f.x(next)).toThrow();
  } finally {
    binds.mockRestore();
    f.lease.dispose();
    f.scene.dispose();
  }
});

it('answers out-of-frame bounds queries from the latest adopted Skin pose', () => {
  const f = persistentFixture();
  try {
    f.extract();
    f.scene.discardSkinFrame();
    expect(f.scene.bounds(f.world, f.entity)?.min[0]).toBeLessThan(1);
    f.world.set(f.joint, Transform, { pos: [8, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    f.extract();
    f.scene.discardSkinFrame();
    // No recording is open; the query neither needs one nor advances history.
    expect(f.scene.skinRecordingFrame()).toBeUndefined();
    const moved = required(f.scene.bounds(f.world, f.entity));
    expect(moved.min[0]).toBeGreaterThan(7);
    expect(f.scene.skinRecordingFrame()).toBeUndefined();
  } finally {
    f.lease.dispose();
    f.scene.dispose();
  }
});

it('keeps submitted roots through physical completion, advances only accepted Scene history, and resets on recovery', async () => {
  const f = persistentFixture();
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  try {
    f.extract();
    const a = required(f.scene.skinRecordingFrame());
    const release = required(f.scene.submitSkinFrame(done, true));
    f.world.set(f.joint, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    f.extract();
    const b = required(f.scene.skinRecordingFrame());
    expect(f.x(a)).toBe(0);
    expect(f.x(b)).toBe(2);
    expect(b.previous?.jointCapacity).toBeGreaterThan(0);
    await f.scene.submitSkinFrame(Promise.resolve(), false);
    f.world.set(f.joint, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    f.extract();
    const c = required(f.scene.skinRecordingFrame()),
      currentSlot = required(c.slots.lookup(0, f.entity)),
      previous = required(c.previous),
      out = mat4.create();
    expect(previous.matrix(currentSlot.slot, 0, out, mat4.create())).toBe(true);
    expect(out[12]).toBe(0);
    f.scene.resetGpuForRecover();
    expect(() => f.x(c)).toThrow();
    expect(f.x(a)).toBe(0); // Physical A is independent of discarded history/recovery.
    f.extract();
    expect(f.scene.skinRecordingFrame()?.previous).toBeUndefined();
    expect(f.x(f.scene.skinRecordingFrame())).toBe(3);
    complete();
    await release;
    expect(() => f.x(a)).toThrow();
  } finally {
    complete();
    f.lease.dispose();
    f.scene.dispose();
  }
});

it('retires a deleted referenced joint without republishing its Skin consumer', () => {
  const f = persistentFixture();
  try {
    f.extract();
    f.requests.length = 0;
    f.world.despawn(f.joint as EntityHandle).unwrap();
    f.world.update(0).unwrap();
    f.extract();
    const fixed = required(f.scene.skinRecordingFrame()),
      slot = required(fixed.slots.lookup(0, f.entity));
    expect(fixed.current.available(slot.slot)).toBe(false);
    expect(f.requests).toEqual(['none']);
  } finally {
    f.lease.dispose();
    f.scene.dispose();
  }
});

it('rebuilds the accepted Scene after partial Skin adoption fails instead of retrying a poisoned owner', () => {
  const f = persistentFixture(),
    failure = new Error('known numeric row write failure');
  const bind = vi.spyOn(SkinInputs.prototype, 'bind').mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(f.extract).toThrow(failure);
    expect(f.scene.compositionSlot(0, f.entity)).toBeUndefined();
    expect(f.scene.skinRecordingFrame()).toBeUndefined();
    expect(f.extract().renderables.length).toBe(1);
    expect(f.x(f.scene.skinRecordingFrame())).toBe(0);
  } finally {
    bind.mockRestore();
    f.lease.dispose();
    f.scene.dispose();
  }
});

it('rebuilds from source facts after the shared numeric allocator itself is poisoned', () => {
  const f = persistentFixture();
  let arena: GpuInputArena | undefined;
  const allocate = GpuInputArena.prototype.allocateDescriptor;
  const capture = vi
    .spyOn(GpuInputArena.prototype, 'allocateDescriptor')
    .mockImplementation(function (this: GpuInputArena, count) {
      arena ??= this;
      return allocate.call(this, count);
    });
  try {
    f.extract();
    const oldArena = required(arena),
      ranges = Reflect.get(oldArena, 'ranges');
    const original = StableRangeAllocator.prototype.release;
    let injected = false;
    const release = vi
      .spyOn(StableRangeAllocator.prototype, 'release')
      .mockImplementation(function (this: StableRangeAllocator, start, count) {
        if (this === ranges && !injected) {
          injected = true;
          throw new Error('numeric allocator retirement failure');
        }
        return original.call(this, start, count);
      });
    try {
      expect(() => f.scene.invalidate()).toThrow();
    } finally {
      release.mockRestore();
    }
    expect(injected).toBe(true);
    expect(() => oldArena.assertLive()).toThrow();
    f.world.set(f.joint, Transform, { pos: [0.25, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    arena = undefined;
    expect(f.extract().renderables.length).toBe(1);
    expect(arena).toBeDefined();
    expect(arena).not.toBe(oldArena);
    expect(f.x(f.scene.skinRecordingFrame())).toBe(0.25);
  } finally {
    capture.mockRestore();
    f.lease.dispose();
    f.scene.dispose();
  }
});

it('transfers physical reads before a post-submit observer detaches the exact Scene', async () => {
  const f = persistentFixture();
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  try {
    f.extract();
    const a = required(f.scene.skinRecordingFrame());
    const released = required(f.scene.trackSkinSubmittedWork(done));
    f.scene.detach(f.world); // Same ordinary owner edge used by renderer.detachScene.
    expect(f.scene.skinRecordingFrame()).toBeUndefined();
    expect(f.scene.submitSkinFrame(done, true)).toBeUndefined();
    expect(f.x(a)).toBe(0); // GPU completion, not Scene/feature teardown, owns this read.
    complete();
    await released;
    expect(() => f.x(a)).toThrow();
  } finally {
    complete();
    f.lease.dispose();
    f.scene.dispose();
  }
});

it.each([
  'invalidate',
  'detach',
  'dispose',
  'reconcile',
  'recover',
] as const)('detaches failed Skin retirement and completes independent cleanup during %s', async (edge) => {
  const f = persistentFixture(),
    failure = new Error('known descriptor retirement failure');
  f.extract();
  await f.scene.submitSkinFrame(Promise.resolve(), true);
  f.world.set(f.joint, Transform, { pos: [0.1, 0, 0] }).unwrap();
  f.world.update(0).unwrap();
  f.extract();

  const release = GpuInputArena.prototype.releaseDescriptor;
  let injected = false;
  const retire = vi
    .spyOn(GpuInputArena.prototype, 'releaseDescriptor')
    .mockImplementation(function (this: GpuInputArena, address, words) {
      release.call(this, address, words);
      if (!injected) {
        injected = true;
        throw failure;
      }
    });
  const arenaDispose = vi.spyOn(GpuInputArena.prototype, 'dispose');
  try {
    const action =
      edge === 'invalidate'
        ? () => f.scene.invalidate()
        : edge === 'detach'
          ? () => f.scene.detach(f.world)
          : edge === 'dispose'
            ? () => f.scene.dispose()
            : edge === 'recover'
              ? () => f.scene.resetGpuForRecover()
              : () =>
                  f.scene.extractComposition(
                    [f.world],
                    { cameraOwner: 0, resourceOwner: 0 },
                    testAssets(f.world),
                    (request) => {
                      // Force the same cold roster boundary by omitting read leases.
                      const metadata = extractFrames([f.world], 0, testAssets(f.world), undefined, {
                        renderables: 'none',
                        cull: 'none',
                      });
                      const slot = required(f.scene.compositionSlot(0, f.entity));
                      return {
                        ...metadata,
                        renderables: request === 'none' ? [] : [slot.snapshot],
                        dispatch: [],
                      };
                    },
                  );
    expect(action).toThrow();
    expect(injected).toBe(true);
    expect(f.scene.compositionSlot(0, f.entity)).toBeUndefined();
    expect(f.scene.skinRecordingFrame()).toBeUndefined();
    if (edge === 'dispose') expect(arenaDispose).toHaveBeenCalled();
    else {
      expect(f.extract().renderables.length).toBe(1);
      expect(f.x(f.scene.skinRecordingFrame())).toBeCloseTo(0.1);
    }
  } finally {
    retire.mockRestore();
    arenaDispose.mockRestore();
    f.lease.dispose();
    f.scene.dispose();
  }
});
