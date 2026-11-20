// One authored World and one workload verifier for both benchmark execution tiers.
import {
  Disabled,
  defineSystem,
  FixedTime,
  FixedUpdate,
  Update,
} from '../../packages/ecs/dist/index.mjs';
import { createBoxGeometry } from '../../packages/geometry/dist/index.mjs';
import { Collider, PhysicsSync, RigidBody } from '../../packages/physics/dist/index.mjs';
import {
  Camera,
  DirectionalLight,
  Instances,
  Layer,
  Materials,
  MeshFilter,
  MeshRenderer,
  SceneInstance,
  ShadowParticipation,
  Visibility,
} from '../../packages/render/dist/index.mjs';
import { ChildOf, Children, Mobility, Name, Transform } from '../../packages/scene/dist/index.mjs';

export function registerBenchmarkVocabulary(world) {
  for (const component of [
    Disabled,
    Transform,
    ChildOf,
    Children,
    Name,
    Mobility,
    MeshFilter,
    MeshRenderer,
    ShadowParticipation,
    Visibility,
    Instances,
    Layer,
    SceneInstance,
    Collider,
    RigidBody,
  ]) {
    if (world.components.resolve(component.name) === undefined)
      world.components.register(component).unwrap();
  }
}

function installLogicTiming(world) {
  const fixedStarts = [];
  const updateStarts = [];
  const fixedCounts = [];
  const clock = { timeOrigin: performance.timeOrigin, startedAt: performance.now() };
  let previousTick = world.getResource(FixedTime).tick;
  world
    .addSystem(
      FixedUpdate,
      defineSystem({
        name: 'level-profile-fixed-timing',
        queries: [],
        before: [PhysicsSync],
        fn: () => {
          fixedStarts.push(performance.now());
        },
      }),
    )
    .unwrap();
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'level-profile-fixed-count',
        queries: [],
        after: [FixedUpdate],
        fn: () => {
          const tick = world.getResource(FixedTime).tick;
          fixedCounts.push(tick - previousTick);
          previousTick = tick;
        },
      }),
    )
    .unwrap();
  return {
    observeUpdate() {
      updateStarts.push(performance.now());
    },
    snapshot: () => ({ clock, fixedStarts, updateStarts, fixedCounts }),
  };
}

function spawnResidentMesh(world) {
  const { assets } = world;
  if (assets === undefined) throw Error('The benchmark requires the World asset owner');
  const mesh = assets.create(createBoxGeometry(5.25, 9.5, 5.75).unwrap()).unwrap();
  try {
    const material = assets.create(Materials.unlit([0.05, 0.9, 0.95, 1])).unwrap();
    try {
      return world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    } finally {
      assets.release(material).unwrap();
    }
  } finally {
    assets.release(mesh).unwrap();
  }
}

export function installBenchmarkWorld(world, profile, traceLogic = false) {
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [42, 35, 100], quat: [-Math.sin(0.2), 0, 0, Math.cos(0.2)] },
      },
      { component: Camera, data: { fov: 1.2, aspect: 1280 / 720, near: 0.1, far: 500 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.3, -1, -0.5], intensity: 10000, castShadow: true },
    })
    .unwrap();
  // Use one of the existing simulated rows as visible old-world content.
  // Its assets are separate from the frozen target Pack.
  const constant = Array.from({ length: profile.cpuSubstrate.constantEntities }, (_, i) =>
    i === 0
      ? spawnResidentMesh(world)
      : world.spawn({ component: Transform, data: { pos: [i, 0, 0] } }).unwrap(),
  );
  let tick = 0;
  const timing = traceLogic ? installLogicTiming(world) : undefined;
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'level-profile-constant-work',
        queries: [],
        fn: () => {
          timing?.observeUpdate();
          tick++;
          for (let i = 0; i < constant.length; i++)
            world.set(constant[i], Transform, { pos: [i, Math.sin(tick * 0.01), 0] }).unwrap();
        },
      }),
    )
    .unwrap();
  return {
    updates: () => tick,
    fixedSteps: () => world.getResource(FixedTime).tick,
    logicTiming: () => timing?.snapshot(),
  };
}

function requireFact(condition, message) {
  if (!condition) throw Error(message);
}
export function sourceFacts(world, level, profile, producer) {
  const meshes = level.members.filter((entity) => world.hasComponent(entity, MeshFilter));
  const colliders = level.members.filter((entity) => world.hasComponent(entity, Collider));
  const instanced = meshes.filter((entity) => world.hasComponent(entity, Instances));
  requireFact(
    meshes.length - instanced.length === profile.streetBlock.meshEntities,
    'original Mesh workload changed',
  );
  requireFact(
    instanced.length === (producer?.instanceGroups ?? 0),
    'Instances group count changed',
  );
  let instances = 0;
  for (const entity of instanced) {
    const count = world.get(entity, Instances).unwrap().transforms.length / 16;
    requireFact(count === producer.instancesPerGroup, 'Instances group size changed');
    instances += count;
  }
  requireFact(
    colliders.length === Object.values(profile.streetBlock.colliders).reduce((a, b) => a + b, 0),
    'original Collider workload changed',
  );
  return {
    members: level.members.length,
    meshes: meshes.length,
    colliders: colliders.length,
    instanceGroups: instanced.length,
    instances,
  };
}
