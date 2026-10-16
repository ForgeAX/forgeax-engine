import { HANDLE_QUAD } from '@forgeax/engine/assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { Camera, Layer, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine/render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine/render/authoring';
import { Transform } from '@forgeax/engine/scene';
import type { Handle, MaterialAsset, TextureAsset } from '@forgeax/engine/types';

export type Rgba = readonly [number, number, number, number];
export type TextureHandle = Handle<'TextureAsset', 'shared'>;
export type MaterialHandle = Handle<'MaterialAsset', 'shared'>;

/** Scenes are laid out for this half-width; the half-height follows the canvas aspect so shapes stay undistorted. */
export const VIEW_HALF_WIDTH = (2 * 1400) / 720;

export function viewHalfHeight(canvas: HTMLCanvasElement): number {
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  return width > 0 && height > 0 ? (VIEW_HALF_WIDTH * height) / width : 2;
}

export function textureAsset(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
): TextureAsset {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = (y * width + x) * 4;
      data[o] = Math.round(r * 255);
      data[o + 1] = Math.round(g * 255);
      data[o + 2] = Math.round(b * 255);
      data[o + 3] = Math.round(a * 255);
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm-srgb',
    data,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  } as TextureAsset;
}

export function texture(world: World, asset: TextureAsset): TextureHandle {
  return world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', asset) as TextureHandle;
}

/** A white disc with an opaque square core: shows both tint and alpha blending. */
export function discTexture(world: World, size = 64): TextureHandle {
  const c = (size - 1) / 2;
  return texture(
    world,
    textureAsset(size, size, (x, y) => {
      const d = Math.hypot(x - c, y - c) / c;
      return d <= 1 ? [1, 1, 1, 1] : [0, 0, 0, 0];
    }),
  );
}

/** 2x2 grid of saturated quadrants: red, green (top row), blue, yellow (bottom row). */
export function quadrantTexture(world: World, size = 64): TextureHandle {
  const colors: readonly Rgba[] = [
    [1, 0.1, 0.1, 1],
    [0.1, 1, 0.1, 1],
    [0.1, 0.2, 1, 1],
    [1, 0.9, 0.1, 1],
  ];
  const half = size / 2;
  return texture(
    world,
    textureAsset(
      size,
      size,
      (x, y) => colors[(y < half ? 0 : 2) + (x < half ? 0 : 1)] ?? [1, 1, 1, 1],
    ),
  );
}

export const SPRITE_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
] as const;

export function spriteMaterialAsset(
  tex: TextureHandle,
  tint: Rgba,
  options: {
    readonly module?: 'forgeax::sprite' | 'forgeax::sprite-lit';
    readonly region?: Rgba;
  } = {},
): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: options.module ?? 'forgeax::sprite' },
        renderState: {
          blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND,
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      colorTint: tint,
      baseColorTexture: tex,
      region: options.region ?? [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  } as MaterialAsset;
}

export function spriteMaterial(world: World, asset: MaterialAsset): MaterialHandle {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    asset,
  ) as MaterialHandle;
}

export function spawnOrthoCamera(
  world: World,
  canvas: HTMLCanvasElement,
  data: Readonly<Record<string, unknown>> = {},
): EntityHandle {
  const halfHeight = viewHalfHeight(canvas);
  return world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
      {
        component: Camera,
        data: {
          ...orthographic({
            left: -VIEW_HALF_WIDTH,
            right: VIEW_HALF_WIDTH,
            bottom: -halfHeight,
            top: halfHeight,
            near: 0.1,
            far: 100,
          }),
          clearColor: [0.08, 0.09, 0.12, 1],
          ...data,
        } as never,
      },
    )
    .unwrap() as EntityHandle;
}

export function spawnSprite(
  world: World,
  mat: MaterialHandle,
  pos: readonly [number, number, number],
  size: number,
  layer = 0,
  ...extra: readonly { readonly component: unknown; readonly data?: unknown }[]
): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: { pos, scale: [size, size, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } as never },
      { component: MeshRenderer, data: { materials: [mat] } as never },
      { component: Layer, data: { value: layer } },
      ...(extra as never[]),
    )
    .unwrap() as EntityHandle;
}
