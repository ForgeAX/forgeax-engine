import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, ray, vec3 } from '@forgeax/engine-math';
import type { InputSnapshot } from '@forgeax/engine-input';
import { viewportToWorld } from '@forgeax/engine-picking';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const TEXTURE_SIZE = 48;

export interface RotateToCursorScene {
  readonly camera: EntityHandle;
  readonly ship: EntityHandle;
}

export function makeShipPixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx = x - 24;
      const body = y >= 10 && y <= 38 && Math.abs(dx) <= 6;
      const nose = y >= 4 && y < 18 && Math.abs(dx) <= Math.max(1, Math.floor((y - 3) / 2));
      const wings = y >= 24 && y <= 34 && Math.abs(dx) <= 17 && Math.abs(dx) >= 5;
      const tail = y >= 36 && y <= 42 && Math.abs(dx) <= 3;
      const visible = body || nose || wings || tail;
      const accent = wings && dx < 0;
      const offset = (y * TEXTURE_SIZE + x) * 4;
      pixels[offset] = accent ? 250 : 60;
      pixels[offset + 1] = accent ? 110 : 215;
      pixels[offset + 2] = accent ? 65 : 255;
      pixels[offset + 3] = visible ? 255 : 0;
    }
  }
  return pixels;
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

export function buildRotateToCursorWorld(world: World, texture: number): RotateToCursorScene {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    spriteMaterial(texture),
  );
  const ship = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [64, 64, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
  const camera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -160, right: 160, bottom: -90, top: 90, near: 0.1, far: 100 }) },
  ).unwrap();
  return { camera, ship };
}

export function cursorPositionFromInput(
  snapshot: Pick<InputSnapshot, 'mouse'>,
  current: { x: number; y: number },
): { x: number; y: number } {
  const position = snapshot.mouse.position;
  if (position !== undefined) {
    current.x = position.x;
    current.y = position.y;
  }
  return current;
}

export function stepRotateToCursor(
  world: World,
  scene: RotateToCursorScene,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const worldRay = viewportToWorld(world, scene.camera, screenX, screenY, viewportWidth, viewportHeight);
  if (worldRay === undefined) return false;
  const origin = ray.getOrigin(vec3.create(), worldRay);
  const direction = ray.getDirection(vec3.create(), worldRay);
  const dz = direction[2] ?? 0;
  if (Math.abs(dz) < 1e-6) return false;
  const distance = -(origin[2] ?? 0) / dz;
  if (distance < 0) return false;
  const targetX = (origin[0] ?? 0) + (direction[0] ?? 0) * distance;
  const targetY = (origin[1] ?? 0) + (direction[1] ?? 0) * distance;
  const ship = world.get(scene.ship, Transform);
  if (!ship.ok) return false;
  const dx = targetX - (ship.value.pos[0] ?? 0);
  const dy = targetY - (ship.value.pos[1] ?? 0);
  if (Math.hypot(dx, dy) < 1e-5) return false;
  const angle = Math.atan2(dy, dx) - Math.PI / 2;
  const rotation = quat.fromEuler(quat.create(), 0, 0, angle, 'XYZ');
  return world.set(scene.ship, Transform, { quat: rotation }).ok;
}

export function readShipRotation(world: World, scene: RotateToCursorScene): Float32Array | undefined {
  const ship = world.get(scene.ship, Transform);
  return ship.ok ? new Float32Array(ship.value.quat) : undefined;
}
