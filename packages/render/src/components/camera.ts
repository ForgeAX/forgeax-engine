// @forgeax/engine-render - Camera (projection variant + ortho extension).
//
// Schema: projection, output, Bloom, and lifecycle columns. The view matrix
// continues to be derived from the entity's Transform. Zero cameras is a
// normal clear/UI frame.
//
// Projection discriminator:
//   projection === 0 → perspective path; RenderSystem builds
//                      mat4.perspectiveReverseZ(out, fov, aspect, near, far).
//                      WebGPU [0, 1] NDC z; perspective reverse-Z hook is
//                      a future spin-off path (plan-strategy §R-7) kept
//                      outside M3 scope — the short-name mat4.perspective
//                      already writes [0, 1] NDC, matching the ortho branch.
//   projection === 1 → orthographic path; RenderSystem builds
//                      mat4.orthographicReverseZ(out, left, right, top, bottom,
//                      near, far) (WebGPU [0, 1] NDC; same z convention).
//
// Naming convention: forgeax uses the bare `Camera` name (no `Component`
// suffix) to follow the unity-style flavor for "individuating" component
// names per plan-strategy 7.2 + D-Q5a user lock.
//
// Related: requirements §AC-16 (Camera Ortho + Box3 / Sphere);
//          plan-strategy §M3 range + §R-7 risk (single perspective camera
//          in hello-room does NOT trigger depth-func conflict; multi-camera
//          mixed perspective + ortho deferred to feat-future-camera-depth-func);
//          plan-tasks.json w9 acceptanceCheck.

import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { TONEMAP_SHADER_MODE } from '@forgeax/engine-shader';

/**
 * Projection discriminator literal union (AC-16 narrowing surface).
 * Exposed for consumer code that maps `camera.projection` numeric values back
 * to a switch-able string literal (e.g. RenderSystem dispatch / inspector
 * snapshot rendering).
 */
export type CameraProjection = 'perspective' | 'orthographic';

/** Numeric encoding of perspective projection (schema value for `projection`). */
export const CAMERA_PROJECTION_PERSPECTIVE = 0;
/** Numeric encoding of orthographic projection (schema value for `projection`). */
export const CAMERA_PROJECTION_ORTHOGRAPHIC = 1;

/** Closed public exposure authoring contract shared by all camera routes. */
export type CameraExposure =
  | { readonly kind: 'manual'; readonly multiplier: number }
  | {
      readonly kind: 'auto';
      readonly fallback: number;
      readonly compensationEv: number;
      readonly rangeEv: readonly [min: number, max: number];
      readonly rates: readonly [up: number, down: number];
    };

/** Numeric encoding of manual exposure in the Camera SoA column. */
export const CAMERA_EXPOSURE_MODE_MANUAL = 0;
/** Numeric encoding of GPU-adapted exposure in the Camera SoA column. */
export const CAMERA_EXPOSURE_MODE_AUTO = 1;

/** Product-supported white-balance temperature range in Kelvin. */
export const CAMERA_TEMPERATURE_MIN = 1000;
export const CAMERA_TEMPERATURE_MAX = 40000;
/** Product-supported normalized tint range. */
export const CAMERA_TINT_MIN = -1;
export const CAMERA_TINT_MAX = 1;

/** Closed validation failures for the Camera authoring/column boundary. */
export type CameraErrorCode =
  | 'camera-exposure-invalid'
  | 'camera-color-grading-invalid'
  | 'camera-exposure-mode-invalid'
  | 'camera-tonemap-invalid'
  | 'camera-antialias-invalid'
  | 'camera-bloom-invalid'
  | 'camera-transparency-invalid'
  | 'camera-projection-invalid';

export interface CameraErrorDetail {
  readonly field: string;
  readonly actual: number | string;
  readonly expected: string;
}

/** Structured Camera error; callers can branch on the closed `code` union. */
export class CameraError<Code extends CameraErrorCode = CameraErrorCode> extends Error {
  readonly code: Code;
  readonly expected: string;
  readonly hint: string;
  readonly detail: CameraErrorDetail;

  constructor(code: Code, field: string, actual: number | string, expected: string, hint: string) {
    super(`${code}: ${field}=${String(actual)}; expected ${expected}`);
    this.name = 'CameraError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = Object.freeze({ field, actual, expected });
  }
}

