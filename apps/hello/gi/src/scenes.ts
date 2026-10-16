// Pure scene data shared by the browser demo, the Dawn smoke and the reference
// tool. Keep this module dependency-free: Node scripts import it through type
// stripping and the Pack source derives cooked materials from the same table.

import type {
  DiffuseGiTierScene,
  StandardDiffuseGi,
  StandardIrradianceField,
} from '@forgeax/engine-render';

export type Vec3 = readonly [number, number, number];

export type GiSceneId = 'cornell' | 'leak' | 'courtyard' | 'sponza';
export const GI_SCENE_IDS: readonly GiSceneId[] = ['cornell', 'leak', 'courtyard', 'sponza'];
export type ProceduralSceneId = Exclude<GiSceneId, 'sponza'>;
export const PROCEDURAL_SCENE_IDS: readonly ProceduralSceneId[] = ['cornell', 'leak', 'courtyard'];

/** The gather selector: every mode except `off` is one `diffuseGi.gather` lane. */
export type GiMode = 'off' | StandardDiffuseGi['gather'];
/**
 * Interactive modes. `baked` needs a cooked volume in the served Catalog, which
 * the Node tools produce (scripts/gi-bake.mjs); the browser build ships none.
 */
export const GI_MODES: readonly GiMode[] = ['off', 'exact', 'irradiance-field', 'screen-probe'];

/** Stable author GUID of each scene's baked irradiance volume; a rebake keeps it. */
export const BAKED_VOLUMES: Readonly<Record<GiSceneId, string>> = {
  cornell: '5b0e7c2a-9d14-4f3b-8a61-2c7e0d9f4b18',
  leak: 'c3a91f5e-2b07-4d6c-9e18-7f4a0b2d6c59',
  courtyard: '7e4d2b90-6c1a-4f85-b3e7-0a9c5d1f8e26',
  sponza: '2f8b6d14-a3c9-4e70-8d52-9b1e7c0a4f63',
};

export interface GiMaterialSpec {
  readonly baseColor: Vec3;
  readonly roughness: number;
  readonly emissive?: Vec3;
  readonly emissiveIntensity?: number;
}

/** Every material is a Standard root with zero specular so GI compares diffuse transport. */
export const GI_MATERIALS = {
  white: { baseColor: [0.73, 0.73, 0.73], roughness: 0.8 },
  red: { baseColor: [0.73, 0.045, 0.035], roughness: 0.8 },
  green: { baseColor: [0.12, 0.45, 0.075], roughness: 0.8 },
  blue: { baseColor: [0.06, 0.14, 0.62], roughness: 0.8 },
  sand: { baseColor: [0.62, 0.52, 0.36], roughness: 0.9 },
  panel: {
    baseColor: [0.05, 0.05, 0.05],
    roughness: 0.9,
    emissive: [1, 0.62, 0.28],
    emissiveIntensity: 6,
  },
  'panel-off': { baseColor: [0.05, 0.05, 0.05], roughness: 0.9 },
} as const satisfies Record<string, GiMaterialSpec>;
export type GiMaterialName = keyof typeof GI_MATERIALS;
export const GI_MATERIAL_NAMES = Object.keys(GI_MATERIALS) as GiMaterialName[];

export interface GiBox {
  readonly material: GiMaterialName;
  readonly center: Vec3;
  readonly half: Vec3;
  readonly yaw?: number;
  /** Emissive panels swap to their `-off` twin when emission is disabled. */
  readonly emissive?: boolean;
}

export type GiLight =
  | {
      readonly kind: 'point';
      readonly position: Vec3;
      readonly color: Vec3;
      readonly intensity: number;
      readonly range: number;
      /** Alternate position used by the light-move toggle and camera-path checks. */
      readonly moved: Vec3;
    }
  | {
      readonly kind: 'directional';
      /** Outgoing direction, from the light toward the scene. */
      readonly direction: Vec3;
      readonly color: Vec3;
      readonly intensity: number;
      readonly moved: Vec3;
    };

export interface GiCamera {
  readonly origin: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly verticalFov: number;
}

