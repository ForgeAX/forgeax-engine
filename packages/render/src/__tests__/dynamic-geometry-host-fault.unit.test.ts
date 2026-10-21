import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../../../physics-rapier3d/src/rapier-physics-world-3d';
import { loadRapier3D } from '../../../physics-rapier3d/src/wasm-loader';
import { createDynamicGeometryHost } from '../assembly/dynamic-geometry-host';
import { dynamicGeometryFrameError } from '../assembly/webgpu-renderer-guards';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { GpuResidencyCache } from '../device/gpu-residency';
import type { DynamicGeometryCandidate } from '../dynamic-geometry';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';
import { worldRenderResources } from '../publication/resource-scope';

function interceptLease(
  store: GpuResidencyCache,
  change: (
    lease: import('../device/residency-lifetime').ResidencyLease,
    scope: Parameters<GpuResidencyCache['prepareMeshResidency']>[3],
  ) => import('../device/residency-lifetime').ResidencyLease,
) {
  const prepare = store.prepareMeshResidency.bind(store);
  return vi
    .spyOn(store, 'prepareMeshResidency')
    .mockImplementation((handle, mesh, revision, scope, profile, capture) =>
      prepare(handle, mesh, revision, scope, profile, (physical) => {
        Object.assign(physical, { lease: change(physical.lease, scope) });
        capture?.(physical);
      }),
    );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture requires a live value');
  return value;
}

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

async function fixture(options: { readonly onTopologyChanged?: () => void } = {}) {
  const world = new World({ assets: new AssetRegistry() });
  let generation = 1;
  const materialHandle = runtimeAssetRegistry(world.assets)
    .create({
      kind: 'material',
      passes: [{ name: 'main', program: { module: 'fixture-material' } }],
    })
    .unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const topologyChanged = options.onTopologyChanged ?? vi.fn();
  const lifecycle = createDynamicGeometryLifecycle();
  const attachedWorlds = new Set([world]);
  const host = createDynamicGeometryHost({
    lifecycle,
    attachedWorlds,
    getGpuStore: () => store,
    currentGeneration: () => generation,
    isConsumedByRenderFrame: () => true,
    onTopologyChanged: topologyChanged,
  });
  const entities = Array.from({ length: 2 }, () =>
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: runtimeAssetRegistry(world.assets).create(mesh()).unwrap() },
        },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap(),
  );
  const prepareOne = (
    entityIndex: number,
    revision: number,
    pairedPhysics = false,
    materialIdentity?: string,
  ) => {
    const entity = entities[entityIndex];
    if (entity === undefined) throw new Error('fixture requires a live entity index');
    const source = mesh();
    return host.prepareDynamicGeometry({
      world,
      entity,

      meshHandle: runtimeAssetRegistry(world.assets).create(source).unwrap(),
      revision,
      ...(pairedPhysics ? { physicsEntity: Number(entity) } : {}),
      ...(materialIdentity === undefined ? {} : { materialIdentity }),
    });
  };
  const prepare = (revision: number | readonly number[], pairedPhysics = false) =>
    entities.map((_, index) => {
      const candidateRevision = typeof revision === 'number' ? revision : revision[index];
      if (candidateRevision === undefined)
        throw new Error('fixture requires a revision per entity');
      return prepareOne(index, candidateRevision, pairedPhysics).unwrap();
    });
  const handles = () =>
    entities.map((entity) => world.get(entity, MeshFilter).unwrap().assetHandle);
  const snapshot = (candidates: readonly DynamicGeometryCandidate[] = []) => {
    const bindings = handles();
    const sharedHandles = new Map<number, (typeof bindings)[number]>();
    for (const handle of [...bindings, ...candidates.map((candidate) => candidate.meshHandle)]) {
      if (handle !== undefined) sharedHandles.set(Number(handle), handle);
    }
    return {
      bindings,
      materialBindings: entities.map((entity) => [
        ...world.get(entity, MeshRenderer).unwrap().materials,
      ]),
      lifecycle: lifecycle.inspect(),
      materialRefCount: runtimeAssets(world.assets).refcount(materialHandle),
      sharedRefCounts: [...sharedHandles.entries()]
        .sort(([left], [right]) => left - right)
        .map(([raw, handle]) => [raw, runtimeAssets(world.assets).refcount(handle)] as const),
      sharedPayloads: candidates.map((candidate) => {
        const handle = candidate.meshHandle;
        return handle === undefined ? undefined : runtimeAssets(world.assets).resolveAsset(handle);
      }),
    };
  };
  return {
    world,
    attachedWorlds,
    store,
    host,
    lifecycle,
    entities,
    prepare,
    prepareOne,
    setGeneration: (value: number) => {
      generation = value;
    },
    handles,
    snapshot,
    topologyChanged,
  };
}

