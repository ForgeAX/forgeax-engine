import { defineSystem } from '@forgeax/engine/ecs';
import { PhysicsSimulation, PhysicsSync, PhysicsWorldResource } from '@forgeax/engine/physics';
import { writeFile } from 'node:fs/promises';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine/assets-runtime/internal';
import { createWorldContext, FixedUpdate, World } from '@forgeax/engine/ecs';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  Collider,
  type PhysicsBodyDynamics,
  type PhysicsWorld,
  RigidBody,
} from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { err, type MeshAsset, ok, type SceneAsset } from '@forgeax/engine/types';
import {
  rotateWaterVector,
  stepWaterBuoyancy,
  validateWaterRuntimeAsset,
  WATER_BUOYANCY_DEFAULTS,
  WaterBuoyancyCoefficientCache,
  type WaterBuoyancyStep,
  WaterSystem,
} from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import pack from '../../assets/estuary.pack';
import { applyBoatControls } from '../boat-controls';

const dt = 1 / 60;
const degrees = 180 / Math.PI;
const rollDegrees = (dynamics: PhysicsBodyDynamics) => {
  const up = rotateWaterVector(dynamics.rotation, [0, 1, 0]);
  return Math.atan2(up[2], up[1]) * degrees;
};

async function sailingFixture(cargoKg: number, cargoSideM: number) {
  const output = (
    await pack.build({
      packageId: pack.packageId,
      readByGuid: async () => err(new Error('Expected Pack-owned Water dependencies')),
    })
  ).unwrap();
  const scene = output['scene/estuary'] as SceneAsset;
  const source = scene.entities['lake-craft']?.components;
  if (!source?.RigidBody || !source.Transform || !source.WaterPontoonSet)
    throw new Error('Missing saved lake craft');
  const lake = validateWaterRuntimeAsset(output['body/lake']).unwrap();
  const off = validateWaterRuntimeAsset(output['waves/off']).unwrap();
  if (lake.kind !== 'water-body' || off.kind !== 'water-wave-set')
    throw new Error('Missing cooked lake');
  if (!lake.waveSetGuid) throw new Error('Missing saved lake WaveSet reference');
  const waveSetGuid = lake.waveSetGuid;
  const lakeGuid = AssetGuid.format(AssetGuid.derive(pack.packageId, 'body/lake'));
  const water = new WaterSystem(
    () => undefined,
    () => [
      {
        guid: waveSetGuid,
        field: 'waveSetGuid',
        kind: off.kind,
        status: 'valid',
        payload: off,
      },
    ],
  );
  const snapshot = water.mountBody(lakeGuid, 'native-sailing', lake).unwrap();
  const descriptor = lake.geometrySnapshot?.collisionDescriptor;
  if (!descriptor) throw new Error('Missing cooked lake sensor bounds');
  const xs = descriptor.footprint.outer.map((point) => point[0]);
  const zs = descriptor.footprint.outer.map((point) => point[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minZ = Math.min(...zs),
    maxZ = Math.max(...zs);
  const anchors = source.WaterPontoonSet.anchorsM;
  const radii = source.WaterPontoonSet.radiiM;
  const coefficient = source.WaterPontoonSet.buoyancyCoefficientNPerM3;
  if (
    !Array.isArray(anchors) ||
    !anchors.every((value) => typeof value === 'number') ||
    !Array.isArray(radii) ||
    !radii.every((value) => typeof value === 'number') ||
    typeof coefficient !== 'number'
  )
    throw new Error('Invalid saved native support');
  expect(source.Transform.pos).toEqual([-5, 0, 3]);
  expect(lake.waveSetGuid).toBe(AssetGuid.format(AssetGuid.derive(pack.packageId, 'waves/off')));
  const world = new World({ assets: new AssetRegistry() });
  const context = await createWorldContext(world, [scenePlugin(), physics3d]);
  const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const mesh = runtimeAssetRegistry(world.assets)
    .create(output['mesh/collider'] as MeshAsset)
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: source.Transform.pos as [number, number, number] } },
      {
        component: RigidBody,
        data: { mass: 125 + cargoKg, linearDamping: 0.02, angularDamping: 0.02, ccdEnabled: true },
      },
      { component: Collider, data: { shape: 5, mesh, density: 1, collisionGroups: 0x0001ffff } },
    )
    .unwrap();
  const sensor = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [
            (minX + maxX) / 2,
            (descriptor.minimumYM + descriptor.maximumYM) / 2,
            (minZ + maxZ) / 2,
          ],
        },
      },
      {
        component: Collider,
        data: {
          halfExtents: [
            (maxX - minX) / 2,
            (descriptor.maximumYM - descriptor.minimumYM) / 2,
            (maxZ - minZ) / 2,
          ],
          isSensor: true,
          collisionGroups: lake.collision.collisionGroups ?? 0x0002ffff,
        },
      },
    )
    .unwrap();
  const cache = new WaterBuoyancyCoefficientCache();
  let throttle = 0;
  let steering = 0;
  let latest: WaterBuoyancyStep | undefined;
  const history: PhysicsBodyDynamics[] = [];
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'nativeSailingRegression',
        after: [PhysicsSync],
        before: [PhysicsSimulation],
        queries: [],
        fn: () => {
          if (!physics.getCommittedBodyDynamics || !physics.getSensorOverlaps)
            throw new Error('Native sailing requires completed dynamics and sensor rosters');
          const dynamics = physics.getCommittedBodyDynamics(entity).unwrap();
          applyBoatControls(physics, entity, {
            throttle,
            steering,
            cargoKg,
            cargoPositionM: [-0.9, 0.95, cargoSideM],
          });
          if (dynamics.completedStep === 0) return;
          const overlaps = physics.getSensorOverlaps(entity, 0xffff0002).unwrap();
          latest = stepWaterBuoyancy({
            physics,
            water,
            dynamics,
            overlaps,
            coefficientCache: cache,
            pontoons: radii.map((radiusM, index) => {
              const x = anchors[index * 3];
              const y = anchors[index * 3 + 1];
              const z = anchors[index * 3 + 2];
              if (x === undefined || y === undefined || z === undefined)
                throw new Error('Missing saved support anchor');
              const anchor = [x, y, z] as const;
              const offset = rotateWaterVector(dynamics.rotation, anchor);
              return {
                id: `support-${index}`,
                enabled: true,
                radiusM,
                anchor: 'relative' as const,
                coefficientPositionM: anchor,
                centerM: [
                  offset[0] + dynamics.positionM[0],
                  offset[1] + dynamics.positionM[1],
                  offset[2] + dynamics.positionM[2],
                ] as const,
              };
            }),
            settings: {
              ...WATER_BUOYANCY_DEFAULTS,
              buoyancyCoefficientNPerM3: coefficient,
              applyDrag: true,
            },
            fixedDeltaSeconds: dt,
            fixedTimeSeconds: dynamics.completedStep * dt,
            resolveBody: (candidate) => {
              if (candidate.entity !== sensor) throw new Error('Unexpected native sensor');
              return ok(snapshot);
            },
          }).unwrap();
        },
      }),
    )
    .unwrap();
  const advance = (steps: number) => {
    for (let tick = 0; tick < steps; tick++) {
      world.update(dt).unwrap();
      const dynamics = physics.getCommittedBodyDynamics?.(entity).unwrap();
      if (!dynamics) throw new Error('Missing completed native dynamics');
      history.push(dynamics);
    }
    const dynamics = history.at(-1);
    if (!dynamics) throw new Error('No native steps completed');
    return dynamics;
  };
  return {
    world,
    context,
    physics,
    entity,
    history,
    advance,
    waterHeightM: lake.baseHeightM,
    controls: (motor: number, rudder: number) => {
      throttle = motor;
      steering = rudder;
    },
    latest: () => latest,
  };
}

