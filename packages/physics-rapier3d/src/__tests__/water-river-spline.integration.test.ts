import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { definePackageId } from '@forgeax/engine-pack/source';
import type { WaterBodySourceAsset } from '@forgeax/engine-water';
import {
  buildRiverPhysicsCandidateInput,
  buildWaterBodyGeometry,
  buildWaterPackOutputs,
  buildWaterPhysicsCandidateInput,
} from '@forgeax/engine-water';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const point = (inputKey: number, x: number) => ({
  inputKey,
  positionM: [x, 2, 0] as const,
  arriveTangentM: [10, 0, 0] as const,
  leaveTangentM: [10, 0, 0] as const,
  up: [0, 1, 0] as const,
  rollAngle: 0,
  angleUnit: 'degrees' as const,
  widthM: 4,
  depthM: 2,
  velocityMPerSec: 0,
  audioIntensity: 0,
});

const river = (): WaterBodySourceAsset => ({
  kind: 'water-body',
  type: 'river',
  spline: { closed: false, points: [point(0, 0), point(1, 10), point(2, 20)] },
  baseHeightM: 2,
  overlapPriority: 0,
  maxWaveHeightM: 0,
  surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
  flags: { affectsWaterInfo: true, affectsWaterMesh: true, affectsLandscape: false },
  collision: { type: 'river-prism', enabled: true },
  queryFootprint: [
    [0, -2],
    [20, -2],
    [20, 2],
    [0, 2],
  ],
});

describe('River spline mesh collision in Rapier 3D', () => {
  it('publishes both segments at a fixed step and contacts the shared endpoint', async () => {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    try {
      physics.setGravity(vec3.create());
      const pose = (x: number, y: number, z: number) => ({
        position: { x, y, z },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      });
      physics.ensureBody(
        1,
        pose(0, 0, 0),
        {
          type: 0,
          mass: 1,
          linearDamping: 0,
          angularDamping: 0,
          gravityScale: 0,
          ccdEnabled: 0,
        },
        undefined,
      );
      physics.ensureBody(
        2,
        pose(10, 2.25, 1.8),
        {
          type: 1,
          mass: 1,
          linearDamping: 0,
          angularDamping: 0,
          gravityScale: 0,
          ccdEnabled: 0,
        },
        {
          shape: 1,
          mesh: 0,
          halfExtents: [0.5, 0.5, 0.5],
          radius: 0.3,
          halfHeight: 0.5,
          friction: 0.5,
          restitution: 0,
          density: 1,
          isSensor: false,
          collisionGroups: 0xffffffff,
          solverGroups: 0xffffffff,
        },
      );

      const geometry = buildWaterBodyGeometry(river()).unwrap();
      expect(geometry.riverSegments).toHaveLength(2);
      expect(geometry.riverSegments.map((segment) => segment.collisionConvexes?.length)).toEqual([
        4, 4,
      ]);
      const input = buildRiverPhysicsCandidateInput({
        entity: 1,
        sourceKey: 'water:river:1',
        revision: 1,
        segments: geometry.riverSegments,
      }).unwrap();
      const candidate = physics.prepareDerivedShapeCandidate(input).unwrap();
      physics.admitDerivedShapeCandidate(candidate).unwrap();
      expect(physics.getDerivedPublication(1)).toBeUndefined();
      physics.step(1 / 60);
      expect(physics.getDerivedPublication(1)).toMatchObject({ revision: 1, fixedStep: 1 });
      const acceptedPublication = requiredFixtureValue(physics.getDerivedPublication(1));
      const acceptedCollision = requiredFixtureValue(physics.getDerivedCollisionReceipt(1));
      const acceptedFirstVertex = acceptedCollision.shapes[0]?.pieces[0]?.[0];
      expect(acceptedCollision.publication).toBe(acceptedPublication);
      expect(physics.getDerivedCollisionReceipt(1)).toBe(acceptedCollision);
      expect(acceptedCollision.shapes).toMatchObject([
        { kind: 'convex-compound', id: 'water-river', revision: 1 },
      ]);
      expect(
        acceptedCollision.shapes[0]?.kind === 'convex-compound'
          ? acceptedCollision.shapes[0].pieces
          : [],
      ).toHaveLength(8);

      for (const x of [1, 9.9, 10, 10.1, 19]) {
        const hit = physics.raycast(vec3.create(x, 5, 0), vec3.create(0, -1, 0), 10);
        expect(hit?.entity).toBe(1);
        expect(hit?.point[1]).toBeCloseTo(2, 2);
      }
      expect(physics.getContactObservations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'started',
            fixedStep: 1,
            entityA: 2,
            entityB: 1,
            shapeB: 'water-river',
          }),
        ]),
      );

      const moved = {
        ...river(),
        spline: {
          ...river().spline,
          points: river().spline.points.map((row) => ({
            ...row,
            positionM: [row.positionM[0] + 100, row.positionM[1], row.positionM[2]] as const,
          })),
        },
      };
      const movedGeometry = buildWaterBodyGeometry(moved).unwrap();
      const movedInput = buildRiverPhysicsCandidateInput({
        entity: 1,
        sourceKey: 'water:river:1',
        revision: 2,
        segments: movedGeometry.riverSegments,
      }).unwrap();
      const movedCandidate = physics.prepareDerivedShapeCandidate(movedInput).unwrap();
      physics.admitDerivedShapeCandidatesGuarded([movedCandidate], () => false).unwrap();
      physics.step(1 / 60);
      expect(physics.getDerivedFailure(1)?.recovery).toBe('old-state-retained');
      expect(physics.getDerivedPublication(1)).toBe(acceptedPublication);
      expect(physics.getDerivedCollisionReceipt(1)).toBe(acceptedCollision);
      expect(acceptedCollision.shapes[0]?.pieces[0]?.[0]).toBe(acceptedFirstVertex);
      physics.removeEntity(1);
      expect(physics.getDerivedPublication(1)).toBeUndefined();
      expect(physics.getDerivedCollisionReceipt(1)).toBeUndefined();
      expect(acceptedCollision.publication).toBe(acceptedPublication);
    } finally {
      physics.dispose();
    }
  });
});