function record(name: string, f: Awaited<ReturnType<typeof fixture>>, extra: object = {}) {
  expect({
    name,
    snapshot: f.snapshot(),
    extra,
    fault: f.host.dynamicGeometryFault(f.world),
    guard: dynamicGeometryFrameError([f.world], (world) => f.host.dynamicGeometryFault(world)),
  }).toMatchObject({ fault: expect.anything(), guard: expect.anything() });
}

afterEach(() => vi.restoreAllMocks());

it('rejects credentials owned by pending detach cleanup before any scalar write', async () => {
  const f = await fixture();
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  interceptLease(f.store, (lease) => {
    lease?.track(completed);
    return lease;
  });
  const prepared = f.prepareOne(0, 1).unwrap();
  f.host.invalidateDynamicGeometryWorld(f.world);
  const before = f.snapshot([prepared]);
  const writes = vi.spyOn(f.world, 'set');
  expect(f.host.acceptDynamicGeometry(prepared, { world: f.world, fixedStep: 0 }).ok).toBe(false);
  expect(writes).not.toHaveBeenCalled();
  expect(f.host.cancelDynamicGeometry(prepared).ok).toBe(false);
  expect(f.snapshot([prepared])).toEqual(before);
  complete();
  await settle();
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
  f.store.destroyAll();
});

it('refuses stale accepted credentials while generation cleanup holds their fence', async () => {
  const f = await fixture();
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  interceptLease(f.store, (lease) => {
    lease?.track(completed);
    return lease;
  });
  const accepted = f.host
    .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
    .unwrap();
  f.setGeneration(2);
  expect(f.host.publishDynamicGeometry({ frameId: 2, deviceGeneration: 2 })).toEqual([]);
  const before = f.snapshot([accepted]);
  expect(f.host.cancelDynamicGeometry(accepted).ok).toBe(false);
  expect(f.snapshot([accepted])).toEqual(before);
  complete();
  await settle();
  f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 2 });
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
  expect(f.lifecycle.inspect().generation).toBe(2);
  f.store.destroyAll();
});