/** Normalized image rectangle, origin top-left, used by falsifiers and metrics. */
export interface GiRegion {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface ProceduralGiScene {
  readonly id: ProceduralSceneId;
  readonly title: string;
  readonly boxes: readonly GiBox[];
  readonly light: GiLight;
  /** Constant sky radiance seen by GI rays that escape; raster direct ignores it. */
  readonly environment: Vec3;
  readonly maxDistance: number;
  readonly camera: GiCamera;
  /** Second camera pose; the camera path interpolates between the two. */
  readonly cameraAlt: GiCamera;
  /** Leak scene only: the room that only receives light through the door gap. */
  readonly darkRoom?: GiRegion;
}

const cornellWalls: GiBox[] = [
  { material: 'white', center: [0, -3.15, 0], half: [3.3, 0.15, 3.3] },
  { material: 'white', center: [0, 3.15, 0], half: [3.3, 0.15, 3.3] },
  { material: 'white', center: [0, 0, -3.15], half: [3.3, 3.15, 0.15] },
  { material: 'red', center: [-3.15, 0, 0], half: [0.15, 3.15, 3.3] },
  { material: 'green', center: [3.15, 0, 0], half: [0.15, 3.15, 3.3] },
  { material: 'white', center: [-1.1, -1.8, -0.9], half: [0.8, 1.2, 0.8], yaw: -0.3 },
  { material: 'white', center: [1.1, -2.15, 0.9], half: [0.7, 0.85, 0.7], yaw: 0.28 },
  {
    material: 'panel',
    center: [2.95, -2.3, -1.6],
    half: [0.05, 0.7, 0.8],
    emissive: true,
  },
];

const leakBoxes: GiBox[] = [
  { material: 'white', center: [0, -0.1, 0], half: [6.2, 0.1, 3.2] },
  { material: 'white', center: [0, 3.1, 0], half: [6.2, 0.1, 3.2] },
  { material: 'white', center: [0, 1.5, -3.1], half: [6.2, 1.5, 0.1] },
  { material: 'red', center: [-6.1, 1.5, 0], half: [0.1, 1.5, 3.2] },
  { material: 'blue', center: [6.1, 1.5, 0], half: [0.1, 1.5, 3.2] },
  // A 4 cm separating wall with a door gap at z in [1.4, 2.4], y in [0, 2.2].
  { material: 'white', center: [0, 1.5, -0.8], half: [0.02, 1.5, 2.2] },
  { material: 'white', center: [0, 1.5, 2.7], half: [0.02, 1.5, 0.3] },
  { material: 'white', center: [0, 2.6, 1.9], half: [0.02, 0.4, 0.5] },
  { material: 'green', center: [-3.6, 0.5, -1.6], half: [0.6, 0.5, 0.6], yaw: 0.4 },
];

const courtyardBoxes: GiBox[] = [
  { material: 'sand', center: [0, -0.1, -1], half: [10, 0.1, 10] },
  { material: 'white', center: [0, 3, -8.3], half: [8.6, 3, 0.3] },
  { material: 'red', center: [-8.3, 3, -2], half: [0.3, 3, 6.6] },
  { material: 'white', center: [8.3, 3, -2], half: [0.3, 3, 6.6] },
  // Arcade roof slab over the back wall, carried by four pillars.
  { material: 'white', center: [0, 4.15, -6.2], half: [8, 0.15, 1.9] },
  { material: 'white', center: [-6, 2, -4.6], half: [0.3, 2, 0.3] },
  { material: 'white', center: [-2, 2, -4.6], half: [0.3, 2, 0.3] },
  { material: 'white', center: [2, 2, -4.6], half: [0.3, 2, 0.3] },
  { material: 'white', center: [6, 2, -4.6], half: [0.3, 2, 0.3] },
  { material: 'blue', center: [-3, 0.6, 1], half: [0.6, 0.6, 0.6], yaw: 0.5 },
];

export const PROCEDURAL_SCENES: Readonly<Record<ProceduralSceneId, ProceduralGiScene>> = {
  cornell: {
    id: 'cornell',
    title: 'Cornell box',
    boxes: cornellWalls,
    light: {
      kind: 'point',
      position: [0, 1.4, 0.6],
      moved: [-1.8, 1.2, 1.6],
      color: [1, 0.95, 0.88],
      intensity: 12,
      range: 30,
    },
    environment: [0, 0, 0],
    maxDistance: 40,
    camera: { origin: [0, 0, 9.6], target: [0, 0, 0], up: [0, 1, 0], verticalFov: 0.66 },
    cameraAlt: { origin: [2.2, 1, 8.4], target: [0, -0.4, 0], up: [0, 1, 0], verticalFov: 0.66 },
  },
  leak: {
    id: 'leak',
    title: 'Thin-wall leak test',
    boxes: leakBoxes,
    light: {
      kind: 'point',
      position: [-3.4, 2.4, -1],
      moved: [-1.2, 2.4, 1],
      color: [1, 0.96, 0.9],
      intensity: 40,
      range: 30,
    },
    environment: [0, 0, 0],
    maxDistance: 40,
    camera: { origin: [0, 1.5, 14.2], target: [0, 1.5, 0], up: [0, 1, 0], verticalFov: 0.8 },
    cameraAlt: { origin: [3, 1.6, 9.5], target: [2.4, 1.2, 0], up: [0, 1, 0], verticalFov: 0.8 },
    darkRoom: { x0: 0.53, y0: 0.24, x1: 0.94, y1: 0.76 },
  },
  courtyard: {
    id: 'courtyard',
    title: 'Open courtyard with sky',
    boxes: courtyardBoxes,
    light: {
      kind: 'directional',
      direction: [-0.35, -0.75, -0.55],
      moved: [0.5, -0.6, -0.4],
      color: [1, 0.94, 0.84],
      intensity: 3,
    },
    environment: [0.18, 0.26, 0.42],
    maxDistance: 60,
    camera: { origin: [0, 2.2, 10], target: [0, 2.2, -6], up: [0, 1, 0], verticalFov: 0.9 },
    cameraAlt: { origin: [-4, 1.8, 6], target: [2, 2, -7], up: [0, 1, 0], verticalFov: 0.9 },
  },
};

/** Sponza is the cooked Khronos sample published through its Meta, not a procedural table. */
export const SPONZA = {
  sceneGuid: '019e4fe2-523b-7506-99e5-ccd39795ecda',
  camera: { origin: [-8, 1.6, 0], target: [2, 3, 0], up: [0, 1, 0], verticalFov: 1.05 },
  cameraAlt: { origin: [6, 1.8, -1], target: [-4, 3.5, 0.6], up: [0, 1, 0], verticalFov: 1.05 },
  light: {
    kind: 'directional',
    direction: [0.45, -1, -0.2],
    moved: [-0.3, -1, 0.25],
    color: [1, 0.95, 0.85],
    intensity: 4,
  },
  environment: [0.4, 0.5, 0.6],
  maxDistance: 60,
  /** Conservative world AABB of the cooked Khronos Sponza; it frames the Global SDF and probes. */
  bounds: { lo: [-15.5, -0.5, -8], hi: [15, 13, 8] },
} as const satisfies Omit<ProceduralGiScene, 'id' | 'title' | 'boxes' | 'darkRoom'> & {
  readonly sceneGuid: string;
  readonly bounds: GiBounds;
};

export interface GiBounds {
  readonly lo: Vec3;
  readonly hi: Vec3;
}

/** World AABB of a procedural scene; a yawed box contributes its rotated XZ extent. */
export function proceduralBounds(boxes: readonly GiBox[]): GiBounds {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { center, half, yaw = 0 } of boxes) {
    const c = Math.abs(Math.cos(yaw));
    const n = Math.abs(Math.sin(yaw));
    const extent = [c * half[0] + n * half[2], half[1], n * half[0] + c * half[2]];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] ?? 0, (center[a] ?? 0) - (extent[a] ?? 0));
      hi[a] = Math.max(hi[a] ?? 0, (center[a] ?? 0) + (extent[a] ?? 0));
    }
  }
  return { lo: [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0], hi: [hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0] };
}

