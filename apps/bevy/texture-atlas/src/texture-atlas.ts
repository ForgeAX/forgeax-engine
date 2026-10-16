import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SpriteRegionOverride, SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';

export const CELL_SIZE = 24;
export const ATLAS_PADDING = 4;
export const ATLAS_COLUMNS = 2;
export const ATLAS_ROWS = 2;
export const UNPADDED_SIZE = CELL_SIZE * ATLAS_COLUMNS;
export const PADDED_SIZE = CELL_SIZE * ATLAS_COLUMNS + ATLAS_PADDING * (ATLAS_COLUMNS + 1);

export type AtlasVariant = 'unpadding' | 'padding';

export interface AtlasTexture {
  readonly pixels: Uint8Array;
  readonly size: number;
  readonly regions: ReadonlyArray<readonly [number, number, number, number]>;
}

const COLORS = [
  [235, 85, 93],
  [71, 207, 126],
  [75, 147, 235],
  [238, 190, 73],
] as const;

function setPixel(pixels: Uint8Array, size: number, x: number, y: number, rgba: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  pixels[offset] = rgba[0]!;
  pixels[offset + 1] = rgba[1]!;
  pixels[offset + 2] = rgba[2]!;
  pixels[offset + 3] = rgba[3]!;
}

function drawSourceSprite(pixels: Uint8Array, size: number, x0: number, y0: number, color: readonly [number, number, number]): void {
  for (let y = 0; y < CELL_SIZE; y += 1) {
    for (let x = 0; x < CELL_SIZE; x += 1) {
      const dx = x - CELL_SIZE / 2 + 0.5;
      const dy = y - CELL_SIZE / 2 + 0.5;
      const inside = dx * dx + dy * dy <= 10.5 * 10.5;
      if (!inside) continue;
      const checker = ((x >> 2) + (y >> 2)) % 2 === 0 ? 1 : 0.72;
      setPixel(pixels, size, x0 + x, y0 + y, [
        Math.round(color[0] * checker),
        Math.round(color[1] * checker),
        Math.round(color[2] * checker),
        255,
      ]);
    }
  }
  for (let x = 5; x < CELL_SIZE - 5; x += 1) {
    setPixel(pixels, size, x0 + x, y0 + 5, [255, 255, 255, 220]);
    setPixel(pixels, size, x0 + x, y0 + CELL_SIZE - 6, [24, 32, 50, 230]);
  }
}

function copyPadding(pixels: Uint8Array, size: number, x0: number, y0: number): void {
  for (let p = 1; p <= ATLAS_PADDING; p += 1) {
    for (let x = 0; x < CELL_SIZE; x += 1) {
      setPixel(pixels, size, x0 + x, y0 - p, readPixel(pixels, size, x0 + x, y0));
      setPixel(pixels, size, x0 + x, y0 + CELL_SIZE - 1 + p, readPixel(pixels, size, x0 + x, y0 + CELL_SIZE - 1));
    }
    for (let y = 0; y < CELL_SIZE; y += 1) {
      setPixel(pixels, size, x0 - p, y0 + y, readPixel(pixels, size, x0, y0 + y));
      setPixel(pixels, size, x0 + CELL_SIZE - 1 + p, y0 + y, readPixel(pixels, size, x0 + CELL_SIZE - 1, y0 + y));
    }
  }
}

function readPixel(pixels: Uint8Array, size: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * size + x) * 4;
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

export function makeAtlas(variant: AtlasVariant): AtlasTexture {
  const padded = variant === 'padding';
  const size = padded ? PADDED_SIZE : UNPADDED_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  const regions: Array<readonly [number, number, number, number]> = [];
  for (let index = 0; index < COLORS.length; index += 1) {
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);
    const x = padded ? ATLAS_PADDING + column * (CELL_SIZE + ATLAS_PADDING) : column * CELL_SIZE;
    const y = padded ? ATLAS_PADDING + row * (CELL_SIZE + ATLAS_PADDING) : row * CELL_SIZE;
    drawSourceSprite(pixels, size, x, y, COLORS[index]!);
    if (padded) copyPadding(pixels, size, x, y);
    regions.push([x / size, y / size, CELL_SIZE / size, CELL_SIZE / size]);
  }
  return { pixels, size, regions };
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
    values: { colorTint: [1, 1, 1, 1], baseColorTexture: texture, pivotAndSize: [0.5, 0.5, 1, 1] },
  };
}

function spawnSprite(world: World, material: Handle<'MaterialAsset', 'shared'>, position: readonly [number, number, number], scale: number, region: readonly [number, number, number, number]): void {
  world.spawn(
    { component: Transform, data: { pos: position, quat: [0, 0, 0, 1], scale: [scale, scale, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: SpriteRegionOverride, data: { region: new Float32Array(region) } },
  );
}

export function buildTextureAtlasWorld(
  world: World,
  variants: ReadonlyArray<{ texture: number; atlas: AtlasTexture }>,
): void {
  const materials = variants.map(({ texture }) => world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', spriteMaterial(texture)));
  spawnSprite(world, materials[0]!, [-4.1, 1.75, 0], 2.35, [0, 0, 1, 1]);
  spawnSprite(world, materials[1]!, [4.1, 1.75, 0], 2.35, [0, 0, 1, 1]);
  const samples = [
    { variant: 0, x: -4.1 },
    { variant: 1, x: -1.35 },
    { variant: 2, x: 1.35 },
    { variant: 3, x: 4.1 },
  ];
  for (const sample of samples) spawnSprite(world, materials[sample.variant]!, [sample.x, -2.15, 0], 2.1, variants[sample.variant]!.atlas.regions[3]!);
  world.spawn({ component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: Camera, data: orthographic({ left: -8, right: 8, bottom: -4.5, top: 4.5, near: 0.1, far: 100 }) });
}
