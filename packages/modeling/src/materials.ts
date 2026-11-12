import type { Materials } from '@forgeax/engine-render';
import { ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import type { ModelingError } from './errors';
import {
  type DecalTextureOptions,
  decalTexture,
  fractalNoise,
  hash2,
  normalFromHeight,
  normalTexture,
  type Rgba,
  textureFrom,
  valueNoise,
} from './texture';

/**
 * Procedural materials (design 13, F1 S6): options for the Engine's `Materials.standard`
 * with every texture generated here, so a Pack ships no image files. A recipe hands
 * each texture to `texture(key, asset)`, which stores it (a Pack output, a runtime
 * asset) and returns its reference; the recipe places it on a coordinate set.
 *
 * ```ts
 * const outputs: Record<string, Asset> = {};
 * const texture = (key: string, asset: TextureAsset) => {
 *   outputs[`texture/${key}`] = asset;
 *   return guid(`texture/${key}`);
 * };
 * const paint = proceduralMaterials.carPaint({ color: '#9c1418', texture });
 * if (!paint.ok) return paint;
 * outputs['material/paint'] = Materials.standard(paint.value);
 * ```
 */
export type StandardMaterialOptions = Extract<
  Parameters<typeof Materials.standard>[0],
  { readonly baseColor: unknown }
>;

type TextureValue = Extract<
  NonNullable<StandardMaterialOptions['normalTexture']>,
  { readonly texture: unknown }
>;
export type TextureReference = TextureValue['texture'];

/** Stores a generated texture and returns how a material refers to it. */
export type TextureSink = (key: string, texture: TextureAsset) => TextureReference;

/** Where a tiling texture lands: a coordinate set and the meters one tile covers. */
export interface TexturePlacement {
  /** Pack a prefiltered mip chain with the texture (default true). */
  readonly mips?: boolean;
  /** uv0 (default, meters for modeled surfaces) or uv1 (normalized patch domain). */
  readonly set?: 0 | 1;
  /** Size of one tile in the set's units (default per recipe). */
  readonly tile?: number;
  /** Degrees. */
  readonly rotation?: number;
}

type Color = string | readonly [number, number, number];

function color4(c: Color): StandardMaterialOptions['baseColor'] {
  return typeof c === 'string' ? c : [c[0], c[1], c[2], 1];
}

function placed(ref: TextureReference, placement: TexturePlacement, tile: number): TextureValue {
  const size = placement.tile ?? tile;
  return {
    texture: ref,
    coordinates: {
      set: placement.set ?? 0,
      transform: {
        scale: [1 / size, 1 / size],
        ...(placement.rotation === undefined
          ? {}
          : { rotation: (placement.rotation * Math.PI) / 180 }),
      },
    },
  } as TextureValue;
}

export interface CarPaintOptions {
  readonly color: Color;
  readonly texture: TextureSink;
  /** Base metalness under the clear coat (default 0.5). */
  readonly metallic?: number;
  /** Base roughness under the clear coat (default 0.35). */
  readonly roughness?: number;
  /** Flake tilt strength (0 disables flakes; default 0.18). */
  readonly flake?: number;
  /** Flakes per tile side (default 160). */
  readonly flakeCells?: number;
  readonly clearcoatRoughness?: number;
  readonly placement?: TexturePlacement;
  readonly seed?: number;
  /** Texture key prefix (default 'car-paint'). */
  readonly key?: string;
}

export interface CarbonFiberOptions {
  readonly texture: TextureSink;
  /** Tow width in meters (default 0.004). */
  readonly tow?: number;
  readonly weave?: 'twill' | 'plain';
  /** Tint of the resin (default near black). */
  readonly color?: Color;
  readonly clearcoat?: number;
  readonly placement?: Omit<TexturePlacement, 'tile'>;
  readonly key?: string;
}

export interface MetalOptions {
  readonly finish: 'chrome' | 'brushed' | 'satin';
  readonly texture?: TextureSink;
  readonly color?: Color;
  /** Brushing direction on the coordinate set, degrees (default 0: along u). */
  readonly direction?: number;
  readonly placement?: TexturePlacement;
  readonly key?: string;
}

export interface GlassOptions {
  /** Linear transmission tint (default a light green-grey). */
  readonly tint?: readonly [number, number, number];
  readonly ior?: number;
  readonly roughness?: number;
  /** Meters (default 0.004). */
  readonly thickness?: number;
}

export interface TireOptions {
  readonly texture: TextureSink;
  readonly pattern?: 'chevron' | 'blocks' | 'ribs';
  /** Tread repeat in meters along the rolling direction (default 0.04). */
  readonly pitch?: number;
  /** Normal strength of the grooves (default 6). */
  readonly depth?: number;
  readonly placement?: Omit<TexturePlacement, 'tile'>;
  readonly key?: string;
}

export interface EmissiveOptions {
  readonly color: Color;
  /** Default 6. */
  readonly intensity?: number;
  /** LED segments along u per tile; absent means a continuous strip. */
  readonly segments?: {
    readonly count: number;
    readonly gap: number;
    readonly texture: TextureSink;
  };
  readonly placement?: TexturePlacement;
  readonly key?: string;
}

const SIZE = 256;

const mipsOf = (placement: { readonly mips?: boolean } | undefined) =>
  placement?.mips === false ? { mips: false } : {};

function carPaint(o: CarPaintOptions): Result<StandardMaterialOptions, ModelingError> {
  const key = o.key ?? 'car-paint';
  const strength = o.flake ?? 0.18;
  const base: StandardMaterialOptions = {
    baseColor: color4(o.color),
    metallic: o.metallic ?? 0.5,
    roughness: o.roughness ?? 0.35,
    clearcoat: 1,
    clearcoatRoughness: o.clearcoatRoughness ?? 0.03,
    staticSwitches: { clearcoat: true },
  };
  if (strength === 0) return ok(base);
  const cells = o.flakeCells ?? 160;
  const seed = o.seed ?? 7;
  // Each flake cell holds one random tilt; tangent-space normals encoded directly.
  const flakes = normalTexture(
    SIZE,
    SIZE,
    (x, y) => {
      const cx = Math.floor((x * cells) / SIZE);
      const cy = Math.floor((y * cells) / SIZE);
      return [
        (hash2(cx, cy, seed) * 2 - 1) * strength,
        (hash2(cx, cy, seed + 1) * 2 - 1) * strength,
        1,
      ];
    },
    mipsOf(o.placement),
  );
  if (!flakes.ok) return flakes;
  const ref = o.texture(`${key}-flakes`, flakes.value);
  return ok({ ...base, normalTexture: placed(ref, o.placement ?? {}, 0.05), normalScale: [1, 1] });
}

function carbonFiber(o: CarbonFiberOptions): Result<StandardMaterialOptions, ModelingError> {
  const key = o.key ?? 'carbon-fiber';
  const tows = 8;
  const twill = (o.weave ?? 'twill') === 'twill';
  const cell = SIZE / tows;
  const warpOnTop = (i: number, j: number) =>
    twill ? (((i - j) % 4) + 4) % 4 < 2 : (i + j) % 2 === 0;
  const sample = (x: number, y: number) => {
    const i = Math.floor(x / cell);
    const j = Math.floor(y / cell);
    const fx = (x % cell) / cell;
    const fy = (y % cell) / cell;
    const warp = warpOnTop(i, j);
    const across = warp ? fy : fx;
    const crown = Math.sqrt(Math.max(0, 1 - (2 * across - 1) * (2 * across - 1)));
    const streak = warp
      ? valueNoise(x / SIZE, (y / SIZE) * 16, 64, 3)
      : valueNoise((x / SIZE) * 16, y / SIZE, 64, 5);
    return { warp, crown, streak };
  };
  const albedo = textureFrom(
    SIZE,
    SIZE,
    (x, y) => {
      const s = sample(x, y);
      const v = 0.035 + 0.03 * s.crown + 0.02 * s.streak;
      return [v, v, v * 1.05, 1];
    },
    { colorSpace: 'srgb', ...mipsOf(o.placement) },
  );
  if (!albedo.ok) return albedo;
  const normal = normalFromHeight(
    SIZE,
    SIZE,
    (x, y) => {
      const s = sample(x, y);
      return s.crown * 0.8 + s.streak * 0.15;
    },
    1.2,
    mipsOf(o.placement),
  );
  if (!normal.ok) return normal;
  // KHR_materials_anisotropy texture: RG direction in tangent space, B strength.
  const aniso = textureFrom(
    SIZE,
    SIZE,
    (x, y) => (sample(x, y).warp ? [1, 0.5, 1, 1] : [0.5, 1, 1, 1]),
    mipsOf(o.placement),
  );
  if (!aniso.ok) return aniso;
  const tile = (o.tow ?? 0.004) * tows;
  const at = { ...(o.placement ?? {}), tile };
  const tint = o.color === undefined ? undefined : color4(o.color);
  return ok({
    baseColor: tint ?? [1, 1, 1, 1],
    baseColorTexture: placed(o.texture(`${key}-albedo`, albedo.value), at, tile),
    normalTexture: placed(o.texture(`${key}-normal`, normal.value), at, tile),
    normalScale: [1, 1],
    metallic: 0,
    roughness: 0.4,
    anisotropyStrength: 0.7,
    anisotropyTexture: placed(o.texture(`${key}-anisotropy`, aniso.value), at, tile),
    clearcoat: o.clearcoat ?? 1,
    clearcoatRoughness: 0.04,
    staticSwitches: { clearcoat: true, anisotropy: true },
  });
}

function metal(o: MetalOptions): Result<StandardMaterialOptions, ModelingError> {
  const base = color4(o.color ?? [0.95, 0.93, 0.9]);
  if (o.finish === 'chrome') return ok({ baseColor: base, metallic: 1, roughness: 0.04 });
  const key = o.key ?? `metal-${o.finish}`;
  const brushed = o.finish === 'brushed';
  const height = normalFromHeight(
    SIZE,
    SIZE,
    (x, y) =>
      brushed
        ? fractalNoise(x / SIZE, (y / SIZE) * 1, 96, 3, 11) * 0.2 +
          valueNoise(x / SIZE / 64, y / SIZE, 256, 13)
        : fractalNoise(x / SIZE, y / SIZE, 16, 4, 17),
    brushed ? 0.6 : 0.5,
    mipsOf(o.placement),
  );
  if (!height.ok) return height;
  if (o.texture === undefined) {
    return ok({ baseColor: base, metallic: 1, roughness: brushed ? 0.3 : 0.45 });
  }
  const ref = o.texture(`${key}-normal`, height.value);
  const placement = { ...(o.placement ?? {}), rotation: o.direction ?? o.placement?.rotation ?? 0 };
  return ok({
    baseColor: base,
    metallic: 1,
    roughness: brushed ? 0.3 : 0.45,
    normalTexture: placed(ref, placement, 0.1),
    normalScale: [0.6, 0.6],
    ...(brushed
      ? {
          anisotropyStrength: 0.8,
          anisotropyRotation: ((o.direction ?? 0) * Math.PI) / 180,
          staticSwitches: { anisotropy: true },
        }
      : {}),
  });
}

function glass(o: GlassOptions = {}): StandardMaterialOptions {
  const tint = o.tint ?? [0.82, 0.9, 0.88];
  return {
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: o.roughness ?? 0.02,
    transmission: 1,
    ior: o.ior ?? 1.5,
    thickness: o.thickness ?? 0.004,
    attenuationColor: tint,
    attenuationDistance: 0.3,
  };
}

function tire(o: TireOptions): Result<StandardMaterialOptions, ModelingError> {
  const key = o.key ?? `tire-${o.pattern ?? 'chevron'}`;
  const pattern = o.pattern ?? 'chevron';
  // Height 1 on the tread blocks, 0 in the grooves; u across the tread, v rolling.
  const groove = (u: number, v: number): number => {
    const soft = (d: number, w: number) => Math.max(0, Math.min(1, (d - w) / 0.02));
    if (pattern === 'ribs') {
      const d = Math.abs(((u * 5) % 1) - 0.5);
      return soft(d, 0.08);
    }
    if (pattern === 'blocks') {
      const du = Math.abs(((u * 4) % 1) - 0.5);
      const shift = Math.floor(u * 4) % 2 === 0 ? 0 : 0.5;
      const dv = Math.abs(((((v * 3 + shift) % 1) + 1) % 1) - 0.5);
      return Math.min(soft(0.5 - du, 0.06), soft(0.5 - dv, 0.07));
    }
    const center = Math.abs(u - 0.5);
    const phase = (((v * 2 - center * 1.6) % 1) + 1) % 1;
    const chevron = soft(Math.abs(phase - 0.5), 0.07);
    const rib = soft(Math.abs(center - 0.02), 0.025);
    return Math.min(chevron, rib);
  };
  const normal = normalFromHeight(
    SIZE,
    SIZE,
    (x, y) => groove(x / SIZE, y / SIZE),
    o.depth ?? 6,
    mipsOf(o.placement),
  );
  if (!normal.ok) return normal;
  const rough = textureFrom(
    SIZE,
    SIZE,
    (x, y) => {
      const g = groove(x / SIZE, y / SIZE);
      return [1, 0.97 - 0.12 * g + 0.04 * fractalNoise(x / SIZE, y / SIZE, 32, 3, 23), 0, 1];
    },
    mipsOf(o.placement),
  );
  if (!rough.ok) return rough;
  const tile = o.pitch ?? 0.04;
  const at = o.placement ?? {};
  return ok({
    baseColor: [0.022, 0.022, 0.024, 1],
    metallic: 0,
    roughness: 1,
    normalTexture: placed(o.texture(`${key}-normal`, normal.value), at, tile),
    normalScale: [1, 1],
    metallicRoughnessTexture: placed(o.texture(`${key}-roughness`, rough.value), at, tile),
  });
}

function emissive(o: EmissiveOptions): Result<StandardMaterialOptions, ModelingError> {
  const glow =
    typeof o.color === 'string' ? o.color : ([o.color[0], o.color[1], o.color[2]] as const);
  const base: StandardMaterialOptions = {
    baseColor: [0.02, 0.02, 0.02, 1],
    metallic: 0,
    roughness: 0.3,
    emissive: glow,
    emissiveIntensity: o.intensity ?? 6,
  };
  if (o.segments === undefined) return ok(base);
  const { count, gap } = o.segments;
  const leds = textureFrom(
    SIZE,
    16,
    (x) => {
      const f = ((x * count) / SIZE) % 1;
      const on = f > gap / 2 && f < 1 - gap / 2 ? 1 : 0.04;
      return [on, on, on, 1];
    },
    { colorSpace: 'srgb', ...mipsOf(o.placement) },
  );
  if (!leds.ok) return leds;
  const ref = o.segments.texture(`${o.key ?? 'emissive'}-segments`, leds.value);
  return ok({ ...base, emissiveTexture: placed(ref, o.placement ?? {}, 1) });
}

/**
 * Decals and text over a base material: the sheet (background usually the paint
 * color, layers from `textRegion` and `region2d`) becomes the base color texture on
 * uv1, the normalized patch domain of `m.surface` output.
 */
function decal(
  base: StandardMaterialOptions,
  sheet: DecalTextureOptions & { readonly texture: TextureSink; readonly key: string },
): Result<StandardMaterialOptions, ModelingError> {
  const { texture, key, ...options } = sheet;
  const image = decalTexture(options);
  if (!image.ok) return image;
  return ok({
    ...base,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: placed(texture(key, image.value), { set: 1 }, 1),
  });
}

/** Procedural Standard material recipes; textures stay deterministic TypeScript output. */
export const proceduralMaterials = { carPaint, carbonFiber, metal, glass, tire, emissive, decal };

export type { Rgba };
