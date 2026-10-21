import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Disabled, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { RigidBody, RigidBodyTypeValue, registerPhysicsComponents } from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain, terrainHeight, terrainHeightfield } from '@forgeax/engine-terrain';
import { describe, expect, it } from 'vitest';
import { samplerContribution } from '../../../render/src/assets/asset-decoders';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

describe('real Rapier heightfield admission', () => {
  it('publishes a noncoplanar heightfield, preserves it after a rejected hole, and recovers it', async () => {
    const physics = createRapier3DPhysicsWorld(await loadRapier3D());
    try {
      physics.ensureBody(
        1,
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        { type: 0, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
        undefined,
      );
      const input = {
        entity: 1,
        sourceKey: 'terrain',
        revision: 1,
        bodyType: 'static' as const,
        shapes: [
          {
            kind: 'heightfield' as const,
            id: 'ground',
            revision: 1,
            rows: 1,
            columns: 1,
            heights: new Float32Array([0, 0, 0, 1]),
            scale: [1, 1, 1] as const,
            origin: [0.5, 0, 0.5] as const,
          },
        ],
      };
      const candidate = physics.prepareDerivedShapeCandidate(input).unwrap();
      expect(physics.getDerivedPublication(1)).toBeUndefined();
      physics.admitDerivedShapeCandidate(candidate).unwrap();
      physics.step(1 / 60);
      const hit = physics.raycast(vec3.create(0.5, 5, 0.5), vec3.create(0, -1, 0), 10);
      expect(hit?.point[1]).toBeCloseTo(0, 5);
      expect(physics.getDerivedPublication(1)?.revision).toBe(1);
      const invalid = {
        ...input,
        revision: 2,
        shapes: [
          { ...defined(input.shapes[0]), revision: 2, heights: new Float32Array([0, NaN, 0, 1]) },
        ],
      };
      expect(physics.prepareDerivedShapeCandidate(invalid).ok).toBe(false);
      physics.step(1 / 60);
      expect(
        physics.raycast(vec3.create(0.5, 5, 0.5), vec3.create(0, -1, 0), 10)?.point[1],
      ).toBeCloseTo(0, 5);
      const snapshot = physics.captureDerivedPhysicsState();
      const fresh = createRapier3DPhysicsWorld(await loadRapier3D());
      try {
        fresh.ensureBody(
          1,
          {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          { type: 0, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
          undefined,
        );
        fresh.restoreDerivedPhysicsState(snapshot).unwrap();
        fresh.step(1 / 60);
        expect(
          fresh.raycast(vec3.create(0.5, 5, 0.5), vec3.create(0, -1, 0), 10)?.point[1],
        ).toBeCloseTo(0, 5);
      } finally {
        fresh.dispose();
      }
      expect(snapshot.bodies[0]?.shapes[0]).toMatchObject({
        kind: 'heightfield',
        rows: 1,
        columns: 1,
        scale: [1, 1, 1],
      });
      expect(physics.getDerivedShapes(1)[0]).toMatchObject({
        kind: 'heightfield',
      });
    } finally {
      physics.dispose();
    }
  });
  it('preserves X/Z and the diagonal at asymmetric off-center points on a non-square matrix', async () => {
    const physics = createRapier3DPhysicsWorld(await loadRapier3D());
    try {
      physics.ensureBody(
        1,
        {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        { type: 0, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
        undefined,
      );
      const candidate = physics
        .prepareDerivedShapeCandidate({
          entity: 1,
          sourceKey: 'rectangle',
          revision: 1,
          bodyType: 'static',
          shapes: [
            {
              kind: 'heightfield',
              id: 'ground',
              revision: 1,
              rows: 1,
              columns: 2,
              heights: new Float32Array([1, 8, 2, 16, 4, 32]),
              scale: [2, 1, 1],
              origin: [1, 0, 0.5],
            },
          ],
        })
        .unwrap();
      physics.admitDerivedShapeCandidate(candidate).unwrap();
      physics.step(1 / 60);
      for (const [x, z, h] of [
        [0.2, 0.3, 3.3],
        [1.7, 0.8, 21.6],
      ])
        expect(
          physics.raycast(vec3.create(defined(x), 50, defined(z)), vec3.create(0, -1, 0), 100)
            ?.point[1],
        ).toBeCloseTo(defined(h), 4);
    } finally {
      physics.dispose();
    }
  });
});
it('withdraws Terrain colliders through the fixed-step owner while preserving the ordinary body', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const material = assets
    .create({
      kind: 'material',
      values: {},
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  world.components.register(Terrain).unwrap();
  registerPhysicsComponents(world);
  const asset = {
    kind: 'terrain' as const,
    materialEncoding: { kind: 'weights' as const },
    columns: 2,
    rows: 2,
    spacing: 1,
    subsectionVertices: 2,
    heights: new Float32Array([0, 0, 0, 1]),
    weights: new Float32Array(4).fill(1),
    layers: [{ material, blend: 'weight' as const }],
    heightRange: [0, 1] as const,
  };
  const terrain = assets.create(asset).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Terrain, data: { asset: terrain } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    )
    .unwrap();
  world
    .set(entity, GlobalTransform, {
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })
    .unwrap();
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  const step = () => {
    physics._syncFromEcs(world, Transform, GlobalTransform);
    physics.step(1 / 60);
    physics.finalizeDerivedFixedStep();
  };
  const ray = () => physics.raycast(vec3.create(0.5, 5, 0.5), vec3.create(0, -1, 0), 10);
  try {
    step();
    expect(ray()?.point[1]).toBeCloseTo(0, 5);
    const count = physics.raw.colliders.len();
    step();
    expect(physics.raw.colliders.len()).toBe(count);
    world.removeComponent(entity, Terrain).unwrap();
    step();
    expect(ray()).toBeUndefined();
    expect(world.hasComponent(entity, RigidBody)).toBe(true);
    expect(physics.raw.colliders.len()).toBe(0);
    world
      .addComponent(entity, {
        component: Terrain,
        data: { asset: terrain },
      })
      .unwrap();
    step();
    expect(ray()?.point[1]).toBeCloseTo(0, 5);
    const pose = world.get(entity, GlobalTransform).unwrap();
    world.removeComponent(entity, GlobalTransform).unwrap();
    step();
    expect(ray()).toBeUndefined();
    expect(physics.raw.colliders.len()).toBe(0);
    expect(world.hasComponent(entity, RigidBody)).toBe(true);
    world.addComponent(entity, { component: GlobalTransform, data: pose }).unwrap();
    step();
    expect(ray()?.point[1]).toBeCloseTo(0, 5);
    world.removeComponent(entity, Transform).unwrap();
    step();
    expect(ray()).toBeUndefined();
    expect(physics.raw.colliders.len()).toBe(0);
    world.addComponent(entity, { component: Transform, data: {} }).unwrap();
    step();
    expect(ray()?.point[1]).toBeCloseTo(0, 5);
    world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    step();
    expect(ray()).toBeUndefined();
  } finally {
    physics.dispose();
  }
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}

it.each([
  'tiny-scale',
  'world-overflow',
] as const)('rejects %s through real Physics Terrain admission', async (mode) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const material = assets
    .create({
      kind: 'material',
      values: {},
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  for (const component of [Transform, GlobalTransform, Terrain])
    world.components.register(component).unwrap();
  registerPhysicsComponents(world);
  const asset = {
    kind: 'terrain' as const,
    materialEncoding: { kind: 'weights' as const },
    columns: 2,
    rows: 2,
    spacing: 1,
    subsectionVertices: 2,
    heights: new Float32Array(
      mode === 'world-overflow' ? [-1e38, 1e38, -1e38, 1e38] : [0, 0, 0, 1],
    ),
    weights: new Float32Array(4).fill(1),
    layers: [{ material, blend: 'weight' as const }],
    heightRange: (mode === 'world-overflow' ? [-1e38, 1e38] : [0, 1]) as [number, number],
  };
  const terrain = assets.create(asset).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Terrain, data: { asset: terrain } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    )
    .unwrap();
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (mode === 'tiny-scale') matrix[0] = 1.0000001;
  else matrix[13] = 3e38;
  world.set(entity, GlobalTransform, { world: matrix }).unwrap();
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  try {
    expect(() => physics._syncFromEcs(world, Transform, GlobalTransform)).toThrow(
      expect.objectContaining({ code: 'terrain-pose-unsupported' }),
    );
    expect(physics.getDerivedPublication(entity)).toBeUndefined();
    expect(physics.getDerivedShapes(entity)).toEqual([]);
  } finally {
    physics.dispose();
  }
});

it('keeps decimal-spacing author boundaries consistent with real Rapier triangles', async () => {
  const source = {
    columns: 4,
    rows: 2,
    spacing: 0.1,
    subsectionVertices: 2,
    heights: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
    weights: new Float32Array(8).fill(1),
    layers: [{ material: 'layer', blend: 'weight' as const }],
  };
  const shape = terrainHeightfield(source);
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  try {
    physics.ensureBody(
      1,
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 0, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    physics
      .admitDerivedShapeCandidate(
        physics
          .prepareDerivedShapeCandidate({
            entity: 1,
            sourceKey: 'decimal-terrain',
            revision: 1,
            bodyType: 'static',
            shapes: [
              {
                kind: 'heightfield',
                id: 'decimal-terrain',
                revision: 1,
                rows: shape.rows,
                columns: shape.columns,
                heights: shape.heights,
                scale: shape.scale,
                origin: shape.origin,
              },
            ],
          })
          .unwrap(),
      )
      .unwrap();
    physics.step(1 / 60);
    for (const [x, z] of [
      [0.25, 0.03],
      [0.3, 0.05],
      [0.3, 0.1],
    ] as const) {
      const hit = physics.raycast(vec3.create(x, 5, z), vec3.create(0, -1, 0), 10);
      expect(hit).toBeDefined();
      expect(
        Math.abs(defined(defined(hit).point[1]) - defined(terrainHeight(source, x, z))),
      ).toBeLessThanOrEqual(1e-5);
    }
    expect(terrainHeight(source, (source.columns - 1) * source.spacing, source.spacing)).toBe(1);
  } finally {
    physics.dispose();
  }
});