describe('dynamic geometry host fault ownership', () => {
  it('latches cancel after a real scalar write commits then throws', async () => {
    const f = await fixture();
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    const before = f.snapshot([accepted]);
    const set = f.world.set.bind(f.world);
    let injected = false;
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) => {
      const result = set(entity, component, data);
      if (!injected && component === MeshFilter && result.ok) {
        injected = true;
        throw new Error('independent cancel post-write exception');
      }
      return result;
    });
    let thrown: unknown;
    try {
      f.host.cancelDynamicGeometry(accepted);
    } catch (error) {
      thrown = error;
    }
    vi.restoreAllMocks();
    let laterAcceptOk = false;
    let laterThrown: unknown;
    try {
      laterAcceptOk = f.host.acceptDynamicGeometry(f.prepareOne(1, 1).unwrap(), {
        world: f.world,
        fixedStep: 0,
      }).ok;
    } catch (error) {
      laterThrown = error;
    }
    record('cancel-post-write', f, {
      before,
      thrown: String(thrown),
      laterAcceptOk,
      laterThrown: String(laterThrown),
    });
    try {
      expect(thrown).toBeDefined();
      expect(
        f.host.dynamicGeometryFault(f.world),
        'cancel exception must latch the exact World',
      ).toBeDefined();
      expect(
        dynamicGeometryFrameError([f.world], (world) => f.host.dynamicGeometryFault(world)),
      ).toBeDefined();
      expect(laterAcceptOk).toBe(false);
    } finally {
      f.store.destroyAll();
    }
  });

  it('does not leave a reusable prepared candidate after native residency cancellation throws', async () => {
    const f = await fixture();
    let fail = true;
    interceptLease(f.store, (lease) => {
      return {
        track: (completed) => lease.track(completed),
        release: (evict) => {
          const result = lease.release(evict);
          if (fail) {
            fail = false;
            throw new Error('independent cancel post-native-release exception');
          }
          return result;
        },
      };
    });
    const prepared = f.prepareOne(0, 1).unwrap();
    const before = f.snapshot([prepared]);
    let thrown: unknown;
    try {
      f.host.cancelDynamicGeometry(prepared);
    } catch (error) {
      thrown = error;
    }
    const nativeResidentAfterCancel =
      f.store.getMeshGpuHandles(required(prepared.meshHandle), worldRenderResources(f.world)) !==
      undefined;
    let reusableAcceptOk = false;
    let reusableThrown: unknown;
    try {
      reusableAcceptOk = f.host.acceptDynamicGeometry(prepared, {
        world: f.world,
        fixedStep: 0,
      }).ok;
    } catch (error) {
      reusableThrown = error;
    }
    record('cancel-post-native-release', f, {
      before,
      thrown: String(thrown),
      nativeResidentAfterCancel,
      reusableAcceptOk,
      reusableThrown: String(reusableThrown),
    });
    vi.restoreAllMocks();
    try {
      expect(thrown).toBeDefined();
      expect(
        f.host.dynamicGeometryFault(f.world),
        'native cancellation failure must fence stale residency',
      ).toBeDefined();
      expect(
        dynamicGeometryFrameError([f.world], (world) => f.host.dynamicGeometryFault(world)),
      ).toBeDefined();
      expect(reusableAcceptOk).toBe(false);
    } finally {
      f.store.destroyAll();
    }
  });

  it('latches a real shared-reference release refusal during cancellation', async () => {
    const f = await fixture();
    const prepared = f.prepareOne(0, 1).unwrap();
    const before = f.snapshot([prepared]);
    const release = runtimeAssets(f.world.assets).release.bind(runtimeAssets(f.world.assets));
    const absent = release(-1);
    expect(absent.ok).toBe(false);
    vi.spyOn(runtimeAssets(f.world.assets), 'release').mockImplementation((handle) =>
      handle === prepared.meshHandle ? absent : release(handle),
    );
    let cancelled: ReturnType<typeof f.host.cancelDynamicGeometry> | undefined;
    let cancelThrown: unknown;
    try {
      cancelled = f.host.cancelDynamicGeometry(prepared);
    } catch (error) {
      cancelThrown = error;
    }
    record('cancel-shared-ref-refusal', f, {
      before,
      cancelOk: cancelled?.ok ?? false,
      cancelThrown: String(cancelThrown),
      candidateRefCount: runtimeAssets(f.world.assets).refcount(required(prepared.meshHandle)),
      releaseError: absent,
    });
    vi.restoreAllMocks();
    try {
      expect(
        f.host.dynamicGeometryFault(f.world),
        'cancel cleanup cannot discard failed lease release',
      ).toBeDefined();
    } finally {
      f.store.destroyAll();
    }
  });

  it('latches native prepare failure and owns both retained shared references', async () => {
    const f = await fixture();
    const source = mesh();
    const handle = runtimeAssetRegistry(f.world.assets).create(source).unwrap();
    const old = required(f.handles()[0]);
    const before = {
      lifecycle: f.lifecycle.inspect(),
      oldRef: runtimeAssets(f.world.assets).refcount(old),
      candidateRef: runtimeAssets(f.world.assets).refcount(handle),
    };
    const ensure = f.store.prepareMeshResidency.bind(f.store);
    vi.spyOn(f.store, 'prepareMeshResidency').mockImplementation((...args) => {
      const resident = ensure(...args);
      expect(resident.ok).toBe(true);
      throw new Error('independent prepare post-native-resident exception');
    });
    let thrown: unknown;
    try {
      f.host.prepareDynamicGeometry({
        world: f.world,
        entity: required(f.entities[0]),

        meshHandle: handle,
        revision: 1,
      });
    } catch (error) {
      thrown = error;
    }
    record('prepare-post-native-resident', f, {
      before,
      thrown: String(thrown),
      oldRef: runtimeAssets(f.world.assets).refcount(old),
      candidateRef: runtimeAssets(f.world.assets).refcount(handle),
      nativeResident:
        f.store.getMeshGpuHandles(handle, worldRenderResources(f.world)) !== undefined,
    });
    vi.restoreAllMocks();
    try {
      expect(
        f.host.dynamicGeometryFault(f.world),
        'native prepare exception must latch',
      ).toBeDefined();
    } finally {
      f.store.destroyAll();
    }
  });

  it('latches retirement after lifecycle commit when previous lease release fails', async () => {
    const f = await fixture();
    const old = required(f.handles()[0]);
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
    f.world.set(required(f.entities[0]), MeshFilter, { assetHandle: old }).unwrap();
    const before = f.snapshot([accepted]);
    const release = runtimeAssets(f.world.assets).release.bind(runtimeAssets(f.world.assets));
    const absent = release(-1);
    expect(absent.ok).toBe(false);
    vi.spyOn(runtimeAssets(f.world.assets), 'release').mockImplementation((handle) =>
      handle === old ? absent : release(handle),
    );
    let retired: ReturnType<typeof f.host.retireDynamicGeometry> | undefined;
    let retireThrown: unknown;
    try {
      retired = f.host.retireDynamicGeometry(accepted);
    } catch (error) {
      retireThrown = error;
    }
    record('retire-previous-ref-refusal', f, {
      before,
      retireOk: retired?.ok ?? false,
      retireThrown: String(retireThrown),
      receipt: f.host.dynamicGeometryReceipt(accepted) ?? null,
    });
    vi.restoreAllMocks();
    try {
      expect(
        f.host.dynamicGeometryFault(f.world),
        'post-retire shared reference failure is not a normal rejection',
      ).toBeDefined();
    } finally {
      f.store.destroyAll();
    }
  });

  it('latches the real World when cancellation throws inside real Rapier admission', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const f = await fixture();
    const physics = createRapier3DPhysicsWorld(RAPIER);
    physics.setGravity(vec3.create(0, 0, 0));
    physics.setMoveContext(f.world, Transform);
    f.world.insertResource('PhysicsWorld', physics);
    const entity = required(f.entities[0]);
    physics.ensureBody(
      Number(entity),
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 1, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    f.world
      .addSystem(FixedUpdate, { name: 'independent-clock', queries: [], fn: () => {} })
      .unwrap();
    f.world.update(1 / 60).unwrap();
    interceptLease(f.store, (lease) => {
      return {
        track: (completed) => lease.track(completed),
        release: (evict) => {
          lease.release(evict);
          throw new Error('independent Rapier callback cancel failure');
        },
      };
    });
    const prepared = f.prepareOne(0, 1, true).unwrap();
    const derived = physics
      .prepareDerivedShapeCandidate({
        entity: Number(entity),
        revision: 1,
        sourceKey: 'independent-body',
        worldIdentity: f.world,
        shapes: [
          {
            kind: 'convex-compound',
            id: 'shape',
            revision: 1,
            pieces: [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])],
          },
        ],
        bodyType: 'dynamic',
        massProperties: {
          mode: 'explicit',
          mass: 1,
          centerOfMass: [0, 0, 0],
          principalInertia: [1, 1, 1],
        },
        velocityPolicy: 'preserve',
        constraints: [],
      })
      .unwrap();
    let acceptedInsideCallback = false;
    physics
      .admitDerivedShapeCandidates([derived], () => {
        const accepted = f.host
          .acceptDynamicGeometry(prepared, {
            world: f.world,
            fixedStep: f.world.getResource(FixedTime).tick,
          })
          .unwrap();
        acceptedInsideCallback = true;
        f.host.cancelDynamicGeometry(accepted).unwrap();
        return ok(undefined);
      })
      .unwrap();
    let stepThrown: unknown;
    try {
      physics.step(1 / 60);
    } catch (error) {
      stepThrown = error;
    }
    record('rapier-callback-cancel-failure', f, {
      acceptedInsideCallback,
      stepThrown: String(stepThrown),
      physicsRecovery: physics.getDerivedRecoveryState(),
      physicsFailure: physics.getDerivedFailure(Number(entity)),
    });
    vi.restoreAllMocks();
    try {
      expect(acceptedInsideCallback).toBe(true);
      expect(
        f.host.dynamicGeometryFault(f.world),
        'Rapier recovery does not replace exact World host fault',
      ).toBeDefined();
    } finally {
      physics.dispose();
      f.store.destroyAll();
    }
  });
});

