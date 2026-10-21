import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../../../physics-rapier3d/src/rapier-physics-world-3d';
import { loadRapier3D } from '../../../physics-rapier3d/src/wasm-loader';
import {
  createDynamicGeometryHost,
  createRendererDynamicGeometryHost,
} from '../assembly/dynamic-geometry-host';
import { dynamicGeometryFrameError } from '../assembly/webgpu-renderer-guards';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { GpuResidencyCache } from '../device/gpu-residency';
import type { DynamicGeometryCandidate } from '../dynamic-geometry';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';

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

async function fixture(
  options: {
    readonly onTopologyChanged?: () => void;
    readonly entityCount?: number;
    readonly rendererAdapter?: boolean;
  } = {},
) {
  const world = new World({ assets: new AssetRegistry() });
  let generation = 1;
  const materialHandle = runtimeAssetRegistry(world.assets)
    .create({
      kind: 'material',
      sourceKey: 'fixture-material',
      passes: [{ name: 'main', program: { module: 'fixture-material' } }],
    })
    .unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const topologyChanged = options.onTopologyChanged ?? vi.fn();
  const lifecycle = createDynamicGeometryLifecycle();
  const hostOptions = {
    lifecycle,
    attachedWorlds: new Set([world]),
    getGpuStore: () => store,
    currentGeneration: () => generation,
    isConsumedByRenderFrame: () => true,
  };
  const renderSystem = {
    invalidateGeometryHistory: topologyChanged,
    isDynamicGeometryConsumed: () => true,
    dynamicGeometryRecordStageLane: () => undefined,
  };
  const host = options.rendererAdapter
    ? createRendererDynamicGeometryHost({
        ...hostOptions,
        renderSystem,
      })
    : createDynamicGeometryHost({ ...hostOptions, onTopologyChanged: topologyChanged });
  const entities = Array.from({ length: options.entityCount ?? 2 }, () =>
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

describe('dynamic geometry batch admission', () => {
  it('keeps the global temporal history when a renderer accepts local geometry', async () => {
    const f = await fixture({ rendererAdapter: true });
    try {
      const before = f.handles();
      f.host
        .acceptDynamicGeometryCandidates(f.prepare(1), { world: f.world, fixedStep: 0 })
        .unwrap();
      expect(f.handles()).not.toEqual(before);
      expect(f.topologyChanged).not.toHaveBeenCalled();
    } finally {
      f.host.invalidateDynamicGeometryWorld(f.world);
      f.store.destroyAll();
    }
  });
  it('prepares and admits a complete 33-mesh roster through actual local GPU residency', async () => {
    const f = await fixture({ entityCount: 33 });
    const old = f.handles();
    const inputs = f.entities.map((entity) => {
      const source = mesh();
      return {
        world: f.world,
        entity,
        meshHandle: runtimeAssetRegistry(f.world.assets).create(source).unwrap(),
        revision: 1,
      };
    });
    const candidates = f.host.prepareDynamicGeometryCandidates(inputs).unwrap();
    expect(candidates).toHaveLength(33);
    expect(candidates.every((candidate) => f.host.isDynamicGeometryCurrent(candidate))).toBe(true);
    expect(f.handles()).toEqual(old);
    expect(
      f.host.acceptDynamicGeometryCandidates(candidates.slice(0, 32), {
        world: f.world,
        fixedStep: 0,
      }).ok,
    ).toBe(false);
    expect(f.handles()).toEqual(old);
    f.host.acceptDynamicGeometryCandidates(candidates, { world: f.world, fixedStep: 0 }).unwrap();
    expect(f.handles()).toEqual(inputs.map((input) => input.meshHandle));
    expect(f.topologyChanged).toHaveBeenCalledTimes(1);
    f.host.invalidateDynamicGeometryWorld(f.world);
    await vi.waitFor(() => expect(f.lifecycle.inspect().meshBytes).toBe(0));
    f.store.destroyAll();
  });

  it('admits both meshes in one ordering and publishes both receipts', async () => {
    const f = await fixture();
    const prepared = f.prepare(1);
    const old = f.handles();
    const accepted = f.host
      .acceptDynamicGeometryCandidates(prepared, { world: f.world, fixedStep: 0 })
      .unwrap();
    expect(f.handles()).not.toEqual(old);
    expect(accepted.map((candidate) => candidate.state)).toEqual(['accepted', 'accepted']);
    expect(f.topologyChanged).toHaveBeenCalledTimes(1);
    const receipts = f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
    expect(receipts.map((receipt) => receipt.candidateId).sort()).toEqual(
      prepared.map((candidate) => candidate.candidateId).sort(),
    );
    f.store.destroyAll();
  });

  it('retains prior unpublished candidates when the second ECS swap fails', async () => {
    const f = await fixture();
    const prior = f
      .prepare(1)
      .map((candidate) =>
        f.host.acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 }).unwrap(),
      );
    const old = f.handles();
    const next = f.prepare(2);
    const set = f.world.set.bind(f.world);
    // Use the ECS's own missing-component failure without changing either live mesh.
    const absent = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const refused = set(absent, MeshFilter, { assetHandle: old[0] });
    expect(refused.ok).toBe(false);
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) =>
      entity === f.entities[1] && component === MeshFilter ? refused : set(entity, component, data),
    );
    expect(f.host.acceptDynamicGeometryCandidates(next, { world: f.world, fixedStep: 0 }).ok).toBe(
      false,
    );
    expect(f.handles()).toEqual(old);
    const receipts = f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
    expect(receipts.map((receipt) => receipt.candidateId).sort()).toEqual(
      prior.map((candidate) => candidate.candidateId).sort(),
    );
    vi.restoreAllMocks();
    f.store.destroyAll();
  });

  it('preserves lifecycle history and prepared leases after a normal second-swap refusal', async () => {
    const f = await fixture();
    const ordering = { world: f.world, fixedStep: 0 };
    const prior = f.host.acceptDynamicGeometryCandidates(f.prepare(1), ordering).unwrap();
    f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
    const pending = f.prepare(2);
    const before = f.snapshot(pending);
    const priorReceipts = prior.map((candidate) => f.host.dynamicGeometryReceipt(candidate));
    const set = f.world.set.bind(f.world);
    const absent = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const refused = set(absent, MeshFilter, { assetHandle: before.bindings[0] });
    expect(refused.ok).toBe(false);
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) =>
      entity === f.entities[1] && component === MeshFilter ? refused : set(entity, component, data),
    );

    try {
      const result = f.host.acceptDynamicGeometryCandidates(pending, ordering);
      expect(result.ok).toBe(false);
      expect(f.snapshot(pending)).toEqual(before);
      expect(priorReceipts.every((receipt) => receipt !== undefined)).toBe(true);
      expect(prior.map((candidate) => f.host.dynamicGeometryReceipt(candidate))).toEqual(
        priorReceipts,
      );
      for (const candidate of pending) f.host.cancelDynamicGeometry(candidate).unwrap();
    } finally {
      vi.restoreAllMocks();
      f.store.destroyAll();
    }
  });

  it('preserves the complete batch snapshot when a later candidate is stale', async () => {
    const f = await fixture();
    const ordering = { world: f.world, fixedStep: 0 };
    const prior = f.host.acceptDynamicGeometryCandidates(f.prepare(1), ordering).unwrap();
    const pending = f.prepare([2, 1]);
    const before = f.snapshot(pending);

    try {
      const result = f.host.acceptDynamicGeometryCandidates(pending, ordering);
      expect(result.ok).toBe(false);
      expect(f.snapshot(pending)).toEqual(before);
      for (const candidate of pending) f.host.cancelDynamicGeometry(candidate).unwrap();
      expect(prior.map((candidate) => f.host.cancelDynamicGeometry(candidate).ok)).toEqual([
        true,
        true,
      ]);
    } finally {
      f.store.destroyAll();
    }
  });

  it.each([
    'expired',
    'credential',
    'tick',
    'material',
    'handle',
  ] as const)('preserves the complete batch snapshot when a later candidate fails %s preflight', async (failure) => {
    const f = await fixture();
    let pending: readonly DynamicGeometryCandidate[];
    let ordering = { world: f.world, fixedStep: 0 };

    if (failure === 'expired') {
      const expired = f.prepareOne(1, 1).unwrap();
      f.setGeneration(2);
      expect(f.host.dynamicGeometryReceipt(expired)).toBeUndefined();
      pending = [f.prepareOne(0, 1).unwrap(), expired];
    } else if (failure === 'material') {
      const laterEntity = f.entities[1];
      if (laterEntity === undefined) throw new Error('fixture requires two live entities');
      pending = [
        f.prepareOne(0, 2, false, 'fixture-material').unwrap(),
        f.prepareOne(1, 2, false, 'fixture-material').unwrap(),
      ];
      f.world.set(laterEntity, MeshRenderer, { materials: [] }).unwrap();
    } else {
      const prepared = f.prepare(1);
      const first = prepared[0];
      const later = prepared[1];
      if (first === undefined || later === undefined)
        throw new Error('fixture requires two prepared candidates');
      pending = prepared;

      if (failure === 'credential') {
        pending = [first, { ...later, owner: {} }];
      } else if (failure === 'tick') {
        ordering = { world: f.world, fixedStep: 1 };
      } else if (failure === 'handle') {
        const laterEntity = f.entities[1];
        if (laterEntity === undefined) throw new Error('fixture requires two live entities');
        if (later.meshHandle === undefined)
          throw new Error('fixture candidate requires a MeshAsset handle');
        f.world.set(laterEntity, MeshFilter, { assetHandle: later.meshHandle }).unwrap();
      }
    }

    const before = f.snapshot(pending);
    try {
      expect(f.host.acceptDynamicGeometryCandidates(pending, ordering).ok).toBe(false);
      expect(f.snapshot(pending)).toEqual(before);
    } finally {
      f.store.destroyAll();
    }
  });

  it('throws when a failed group cannot restore its first ECS binding', async () => {
    const f = await fixture();
    const old = f.handles();
    const next = f.prepare(1);
    const set = f.world.set.bind(f.world);
    const absent = f.world.spawn({ component: Transform, data: {} }).unwrap();
    const refused = set(absent, MeshFilter, { assetHandle: old[0] });
    let writes = 0;
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) => {
      if (component === MeshFilter && ++writes >= 2) return refused;
      return set(entity, component, data);
    });
    expect(() =>
      f.host.acceptDynamicGeometryCandidates(next, { world: f.world, fixedStep: 0 }),
    ).toThrow('every staged MeshFilter write');
    expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
    vi.restoreAllMocks();
    f.store.destroyAll();
  });

  it('latches a partial-write exception and fences every later frame', async () => {
    const f = await fixture();
    const before = f.handles();
    const next = f.prepare(1);
    const set = f.world.set.bind(f.world);
    let injected = false;
    vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) => {
      if (!injected && entity === f.entities[1] && component === MeshFilter) {
        injected = true;
        const committed = set(entity, component, data);
        if (!committed.ok) return committed;
        throw new Error('injected post-write exception');
      }
      return set(entity, component, data);
    });

    try {
      expect(() =>
        f.host.acceptDynamicGeometryCandidates(next, { world: f.world, fixedStep: 0 }),
      ).toThrow('ECS MeshFilter writes either commit');
      expect(f.host.dynamicGeometryFault(f.world)?.detail.actual).toMatchObject({
        message: 'injected post-write exception',
      });
      expect(f.handles()).toEqual(before);
      expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
      expect(
        dynamicGeometryFrameError([f.world], (world) => f.host.dynamicGeometryFault(world)),
      ).toBeDefined();
      expect(() =>
        f.host.acceptDynamicGeometryCandidates(next, { world: f.world, fixedStep: 0 }),
      ).toThrow('ECS MeshFilter writes either commit');
    } finally {
      vi.restoreAllMocks();
      f.store.destroyAll();
    }
  });

  it('latches a temporal callback failure after commit and fences the next frame', async () => {
    const f = await fixture({
      onTopologyChanged: () => {
        throw new Error('injected topology callback failure');
      },
    });
    const before = f.handles();
    const prepared = f.prepare(1);

    try {
      expect(() =>
        f.host.acceptDynamicGeometryCandidates(prepared, { world: f.world, fixedStep: 0 }),
      ).toThrow('temporal geometry owner');
      expect(f.handles()).not.toEqual(before);
      expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
      expect(
        dynamicGeometryFrameError([f.world], (world) => f.host.dynamicGeometryFault(world)),
      ).toBeDefined();
    } finally {
      f.store.destroyAll();
    }
  });

  it('latches a synchronous GPU cleanup failure after commit and fences the next frame', async () => {
    const f = await fixture();
    const prepare = f.store.prepareMeshResidency.bind(f.store);
    let failRelease = false;
    vi.spyOn(f.store, 'prepareMeshResidency').mockImplementation(
      (handle, mesh, revision, scope, profile, capture) =>
        prepare(handle, mesh, revision, scope, profile, (physical) => {
          const lease = physical.lease;
          Object.assign(physical, {
            lease: {
              track: (completed: Promise<void>) => lease.track(completed),
              release: (evict: boolean) => {
                if (failRelease) throw new Error('injected GPU residency cleanup failure');
                return lease.release(evict);
              },
            },
          });
          capture?.(physical);
        }),
    );
    const ordering = { world: f.world, fixedStep: 0 };
    f.host.acceptDynamicGeometryCandidates(f.prepare(1), ordering).unwrap();
    const pending = f.prepare(2);
    failRelease = true;

    try {
      expect(() => f.host.acceptDynamicGeometryCandidates(pending, ordering)).toThrow(
        'GPU residency release and superseded candidate cleanup complete after commit',
      );
      expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
      expect(
        dynamicGeometryFrameError([f.world], (world) => f.host.dynamicGeometryFault(world)),
      ).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      f.store.destroyAll();
    }
  });

  it('preserves a real Rapier paired admission after a later ECS swap refusal', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const f = await fixture();
    const physics = createRapier3DPhysicsWorld(RAPIER);
    try {
      physics.setGravity(vec3.create(0, 0, 0));
      physics.setMoveContext(f.world, Transform);
      f.world.insertResource('PhysicsWorld', physics);
      f.entities.forEach((entity, index) => {
        physics.ensureBody(
          Number(entity),
          {
            position: { x: index * 4, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          {
            type: 1,
            mass: 1,
            linearDamping: 0,
            angularDamping: 0,
            gravityScale: 0,
            ccdEnabled: 0,
          },
          undefined,
        );
      });
      f.world
        .addSystem(FixedUpdate, { name: 'dynamic-geometry-test-clock', queries: [], fn: () => {} })
        .unwrap();
      f.world.update(1 / 60).unwrap();
      expect(f.world.getResource(FixedTime).tick).toBe(1);

      const prior = f.host
        .acceptDynamicGeometryCandidates(f.prepare(1), {
          world: f.world,
          fixedStep: f.world.getResource(FixedTime).tick,
        })
        .unwrap();
      f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 });
      const pending = f.prepare(2, true);
      const before = f.snapshot(pending);
      const priorReceipts = prior.map((candidate) => f.host.dynamicGeometryReceipt(candidate));
      const derived = f.entities.map((entity) =>
        physics
          .prepareDerivedShapeCandidate({
            entity: Number(entity),
            revision: 2,
            sourceKey: `body:${Number(entity)}`,
            worldIdentity: f.world,
            shapes: [
              {
                kind: 'convex-compound',
                id: 'shape',
                revision: 2,
                pieces: [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])],
              },
            ],
            bodyType: 'dynamic',
            massProperties: {
              mode: 'explicit',
              mass: 1,
              centerOfMass: [0, 0, 0] as const,
              principalInertia: [1, 1, 1] as const,
            },
            velocityPolicy: 'preserve',
            constraints: [],
          })
          .unwrap(),
      );
      const set = f.world.set.bind(f.world);
      const absent = f.world.spawn({ component: Transform, data: {} }).unwrap();
      const refused = set(absent, MeshFilter, { assetHandle: before.bindings[0] });
      expect(refused.ok).toBe(false);
      vi.spyOn(f.world, 'set').mockImplementation((entity, component, data) =>
        entity === f.entities[1] && component === MeshFilter
          ? refused
          : set(entity, component, data),
      );

      physics
        .admitDerivedShapeCandidates(derived, () => {
          const result = f.host.acceptDynamicGeometryCandidates(pending, {
            world: f.world,
            fixedStep: f.world.getResource(FixedTime).tick,
          });
          return result.ok ? ok(undefined) : err(result.error);
        })
        .unwrap();
      physics.step(1 / 60);

      expect(f.snapshot(pending)).toEqual(before);
      expect(prior.map((candidate) => f.host.dynamicGeometryReceipt(candidate))).toEqual(
        priorReceipts,
      );
      expect(f.host.dynamicGeometryFault(f.world)).toBeUndefined();
      expect(physics.getDerivedRecoveryState()).toBe('ready');
      expect(f.entities.map((entity) => physics.getDerivedPublication(Number(entity)))).toEqual([
        undefined,
        undefined,
      ]);
      expect(
        f.entities.map((entity) => physics.getDerivedFailure(Number(entity))?.recovery),
      ).toEqual(['old-state-retained', 'old-state-retained']);

      vi.restoreAllMocks();
      for (const candidate of pending) f.host.cancelDynamicGeometry(candidate).unwrap();
    } finally {
      physics.dispose();
      f.store.destroyAll();
    }
  });

  it('rejects duplicate entities before changing the visible meshes', async () => {
    const f = await fixture();
    const candidates = f.prepare(1);
    const first = candidates[0];
    if (first === undefined) throw new Error('fixture requires a prepared candidate');
    const old = f.handles();
    expect(
      f.host.acceptDynamicGeometryCandidates([first, first], {
        world: f.world,
        fixedStep: 0,
      }).ok,
    ).toBe(false);
    expect(f.handles()).toEqual(old);
    expect(f.topologyChanged).not.toHaveBeenCalled();
    f.store.destroyAll();
  });
});
