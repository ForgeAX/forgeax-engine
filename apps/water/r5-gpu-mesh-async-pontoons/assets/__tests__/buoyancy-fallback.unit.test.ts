import { PhysicsWorldResource } from '@forgeax/engine/physics';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { Collider, type PhysicsWorld, RigidBody } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { ChildOf, scenePlugin, Transform, WaterPontoonSet } from '@forgeax/engine/scene';
import {
  err,
  type SceneAsset,
  type WaterBodyAsset,
  type WaterWaveSetAsset,
} from '@forgeax/engine/types';
import { buildWaterPhysicsCandidateInput, WaterSystem } from '@forgeax/engine/water';
import { beforeAll, expect, it } from 'vitest';
import {
  installWaterBuoyancy,
  WATER_BUOYANCY_RESOURCE,
  type WaterBuoyancyState,
} from '../../../../../packages/runtime/src/water-buoyancy';
import pack from '../estuary.pack';

let outputs: Awaited<ReturnType<typeof pack.build>>;
beforeAll(async () => {
  outputs = await pack.build({
    packageId: pack.packageId,
    readByGuid: async () => err(new Error('All Water dependencies belong to this Pack')),
  });
}, 30_000);

it.each([
  ['river', 'global-off'],
  ['lake', 'global-off'],
  ['ocean', 'global-off'],
  ['river', 'component-off'],
  ['lake', 'component-off'],
  ['ocean', 'component-off'],
] as const)('keeps authored %s buoyancy valid through %s synchronous fallback', async (craft, gate) => {
  const assets = outputs.unwrap();
  const scene = assets['scene/estuary'] as SceneAsset | undefined;
  const bodyAsset = assets['body/lake'] as WaterBodyAsset | undefined;
  const waves = assets['waves/estuary'] as WaterWaveSetAsset | undefined;
  if (
    scene?.kind !== 'scene' ||
    bodyAsset?.kind !== 'water-body' ||
    waves?.kind !== 'water-wave-set'
  )
    throw new Error('Expected the cooked estuary Scene, lake and waves');
  const authored = scene.entities[`${craft}-craft`]?.components;
  const pontoons = authored?.WaterPontoonSet;
  if (!authored?.RigidBody || !pontoons) throw new Error('Expected authored native craft');
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), physics3d]);
  const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const water = new WaterSystem(
    () => undefined,
    () => [
      {
        guid: bodyAsset.waveSetGuid ?? '',
        field: 'waveSetGuid',
        kind: waves.kind,
        status: 'valid',
        payload: waves,
      },
    ],
  );
  const waterEntity = world
    .spawn({ component: Transform, data: {} }, { component: RigidBody, data: { type: 0 } })
    .unwrap();
  const guid = 'fallback-water';
  const mounted = water.mountBody(guid, '1', bodyAsset).unwrap();
  const input = buildWaterPhysicsCandidateInput({
    entity: waterEntity,
    sourceKey: 'r5-fallback-water',
    revision: mounted.outputGenerations.collision,
    body: mounted.asset,
    bodyWorldMatrixM: mounted.worldMatrixM,
    exclusionVolumes: [],
  }).unwrap();
  const release = installWaterBuoyancy(world, water, (entity) =>
    entity === waterEntity ? water.snapshot(guid) : undefined,
  );
  try {
    world.update(1 / 60).unwrap();
    if (!physics.prepareDerivedShapeCandidate || !physics.admitDerivedShapeCandidate)
      throw new Error('Expected native derived collision admission');
    physics
      .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input).unwrap())
      .unwrap();
    world.update(1 / 60).unwrap();
    const publication = physics.getDerivedPublication?.(waterEntity);
    if (!publication || !input.inputDigest) throw new Error('Expected accepted native lake sensor');
    water
      .acceptOutput(guid, 'collision', mounted.outputGenerations.collision, {
        generation: publication.revision,
        digest: input.inputDigest,
      })
      .unwrap();
    const root = world
      .spawn(
        { component: Transform, data: { pos: [-5, 0.2, 3] } },
        { component: RigidBody, data: authored.RigidBody },
        {
          component: Collider,
          data: { shape: 0, halfExtents: [2, 0.325, 0.85], collisionGroups: 0x0001ffff },
        },
      )
      .unwrap();
    const sockets =
      (Array.isArray(pontoons.socketEntities) ? pontoons.socketEntities : []).map(
        (key: unknown) => {
          const socket =
            typeof key === 'string' ? scene.entities[key]?.components.Transform : undefined;
          if (!socket) throw new Error('Expected authored descendant socket');
          return world
            .spawn(
              { component: Transform, data: socket },
              { component: ChildOf, data: { parent: root } },
            )
            .unwrap();
        },
      ) ?? [];
    world.update(1 / 60).unwrap();
    world
      .addComponent(root, {
        component: WaterPontoonSet,
        data: { ...pontoons, socketEntities: sockets, useAsyncPath: gate === 'global-off' },
      })
      .unwrap();
    const state = world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE);
    state.asyncEnabled = gate !== 'global-off';
    let wetSteps = 0;
    for (let tick = 0; tick < 300; tick++) {
      world.update(1 / 60).unwrap();
      const step = state.steps.find((row) => row.entity === root)?.result;
      expect(
        step,
        `native ${craft} ${gate} tick ${tick}: ${JSON.stringify(step?.ok ? undefined : step?.error)}`,
      ).toMatchObject({ ok: true });
      if (step?.ok && step.value.pontoons.some((p) => p.buoyancyForceN[1] > 0)) wetSteps++;
    }
    expect(wetSteps).toBeGreaterThan(10);
    expect(physics.getCommittedBodyDynamics?.(root).unwrap().positionM[1]).toBeGreaterThan(-0.3);
    expect(state.async.execution).toBe('disabled');
    // The Cancel control writes the same component gate. Repeated cancellation
    // must preserve an admitted native synchronous step and its Water forces.
    world.set(root, WaterPontoonSet, { useAsyncPath: false }).unwrap();
    state.asyncEnabled = true;
    world.update(1 / 60).unwrap();
    expect(state.steps.find((row) => row.entity === root)?.result).toMatchObject({ ok: true });
  } finally {
    release();
    await context.fiber.dispose();
  }
});