function actualValue(value: unknown): number | string {
  if (typeof value === 'number' || typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function cameraError<Code extends CameraErrorCode>(
  code: Code,
  field: string,
  actual: unknown,
  expected: string,
  hint: string,
): CameraError<Code> {
  return new CameraError(code, field, actualValue(actual), expected, hint);
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Validate the closed exposure union before it is projected into columns. */
export function validateCameraExposure(exposure: CameraExposure): CameraExposure {
  if (typeof exposure !== 'object' || exposure === null) {
    throw cameraError(
      'camera-exposure-invalid',
      'value',
      exposure,
      'an object with kind manual or auto',
      'choose one member of the CameraExposure union',
    );
  }
  if (exposure.kind === 'manual') {
    if (!finitePositive(exposure.multiplier)) {
      throw cameraError(
        'camera-exposure-invalid',
        'multiplier',
        exposure.multiplier,
        'a finite number greater than zero',
        'set Camera.exposure to a positive finite manual multiplier',
      );
    }
    return exposure;
  }
  if (exposure.kind === 'auto') {
    const [min, max] = exposure.rangeEv;
    const [up, down] = exposure.rates;
    if (
      !finitePositive(exposure.fallback) ||
      !Number.isFinite(exposure.compensationEv) ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min > max ||
      !Number.isFinite(up) ||
      !Number.isFinite(down) ||
      up < 0 ||
      down < 0
    ) {
      throw cameraError(
        'camera-exposure-invalid',
        'auto',
        JSON.stringify(exposure),
        'finite fallback/compensation, an ordered range, and non-negative rates',
        'inspect fallback, compensationEv, rangeEv, and rates before rebuilding the camera',
      );
    }
    return exposure;
  }
  throw cameraError(
    'camera-exposure-invalid',
    'kind',
    (exposure as { readonly kind?: unknown }).kind,
    "'manual' or 'auto'",
    'choose one member of the CameraExposure union',
  );
}

/** Validate the Camera-owned white-balance and LUT authoring fields. */
export function validateCameraColorGrading(
  temperature: number,
  tint: number,
  colorLutStrength: number,
): void {
  if (
    !Number.isFinite(temperature) ||
    temperature < CAMERA_TEMPERATURE_MIN ||
    temperature > CAMERA_TEMPERATURE_MAX
  ) {
    throw cameraError(
      'camera-color-grading-invalid',
      'temperature',
      temperature,
      `a finite value in [${CAMERA_TEMPERATURE_MIN}, ${CAMERA_TEMPERATURE_MAX}]`,
      'set Camera.temperature to a supported Kelvin value',
    );
  }
  if (!Number.isFinite(tint) || tint < CAMERA_TINT_MIN || tint > CAMERA_TINT_MAX) {
    throw cameraError(
      'camera-color-grading-invalid',
      'tint',
      tint,
      `a finite value in [${CAMERA_TINT_MIN}, ${CAMERA_TINT_MAX}]`,
      'set Camera.tint to a normalized value between -1 and 1',
    );
  }
  if (!Number.isFinite(colorLutStrength) || colorLutStrength < 0 || colorLutStrength > 1) {
    throw cameraError(
      'camera-color-grading-invalid',
      'colorLutStrength',
      colorLutStrength,
      'a finite value in [0, 1]',
      'set Camera.colorLutStrength to zero to disable the LUT or a blend in [0, 1]',
    );
  }
}

/**
 * Map a `camera.projection` numeric value to the closed `CameraProjection`
 * string-literal union. Values other than 0 / 1 fall back to `'perspective'`
 * (defensive for defaulted / uninitialised entities; charter proposition 4
 * no silent exception).
 */
export function cameraProjectionFromF32(value: number): CameraProjection {
  return value === CAMERA_PROJECTION_ORTHOGRAPHIC ? 'orthographic' : 'perspective';
}

/**
 * Tone-mapping mode discriminator literal union (AC-01 narrowing surface;
 * feat-20260519-tonemap-reinhard-mvp / M1).
 *
 * Two members for the MVP:
 *   `'none'`              - default; render-target stays `bgra8unorm-srgb`
 *                            and the geometry pass writes directly to the
 *                            swap-chain (zero-overhead opt-out path).
 *   `'reinhard-extended'` - Forgeax Reinhard 2002 extended (luminance-domain)
 *                            opt-in;
 *   `'reinhard'`          - Three r184 per-channel Reinhard opt-in;
 *                            geometry pass routes through an `rgba16float`
 *                            HDR target and a fullscreen tonemap pass
 *                            (`packages/shader/src/tonemap.wgsl`).
 *
 * The remaining members mirror the Three r184 public names and formulas.
 */
export type Tonemap =
  | 'none'
  | 'reinhard-extended'
  | 'reinhard'
  | 'linear'
  | 'cineon'
  | 'aces-filmic'
  | 'agx'
  | 'neutral';

/** Numeric encoding of the no-op tonemap path (schema value for `tonemap`). */
export const TONEMAP_NONE = TONEMAP_SHADER_MODE.none;
/**
 * Numeric encoding of the Reinhard-extended tonemap path
 * (schema value for `tonemap`).
 */
export const TONEMAP_REINHARD_EXTENDED = TONEMAP_SHADER_MODE.reinhardExtended;
/** Numeric encoding of the Three r184 per-channel Reinhard path. */
export const TONEMAP_REINHARD = TONEMAP_SHADER_MODE.reinhard;
/** Numeric encoding of the linear (identity after exposure) tonemap path. */
export const TONEMAP_LINEAR = TONEMAP_SHADER_MODE.linear;
/** Numeric encoding of the Cineon (Kodak log) tonemap path. */
export const TONEMAP_CINEON = TONEMAP_SHADER_MODE.cineon;
/** Numeric encoding of the ACES filmic (Narkowicz 2015) tonemap path. */
export const TONEMAP_ACES_FILMIC = TONEMAP_SHADER_MODE.acesFilmic;
/** Numeric encoding of the AgX (Troy Sobotka / Blender 3.x) tonemap path. */
export const TONEMAP_AGX = TONEMAP_SHADER_MODE.agx;
/** Numeric encoding of the Khronos PBR neutral tonemap path. */
export const TONEMAP_NEUTRAL = TONEMAP_SHADER_MODE.neutral;

/**
 * Map a `camera.tonemap` numeric value to the closed `Tonemap` string-literal
 * union. Unknown values fall back to `'none'` for defensive schema decoding.
 */
export function tonemapFromF32(value: number): Tonemap {
  switch (value) {
    case TONEMAP_REINHARD_EXTENDED:
      return 'reinhard-extended';
    case TONEMAP_REINHARD:
      return 'reinhard';
    case TONEMAP_LINEAR:
      return 'linear';
    case TONEMAP_CINEON:
      return 'cineon';
    case TONEMAP_ACES_FILMIC:
      return 'aces-filmic';
    case TONEMAP_AGX:
      return 'agx';
    case TONEMAP_NEUTRAL:
      return 'neutral';
    default:
      return 'none';
  }
}

/**
 * Inverse of {@link tonemapFromF32}: map the closed `Tonemap` string-literal
 * union to the u32 mode the tonemap WGSL `params.mode` switch reads. SSOT for
 * the mode encoding shared by the extract-stage built-in tonemap provider
 * (feat-20260621 M-A3 / w13: `Camera.tonemap` -> `forgeax::tonemap` 16B data)
 * and any other consumer. `'none'` maps to 0 (the tonemap pass never dispatches
 * on the LDR path, so 0 is only ever a placeholder).
 */
export function tonemapToU32(mode: Tonemap): number {
  switch (mode) {
    case 'reinhard-extended':
      return TONEMAP_REINHARD_EXTENDED;
    case 'reinhard':
      return TONEMAP_REINHARD;
    case 'linear':
      return TONEMAP_LINEAR;
    case 'cineon':
      return TONEMAP_CINEON;
    case 'aces-filmic':
      return TONEMAP_ACES_FILMIC;
    case 'agx':
      return TONEMAP_AGX;
    case 'neutral':
      return TONEMAP_NEUTRAL;
    case 'none':
      return TONEMAP_NONE;
  }
  throw cameraError(
    'camera-tonemap-invalid',
    'tonemap',
    mode,
    'one of the closed Tonemap values',
    'select a supported Camera tonemap mode',
  );
}

/**
 * Anti-alias mode discriminator literal union
 * (feat-20260528-fxaa-post-processing / w2;
 *  feat-20260604-learn-render-4-10-anti-aliasing-msaa adds `'msaa'`).
 *
 * Supported modes:
 *   `'none'` - default; no anti-aliasing (zero-overhead opt-out path)
 *   `'fxaa'` - FXAA 3.11 fullscreen post-processing pass (screen-space, shading-aliasing)
 *   `'msaa'` - 4x hardware multi-sample anti-aliasing (geometry-edge coverage).
 *              Active on both HDR and LDR-swap-chain paths, so a default Camera
 *              (`tonemap='none'`) with `antialias='msaa'` is NOT a silent no-op.
 *   `'smaa'` - SMAA 1x Medium, spatial three-pass color-edge anti-aliasing.
 *   `'taa'`  - temporal anti-aliasing; renderer temporal projection owns its
 *              jitter and successful-submit history contract.
 *
 * MSAA and FXAA are orthogonal: MSAA resolves geometry-edge aliasing, FXAA
 * resolves shading/high-frequency aliasing. TAA is mutually exclusive with both.
 */
export type Antialias = 'none' | 'fxaa' | 'msaa' | 'taa' | 'smaa';

/** Numeric encoding of anti-alias disabled (schema value for `antialias`). */
export const ANTIALIAS_NONE = 0;
/** Numeric encoding of FXAA anti-aliasing (schema value for `antialias`). */
export const ANTIALIAS_FXAA = 1;
/** Numeric encoding of MSAA multi-sample anti-aliasing (schema value for `antialias`). */
export const ANTIALIAS_MSAA = 2;
/** Numeric encoding of temporal anti-aliasing (schema value for `antialias`). */
export const ANTIALIAS_TAA = 3;
/** SMAA 1x Medium: spatial color edges, area weights, linear neighborhood blend. */
export const ANTIALIAS_SMAA = 4;

/**
 * Map a `camera.antialias` numeric value to the closed `Antialias`
 * string-literal union. Invalid values fail-fast with structured error (charter P3).
 */
export function antialiasFromF32(value: number): Antialias {
  if (value === ANTIALIAS_NONE) return 'none';
  if (value === ANTIALIAS_FXAA) return 'fxaa';
  if (value === ANTIALIAS_MSAA) return 'msaa';
  if (value === ANTIALIAS_TAA) return 'taa';
  if (value === ANTIALIAS_SMAA) return 'smaa';
  throw cameraError(
    'camera-antialias-invalid',
    'antialias',
    value,
    `${ANTIALIAS_NONE}, ${ANTIALIAS_FXAA}, ${ANTIALIAS_MSAA}, ${ANTIALIAS_TAA}, or ${ANTIALIAS_SMAA}`,
    'select a supported Camera antialias mode',
  );
}

/**
 * How a view composites its transparent draws.
 *
 *   `'sorted'`           - default; exact back-to-front sorted blending.
 *   `'weighted-blended'` - weighted blended order-independent transparency
 *                          (McGuire-Bavoil). Coverage is exact; color is a
 *                          depth-weighted average, so the result is an
 *                          approximation that does not depend on draw order.
 *
 * Draws that cannot accumulate (see the render README OIT section) stay in the
 * sorted pass, recorded after the OIT composite. `renderer.inspect()` reports
 * the resolved mode and every kept draw's reason.
 */
export type Transparency = 'sorted' | 'weighted-blended';

/** Numeric encoding of sorted transparency (schema value for `transparency`). */
export const TRANSPARENCY_SORTED = 0;
/** Numeric encoding of weighted blended OIT (schema value for `transparency`). */
export const TRANSPARENCY_WEIGHTED_BLENDED = 1;

/**
 * Map a `camera.transparency` numeric value to the closed `Transparency`
 * union. Invalid values fail-fast with structured error (charter P3).
 */
export function transparencyFromF32(value: number): Transparency {
  if (value === TRANSPARENCY_SORTED) return 'sorted';
  if (value === TRANSPARENCY_WEIGHTED_BLENDED) return 'weighted-blended';
  throw cameraError(
    'camera-transparency-invalid',
    'transparency',
    value,
    `${TRANSPARENCY_SORTED} or ${TRANSPARENCY_WEIGHTED_BLENDED}`,
    'select Camera transparency TRANSPARENCY_SORTED or TRANSPARENCY_WEIGHTED_BLENDED',
  );
}

/**
 * Bloom enabled discriminator literal union
 * (feat-20260531-bloom-first-declarative-render-graph-pass / w2).
 *
 * Two members:
 *   `'off'` - default; no bloom post-processing (zero-overhead opt-out path)
 *   `'on'`  - five-level HDR highpass/Gaussian/composite pipeline
 *
 * Bloom is a discrete enum (0/1) — illegal values fail-fast with the closed
 * CameraError contract (charter P3), matching antialiasFromF32 precedent.
 */
export type BloomEnabled = 'off' | 'on';

/** Numeric encoding of bloom disabled (schema value for `bloom`). */
export const BLOOM_DISABLED = 0;
/** Numeric encoding of bloom enabled (schema value for `bloom`). */
export const BLOOM_ENABLED = 1;

/** Bloom intensity is a linear HDR add-back multiplier. */
export const CAMERA_BLOOM_INTENSITY_MIN = 0;
export const CAMERA_BLOOM_INTENSITY_MAX = 8;
/** Bloom threshold is expressed in scene-linear Rec.709 luminance. */
export const CAMERA_BLOOM_THRESHOLD_MIN = 0;
export const CAMERA_BLOOM_THRESHOLD_MAX = 65504;
/** Absolute luminance interval above the threshold used by the smooth highpass. */
export const CAMERA_BLOOM_SMOOTH_WIDTH_MIN = 0;
export const CAMERA_BLOOM_SMOOTH_WIDTH_MAX = 1;
/** Mix each Gaussian level's weight toward its complementary radius weight. */
export const CAMERA_BLOOM_RADIUS_MIN = 0;
export const CAMERA_BLOOM_RADIUS_MAX = 1;

/**
 * Map a `camera.bloom` numeric value to the closed `BloomEnabled` string-literal
 * union. Invalid values fail-fast with structured error (charter P3).
 */
export function bloomEnabledFromF32(value: number): BloomEnabled {
  if (value === BLOOM_DISABLED) return 'off';
  if (value === BLOOM_ENABLED) return 'on';
  throw cameraError(
    'camera-bloom-invalid',
    'bloom',
    value,
    `${BLOOM_DISABLED} or ${BLOOM_ENABLED}`,
    'select Camera bloom off or on',
  );
}

function validateBloomRange(field: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw cameraError(
      'camera-bloom-invalid',
      field,
      value,
      `a finite value in [${min}, ${max}]`,
      `set Camera.${field} to a finite value in [${min}, ${max}]`,
    );
  }
}

/** Validate the complete Camera-owned Bloom contract at the extract boundary. */
export function validateCameraBloom(
  bloom: number,
  threshold: number,
  intensity: number,
  smoothWidth: number,
  radius: number,
): BloomEnabled {
  const enabled = bloomEnabledFromF32(bloom);
  validateBloomRange(
    'bloomThreshold',
    threshold,
    CAMERA_BLOOM_THRESHOLD_MIN,
    CAMERA_BLOOM_THRESHOLD_MAX,
  );
  validateBloomRange(
    'bloomIntensity',
    intensity,
    CAMERA_BLOOM_INTENSITY_MIN,
    CAMERA_BLOOM_INTENSITY_MAX,
  );
  validateBloomRange(
    'bloomSmoothWidth',
    smoothWidth,
    CAMERA_BLOOM_SMOOTH_WIDTH_MIN,
    CAMERA_BLOOM_SMOOTH_WIDTH_MAX,
  );
  validateBloomRange('bloomRadius', radius, CAMERA_BLOOM_RADIUS_MIN, CAMERA_BLOOM_RADIUS_MAX);
  return enabled;
}

/**
 * Camera projection parameters (perspective + orthographic variants) +
 * tonemap trio (mode + exposure + whitePoint).
 *
 * Camera transform comes from the entity's `Transform` (AI users
 * spawn camera entities with both components: see example below).
 *
 * Required perspective inputs (the perspective factory enforces these):
 *   fov                    - vertical field of view in radians
 *   aspect                 - target width / height
 *
 * Schema defaults:
 *   near       = 0.1
 *   far        = 2000
 *   projection = 0          - CAMERA_PROJECTION_PERSPECTIVE (layer-2)
 *   left       = -1, right  = 1, bottom = -1, top = 1  (orthographic; layer-2)
 *   tonemap    = 0          - TONEMAP_NONE (layer-2; opt-in path stays
 *                              0-overhead by default)
 *   exposure   = 1.0        - layer-2 default for the Reinhard-extended path
 *                              @applicableWhen tonemap === 'reinhard-extended'
 *   whitePoint = 4.0        - layer-2 default for the Reinhard-extended path
 *                              @applicableWhen tonemap === 'reinhard-extended'
 *                              @minimum 0 (shader floor `max(Y, 1e-5)` keeps
 *                              the divisor finite even at 0; D-O3)
 *   clearColor = [0, 0, 0, 0]
 *                            - feat-20260709 M3 / D-3: clear-color is one
 *                              inline `array<f32,4>` column (collapsed from the
 *                              feat-20260608 clearR/G/B/A quartet). Defaults to
 *                              transparent black; an explicit alpha remains
 *                              visible through this public field.
 *
 * CameraView opts cameras into simultaneous, ordered viewport/target output.
 * Without CameraView, ActiveCamera selects the single display view. The orthographic path reuses the
 * same near / far as the perspective path — both variants share the single
 * Camera archetype (32 schema fields, including the Bloom controls, one
 * historyVersion u32 column, the `targetLayer` u32 column, the `clearColor` array<f32,4> column, and the
 * `autoAspect` bool column).
 *
 * @example Perspective camera at (0, 0, 3) looking down -Z (zero-config tonemap):
 *   world.spawn(
 *     { component: Transform, data: {
 *       pos: [0, 0, 3],
 *       quat: [0, 0, 0, 1],
 *       scale: [1, 1, 1],
 *     } },
 *     { component: Camera, data: {
 *       fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100,
 *     } },
 *   );
 *   // tonemap defaults to 0 (TONEMAP_NONE) - 0-overhead path.
 *
 * @example Opt-in Reinhard-extended tonemap (high-intensity HDR scene):
 *   world.spawn(
 *     { component: Transform, data: { ... } },
 *     { component: Camera, data: {
 *       fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100,
 *       tonemap: TONEMAP_REINHARD_EXTENDED,
 *       exposure: 1.0,
 *       whitePoint: 4.0,
 *     } },
 *   );
 *
 * @example Orthographic camera spanning [-10, 10]^2 on the near plane:
 *   world.spawn(
 *     { component: Transform, data: {
 *       pos: [0, 0, 5],
 *       quat: [0, 0, 0, 1],
 *       scale: [1, 1, 1],
 *     } },
 *     { component: Camera, data: {
 *       fov: 0, aspect: 1, near: 0.1, far: 100,
 *       projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
 *       left: -10, right: 10, bottom: -10, top: 10,
 *     } },
 *   );
 */
export const Camera = defineComponent('Camera', {
  fov: { type: 'f32' },
  aspect: { type: 'f32' },
  near: { type: 'f32', default: 0.1 },
  far: { type: 'f32', default: 2000 },
  projection: { type: 'f32', default: 0 },
  /** Additive NDC offset: +X moves the image right, +Y moves it up. */
  projectionOffset: { type: 'array<f32, 2>', default: new Float32Array([0, 0]) },
  left: { type: 'f32', default: -1 },
  right: { type: 'f32', default: 1 },
  bottom: { type: 'f32', default: -1 },
  top: { type: 'f32', default: 1 },
  tonemap: { type: 'f32', default: 0 },
  exposure: { type: 'f32', default: 1.0 },
  exposureMode: { type: 'f32', default: CAMERA_EXPOSURE_MODE_MANUAL },
  compensationEv: { type: 'f32', default: 0 },
  rangeEv: { type: 'array<f32, 2>', default: new Float32Array([-8, 8]) },
  rates: { type: 'array<f32, 2>', default: new Float32Array([3, 1]) },
  whitePoint: { type: 'f32', default: 4.0 },
  temperature: { type: 'f32', default: 6504 },
  tint: { type: 'f32', default: 0 },
  colorLut: { type: 'shared<TextureAsset>', default: 0 as never },
  colorLutStrength: { type: 'f32', default: 1 },
  antialias: { type: 'f32', default: 0 },
  transparency: { type: 'f32', default: TRANSPARENCY_SORTED },
  historyVersion: { type: 'u32', default: 0 },
  bloom: { type: 'f32', default: 0 },
  bloomThreshold: { type: 'f32', default: 0 },
  bloomIntensity: { type: 'f32', default: 1.0 },
  bloomSmoothWidth: { type: 'f32', default: 0.01 },
  bloomRadius: { type: 'f32', default: 0 },
  // M1 target camera role: zero means this camera is eligible for display;
  // non-zero shared targets are auxiliary producers whose views and receipt
  // promotion remain owned by Renderer.
  target: { type: 'shared<RenderTarget>', simulationTransient: true },
  // Layer of `target` this camera writes: cube face, `2d-array` layer, or
  // `3d` depth slice (Three.js reuses activeCubeFace the same way). Zero for
  // a 2D target; writers of one target must name distinct layers.
  targetLayer: { type: 'u32', default: 0 },
  // feat-20260709 M3 / D-3: clear-color is one inline `array<f32,4>` column.
  // The earlier 4-scalar form (clearR/G/B/A) was chosen when this was believed
  // to be the only SoA-safe shape; the Transform (pos/quat/scale) and light
  // (direction/color) precedents disprove that -- an `array<f32,N>` IS an
  // inline stride-N SoA column, read on the hot path as `col[i*N+a]` with zero
  // allocation, so collapsing four scalars into one column removes three field
  // names a reader must track without changing the storage layout or read
  // pattern. The default `[0, 0, 0, 0]` is transparent black; explicit alpha
  // stays visible through the same public array field.
  clearColor: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 0]) },
  // feat-20260617-host-engine-contract-and-video-cutscene / M3 / D-4: the
  // aspect-sync sidecar on the createApp(canvas) path writes
  // canvas.width / canvas.height into `aspect` every frame when this flag is
  // true. Reuses the existing `bool` column tier (AnimationPlayer.paused /
  // AudioSource.playing precedent) -- zero ECS infrastructure change. Default
  // true so demos that never touch aspect track the canvas automatically
  // (charter P1 default-is-correct); set false for render-to-texture /
  // split-screen cameras that drive aspect themselves. Read it via
  // world.get (readRow narrows bool -> JS boolean); the query-bundle path
  // returns a raw 0/1 number (the `!== 0` always-true trap).
  autoAspect: { type: 'bool', default: true },
});