/**
 * Global SDF samples along the longest axis, and probe cells along the
 * geometric-mean extent of the scene AABB.
 */
const FIELD_SAMPLES = 64;
const PROBE_CELLS = 12;
/** Card texels per side: 16-texel Cards bleed light across thin walls. */
const CARD_RESOLUTION = 32;

export interface GiFieldOptions {
  /** Probes traced per frame, round-robin; the planner clamps it to the lattice. */
  readonly probeBudget?: number;
}

/**
 * Irradiance Field config framed by the scene AABB: a Global SDF grid with
 * one-sample margins around it and a coarser probe lattice inside. Every
 * per-frame budget is bounded so steady-state cost does not grow with the scene.
 */
export function fieldFor(bounds: GiBounds, options: GiFieldOptions = {}): StandardIrradianceField {
  const [sx, sy, sz] = [0, 1, 2].map((a) => (bounds.hi[a] ?? 0) - (bounds.lo[a] ?? 0)) as [
    number,
    number,
    number,
  ];
  const size = [sx, sy, sz];
  const spacing = Math.max(...size) / (FIELD_SAMPLES - 4);
  const margin = 2 * spacing;
  const dimensions = size.map((v) =>
    Math.min(128, Math.max(4, Math.ceil((v + 2 * margin) / spacing) + 1)),
  ) as unknown as [number, number, number];
  return {
    region: {
      grid: {
        origin: [0, 1, 2].map((a) => (bounds.lo[a] ?? 0) - margin) as unknown as [
          number,
          number,
          number,
        ],
        dimensions,
        spacing,
        maxDistance: 8 * spacing,
        coverageDistance: spacing,
      },
      maxInstances: 1024,
      maxFieldBytes: 64 * 1024 * 1024,
    },
    // Uniform density independent of aspect: sizing by the longest axis left flat
    // rooms and tall atria a few probe layers thick, which leaked light through
    // dividers and underestimated Sponza's bounce light.
    probeSpacing: Math.max(spacing, Math.cbrt(sx * sy * sz) / PROBE_CELLS),
    raysPerProbe: 64,
    probeBudget: options.probeBudget ?? 128,
    hysteresis: 0.7,
    // A cap, not an allocation: Sponza's card scene buffers exceed 32 MiB, and the
    // plan admits at most 256 MiB.
    cards: { resolution: CARD_RESOLUTION, maxCaptureBytes: 256 * 1024 * 1024, budget: 256 },
    resolution: 'half',
    radiosity: true,
  };
}

