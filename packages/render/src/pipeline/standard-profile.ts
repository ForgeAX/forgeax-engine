import type { GlobalSdfGrid } from '../raytracing/global-sdf';
import type { GlobalSdfQueryOptions } from '../raytracing/global-sdf-query';
import type { SsaoParameterConfig } from '../ssao-config';
export const STANDARD_PIPELINE_ID = 'forgeax::standard' as const;
export const STANDARD_LIGHT_COUNTS = [1, 32, 256] as const;
export {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
} from './standard-lighting/layout';

export type StandardLightCount = (typeof STANDARD_LIGHT_COUNTS)[number];
export type StandardVolumetricFogQuality = 'low' | 'high';

interface StandardDiffuseGiCommon {
  /** Ray interval in world units; misses and region exits sample `environment`. */
  readonly maxDistance: number;
  /** Constant miss radiance (linear RGB). */
  readonly environment: readonly [number, number, number];
  /** Lite reflections: world-traced specular indirect from this GI lane's world radiance
   * (exact transport, or the field's radiance cache plus Global SDF/Card rays).
   * Replaces IBL specular (already off under GI); admitted SSR hits replace it by confidence. */
  readonly reflections?: StandardLiteReflections;
}

/** UE LumenReflectionsCombine: dedicated reflection rays below
 * `maxRoughnessToTrace - roughnessFadeLength`, rough specular E(R)/pi above
 * `maxRoughnessToTrace`, linear blend between. Defaults mirror UE (0.4, 0.1). */
export interface StandardLiteReflections {
  /** Perceptual roughness in [0, 1] where dedicated GGX reflection rays end. */
  readonly maxRoughnessToTrace: number;
  /** Fade width in (0, 1]; the blend spans [max - fade, max]. */
  readonly roughnessFadeLength: number;
}

/** Bounded exact-query diffuse reference lane, before cache/gather reconstruction.
 * Raster retains direct/emissive lighting; IBL must be disabled for this lane. */
export interface StandardExactDiffuseGi extends StandardDiffuseGiCommon {
  readonly gather: 'exact';
  readonly maxBounces: number;
  readonly seed: number;
  /** Omit for raw D; reconstruction never changes the ray budget. */
  readonly reconstruction?: 'spatial' | 'temporal' | 'combined';
}

/** One frozen Global SDF region: grid, admission budgets and traversal limits.
 * Shared by probe placement queries and the irradiance-field producer. */
export interface StandardGlobalSdfRegion extends GlobalSdfQueryOptions {
  readonly grid: GlobalSdfGrid;
  readonly maxInstances: number;
  readonly maxFieldBytes: number;
}

/** Native Card capture: per-Card texel resolution, total atlas byte budget and the
 * atlas tiles captured (and, in the irradiance field, re-lit) per frame. */
export interface StandardCardCapture {
  readonly resolution: number;
  readonly maxCaptureBytes: number;
  readonly budget: number;
}

/** Lumen-Lite style world irradiance field (UE r.Lumen.IrradianceFieldGather).
 * The probe lattice spans the Global SDF region; every budget is per frame. */
export interface StandardIrradianceField {
  readonly region: StandardGlobalSdfRegion;
  /** World distance between lattice probes (>= region spacing). */
  readonly probeSpacing: number;
  /** Fixed spherical Fibonacci rays traced per updated probe (16..256). */
  readonly raysPerProbe: number;
  /** Probes traced and integrated per frame, round-robin over the lattice. */
  readonly probeBudget: number;
  /** History weight in [0, 1); the first update of a probe writes directly. */
  readonly hysteresis: number;
  /** Card capture plus Card tiles re-lit (direct + radiosity) per frame. */
  readonly cards: StandardCardCapture;
  /** Pixel interpolation resolution; half uses a depth/normal-aware upsample. */
  readonly resolution: 'full' | 'half';
  /** Card texels gather the field (UE r.LumenScene.Radiosity); false is one bounce. */
  readonly radiosity: boolean;
  /** Camera-following probe clipmap. Absent: one fixed lattice spanning the region. */
  readonly clipmap?: StandardProbeClipmap;
}

/** Nested probe windows centred on the camera (UE Lumen radiance-cache clipmaps).
 * Level `l` spaces probes `probeSpacing * 2^l`; a scroll re-traces only the newly
 * exposed slabs, addressed toroidally. `probeBudget` splits over levels by 2^-l. */
export interface StandardProbeClipmap {
  /** Nested levels, 1..4. */
  readonly levels: number;
  /** Probes per axis of every level window, 2..64 each. */
  readonly dimensions: readonly [number, number, number];
}

export interface StandardIrradianceFieldGi extends StandardDiffuseGiCommon {
  readonly gather: 'irradiance-field';
  readonly field: StandardIrradianceField;
}

/** Screen Probe gather (UE r.Lumen.ScreenProbeGather). Probes on the
 * G-buffer trace screen space, then the Global SDF/Card scene; the field is
 * the world fallback and also lights the Card radiance the world trace reads. */