function replacementWorld(f: Awaited<ReturnType<typeof fixture>>) {
  const world = new World({ assets: new AssetRegistry() });
  const material = runtimeAssetRegistry(world.assets)
    .create({
      kind: 'material',
      passes: [{ name: 'main', program: { module: 'fixture-material' } }],
    })
    .unwrap();
  const entities = Array.from({ length: 2 }, () =>
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: runtimeAssetRegistry(world.assets).create(mesh()).unwrap() },
        },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap(),
  );
  f.attachedWorlds.delete(f.world);
  f.attachedWorlds.add(world);
  const source = mesh();
  const handle = runtimeAssetRegistry(world.assets).create(source).unwrap();
  const prepared = f.host
    .prepareDynamicGeometry({
      world,
      entity: required(entities[0]),

      meshHandle: handle,
      revision: 1,
    })
    .unwrap();
  return { world, prepared };
}

async function settle() {
  // Drain native lifetime, Host completion and lifecycle completion callbacks.
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('dynamic geometry terminal cleanup boundaries', () => {
  it('attributes asynchronous post-release failure to the detached original World', async () => {
    const f = await fixture();
    let reject!: (cause: Error) => void;
    const failed = new Promise<void>((_, fail) => {
      reject = fail;
    });
    let releases = 0;
    interceptLease(f.store, (lease, world) => {
      if (world !== worldRenderResources(f.world)) return lease;
      return {
        track: (completed) => lease.track(completed),
        release: (evict) => {
          releases += 1;
          lease.release(evict);
          return failed;
        },
      };
    });
    const prepared = f.prepareOne(0, 1).unwrap();
    const before = f.snapshot([prepared]);
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(
      f.store.getMeshGpuHandles(required(prepared.meshHandle), worldRenderResources(f.world)),
    ).toBeUndefined();
    const replacement = replacementWorld(f);
    expect(replacement.prepared.meshHandle).not.toBe(prepared.meshHandle);
    reject(new Error('release failed after native eviction and replacement attachment'));
    await settle();
    record('detached-async-native-failure', f, {
      before,
      releases,
      replacementFault: f.host.dynamicGeometryFault(replacement.world),
    });
    expect(f.host.dynamicGeometryFault(replacement.world)).toBeUndefined();
    expect(
      dynamicGeometryFrameError([replacement.world], (world) => f.host.dynamicGeometryFault(world)),
    ).toBeUndefined();
    expect(f.lifecycle.inspect().meshBytes).toBe(
      prepared.meshBytes + replacement.prepared.meshBytes,
    );
    expect(runtimeAssets(f.world.assets).refcount(required(prepared.meshHandle))).toBe(2);
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(releases).toBe(1);
    const accepted = f.host
      .acceptDynamicGeometry(replacement.prepared, { world: replacement.world, fixedStep: 0 })
      .unwrap();
    expect(
      f.host.publishDynamicGeometry({ frameId: 2, deviceGeneration: 1 }, [replacement.world]),
    ).toHaveLength(1);
    expect(f.host.dynamicGeometryReceipt(accepted)).toBeDefined();
    expect(f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 }, [f.world])).toEqual(
      [],
    );
    // Detached admission rejects before the attached-World fault guard.
    expect(f.host.acceptDynamicGeometry(prepared, { world: f.world, fixedStep: 0 }).ok).toBe(false);
    f.store.destroyAll();
  });

  it('retains retired reservation when shared-reference release fails after the real frame fence', async () => {
    const f = await fixture();
    const old = required(f.handles()[0]);
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1, completed });
    const native = f.store.getMeshGpuHandles(
      required(accepted.meshHandle),
      worldRenderResources(f.world),
    );
    f.world.set(required(f.entities[0]), MeshFilter, { assetHandle: old }).unwrap();
    const release = runtimeAssets(f.world.assets).release.bind(runtimeAssets(f.world.assets));
    const absent = release(-1);
    let attempts = 0;
    vi.spyOn(runtimeAssets(f.world.assets), 'release').mockImplementation((handle) => {
      if (handle !== old) return release(handle);
      attempts += 1;
      return absent;
    });
    f.host.retireDynamicGeometry(accepted).unwrap();
    f.host.retireDynamicGeometry(accepted).unwrap();
    expect(
      f.store.getMeshGpuHandles(required(accepted.meshHandle), worldRenderResources(f.world)),
    ).toBe(native);
    expect(f.lifecycle.inspect().meshBytes).toBe(accepted.meshBytes);
    expect(attempts).toBe(0);
    const replacement = replacementWorld(f);
    complete();
    await settle();
    record('detached-async-reference-failure', f, {
      attempts,
      nativeResident:
        f.store.getMeshGpuHandles(required(accepted.meshHandle), worldRenderResources(f.world)) !==
        undefined,
    });
    expect(
      f.store.getMeshGpuHandles(required(accepted.meshHandle), worldRenderResources(f.world)),
    ).toBeUndefined();
    expect(f.host.dynamicGeometryFault(replacement.world)).toBeUndefined();
    expect(f.lifecycle.inspect().meshBytes).toBe(
      accepted.meshBytes + replacement.prepared.meshBytes,
    );
    expect(runtimeAssets(f.world.assets).refcount(old)).toBe(3);
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(attempts).toBe(1);
    expect(f.lifecycle.inspect().meshBytes).toBe(
      accepted.meshBytes + replacement.prepared.meshBytes,
    );
    f.store.destroyAll();
  });

  it('keeps the unique synchronous failed cleanup owner across invalidation and generation replacement', async () => {
    const f = await fixture();
    const prepared = f.prepareOne(0, 1).unwrap();
    const before = f.snapshot([prepared]);
    const release = runtimeAssets(f.world.assets).release.bind(runtimeAssets(f.world.assets));
    const absent = release(-1);
    let attempts = 0;
    vi.spyOn(runtimeAssets(f.world.assets), 'release').mockImplementation((handle) => {
      if (handle !== prepared.meshHandle) return release(handle);
      attempts += 1;
      return absent;
    });
    expect(() => f.host.cancelDynamicGeometry(prepared)).toThrow();
    f.host.invalidateDynamicGeometryWorld(f.world);
    f.setGeneration(2);
    expect(f.host.publishDynamicGeometry({ frameId: 2, deviceGeneration: 2 })).toEqual([]);
    record('failed-cleanup-generation-budget', f, { before, attempts });
    expect(f.lifecycle.inspect().generation).toBe(1);
    expect(f.lifecycle.inspect().meshBytes).toBe(prepared.meshBytes);
    expect(runtimeAssets(f.world.assets).refcount(required(prepared.meshHandle))).toBe(2);
    expect(attempts).toBe(1);
    f.store.destroyAll();
  });

  it('recovers the pre-upload registered owner after upload throws before returning a credential', async () => {
    const f = await fixture();
    const source = mesh();
    const handle = runtimeAssetRegistry(f.world.assets).create(source).unwrap();
    const old = required(f.handles()[0]);
    const before = {
      old: runtimeAssets(f.world.assets).refcount(old),
      candidate: runtimeAssets(f.world.assets).refcount(handle),
    };
    const upload = f.store.prepareMeshResidency.bind(f.store);
    vi.spyOn(f.store, 'prepareMeshResidency').mockImplementation((...args) => {
      upload(...args).unwrap();
      throw new Error('post-upload failure before credential return');
    });
    expect(() =>
      f.host.prepareDynamicGeometry({
        world: f.world,
        entity: required(f.entities[0]),

        meshHandle: handle,
        revision: 1,
      }),
    ).toThrow();
    expect(f.lifecycle.inspect().prepared).toBe(1);
    expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBeUndefined();
    expect(() => f.prepareOne(0, 2)).toThrow();
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBeUndefined();
    expect(f.lifecycle.inspect().meshBytes).toBe(0);
    expect(runtimeAssets(f.world.assets).refcount(old)).toBe(before.old);
    expect(runtimeAssets(f.world.assets).refcount(handle)).toBe(before.candidate);
    record('post-upload-owned-recovery', f, { before });
    f.store.destroyAll();
  });

  it('rejects normally only when a refused scalar write leaves binding, references and lifecycle unchanged', async () => {
    const f = await fixture();
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    const before = f.snapshot([accepted]);
    const missing = f.world.get(0xffffff as never, MeshFilter);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a real missing entity error');
    vi.spyOn(f.world, 'set').mockImplementation(
      () => ({ ok: false, error: missing.error }) as never,
    );
    expect(f.host.cancelDynamicGeometry(accepted).ok).toBe(false);
    expect(f.snapshot([accepted])).toEqual(before);
    expect(f.host.dynamicGeometryFault(f.world)).toBeUndefined();
    f.store.destroyAll();
  });

  it('faults when a scalar write returns refusal after actually committing', async () => {
    const f = await fixture();
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    const missing = f.world.get(0xffffff as never, MeshFilter);
    if (missing.ok) throw new Error('expected a real missing entity error');
    const set = f.world.set.bind(f.world);
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) => {
      set(entity, component, data).unwrap();
      return { ok: false, error: missing.error } as never;
    });
    expect(() => f.host.cancelDynamicGeometry(accepted)).toThrow();
    record('post-write-refusal-is-fault', f);
    expect(f.lifecycle.inspect().accepted).toBe(1);
    expect(f.lifecycle.inspect().meshBytes).toBe(accepted.meshBytes);
    expect(f.host.publishDynamicGeometry({ frameId: 2, deviceGeneration: 1 })).toEqual([]);
    expect(() =>
      f.host.acceptDynamicGeometry(accepted, { world: f.world, fixedStep: 0 }),
    ).toThrow();
    f.store.destroyAll();
  });
});