// ─── Camera POD type (derived from Camera token — single source, AC-07) ─────
//
// ShapeOf<SchemaOf<typeof Camera>> resolves the 32-field POD from the Camera
// token's schema, which is itself derived from Camera.fields[k].type (D-A7).
// This replaces the hand-maintained CameraDataPod interface — the field set
// lives exclusively in the Camera component definition above.
export type CameraData = ShapeOf<SchemaOf<typeof Camera>>;
type CameraPod = CameraData;

/** Validate and detach the two shared lens offsets before extraction/publication. */
export function validateCameraProjectionOffset(
  value: ArrayLike<number>,
): readonly [number, number] {
  if (
    value.length !== 2 ||
    ![value[0], value[1]].every((v) => Number.isFinite(Math.fround(v ?? NaN)))
  )
    throw cameraError(
      'camera-projection-invalid',
      'projectionOffset',
      value,
      'two finite Float32 NDC offsets',
      'use [0, 0] for a centered lens or finite X/Y offsets for an off-axis lens',
    );
  return [value[0] as number, value[1] as number];
}

/** Project the Camera SoA columns back into the public closed union. */
export function cameraExposureFromColumns(
  input: Pick<CameraData, 'exposureMode' | 'exposure' | 'compensationEv' | 'rangeEv' | 'rates'>,
): CameraExposure {
  if (input.exposureMode === CAMERA_EXPOSURE_MODE_MANUAL) {
    return validateCameraExposure({ kind: 'manual', multiplier: input.exposure });
  }
  if (input.exposureMode === CAMERA_EXPOSURE_MODE_AUTO) {
    return validateCameraExposure({
      kind: 'auto',
      fallback: input.exposure,
      compensationEv: input.compensationEv,
      rangeEv: [input.rangeEv[0] ?? -8, input.rangeEv[1] ?? 8],
      rates: [input.rates[0] ?? 3, input.rates[1] ?? 1],
    });
  }
  throw cameraError(
    'camera-exposure-mode-invalid',
    'exposureMode',
    input.exposureMode,
    `${CAMERA_EXPOSURE_MODE_MANUAL} or ${CAMERA_EXPOSURE_MODE_AUTO}`,
    'set Camera.exposureMode to the manual or auto encoding',
  );
}

