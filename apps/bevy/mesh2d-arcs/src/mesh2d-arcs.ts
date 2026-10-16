import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  compute2dBounds,
  create2dGeometry,
  type Shape2d,
} from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { Camera, MeshFilter, MeshRenderer, orthographic, Materials } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';

const NUM_SLICES = 8;
const RADIUS = 40;
const SPACING_X = 110;
const OFFSET_X = (SPACING_X * (NUM_SLICES - 1)) / 2;
const ARC_RESOLUTION = 24;
export const TEXTURE_SIZE = 32;

type ArcInstance = {
  readonly entity: EntityHandle;
  readonly shape: Shape2d;
  readonly position: readonly [number, number];
  readonly rotation: number;
};

export type Mesh2dArcsScene = {
  readonly instances: readonly ArcInstance[];
};

export function makeTexturePixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const colors: readonly [number, number, number][] = [
    [232, 58, 70],
    [45, 190, 120],
    [42, 108, 230],
    [242, 190, 54],
  ];
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const quadrant = (x < TEXTURE_SIZE / 2 ? 0 : 1) + (y < TEXTURE_SIZE / 2 ? 0 : 2);
      const color = colors[quadrant] ?? [255, 255, 255];
      const border = x < 2 || y < 2 || x >= TEXTURE_SIZE - 2 || y >= TEXTURE_SIZE - 2;
      const offset = (y * TEXTURE_SIZE + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = border ? 0 : 255;
    }
  }
  return pixels;
}

export function makeTextureAsset(pixels: Uint8Array): TextureAsset {
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE },
    },
    format: 'rgba8unorm-srgb',
    data: pixels,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

function meshResult(result: ReturnType<typeof create2dGeometry>, label: string): MeshAsset {
  if (result.ok) return result.value;
  const detail = result.error.detail ? ` (${JSON.stringify(result.error.detail)})` : '';
  throw new Error(`[bevy-mesh2d-arcs] ${label} failed: ${result.error.code}${detail}`);
}

function spawnArc(
  world: World,
  material: Handle<'MaterialAsset', 'shared'>,
  shape: Shape2d,
  position: readonly [number, number],
  rotation: number,
  label: string,
): ArcInstance {
  const mesh = meshResult(
    create2dGeometry(shape, { uv: { kind: 'circular-mask', angle: rotation } }),
    label,
  );
  const meshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [position[0], position[1], 0], quat: [0, 0, 0, 1] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  return { entity, shape, position, rotation };
}

export function buildMesh2dArcsWorld(world: World, texture: number): Mesh2dArcsScene {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1, 1, 1, 1], {
      alphaCutoff: 0.1,
      baseColorTexture: texture,
      renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
    }),
  );
  const instances: ArcInstance[] = [];
  for (let i = 0; i < NUM_SLICES; i += 1) {
    const fraction = (i + 1) / NUM_SLICES;
    const x = SPACING_X * i - OFFSET_X;
    const sector: Shape2d = {
      kind: 'circular-sector',
      radius: RADIUS,
      angle: fraction * Math.PI * 2,
      resolution: ARC_RESOLUTION,
    };
    const sectorAngle = -(fraction * Math.PI * 2) / 2;
    instances.push(spawnArc(world, material, sector, [x, 55], sectorAngle, 'sector'));

    const segment: Shape2d = {
      kind: 'circular-segment',
      radius: RADIUS,
      angle: fraction * Math.PI * 2,
      resolution: ARC_RESOLUTION,
    };
    const segmentAngle = -Math.PI / 2;
    instances.push(spawnArc(world, material, segment, [x, -55], segmentAngle, 'segment'));
  }
  world.spawn({
    component: Transform,
    data: { pos: [0, 0, 400], quat: [0, 0, 0, 1] },
  }, { component: Camera, data: orthographic({ left: -460, right: 460, bottom: -150, top: 150, near: 0.1, far: 1000 }) }).unwrap();
  return { instances };
}

function drawBounds(debugDraw: DebugDraw, bounds: ReturnType<typeof compute2dBounds>): void {
  if (!bounds.ok) return;
  const box = bounds.value.aabb;
  debugDraw.aabb(vec3.create(box[0], box[1], 3), vec3.create(box[2], box[3], 3), [0.95, 0.15, 0.1, 1]);
  const circle = bounds.value.circle;
  debugDraw.sphere(
    vec3.create(circle[0], circle[1], 3),
    circle[2] as number,
    [0.1, 0.55, 1, 1],
    24,
  );
}

export function drawMesh2dArcsBounds(debugDraw: DebugDraw, scene: Mesh2dArcsScene): void {
  for (const instance of scene.instances) {
    drawBounds(
      debugDraw,
      compute2dBounds(instance.shape, {
        translation: instance.position,
        rotation: instance.rotation,
      }),
    );
  }
}