export interface StandardScreenProbes {
  /** Uniform probe tile in pixels (UE DownsampleFactor). */
  readonly downsample: 4 | 8 | 16 | 32;
  /** Adaptive probe capacity as a fraction of uniform probes, in [0, 1]. */
  readonly adaptiveFraction: number;
  /** 'brdf' culls probe directions below the cosine PDF floor and refines the
   * highest-PDF texels with the freed rays (UE ImportanceSampling). */
  readonly importance: 'uniform' | 'brdf';
  /** HZB march steps (0 = world trace only) and depth thickness relative to view distance. */
  readonly screenTrace: { readonly maxSteps: number; readonly thickness: number };
  /** Probe-space spatial radiance filter passes (0..4). */
  readonly filterPasses: number;
  /** Short-range screen AO radius in world units applied to this lane only; 0 disables. */
  readonly shortRangeAo: number;
  /** Shared probe/pixel response budget (1 = no accumulation). One active
   * history uses the full cap; two split it so their steady EMA mean ages
   * sum to maxFrames - 1 rather than doubling the response delay. */
  readonly maxFrames: number;
  /** Independent history controls for diagnosis; omitted lanes default to true. */
  readonly history?: {
    readonly probe?: boolean;
    readonly pixel?: boolean;
    readonly screen?: boolean;
  };
}

export interface StandardScreenProbeGi extends StandardDiffuseGiCommon {
  readonly gather: 'screen-probe';
  readonly probes: StandardScreenProbes;
  readonly field: StandardIrradianceField;
}

/** Build-time baked irradiance volume (UE precomputed volumetric lightmap,
 * gathered like r.Lumen.IrradianceFieldGather). The Catalog `irradiance-volume`
 * asset holds the probes; the frame traces nothing, and every receiver,
 * dynamic or static, samples the same baked D = E / pi. */
export interface StandardBakedDiffuseGi {
  readonly gather: 'baked';
  /** GUID of a cooked `irradiance-volume` Catalog asset. */
  readonly volume: string;
  /** Pixel interpolation resolution; half uses a depth/normal-aware upsample. */
  readonly resolution: 'full' | 'half';
}

/** Diffuse GI gather selector; every lane shares the single additive composite. */
export type StandardDiffuseGi =
  | StandardExactDiffuseGi
  | StandardIrradianceFieldGi
  | StandardScreenProbeGi
  | StandardBakedDiffuseGi;

export interface StandardVolumetricFogProfile {
  readonly quality: StandardVolumetricFogQuality;
  readonly depth: 48 | 64;
  readonly tileSize: 4 | 16;
}

export const STANDARD_POST_STAGE_NAMES = [
  'transparent-blend',
  'bloom',
  'output-transform',
  'fxaa',
  'post-effect',
  'present',
] as const;
/** Explicit bounded placement inputs; traced is eligibility supplied by the caller.
 * Changing identity/generation or seed geometry starts a fresh zero-offset pair. */
export interface StandardProbePlacementSeed {
  readonly id: number;
  readonly generation: number;
  readonly position: readonly [number, number, number];
  readonly cellSize: number;
  readonly traced: boolean;
}

/** One frozen region and a bounded diagnostic query, independent of diffuse GI. */
export interface StandardProbeGlobal extends StandardGlobalSdfRegion {
  /** Equal-area ray texels per axis; total rays remain within the query owner limit. */
  readonly rayResolution: number;
  /** Ray interval length; grid.maxDistance separately bounds composition influence. */
  readonly tMax: number;
  /** Opt-in unlit Card support diagnostic; no scene-color or lighting contribution. */
  readonly cards?: StandardCardCapture;
}
export interface StandardProbePlacement {
  readonly seeds: readonly StandardProbePlacementSeed[];
  readonly global?: StandardProbeGlobal;
}

export interface StandardProfile {
  readonly pipelineId: typeof STANDARD_PIPELINE_ID;
  readonly lightCount: StandardLightCount;
  /** Graph topology selector; all local lights use the shared Cluster path. */
  readonly renderPath: 'forward' | 'deferred';
  /** Subsurface kernel samples: low=13, high=25 per axis; defaults to high. */
  readonly subsurfaceQuality?: 'low' | 'high';
  /** Rigid deferred surface identity/geometry attachment for transport and inspection. */
  readonly visibleSurface?: boolean;
  readonly diffuseGi?: StandardDiffuseGi;
  readonly probePlacement?: StandardProbePlacement;
  readonly pbr: boolean;
  readonly ibl: boolean;
  readonly ssao: boolean | SsaoParameterConfig;
  /** Seeds `RenderPipelineAsset.config.gpuOcclusion`; omitted means on. */
  readonly gpuOcclusion?: boolean | undefined;
  /** Renderer-owned 1080p volume profile; tile width/height remain surface-derived. */
  readonly volumetricFog?: StandardVolumetricFogProfile | undefined;
  readonly postStages: typeof STANDARD_POST_STAGE_NAMES;
}

export const DEFAULT_STANDARD_PROFILE: StandardProfile = Object.freeze({
  pipelineId: STANDARD_PIPELINE_ID,
  lightCount: 32,
  renderPath: 'forward',
  pbr: true,
  ibl: true,
  ssao: false,
  postStages: STANDARD_POST_STAGE_NAMES,
});

export function resolveVolumetricFogProfile(
  profile: Pick<StandardProfile, 'volumetricFog'>,
): StandardVolumetricFogProfile {
  return profile.volumetricFog ?? { quality: 'high', depth: 64, tileSize: 4 };
}