it('settles 25 kg at starboard 0.45 m with wet support and a visible deck', async () => {
  const centered = await sailingFixture(0, 0);
  const loaded = await sailingFixture(25, 0.45);
  try {
    const calm = centered.advance(600);
    const cargo = loaded.advance(600);
    expect(cargo.massKg - calm.massKg).toBeCloseTo(25, 3);
    expect(cargo.positionM[1]).toBeLessThan(calm.positionM[1]);
    expect(Math.abs(rollDegrees(calm))).toBeLessThan(1);
    expect(Math.abs(rollDegrees(cargo))).toBeGreaterThan(2);
    expect(Math.abs(rollDegrees(cargo))).toBeLessThan(12);
    const tail = loaded.history.slice(-60);
    expect(Math.max(...tail.map(rollDegrees)) - Math.min(...tail.map(rollDegrees))).toBeLessThan(1);
    expect(Math.abs(cargo.linearVelocityMps[1])).toBeLessThan(0.03);
    const deckOffset = rotateWaterVector(cargo.rotation, [-0.3, 0.65, 0]);
    expect(cargo.positionM[1] + deckOffset[1] - loaded.waterHeightM).toBeGreaterThan(0.2);
    expect(
      loaded.latest()?.pontoons.every((pontoon) => pontoon.immersionM > 0 && pontoon.volumeM3 > 0),
    ).toBe(true);
    expect(cargo.completedStep).toBe(600);
    if (process.env.FORGEAX_BOAT_REGRESSION_EVIDENCE_ROOT)
      await writeFile(
        `${process.env.FORGEAX_BOAT_REGRESSION_EVIDENCE_ROOT}/cargo.json`,
        `${JSON.stringify(
          {
            cargoKg: 25,
            cargoPositionM: [-0.9, 0.95, 0.45],
            nativeSteps: 600,
            waterHeightM: loaded.waterHeightM,
            centered: calm,
            loaded: cargo,
            rollDegrees: rollDegrees(cargo),
            tail,
            latest: loaded.latest(),
          },
          null,
          2,
        )}\n`,
      );
  } finally {
    await centered.context.fiber.dispose();
    await loaded.context.fiber.dispose();
  }
}, 30_000);