describe('native preparation ownership before credential publication', () => {
  it('keeps unknown lease acquisition owned and faulted instead of acquiring a substitute lease', async () => {
    const f = await fixture();
    let acquisitions = 0;
    interceptLease(f.store, (lease) => {
      acquisitions += 1;
      expect(lease).toBeDefined();
      throw new Error('native lease acquired before returning an exception');
    });
    expect(() => f.prepareOne(0, 1)).toThrow();
    const before = f.snapshot();
    expect(f.lifecycle.inspect().prepared).toBe(1);
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    expect(acquisitions).toBe(1);
    record('unknown-native-lease-acquisition', f, { before, acquisitions });
    f.store.destroyAll();
  });

  it('faults a native refusal after actual upload while retaining the recovery owner', async () => {
    const f = await fixture();
    const source = mesh();
    const handle = runtimeAssetRegistry(f.world.assets).create(source).unwrap();
    const missingDevice = new GpuResidencyCache().prepareMeshResidency(
      handle,
      source,
      1,
      worldRenderResources(f.world),
    );
    expect(missingDevice.ok).toBe(false);
    if (missingDevice.ok) throw new Error('expected a real missing device error');
    const upload = f.store.prepareMeshResidency.bind(f.store);
    vi.spyOn(f.store, 'prepareMeshResidency').mockImplementation((...args) => {
      upload(...args).unwrap();
      return err(missingDevice.error);
    });
    expect(() =>
      f.host.prepareDynamicGeometry({
        world: f.world,
        entity: required(f.entities[0]),

        meshHandle: handle,
        revision: 1,
      }),
    ).toThrow();
    record('post-upload-native-refusal', f, {
      nativeResident:
        f.store.getMeshGpuHandles(handle, worldRenderResources(f.world)) !== undefined,
    });
    expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(f.store.getMeshGpuHandles(handle, worldRenderResources(f.world))).toBeUndefined();
    expect(f.lifecycle.inspect().meshBytes).toBe(0);
    expect(runtimeAssets(f.world.assets).refcount(handle)).toBe(1);
    f.store.destroyAll();
  });
});

