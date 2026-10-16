import { FixedTime, FixedUpdate, defineComponent, type EntityHandle, type World, Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, FRAME_START_SCAN_SYSTEM_NAME, type InputSnapshot } from '@forgeax/engine-input';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { Handle } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';

const SPEED = 2.5;

export const AccumulatedInput = defineComponent('AccumulatedInput', {
  x: { type: 'f32', default: 1 },
  z: { type: 'f32', default: 0 },
});

export const Velocity = defineComponent('Velocity', {
  x: { type: 'f32', default: SPEED },
  y: { type: 'f32', default: 0 },
  z: { type: 'f32', default: 0 },
});

export const PhysicalTranslation = defineComponent('PhysicalTranslation', {
  x: { type: 'f32', default: 0 },
  y: { type: 'f32', default: 0 },
  z: { type: 'f32', default: 0 },
});

export const PreviousPhysicalTranslation = defineComponent('PreviousPhysicalTranslation', {
  x: { type: 'f32', default: 0 },
  y: { type: 'f32', default: 0 },
  z: { type: 'f32', default: 0 },
});

export interface PhysicsFixedState {
  player: EntityHandle;
  fixedSteps: number;
  interpolationFrames: number;
  lastAlpha: number;
}

export const PHYSICS_FIXED_STATE = 'bevyPhysicsFixedState';

function material(world: World, color: readonly [number, number, number, number]): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: color }));
}

export function buildPhysicsFixedWorld(world: World): PhysicsFixedState {
  const floor = material(world, [0.08, 0.12, 0.24, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [14, 0.05, 8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floor] } },
  );

  const player = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material(world, [0.95, 0.28, 0.2, 1])] } },
    { component: AccumulatedInput, data: {} },
    { component: Velocity, data: {} },
    { component: PhysicalTranslation, data: {} },
    { component: PreviousPhysicalTranslation, data: {} },
  ).unwrap();

  world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.8, -0.3], color: [1, 1, 1], intensity: 3, castShadow: false } });
  const eye: [number, number, number] = [0, 3, 10];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  const state: PhysicsFixedState = { player, fixedSteps: 0, interpolationFrames: 0, lastAlpha: 0 };
  world.insertResource(PHYSICS_FIXED_STATE, state);
  return state;
}

function readInput(world: World): InputSnapshot | undefined {
  if (!world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) return undefined;
  return world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
}

export function installPhysicsFixedSystems(world: World): void {
  world.addSystem(Update, {
    name: 'accumulate-fixed-loop-input',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    before: [FixedUpdate],
    queries: [],
    fn: (world) => {
      const state = world.getResource<PhysicsFixedState>(PHYSICS_FIXED_STATE);
      const input = readInput(world);
      const rawX = input ? Number(input.keyboard.downCode('KeyD')) - Number(input.keyboard.downCode('KeyA')) : 0;
      const rawZ = input ? Number(input.keyboard.downCode('KeyS')) - Number(input.keyboard.downCode('KeyW')) : 0;
      const x = rawX === 0 && rawZ === 0 ? 1 : rawX;
      const z = rawX === 0 && rawZ === 0 ? 0 : rawZ;
      world.set(state.player, AccumulatedInput, { x, z });
      world.set(state.player, Velocity, { x: x * SPEED, y: 0, z: z * SPEED });
    },
  });

  world.addSystem(FixedUpdate, {
    name: 'advance-fixed-physics',
    queries: [],
    fn: (world) => {
      const state = world.getResource<PhysicsFixedState>(PHYSICS_FIXED_STATE);
      const fixed = world.getResource(FixedTime);
      const current = world.get(state.player, PhysicalTranslation);
      const previous = world.get(state.player, PreviousPhysicalTranslation);
      const velocity = world.get(state.player, Velocity);
      if (!current.ok || !previous.ok || !velocity.ok) return;
      world.set(state.player, PreviousPhysicalTranslation, { x: current.value.x, y: current.value.y, z: current.value.z });
      world.set(state.player, PhysicalTranslation, {
        x: current.value.x + velocity.value.x * fixed.delta,
        y: current.value.y + velocity.value.y * fixed.delta,
        z: current.value.z + velocity.value.z * fixed.delta,
      });
      state.fixedSteps += 1;
    },
  });

  world.addSystem(Update, {
    name: 'interpolate-fixed-physics-render',
    after: [FixedUpdate],
    queries: [],
    fn: (world) => {
      const state = world.getResource<PhysicsFixedState>(PHYSICS_FIXED_STATE);
      const fixed = world.getResource(FixedTime);
      const current = world.get(state.player, PhysicalTranslation);
      const previous = world.get(state.player, PreviousPhysicalTranslation);
      if (!current.ok || !previous.ok) return;
      const alpha = Math.min(1, Math.max(0, fixed.overstep / fixed.delta));
      world.set(state.player, Transform, {
        pos: [
          previous.value.x + (current.value.x - previous.value.x) * alpha,
          previous.value.y + (current.value.y - previous.value.y) * alpha,
          previous.value.z + (current.value.z - previous.value.z) * alpha,
        ],
      });
      state.lastAlpha = alpha;
      state.interpolationFrames += 1;
    },
  });
}

export function readPhysicsFixedState(world: World): PhysicsFixedState {
  return { ...world.getResource<PhysicsFixedState>(PHYSICS_FIXED_STATE) };
}