function cameraExposureColumns(
  exposure: CameraExposure,
): Pick<CameraData, 'exposureMode' | 'exposure' | 'compensationEv' | 'rangeEv' | 'rates'> {
  const checked = validateCameraExposure(exposure);
  if (checked.kind === 'manual') {
    return {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: checked.multiplier,
      compensationEv: 0,
      rangeEv: new Float32Array([-8, 8]),
      rates: new Float32Array([3, 1]),
    };
  }
  return {
    exposureMode: CAMERA_EXPOSURE_MODE_AUTO,
    exposure: checked.fallback,
    compensationEv: checked.compensationEv,
    rangeEv: new Float32Array(checked.rangeEv),
    rates: new Float32Array(checked.rates),
  };
}

interface CameraColorGradingOpts {
  exposure?: CameraExposure;
  temperature?: number;
  tint?: number;
  colorLut?: CameraPod['colorLut'];
  colorLutStrength?: number;
}

function cameraColorGradingColumns(
  opts: CameraColorGradingOpts,
): ReturnType<typeof cameraExposureColumns> &
  Pick<CameraData, 'temperature' | 'tint' | 'colorLut' | 'colorLutStrength'> {
  const exposure = opts.exposure ?? { kind: 'manual', multiplier: 1 };
  const temperature = opts.temperature ?? 6504;
  const tint = opts.tint ?? 0;
  const colorLutStrength =
    opts.colorLutStrength ?? (Camera.fields.colorLutStrength.default as number);
  validateCameraColorGrading(temperature, tint, colorLutStrength);
  return {
    ...cameraExposureColumns(exposure),
    temperature,
    tint,
    colorLut: opts.colorLut ?? (0 as CameraPod['colorLut']),
    colorLutStrength,
  };
}

