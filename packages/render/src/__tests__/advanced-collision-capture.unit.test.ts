import { createHash } from 'node:crypto';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  buildMeshDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsBodyObbQuery,
  type PhysicsColliderPrimitives,
  PhysicsFixedError,
  PhysicsWorldResource,
  RigidBody,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform, WaterShallowCollider } from '@forgeax/engine-scene';
import { type Asset, type AssetHandle, err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../../../physics-rapier3d/src/rapier-physics-world-3d';
import { loadRapier3D } from '../../../physics-rapier3d/src/wasm-loader';
import { MeshFilter } from '../components/mesh-filter';
import * as featureSource from '../features/source';
import { SdfFieldUpload } from '../raytracing/sdf-field-storage';
import {
  AdvancedCollisionMeshOwner,
  captureAdvancedCollisions,
} from '../water/advanced-collisions';
import { dispersiveSourceIdentity } from '../water/dispersive-ocean';
import { advancedPhysicsFixture, advancedWaterFixture } from './advanced-water-fixture';

function body(
  entity: number,
  elements: PhysicsColliderPrimitives['elements'],
  rawAggregateCount = elements.length,
): PhysicsColliderPrimitives {
  return {
    entity,
    generation: 3,
    completedStep: 8,
    motionDiscontinuity: 5,
    positionM: [10, 6, 20],
    rotation: [0, 0, 0, 1],
    scale: [2, 3, 4],
    centerOfMassM: [10, 6, 20],
    linearVelocityMps: [0, 0, 0],
    angularVelocityRadps: [0, 1, 0],
    rawAggregateCount,
    elements,
  };
}
function box(index = 0): PhysicsColliderPrimitives['elements'][number] {
  return {
    colliderId: `native:${index}`,
    generation: 4,
    elementIndex: index,
    collisionGroups: 0xffff_ffff,
    positionM: [10 + index * 100, 6, 20],
    rotation: [0, 0, 0, 1],
    shape: { kind: 'box', representation: 'native', halfExtentsM: [1, 1, 1] },
  };
}

async function geometricMesh(width = 1) {
  const geometry = createBoxGeometry(width, 1, 1).unwrap();
  if (geometry.indices === undefined) throw new Error('indexed fixture required');
  const field = (
    await buildMeshDistanceField(geometry.attributes.position as Float32Array, geometry.indices, {
      resolution: 8,
    })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  return {
    ...geometry,
    distanceField: {
      ...field,
      sectionSidedness: geometry.submeshes.map(() => 0 as const),
      artifact: {
        integrity: {
          algorithm: 'sha256' as const,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        assetCodec: { ...MESH_GEOMETRIC_DISTANCE_FIELD_CODEC },
      },
    },
  };
}

describe('advanced rigid component capture', () => {
  it('keeps field packing lazy across owned captures and exposes one cached initialization payload', async () => {
    const f = await advancedWaterFixture({
      kind: 'distance-field',
      accurate: true,
      useWaterHeightForCollision: false,
      collisionGroups: 0xffffffff,
      collisionOffsetCells: 0,
      overlapThicknessCells: 1,
      softCollisionFalloffM: 0.3,
      maxElements: 100,
    });
    const geometry = await geometricMesh(),
      handle = f.assets.create(geometry).unwrap(),
      entity = f.world
        .spawn(
          { component: WaterShallowCollider, data: { enabled: true } },
          { component: MeshFilter, data: { assetHandle: handle } },
        )
        .unwrap();
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: () => ok(body(entity, [], 0)),
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    const records = runtimeAssets(f.assets),
      owner = new AdvancedCollisionMeshOwner(),
      uploadCopies = vi.spyOn(SdfFieldUpload.prototype, 'copyInto'),
      uploadCaptures = vi.spyOn(SdfFieldUpload, 'capture');
    const capture = () => {
      const leases: { dispose(): void }[] = [];
      owner.beginFrame();
      try {
        return captureAdvancedCollisions(
          {
            ...f.context,
            referenceAssetVersion: ({ handle: mesh }) => {
              const lease = records.pin<Asset>(mesh).unwrap();
              leases.push(lease);
            },
          },
          0,
          f.frame,
          owner,
        );
      } finally {
        for (const lease of leases) lease.dispose();
        owner.finishFrame();
      }
    };
    try {
      const first = capture();
      if (first.kind !== 'ready') throw new Error('ready fixture required');
      const initialization = owner.fieldInitializationFor(first.value);
      if (initialization === undefined) throw new Error('owned field payload required');
      expect(initialization).toMatchObject({
        version: expect.any(String),
        byteLength: expect.any(Number),
      });
      expect(Object.getOwnPropertyDescriptor(first.value, 'sdfFields')?.get).toBeTypeOf('function');
      expect(uploadCopies).not.toHaveBeenCalled();
      expect(uploadCaptures).toHaveBeenCalledOnce();

      const warm = capture();
      if (warm.kind !== 'ready') throw new Error('ready fixture required');
      expect(owner.fieldInitializationFor(warm.value)).toBe(initialization);
      expect(uploadCopies).not.toHaveBeenCalled();
      expect(uploadCaptures).toHaveBeenCalledOnce();

      const seeded = new Uint8Array(initialization.byteLength);
      expect(initialization.copyInto(seeded)).toBe(true);
      expect(new Uint8Array(warm.value.sdfFields)).toEqual(seeded);
      expect(uploadCopies).toHaveBeenCalledTimes(2);
      expect(uploadCaptures).toHaveBeenCalledOnce();
    } finally {
      uploadCopies.mockRestore();
      uploadCaptures.mockRestore();
      f.assets.dispose();
    }
  });

  it('owns static fields by root revision across fresh pins and keeps frame outputs detached', async () => {
    const f = await advancedWaterFixture({
      kind: 'distance-field',
      accurate: true,
      useWaterHeightForCollision: false,
      collisionGroups: 0xffffffff,
      collisionOffsetCells: 0,
      overlapThicknessCells: 1,
      softCollisionFalloffM: 0.3,
      maxElements: 100,
    });
    const geometry = await geometricMesh();
    const distanceField = geometry.distanceField;
    const handle = f.assets.create(geometry).unwrap();
    const entity = f.world
      .spawn(
        { component: WaterShallowCollider, data: { enabled: true } },
        { component: MeshFilter, data: { assetHandle: handle } },
      )
      .unwrap();
    let native = body(entity, [], 0);
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: () => ok(native),
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    const records = runtimeAssets(f.assets),
      owner = new AdvancedCollisionMeshOwner();
    const prepared = vi.spyOn(SdfFieldUpload, 'capture');
    const capture = () => {
      const leases: { dispose(): void }[] = [];
      owner.beginFrame();
      try {
        return captureAdvancedCollisions(
          {
            ...f.context,
            referenceAssetVersion: ({ handle: mesh }) => {
              const lease = records.pin<Asset>(mesh).unwrap();
              leases.push(lease);
            },
          },
          0,
          f.frame,
          owner,
        );
      } finally {
        for (const lease of leases) lease.dispose();
        owner.finishFrame();
      }
    };
    try {
      const first = capture();
      if (first.kind !== 'ready') throw new Error('ready fixture required');
      const expected = first.value.sdfFields.slice();
      const rootRevision = records.version(handle).unwrap();
      for (let frame = 0; frame < 4; frame++) {
        const unrelated = f.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
        native = { ...native, positionM: [11 + frame, 6, 20], completedStep: 9 + frame };
        const next = capture();
        expect(next.kind).toBe('ready');
        if (next.kind !== 'ready') throw new Error('ready fixture required');
        expect(next.value.sdfFields).toEqual(expected);
        expect(next.value.sdfFields.buffer).not.toBe(first.value.sdfFields.buffer);
        expect(next.value.sdfInstances).not.toEqual(first.value.sdfInstances);
        expect(next.value.roster[0]?.mesh?.revision).toBe(rootRevision);
        expect(first.value.roster[0]?.mesh?.revision).toBe(rootRevision);
        expect(dispersiveSourceIdentity(next.value)).toBe(dispersiveSourceIdentity(first.value));
        next.value.sdfFields.fill(0);
        f.assets.release(unrelated).unwrap();
      }
      expect(records.version(handle).unwrap()).toBe(rootRevision);
      expect(prepared).toHaveBeenCalledTimes(1);
      f.assets
        .update(handle, {
          distanceField: { ...distanceField, values: new Float32Array(distanceField.values) },
        })
        .unwrap();
      expect(records.version(handle).unwrap()).not.toBe(rootRevision);
      expect(capture().kind).toBe('ready');
      expect(prepared).toHaveBeenCalledTimes(2);
      expect(first.value.sdfFields).toEqual(expected);
      f.world.set(entity, WaterShallowCollider, { enabled: false }).unwrap();
      capture();
      f.world.set(entity, WaterShallowCollider, { enabled: true }).unwrap();
      expect(capture().kind).toBe('ready');
      expect(prepared).toHaveBeenCalledTimes(3);
    } finally {
      prepared.mockRestore();
      f.assets.dispose();
    }
  });

  it('isolates equal handles and root revisions across Worlds without admitting a failed replacement', async () => {
    const collisions = {
      kind: 'distance-field' as const,
      accurate: true,
      useWaterHeightForCollision: false,
      collisionGroups: 0xffff_ffff,
      collisionOffsetCells: 0,
      overlapThicknessCells: 1,
      softCollisionFalloffM: 0.3,
      maxElements: 100,
    };
    const fixtures = [
      await advancedWaterFixture(collisions),
      await advancedWaterFixture(collisions),
    ] as const;
    const meshes = [await geometricMesh(1), await geometricMesh(2)] as const;
    const handle = 37 as AssetHandle<'mesh'>;
    const owner = new AdvancedCollisionMeshOwner();
    const prepared = vi.spyOn(SdfFieldUpload, 'capture');
    const createSource = (index: 0 | 1) => {
      const f = fixtures[index];
      const localHandle = f.assets.create(meshes[index]).unwrap();
      const entity = f.world
        .spawn(
          { component: WaterShallowCollider, data: { enabled: true } },
          { component: MeshFilter, data: { assetHandle: localHandle } },
        )
        .unwrap();
      f.world.insertResource(
        PhysicsWorldResource,
        advancedPhysicsFixture({
          getCommittedColliderPrimitives: () => ok(body(entity, [], 0)),
          intersectsCommittedBodyObb: () => ok(true),
        }),
      );
      return { value: meshes[index], contentRevision: 1 };
    };
    const sources = [createSource(0), createSource(1)] as const;
    // Asset capture is owned by the World read seam. The publication callback
    // only observes versions and cannot supply this isolated replacement fixture.
    const captureSource = vi
      .spyOn(featureSource, 'captureFeatureSourceAssetVersion')
      .mockImplementation((context) => {
        const source = sources[context.world === fixtures[0].world ? 0 : 1];
        return ok({ handle, revision: 7, ...source });
      });
    const capture = (index: 0 | 1) => {
      const f = fixtures[index];
      return captureAdvancedCollisions(f.context, 0, f.frame, owner);
    };
    const requireReady = (index: 0 | 1) => {
      const result = capture(index);
      if (result.kind !== 'ready') throw new Error('ready fixture required');
      return result.value;
    };
    try {
      owner.beginFrame();
      const first = requireReady(0),
        second = requireReady(1);
      owner.finishFrame();
      expect(prepared).toHaveBeenCalledTimes(2);
      expect(first.sdfFields).not.toEqual(second.sdfFields);
      owner.beginFrame();
      const source = sources[0];
      const valid = source.value;
      source.value = {
        ...valid,
        distanceField: { ...valid.distanceField, values: new Float32Array() },
      };
      source.contentRevision = 2;
      expect(capture(0)).toMatchObject({ kind: 'failed' });
      source.value = valid;
      source.contentRevision = 1;
      expect(requireReady(0).sdfFields).toEqual(first.sdfFields);
      expect(requireReady(1).sdfFields).toEqual(second.sdfFields);
      expect(prepared).toHaveBeenCalledTimes(2);
      owner.finishFrame();
    } finally {
      prepared.mockRestore();
      captureSource.mockRestore();
      for (const f of fixtures) f.assets.dispose();
    }
  });

  it('keeps missing authoring and invalid native siblings failed despite pending admission', async () => {
    const f = await advancedWaterFixture();
    registerPhysicsComponents(f.world);
    const missing = f.world
      .spawn({ component: WaterShallowCollider, data: { enabled: true } })
      .unwrap();
    const pendingFailure = new PhysicsFixedError('fixed-body-missing', {
      entity: missing,
      reason: 'new authored body',
      recovery: 'await-native-sync',
    });
    const snapshot = vi.fn((_entity: number) => err(pendingFailure));
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: snapshot,
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({ kind: 'failed' });
    f.world.addComponent(missing, { component: RigidBody, data: {} }).unwrap();
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({ kind: 'pending' });
    const invalid = f.world
      .spawn(
        { component: RigidBody, data: {} },
        { component: WaterShallowCollider, data: { enabled: true } },
      )
      .unwrap();
    for (const code of [
      'fixed-body-missing',
      'fixed-generation-stale',
      'fixed-input-invalid',
    ] as const) {
      snapshot.mockImplementation((entity) =>
        err(
          entity === missing
            ? pendingFailure
            : new PhysicsFixedError(code, {
                entity: invalid,
                reason: 'invalid or retired native source',
              }),
        ),
      );
      expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
        kind: 'failed',
        error: { detail: { cause: { code, detail: { entity: invalid } } } },
      });
    }
    f.assets.dispose();
  });

  it('holds the whole roster until a newly authored body is natively synchronized', async () => {
    const f = await advancedWaterFixture();
    f.world.components.register(Transform).unwrap();
    f.world.components.register(GlobalTransform).unwrap();
    registerPhysicsComponents(f.world);
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    f.world.insertResource(PhysicsWorldResource, advancedPhysicsFixture(physics));
    const spawn = () =>
      f.world
        .spawn(
          { component: Transform, data: { pos: [10, 6, 20] } },
          { component: RigidBody, data: {} },
          { component: Collider, data: { shape: ColliderShapeValue.sphere } },
          { component: WaterShallowCollider, data: { enabled: true } },
        )
        .unwrap();
    try {
      const first = spawn();
      physics._syncFromEcs(f.world, Transform, GlobalTransform);
      const pending = spawn();
      expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
        kind: 'pending',
        error: { detail: { entity: pending, recovery: 'await-native-sync' } },
      });
      physics._syncFromEcs(f.world, Transform, GlobalTransform);
      const ready = captureAdvancedCollisions(f.context, 0, f.frame);
      expect(ready).toMatchObject({
        kind: 'ready',
        value: { roster: [{ entity: first }, { entity: pending }] },
      });
      f.world.set(first, WaterShallowCollider, { enabled: false }).unwrap();
      f.world.despawn(pending).unwrap();
      expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
        kind: 'ready',
        value: { roster: [] },
      });
    } finally {
      physics.dispose();
      f.assets.dispose();
    }
  });

  it('distinguishes an authored plane from one-cell full thickness with a positive native gap', async () => {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    for (const overlapThicknessCells of [0, 1]) {
      const f = await advancedWaterFixture({
        kind: 'simple',
        accurate: false,
        useWaterHeightForCollision: false,
        collisionGroups: 0xffff_ffff,
        collisionOffsetCells: 0,
        overlapThicknessCells,
        softCollisionFalloffM: 0.3,
        maxElements: 100,
      });
      const entity = f.world
        .spawn({ component: WaterShallowCollider, data: { enabled: true } })
        .unwrap();
      const dx = f.frame.transform.extentM[0] / f.recipe.shallowStageConfig.gridResolution[0];
      const physics = createRapier3DPhysicsWorld(module);
      try {
        physics.ensureBody(
          entity,
          {
            position: { x: 10, y: 6 + dx / 4, z: 20 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: dx / 8, z: 1 },
          },
          { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
          {
            shape: ColliderShapeValue.cuboid,
            mesh: 0 as AssetHandle<'mesh'>,
            halfExtents: [0.5, 0.5, 0.5],
            radius: 0.5,
            halfHeight: 0.5,
            friction: 0,
            restitution: 0,
            density: 1,
            isSensor: false,
            collisionGroups: 0xffff_ffff,
            solverGroups: 0xffff_ffff,
          },
        );
        f.world.insertResource(PhysicsWorldResource, advancedPhysicsFixture(physics));
        const captured = captureAdvancedCollisions(f.context, 0, f.frame);
        expect(captured.kind).toBe('ready');
        if (captured.kind !== 'ready') throw captured.error;
        expect(captured.value.roster).toHaveLength(overlapThicknessCells);
      } finally {
        physics.dispose();
      }
    }
  });

  it('selects once by the runtime surface and retains the full component roster in primitive order', async () => {
    const f = await advancedWaterFixture();
    const entity = f.world
      .spawn({ component: WaterShallowCollider, data: { enabled: true } })
      .unwrap();
    const accepted = body(entity, [
      box(),
      { ...box(1), shape: { kind: 'sphere', radiusM: 1 } },
      { ...box(2), shape: { kind: 'capsule', radiusM: 1, halfHeightM: 1 } },
    ]);
    const snapshot = vi.fn(() => ok(accepted));
    const overlap = vi.fn((_input: PhysicsBodyObbQuery) => ok(true));
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: snapshot,
        intersectsCommittedBodyObb: overlap,
      }),
    );
    const captured = captureAdvancedCollisions(f.context, 0, f.frame);
    expect(captured.kind).toBe('ready');
    if (captured.kind !== 'ready') throw captured.error;
    expect(overlap).toHaveBeenCalledTimes(1);
    expect(overlap.mock.calls[0]?.[0]).toMatchObject({
      entity,
      generation: 3,
      completedStep: 8,
      positionM: [10, 6, 20],
    });
    expect(overlap.mock.calls[0]?.[0].fullExtentsM).toEqual([8, 1, 12]);
    expect(overlap.mock.calls[0]?.[0].rotation).toEqual([0, 0, 0, 1]);
    expect(snapshot).toHaveBeenCalledWith(entity, 0xffff_ffff);
    expect(captured.value.roster.map((row) => row.representation)).toEqual([
      'sphere',
      'capsule',
      'box',
    ]);
    expect(captured.value.roster.map((row) => row.motionDiscontinuity)).toEqual([5, 5, 5]);
    expect(captured.value.roster.map((row) => row.identity)).toEqual(
      [1, 2, 0].map((elementIndex) => ({
        kind: 'native-collider',
        colliderId: `native:${elementIndex}`,
        generation: 4,
        elementIndex,
      })),
    );
  });

  it('never gives a nonempty aggregate filtered to zero a mesh-bounds fallback', async () => {
    const f = await advancedWaterFixture();
    const mesh = f.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const entity = f.world
      .spawn(
        { component: WaterShallowCollider, data: { enabled: true } },
        { component: MeshFilter, data: { assetHandle: mesh } },
      )
      .unwrap();
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: () => ok(body(entity, [], 2)),
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    const held = vi.fn();
    const captured = captureAdvancedCollisions(
      { ...f.context, referenceAssetVersion: held },
      0,
      f.frame,
    );
    expect(captured).toMatchObject({ kind: 'ready', value: { roster: [] } });
    expect(held).not.toHaveBeenCalled();
  });

  it('uses one exact held mesh for raw-empty local bounds and a distinct fallback identity', async () => {
    const f = await advancedWaterFixture();
    const mesh = f.assets.create(createBoxGeometry(2, 4, 6).unwrap()).unwrap();
    const revision = f.assets.revision(mesh).unwrap();
    const entity = f.world
      .spawn(
        { component: WaterShallowCollider, data: { enabled: true } },
        { component: MeshFilter, data: { assetHandle: mesh } },
      )
      .unwrap();
    const overlap = vi.fn((_input: PhysicsBodyObbQuery) => ok(true));
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: () => ok(body(entity, [])),
        intersectsCommittedBodyObb: overlap,
      }),
    );
    const held = vi.fn();
    const captured = captureAdvancedCollisions(
      { ...f.context, referenceAssetVersion: held },
      0,
      f.frame,
    );
    expect(held).toHaveBeenCalledExactlyOnceWith({
      handle: mesh,
      revision,
      contentRevision: revision,
      value: f.assets.read(mesh).unwrap(),
    });
    expect(overlap.mock.calls[0]?.[0].emptyAggregateLocalBounds).toEqual({
      centerM: [0, 0, 0],
      halfExtentsM: [1, 2, 3],
    });
    expect(captured).toMatchObject({
      kind: 'ready',
      value: {
        roster: [
          {
            entity,
            bodyGeneration: 3,
            identity: { kind: 'component-bounds', handle: mesh, revision },
            representation: 'bounds',
            mesh: { handle: mesh, revision },
          },
        ],
      },
    });
    if (captured.kind !== 'ready') throw captured.error;
    expect(Array.from(captured.value.primitives.slice(32, 36))).toEqual([2, 2, 6, 12]);
  });

  it('rejects missing raw-empty bounds and forwards stale native query failures without partial capture', async () => {
    const f = await advancedWaterFixture();
    const entity = f.world
      .spawn({ component: WaterShallowCollider, data: { enabled: true } })
      .unwrap();
    const snapshot = vi.fn(() => ok(body(entity, [])));
    const overlap = vi.fn(() =>
      err(new PhysicsFixedError('fixed-step-stale', { entity, reason: 'stale frame' })),
    );
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: snapshot,
        intersectsCommittedBodyObb: overlap,
      }),
    );
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
      kind: 'failed',
      error: { expected: expect.stringContaining('finite held MeshAsset local bounds') },
    });
    expect(overlap).not.toHaveBeenCalled();
    snapshot.mockReturnValue(ok(body(entity, [box()])));
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
      kind: 'failed',
      error: {
        detail: { cause: { code: 'fixed-step-stale' } },
      },
    });
  });

  it('applies the element budget to every retained element of selected components', async () => {
    const f = await advancedWaterFixture({
      kind: 'simple',
      accurate: false,
      useWaterHeightForCollision: false,
      collisionGroups: 0xffff_ffff,
      collisionOffsetCells: 0,
      overlapThicknessCells: 1,
      softCollisionFalloffM: 0.3,
      maxElements: 1,
    });
    const entity = f.world
      .spawn({ component: WaterShallowCollider, data: { enabled: true } })
      .unwrap();
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: () => ok(body(entity, [box(), box(1)])),
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
      kind: 'failed',
      error: {
        expected: expect.stringContaining(
          'at most 1 accepted rigid elements across selected components',
        ),
      },
    });
  });

  it('retains the accepted primitive when the held distance field is absent', async () => {
    const f = await advancedWaterFixture({
      kind: 'distance-field',
      accurate: true,
      useWaterHeightForCollision: false,
      collisionGroups: 0xffff_ffff,
      collisionOffsetCells: 0,
      overlapThicknessCells: 1,
      softCollisionFalloffM: 0.3,
      maxElements: 100,
    });
    const mesh = f.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const revision = f.assets.revision(mesh).unwrap();
    const entity = f.world
      .spawn(
        { component: WaterShallowCollider, data: { enabled: true } },
        { component: MeshFilter, data: { assetHandle: mesh } },
      )
      .unwrap();
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: () => ok(body(entity, [box()])),
        intersectsCommittedBodyObb: () => ok(true),
      }),
    );
    const captured = captureAdvancedCollisions(
      {
        ...f.context,
        referenceAssetVersion: () =>
          ok({ handle: mesh, revision, value: f.assets.read(mesh).unwrap() }),
      },
      0,
      f.frame,
    );
    expect(captured).toMatchObject({
      kind: 'ready',
      value: { roster: [{ representation: 'box', mesh: { handle: mesh, revision } }] },
    });
  });

  it('submits no selected geometry for disabled or nonoverlapping participants', async () => {
    const f = await advancedWaterFixture();
    const entity = f.world
      .spawn({ component: WaterShallowCollider, data: { enabled: false } })
      .unwrap();
    const snapshot = vi.fn(() => ok(body(entity, [box()])));
    const overlap = vi.fn(() => ok(false));
    f.world.insertResource(
      PhysicsWorldResource,
      advancedPhysicsFixture({
        getCommittedColliderPrimitives: snapshot,
        intersectsCommittedBodyObb: overlap,
      }),
    );
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
      kind: 'ready',
      value: { roster: [] },
    });
    expect(snapshot).not.toHaveBeenCalled();
    f.world.set(entity, WaterShallowCollider, { enabled: true }).unwrap();
    expect(captureAdvancedCollisions(f.context, 0, f.frame)).toMatchObject({
      kind: 'ready',
      value: { roster: [] },
    });
    expect(overlap).toHaveBeenCalledTimes(1);
  });
});