describe('world-space Ocean collision in Rapier 3D', () => {
  it('keeps its axis-aligned box extents after rotated non-uniform actor scaling and fixed-step admission', async () => {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    try {
      physics.setGravity(vec3.create());
      const half = Math.SQRT1_2;
      const matrix = [
        half * 2,
        0,
        -half * 2,
        0,
        0,
        3,
        0,
        0,
        half * 0.5,
        0,
        half * 0.5,
        0,
        5,
        7,
        -3,
        1,
      ] as const;
      const oceanLoop = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const;
      const ocean: WaterBodySourceAsset = {
        ...river(),
        type: 'ocean',
        oceanExtentM: [20, 12],
        spline: {
          closed: true,
          points: oceanLoop.map(([x, z], inputKey) => ({
            ...point(inputKey, x),
            positionM: [x, 0, z] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
          })),
        },
        collision: {
          type: 'polygon',
          enabled: true,
          collisionHalfHeightM: 4,
          collisionHalfExtentsM: [10, 6],
        },
      };
      physics.ensureBody(
        3,
        {
          position: { x: 5, y: 7, z: -3 },
          rotation: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
          scale: { x: 2, y: 3, z: 0.5 },
        },
        { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
        undefined,
      );
      const packed = await buildWaterPackOutputs(
        { ocean },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000498') },
      );
      if (!packed.ok) throw new Error(JSON.stringify(packed.error));
      if (!packed.ok || packed.value.ocean?.kind !== 'water-body') return;
      const input = buildWaterPhysicsCandidateInput({
        entity: 3,
        sourceKey: 'water:ocean:3',
        revision: 1,
        body: packed.value.ocean,
        bodyWorldMatrixM: matrix,
        exclusionVolumes: [],
      }).unwrap();
      physics
        .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input).unwrap())
        .unwrap();
      expect(physics.getDerivedPublication(3)).toBeUndefined();
      physics.step(1 / 60);
      expect(physics.getDerivedPublication(3)).toMatchObject({ revision: 1, fixedStep: 1 });
      expect(physics.raycast(vec3.create(14.5, 5, -3), vec3.create(-1, 0, 0), 1)?.entity).toBe(3);
      expect(physics.raycast(vec3.create(16.1, 5, -3), vec3.create(-1, 0, 0), 1)).toBeUndefined();
      expect(physics.raycast(vec3.create(5, 5, 2.5), vec3.create(0, 0, -1), 1)?.entity).toBe(3);
      expect(physics.raycast(vec3.create(5, 5, 4.1), vec3.create(0, 0, -1), 0.9)).toBeUndefined();
    } finally {
      physics.dispose();
    }
  });

  it('cooks and admits a static Custom collision mesh as a trimesh with fixed-step receipts', async () => {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    try {
      physics.setGravity(vec3.create());
      const meshGuid = '00000000-0000-7000-8000-000000000498';
      const mesh = createBoxGeometry(4, 2, 4).unwrap();
      const source: WaterBodySourceAsset = {
        ...river(),
        type: 'custom',
        flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
        collision: { type: 'custom-mesh', enabled: true, meshGuid },
      };
      const packed = await buildWaterPackOutputs(
        { body: source },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000497'),
          readByGuid: async () => ({ ok: true, value: mesh }),
        },
      );
      expect(packed.ok).toBe(true);
      if (!packed.ok || packed.value.body?.kind !== 'water-body') return;
      const body = packed.value.body;
      physics.ensureBody(
        4,
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
        undefined,
      );
      const input = buildWaterPhysicsCandidateInput({
        entity: 4,
        sourceKey: 'water:custom:4',
        revision: 1,
        body,
        bodyWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        exclusionVolumes: [],
      }).unwrap();
      expect(input.shapes.map((shape) => shape.kind)).toEqual(['trimesh']);
      const trimeshInput = input.shapes[0];
      if (trimeshInput?.kind !== 'trimesh')
        throw new Error('Custom collision fixture must produce a trimesh');
      physics
        .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input).unwrap())
        .unwrap();
      expect(physics.getDerivedPublication(4)).toBeUndefined();
      physics.step(1 / 60);
      const firstPublication = physics.getDerivedPublication(4);
      expect(firstPublication).toMatchObject({ revision: 1, fixedStep: 1 });
      expect(physics.getDerivedCollisionReceipt(4)?.shapes).toMatchObject([
        {
          kind: 'trimesh',
          vertices: Array.from(trimeshInput.vertices),
          indices: Array.from(trimeshInput.indices),
        },
      ]);
      expect(physics.raycast(vec3.create(0, 5, 0), vec3.create(0, -1, 0), 10)?.entity).toBe(4);

      const rejectedCook = await buildWaterPackOutputs(
        { body: source },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000497') },
      );
      expect(rejectedCook.ok).toBe(false);
      physics.step(1 / 60);
      expect(physics.getDerivedPublication(4)).toBe(firstPublication);
      expect(physics.raycast(vec3.create(0, 5, 0), vec3.create(0, -1, 0), 10)?.entity).toBe(4);

      const updatedMesh = createBoxGeometry(6, 2, 6).unwrap();
      const updatedCook = await buildWaterPackOutputs(
        { body: source },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000497'),
          readByGuid: async () => ({ ok: true as const, value: updatedMesh }),
        },
      );
      expect(updatedCook.ok).toBe(true);
      if (!updatedCook.ok || updatedCook.value.body?.kind !== 'water-body') return;
      const updatedInput = buildWaterPhysicsCandidateInput({
        entity: 4,
        sourceKey: 'water:custom:4',
        revision: 2,
        body: updatedCook.value.body,
        bodyWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        exclusionVolumes: [],
      }).unwrap();
      physics
        .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(updatedInput).unwrap())
        .unwrap();
      physics.step(1 / 60);
      expect(physics.getDerivedPublication(4)).toMatchObject({ revision: 2, fixedStep: 3 });
      expect(physics.getDerivedCollisionReceipt(4)?.shapes).toMatchObject([
        { kind: 'trimesh', revision: 2 },
      ]);
    } finally {
      physics.dispose();
    }
  });

  it('raycasts through Ocean collision holes as misses, with exterior and touching-boundary hits', async () => {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    try {
      physics.setGravity(vec3.create());
      const loop = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const;
      const source: WaterBodySourceAsset = {
        ...river(),
        type: 'ocean',
        oceanExtentM: [20, 20],
        spline: {
          closed: true,
          points: loop.map(([x, z], inputKey) => ({
            ...point(inputKey, x),
            positionM: [x, 0, z] as const,
            arriveTangentM: [0, 0, 0] as const,
            leaveTangentM: [0, 0, 0] as const,
          })),
        },
        collision: {
          type: 'polygon',
          enabled: true,
          collisionHalfHeightM: 20,
          collisionHalfExtentsM: [10, 10],
        },
      };
      const packed = await buildWaterPackOutputs(
        { ocean: source },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000495') },
      );
      if (!packed.ok || packed.value.ocean?.kind !== 'water-body')
        throw new Error(JSON.stringify(packed));
      const exclusion = {
        entity: 99,
        centerM: [0, -18, 0] as const,
        halfExtentsM: [2, 25, 2] as const,
        worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const,
      };
      const input = buildWaterPhysicsCandidateInput({
        entity: 5,
        sourceKey: 'water:ocean-hole:5',
        revision: 1,
        body: packed.value.ocean,
        bodyWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        exclusionVolumes: [exclusion],
      }).unwrap();
      physics.ensureBody(
        5,
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
        undefined,
      );
      physics
        .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input).unwrap())
        .unwrap();
      physics.step(1 / 60);
      expect(physics.getDerivedCollisionReceipt(5)?.shapes).toHaveLength(1);
      const ray = (x: number) =>
        physics.raycast(vec3.create(x, 5, 0), vec3.create(0, -1, 0), 50)?.entity;
      expect(ray(0)).toBeUndefined();
      expect(ray(5)).toBe(5);
      expect(ray(2)).toBe(5);
    } finally {
      physics.dispose();
    }
  });
});