// ─── Camera factory functions (w13 SSOT refactoring) ─────────────────────
//
// Standalone factory functions that return 29-field CameraPod objects
// matching the Camera component column shape. Not static methods because
// TypeScript const-namespace merge is not supported, and Object.assign
// would break the Camera token's reference identity (archetype columns /
// queries key off the global owner identity associated with the token).
//
// Import as:
//   import { Camera, perspective, orthographic } from '@forgeax/engine-render';
//   world.spawn({ component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 4/3 }) });
//
// Charter P1 progressive disclosure: Barrel re-exports put perspective
// / orthographic next to Camera in IDE autocomplete.
//
// D-A4 factory retention reason: perspective() / orthographic() carry
// required/optional parameter semantics that cannot be derived from
// the schema.  perspective requires fov + aspect (no universal default),
// orthographic requires left/right/bottom/top.  The schema/defaults system
// only records type + optional default value per field — it has no concept
// of "this field MUST be supplied by the caller."  The factories encode
// that contract at the TypeScript type level, which schema/defaults alone
// cannot express.  Per AC-07, the factories are kept; only the POD type
// and default literals are derived from the Camera token (SSOT).

interface CameraPerspectiveOpts {
  fov: number;
  aspect: number;
  near?: number;
  far?: number;
  projectionOffset?: readonly [number, number];
  /**
   * feat-20260617-host-engine-contract-and-video-cutscene / M3: when true
   * (the schema default), the aspect-sync sidecar on the createApp(canvas)
   * path overwrites `aspect` with `canvas.width / canvas.height` every frame.
   * Omit it for the default-correct behaviour; set `false` to opt out (the
   * factory then leaves `aspect` under your control -- render-to-texture,
   * split-screen). Cameras built on the bare `createRenderer` path never
   * receive aspect-sync regardless of this flag.
   */
  autoAspect?: boolean;
  exposure?: CameraExposure;
  temperature?: number;
  tint?: number;
  colorLut?: CameraPod['colorLut'];
  colorLutStrength?: number;
}

