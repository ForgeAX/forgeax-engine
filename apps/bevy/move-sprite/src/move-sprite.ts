// Shared scene and motion step for Bevy `move_sprite` reproduction.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const SPRITE_SIZE = 32;
export const MOVE_SPEED = 10;
export const MIN_X = -4;
export const MAX_X = 4;

export const SpriteMover = defineComponent('SpriteMover', {
  velocity: { type: 'f32', default: MOVE_SPEED },
  minX: { type: 'f32', default: MIN_X },
  maxX: { type: 'f32', default: MAX_X },
});

export function makeSpritePixels(): Uint8Array {
  const data = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const off = (y * SPRITE_SIZE + x) * 4;
      const inside = x >= 4 && x <= 27 && y >= 5 && y <= 26;
      const nose = inside && x >= 24 && y >= 11 && y <= 20;
      const tail = inside && x <= 8 && y >= 9 && y <= 22;
      const color: readonly [number, number, number] = nose ? [240, 60, 50] : tail ? [50, 120, 240] : [245, 164, 48];
      data[off] = color[0];
      data[off + 1] = color[1];
      data[off + 2] = color[2];
      data[off + 3] = inside ? 255 : 0;
    }
  }
  return data;
}

function spriteMaterial(texture: number): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } }],
    parameters: [
      { name: 'colorTint', type: 'vec4' },
      { name: 'region', type: 'vec4', optional: true },
      { name: 'pivotAndSize', type: 'vec4' },
      { name: 'slicesAndMode', type: 'vec4', optional: true },
      { name: 'baseColorTexture', type: 'texture' },
    ],
    values: {
      colorTint: [1, 1, 1, 1],
      baseColorTexture: texture,
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  };
}

export function buildMoveSpriteWorld(world: World, texture: number): void {
  const material = world.allocSharedRef('MaterialAsset', spriteMaterial(texture));
  world.spawn(
    { component: Transform, data: { pos: [MIN_X, 0, 0], quat: [0, 0, 0, 1], scale: [2, 2, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: SpriteMover, data: { velocity: MOVE_SPEED, minX: MIN_X, maxX: MAX_X } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
  );
}

export function stepMoveSprite(world: World, dt: number): void {
  const query = world.query({ with: [Transform, SpriteMover] }).unwrap();
  const targets: EntityHandle[] = [];
  for (const row of query) targets.push(row.entity);
  for (const entity of targets) {
    const transform = world.get(entity, Transform);
    const mover = world.get(entity, SpriteMover);
    if (!transform.ok || !mover.ok) return;
    const x = transform.value.pos[0] ?? MIN_X;
    const velocity = mover.value.velocity ?? MOVE_SPEED;
    let nextX = x + velocity * dt;
    let nextVelocity = velocity;
    if (nextX >= (mover.value.maxX ?? MAX_X)) {
      nextX = mover.value.maxX ?? MAX_X;
      nextVelocity = -Math.abs(velocity);
    } else if (nextX <= (mover.value.minX ?? MIN_X)) {
      nextX = mover.value.minX ?? MIN_X;
      nextVelocity = Math.abs(velocity);
    }
    world.set(entity, Transform, { pos: [nextX, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0] });
    if (nextVelocity !== velocity) world.set(entity, SpriteMover, { velocity: nextVelocity });
  }
}

export function readSpriteMotion(world: World): { x: number; velocity: number } {
  const query = world.query({ with: [Transform, SpriteMover] }).unwrap();
  let result = { x: MIN_X, velocity: MOVE_SPEED };
  for (const row of query) {
    const entity = row.entity;
    const transform = world.get(entity, Transform);
    const mover = world.get(entity, SpriteMover);
    if (transform.ok && mover.ok) result = { x: transform.value.pos[0] ?? MIN_X, velocity: mover.value.velocity ?? MOVE_SPEED };
    break;
  }
  return result;
}