describe('submitted frame failure ownership', () => {
  it('holds retired budget and references when the real submitted fence rejects after detach', async () => {
    const f = await fixture();
    const old = required(f.handles()[0]);
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    let reject!: (cause: Error) => void;
    const completed = new Promise<void>((_, fail) => {
      reject = fail;
    });
    f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1, completed });
    f.world.set(required(f.entities[0]), MeshFilter, { assetHandle: old }).unwrap();
    f.host.retireDynamicGeometry(accepted).unwrap();
    const replacement = replacementWorld(f);
    reject(new Error('submitted frame completion failed'));
    await settle();
    record('submitted-fence-rejection', f);
    expect(f.host.dynamicGeometryFault(replacement.world)).toBeUndefined();
    expect(runtimeAssets(f.world.assets).refcount(old)).toBe(3);
    expect(f.lifecycle.inspect().meshBytes).toBe(
      accepted.meshBytes + replacement.prepared.meshBytes,
    );
    f.host.invalidateDynamicGeometryWorld(f.world);
    expect(f.lifecycle.inspect().meshBytes).toBe(
      accepted.meshBytes + replacement.prepared.meshBytes,
    );
    f.store.destroyAll();
  });

  it('faults and retains the published receipt owner when native submission tracking throws after recording', async () => {
    const f = await fixture();
    let releases = 0;
    interceptLease(f.store, (lease) => {
      return {
        track: (completed) => {
          lease.track(completed);
          throw new Error('native submission tracked before exception');
        },
        release: (evict) => {
          releases += 1;
          return lease.release(evict);
        },
      };
    });
    const accepted = f.host
      .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
      .unwrap();
    expect(() =>
      f.host.publishDynamicGeometry({
        frameId: 1,
        deviceGeneration: 1,
        completed: Promise.resolve(),
      }),
    ).toThrow();
    await settle();
    f.host.invalidateDynamicGeometryWorld(f.world);
    record('postcommit-native-track-failure', f, { releases });
    expect(f.lifecycle.inspect().meshBytes).toBe(accepted.meshBytes);
    expect(f.host.dynamicGeometryReceipt(accepted)).toBeUndefined();
    expect(releases).toBe(0);
    f.store.destroyAll();
  });
});

it('preserves the published owner when submitted failure is observed before detach begins', async () => {
  const f = await fixture();
  const accepted = f.host
    .acceptDynamicGeometry(f.prepareOne(0, 1).unwrap(), { world: f.world, fixedStep: 0 })
    .unwrap();
  let reject!: (cause: Error) => void;
  const completed = new Promise<void>((_, fail) => {
    reject = fail;
  });
  f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1, completed });
  reject(new Error('submitted fence failed before detach'));
  await settle();
  const before = f.snapshot([accepted]);
  f.host.invalidateDynamicGeometryWorld(f.world);
  f.host.invalidateDynamicGeometryWorld(f.world);
  record('submitted-failure-before-detach', f, { before });
  expect(f.lifecycle.inspect().meshBytes).toBe(accepted.meshBytes);
  expect(runtimeAssets(f.world.assets).refcount(required(accepted.meshHandle))).toBe(3);
  expect(
    f.store.getMeshGpuHandles(required(accepted.meshHandle), worldRenderResources(f.world)),
  ).toBeDefined();
  f.store.destroyAll();
});
