// apps/bevy/transform — shared World builder and orbit step for the browser app
// and Dawn smoke. Reproduces Bevy's transforms/transform.rs: a cube moves forward,
// turns smoothly toward a center sphere, and shrinks that sphere by travel distance.

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat, vec3 } from '@forgeax/engine-math';

export const MOVE_SPEED = 2;
export const TURN_RATE = 1;
export const CENTER_MAX_SCALE = 1;
export const CENTER_MIN_SCALE = 0.25;
export const CENTER_SCALE_FACTOR = 0.12;

/** Game-owned state matching Bevy's moving CubeState component. */
export const Orbiting = defineComponent('Orbiting', {
  start: { type: 'array<f32, 3>', default: new Float32Array([0, 0, -6]) },
  moveSpeed: { type: 'f32', default: MOVE_SPEED },
  turnRate: { type: 'f32', default: TURN_RATE },
});

/** Game-owned state matching Bevy's stationary Center component. */
export const CenterSphere = defineComponent('CenterSphere', {
  maxSize: { type: 'f32', default: CENTER_MAX_SCALE },
  minSize: { type: 'f32', default: CENTER_MIN_SCALE },
  scaleFactor: { type: 'f32', default: CENTER_SCALE_FACTOR },
});

function firstHandleWith(world: World, component: typeof Orbiting | typeof CenterSphere): EntityHandle | null {
  const query = world.query({ with: [component] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

/** Build the orbiting cube and center sphere scene from Bevy's transform example. */
export function buildTransformWorld(world: World): void {
  const yellow = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.8, 0.1, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [yellow] } },
    { component: CenterSphere, data: { maxSize: CENTER_MAX_SCALE, minSize: CENTER_MIN_SCALE, scaleFactor: CENTER_SCALE_FACTOR } },
  );

  const white = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.95, 0.95, 0.95, 1] }),
  );
  const start: [number, number, number] = [0, 0, -6];
  // Begin tangent to the center so slerp visibly bends the forward path into
  // an orbit instead of merely flying straight at the sphere.
  const startQuat = quat.eulerY(Math.PI / 2);
  world.spawn(
    { component: Transform, data: { pos: start, quat: startQuat, scale: [0.7, 0.7, 0.7] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [white] } },
    { component: Orbiting, data: { start, moveSpeed: MOVE_SPEED, turnRate: TURN_RATE } },
  );

  world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -0.8, -0.4], color: [1, 1, 1], intensity: 3, castShadow: false } });
  const eye: [number, number, number] = [0, 8, 16];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

/** Move, smoothly turn toward the center, then shrink the center by traveled distance. */
export function stepTransform(world: World, dt: number): void {
  const cubeHandle = firstHandleWith(world, Orbiting);
  const centerHandle = firstHandleWith(world, CenterSphere);
  if (cubeHandle === null || centerHandle === null) return;
  const cube = world.get(cubeHandle, Transform);
  const orbit = world.get(cubeHandle, Orbiting);
  const center = world.get(centerHandle, Transform);
  const centerState = world.get(centerHandle, CenterSphere);
  if (!cube.ok || !orbit.ok || !center.ok || !centerState.ok) return;

  // ForgeaX's Transform convention is local −Z forward (the same Bevy convention).
  const forward = quat.transformVec3(vec3.create(), cube.value.quat, [0, 0, -1]);
  const move = orbit.value.moveSpeed * dt;
  const nextPos: [number, number, number] = [
    (cube.value.pos[0] ?? 0) + (forward[0] ?? 0) * move,
    (cube.value.pos[1] ?? 0) + (forward[1] ?? 0) * move,
    (cube.value.pos[2] ?? 0) + (forward[2] ?? 0) * move,
  ];
  const targetQuat = quat.fromLookAt(quat.create(), nextPos, center.value.pos, [0, 1, 0]);
  const nextQuat = quat.slerp(quat.create(), cube.value.quat, targetQuat, Math.min(1, orbit.value.turnRate * dt));
  world.set(cubeHandle, Transform, { pos: nextPos, quat: nextQuat });

  const start = orbit.value.start;
  const dx = nextPos[0] - (start[0] ?? 0);
  const dy = nextPos[1] - (start[1] ?? 0);
  const dz = nextPos[2] - (start[2] ?? 0);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const size = Math.max(centerState.value.minSize, centerState.value.maxSize - centerState.value.scaleFactor * distance);
  world.set(centerHandle, Transform, { scale: [size, size, size] });
}

/** Orbit cube distance from its start; used by the smoke's semantic assertion. */
export function orbitDistance(world: World): number {
  const cubeHandle = firstHandleWith(world, Orbiting);
  if (cubeHandle === null) return Number.NaN;
  const cube = world.get(cubeHandle, Transform);
  const orbit = world.get(cubeHandle, Orbiting);
  if (!cube.ok || !orbit.ok) return Number.NaN;
  const dx = (cube.value.pos[0] ?? 0) - (orbit.value.start[0] ?? 0);
  const dy = (cube.value.pos[1] ?? 0) - (orbit.value.start[1] ?? 0);
  const dz = (cube.value.pos[2] ?? 0) - (orbit.value.start[2] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