interface CameraOrthographicOpts {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near?: number;
  far?: number;
  projectionOffset?: readonly [number, number];
  exposure?: CameraExposure;
  temperature?: number;
  tint?: number;
  colorLut?: CameraPod['colorLut'];
  colorLutStrength?: number;
}

/**
 * Build a CameraPod base from Camera.fields defaults (per-field SSOT).
 * Fields without a default (fov / aspect) are left
 * unset; caller fills them from opts or sentinel values.
 */
function cameraPodFromDefaults(): CameraPod {
  const base: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(Camera.fields)) {
    if ('default' in field && field.default !== undefined) {
      base[key] = field.default;
    }
  }
  return base as CameraPod;
}

/**
 * Convenience factory: perspective CameraData POD.
 *
 * `fov` and `aspect` are required (no sensible universal default).
 * `near` defaults to 0.1, `far` defaults to 2000.
 * Orthographic quartet defaults to [-1, 1]x[-1, 1]; tonemap defaults to
 * TONEMAP_NONE (0-overhead path).
 *
 * When `autoAspect` is `true` (the default once shipped in M3), the
 * aspect-sync sidecar on the `createApp(canvas)` path automatically writes
 * `canvas.width / canvas.height` into `Camera.aspect` every frame. Set
 * `autoAspect = false` to opt out (render-to-texture, split-screen).
 * Cameras on the `createRenderer` path do not receive aspect-sync.
 *
 * @see {@link https://github.com/ForgeaX-Games/forgeax-engine/blob/main/docs/how-to/2026-06-18-host-engine-contract.md | Host-engine contract SSOT}
 *
 * @example
 * ```ts
 * import { Camera, perspective } from '@forgeax/engine-render';
 * world.spawn(
 *   { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 4 / 3 }) }
 * ).unwrap();
 * ```
 *
 * @example With explicit near/far:
 * ```ts
 * const camData = perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.01, far: 1000 });
 * world.spawn({ component: Camera, data: camData }).unwrap();
 * ```
 *
 * @example With non-default clear color (default is `[0, 0, 0, 0]`).
 * `clearColor` is an inline `array<f32,4>` field on `Camera`; spread the
 * factory then override:
 * ```ts
 * world.spawn({
 *   component: Camera,
 *   data: { ...perspective({ fov: Math.PI / 3, aspect: 4 / 3 }), clearColor: [0, 1, 0, 1] },
 * }).unwrap();
 * ```
 */