/** Screen Probe settings used by the `screen-probe` mode (downsample 8, BRDF importance). */
export const GI_SCREEN_PROBES = {
  downsample: 8,
  adaptiveFraction: 0.5,
  importance: 'brdf',
  screenTrace: { maxSteps: 32, thickness: 0.02 },
  filterPasses: 2,
  shortRangeAo: 0,
  maxFrames: 10,
} as const;

/** Lite reflection settings used when a lane enables reflections (UE defaults). */
export const GI_REFLECTIONS: NonNullable<
  Exclude<StandardDiffuseGi, { gather: 'baked' }>['reflections']
> = {
  maxRoughnessToTrace: 0.4,
  roughnessFadeLength: 0.1,
};

/** The single mode-to-profile mapping. `off` removes the key entirely. */
export function diffuseGiFor(
  mode: GiMode,
  scene: {
    readonly maxDistance: number;
    readonly environment: Vec3;
  } & ({ readonly boxes: readonly GiBox[] } | { readonly bounds: GiBounds }),
  options: {
    readonly maxBounces?: number;
    readonly seed?: number;
    readonly sky?: boolean;
    readonly field?: GiFieldOptions;
    readonly reflections?: boolean;
    /** Volume GUID for the `baked` mode (see `BAKED_VOLUMES`). */
    readonly volume?: string;
  } = {},
): StandardDiffuseGi | undefined {
  if (mode === 'off') return undefined;
  if (mode === 'baked') {
    if (options.volume === undefined) throw new Error("diffuseGiFor('baked') needs a volume GUID");
    return { gather: 'baked', volume: options.volume, resolution: 'half' };
  }
  const common = {
    maxDistance: scene.maxDistance,
    environment: options.sky === false ? ([0, 0, 0] as const) : scene.environment,
    ...(options.reflections === true ? { reflections: GI_REFLECTIONS } : {}),
  };
  if (mode === 'exact')
    return { gather: 'exact', ...common, maxBounces: options.maxBounces ?? 1, seed: options.seed ?? 47 };
  const field = fieldFor(
    'bounds' in scene ? scene.bounds : proceduralBounds(scene.boxes),
    options.field,
  );
  return mode === 'irradiance-field'
    ? { gather: 'irradiance-field', ...common, field }
    : { gather: 'screen-probe', ...common, field, probes: GI_SCREEN_PROBES };
}

/** Scene framing for `resolveDiffuseGiTier`: the same region and probe spacing as `fieldFor`. */
export function tierSceneFor(
  scene: {
    readonly maxDistance: number;
    readonly environment: Vec3;
  } & ({ readonly boxes: readonly GiBox[] } | { readonly bounds: GiBounds }),
): DiffuseGiTierScene {
  const field = fieldFor('bounds' in scene ? scene.bounds : proceduralBounds(scene.boxes));
  return {
    maxDistance: scene.maxDistance,
    environment: scene.environment,
    region: field.region,
    probeSpacing: field.probeSpacing,
    maxCaptureBytes: field.cards.maxCaptureBytes,
  };
}

export function parseGiMode(value: string | null): GiMode {
  return GI_MODES.find((mode) => mode === value) ?? 'exact';
}

export function parseGiScene(value: string | null): GiSceneId {
  return GI_SCENE_IDS.find((scene) => scene === value) ?? 'cornell';
}
