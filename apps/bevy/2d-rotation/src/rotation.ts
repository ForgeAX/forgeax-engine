import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { quat, vec3 } from '@forgeax/engine-math';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

const BOUNDS: readonly [number, number] = [1200, 640];
const PLAYER_SPEED = 500;
const PLAYER_ROTATION_SPEED = Math.PI * 2;
const TRACK_ROTATION_SPEED = Math.PI * 0.75;

export const Player = defineComponent('RotationPlayer', {});
export const SnapToPlayer = defineComponent('RotationSnapToPlayer', {});
export const RotateToPlayer = defineComponent('RotationRotateToPlayer', {});

type XY = readonly [number, number];

function firstEntity(world: World, component: typeof Player | typeof Camera): EntityHandle | null {
  const query = world.query({ with: [component, Transform] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

function trackingEntities(world: World, component: typeof SnapToPlayer | typeof RotateToPlayer): EntityHandle[] {
  const query = world.query({ with: [component, Transform] }).unwrap();
  const handles: EntityHandle[] = [];
  for (const row of query) handles.push(row.entity);
  return handles;
}

function direction(from: XY, to: XY): [number, number, number] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  return length > 1e-5 ? [dx / length, dy / length, 0] : null;
}

function faceDirection(value: [number, number, number]): Float32Array {
  return quat.fromUnitVectors(quat.create(), [0, 1, 0], value);
}

function spawnActor(world: World, pos: readonly [number, number, number], color: readonly [number, number, number, number], scale: readonly [number, number, number], marker: typeof Player | typeof SnapToPlayer | typeof RotateToPlayer): void {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: marker, data: {} },
  );
}

export function buildRotationWorld(world: World): void {
  spawnActor(world, [0, 0, 2], [0.1, 0.85, 1, 1], [42, 68, 1], Player);
  spawnActor(world, [-320, 0, 1], [1, 0.35, 0.15, 1], [34, 56, 1], SnapToPlayer);
  spawnActor(world, [0, -180, 1], [1, 0.55, 0.1, 1], [34, 56, 1], SnapToPlayer);
  spawnActor(world, [320, 0, 1], [0.75, 0.25, 1, 1], [34, 56, 1], RotateToPlayer);
  spawnActor(world, [0, 180, 1], [0.75, 0.35, 1, 1], [34, 56, 1], RotateToPlayer);

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 999.9], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -600, right: 600, bottom: -320, top: 320, near: 0.1, far: 2000 }) },
  );
}

let demoTime = 0;

export function stepRotationWorld(world: World, dt: number, input: InputSnapshot): void {
  demoTime += dt;
  const player = firstEntity(world, Player);
  if (player === null) return;
  const playerResult = world.get(player, Transform);
  if (!playerResult.ok) return;

  const keyboard = input.keyboard;
  const left = keyboard.down('ArrowLeft');
  const right = keyboard.down('ArrowRight');
  const up = keyboard.down('ArrowUp');
  const playerPos = playerResult.value.pos;
  let nextX = playerPos[0] ?? 0;
  let nextY = playerPos[1] ?? 0;
  let nextQuat = playerResult.value.quat;

  if (left || right || up) {
    const turn = (right ? -1 : 0) + (left ? 1 : 0);
    nextQuat = quat.rotateAxis(quat.create(), nextQuat, [0, 0, 1], turn * PLAYER_ROTATION_SPEED * dt);
    if (up) {
      const forward = quat.transformVec3(vec3.create(), nextQuat, [0, 1, 0]);
      nextX += (forward[0] ?? 0) * PLAYER_SPEED * dt;
      nextY += (forward[1] ?? 0) * PLAYER_SPEED * dt;
    }
  } else {
    nextX = Math.cos(demoTime * 0.65) * 300;
    nextY = Math.sin(demoTime * 0.65) * 190;
    nextQuat = faceDirection([Math.cos(demoTime * 0.65), Math.sin(demoTime * 0.65), 0]);
  }

  nextX = Math.max(-BOUNDS[0] / 2, Math.min(BOUNDS[0] / 2, nextX));
  nextY = Math.max(-BOUNDS[1] / 2, Math.min(BOUNDS[1] / 2, nextY));
  world.set(player, Transform, { pos: [nextX, nextY, 2], quat: nextQuat });
  const target: XY = [nextX, nextY];

  for (const handle of trackingEntities(world, SnapToPlayer)) {
    const result = world.get(handle, Transform);
    if (!result.ok) continue;
    const d = direction([result.value.pos[0] ?? 0, result.value.pos[1] ?? 0], target);
    if (d !== null) world.set(handle, Transform, { quat: faceDirection(d) });
  }

  for (const handle of trackingEntities(world, RotateToPlayer)) {
    const result = world.get(handle, Transform);
    if (!result.ok) continue;
    const d = direction([result.value.pos[0] ?? 0, result.value.pos[1] ?? 0], target);
    if (d === null) continue;
    const desired = faceDirection(d);
    const factor = Math.min(1, TRACK_ROTATION_SPEED * dt);
    world.set(handle, Transform, { quat: quat.slerp(quat.create(), result.value.quat, desired, factor) });
  }
}

export function readRotationState(world: World): { player: [number, number]; snap: Float32Array; rotate: Float32Array } {
  const player = firstEntity(world, Player);
  const snap = trackingEntities(world, SnapToPlayer)[0] ?? null;
  const rotate = trackingEntities(world, RotateToPlayer)[0] ?? null;
  const playerTransform = player === null ? null : world.get(player, Transform);
  const snapTransform = snap === null ? null : world.get(snap, Transform);
  const rotateTransform = rotate === null ? null : world.get(rotate, Transform);
  return {
    player: playerTransform?.ok ? [playerTransform.value.pos[0] ?? 0, playerTransform.value.pos[1] ?? 0] : [0, 0],
    snap: snapTransform?.ok ? new Float32Array(snapTransform.value.quat) : new Float32Array([0, 0, 0, 1]),
    rotate: rotateTransform?.ok ? new Float32Array(rotateTransform.value.quat) : new Float32Array([0, 0, 0, 1]),
  };
}