export function perspective(opts: CameraPerspectiveOpts): CameraPod {
  return {
    // cameraPodFromDefaults() reads autoAspect's schema default (true), so an
    // omitted opts.autoAspect lands the default-correct value; an explicit
    // false overrides it below (D-4: factory one-step opt-out, charter P1).
    ...cameraPodFromDefaults(),
    fov: opts.fov,
    aspect: opts.aspect,
    ...(opts.near === undefined ? {} : { near: opts.near }),
    ...(opts.far === undefined ? {} : { far: opts.far }),
    projection: CAMERA_PROJECTION_PERSPECTIVE,
    ...(opts.autoAspect !== undefined ? { autoAspect: opts.autoAspect } : {}),
    ...(opts.projectionOffset === undefined
      ? {}
      : {
          projectionOffset: new Float32Array(validateCameraProjectionOffset(opts.projectionOffset)),
        }),
    ...cameraColorGradingColumns(opts),
  };
}

/**
 * Convenience factory: orthographic CameraData POD.
 *
 * All four ortho bounds (`left` / `right` / `bottom` / `top`) are required.
 * `near` defaults to 0.1, `far` defaults to 2000.
 * Perspective fields get sentinel defaults (fov=0, aspect=1) for column
 * alignment with the 12-field schema.
 *
 * @example
 * ```ts
 * import { Camera, orthographic } from '@forgeax/engine-render';
 * world.spawn(
 *   { component: Camera, data: orthographic({
 *     left: -10, right: 10, bottom: -10, top: 10,
 *   }) }
 * ).unwrap();
 * ```
 *
 * @example Screen-aligned orthographic for pixel-unit rendering:
 * ```ts
 * const camData = orthographic({ left: 0, right: 800, bottom: 600, top: 0 });
 * world.spawn({ component: Camera, data: camData }).unwrap();
 * ```
 */
export function orthographic(opts: CameraOrthographicOpts): CameraPod {
  return {
    ...cameraPodFromDefaults(),
    fov: 0,
    aspect: 1,
    ...(opts.near === undefined ? {} : { near: opts.near }),
    ...(opts.far === undefined ? {} : { far: opts.far }),
    projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
    left: opts.left,
    right: opts.right,
    bottom: opts.bottom,
    top: opts.top,
    ...(opts.projectionOffset === undefined
      ? {}
      : {
          projectionOffset: new Float32Array(validateCameraProjectionOffset(opts.projectionOffset)),
        }),
    ...cameraColorGradingColumns(opts),
  };
}