it('drives and steers the wet craft with opposite native heading changes', async () => {
  const left = await sailingFixture(0, 0);
  const right = await sailingFixture(0, 0);
  try {
    const start = left.advance(180);
    right.advance(180);
    left.controls(1, 0);
    right.controls(1, 0);
    const underway = left.advance(120);
    right.advance(120);
    expect(underway.linearVelocityMps[0]).toBeGreaterThan(0.5);
    expect(underway.positionM[0] - start.positionM[0]).toBeGreaterThan(0.5);
    left.controls(1, -1);
    right.controls(1, 1);
    const port = left.advance(60);
    const starboard = right.advance(60);
    const a = rotateWaterVector(port.rotation, [1, 0, 0]);
    const b = rotateWaterVector(starboard.rotation, [1, 0, 0]);
    expect(a[2] * b[2]).toBeLessThan(0);
    expect(Math.abs(a[2])).toBeGreaterThan(0.05);
    expect(Math.abs(b[2])).toBeGreaterThan(0.05);
    expect(port.angularVelocityRadps[1] * starboard.angularVelocityRadps[1]).toBeLessThan(0);
    expect(left.latest()?.pontoons.some((pontoon) => pontoon.volumeM3 > 0)).toBe(true);
    expect(right.latest()?.pontoons.some((pontoon) => pontoon.volumeM3 > 0)).toBe(true);
    if (process.env.FORGEAX_BOAT_REGRESSION_EVIDENCE_ROOT)
      await writeFile(
        `${process.env.FORGEAX_BOAT_REGRESSION_EVIDENCE_ROOT}/motor-rudder.json`,
        `${JSON.stringify(
          {
            start,
            underway,
            port,
            starboard,
            portForward: a,
            starboardForward: b,
            portWet: left.latest(),
            starboardWet: right.latest(),
          },
          null,
          2,
        )}\n`,
      );
  } finally {
    await left.context.fiber.dispose();
    await right.context.fiber.dispose();
  }
}, 30_000);
