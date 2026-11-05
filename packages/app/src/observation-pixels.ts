import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { pickTriangleDisplay, type TriangleHit } from '@forgeax/engine-picking';
import {
  type BarrelDistortionMapping,
  freezeBarrelDistortionMapping,
  MeshFilter,
  MeshRenderer,
  mapDisplayToScene,
} from '@forgeax/engine-render';
import { ChildOf, Name } from '@forgeax/engine-scene';
import type {
  ExecutionHdrFrameObservation,
  ExecutionHdrObservationResult,
} from './execution/types';

// observation-pixels.ts -- HDR luminance and pixel provenance for the live
// observation surface. Both queries read the Renderer's armed `linear-hdr`
// copy: pre-exposure, pre-tonemap scene-linear Rec.709 colour, which is the
// exact domain the bloom high pass thresholds.

/** Rec.709 luminance weights used by the bloom high pass. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
const HALF_FLOAT_MAX = 65504;

/** EV code layout: 0 is non-positive luminance; 1..255 are 1/8-stop bins from EV_MIN. */
export const LUMINANCE_EV_MIN = -16;
export const LUMINANCE_EV_STEPS_PER_STOP = 8;
export const LUMINANCE_EV_MAX = LUMINANCE_EV_MIN + (255 - 1) / LUMINANCE_EV_STEPS_PER_STOP;

/** Bloom high-pass class of one pixel. */
export const BLOOM_CLASS_BELOW = 0;
export const BLOOM_CLASS_KNEE = 1;
export const BLOOM_CLASS_ABOVE = 2;
export type BloomClassName = 'below' | 'knee' | 'above';
const BLOOM_CLASS_NAMES: readonly BloomClassName[] = ['below', 'knee', 'above'];

export interface BloomSettings {
  readonly enabled: boolean;
  /** Scene-linear Rec.709 luminance threshold. */
  readonly threshold: number;
  /** Absolute luminance interval above the threshold (smoothstep knee). */
  readonly smoothWidth: number;
  readonly intensity: number;
}

let halfTable: Float32Array | undefined;

/** IEEE 754 binary16 to binary32, table-driven for whole-frame decoding. */
export function halfToFloat(bits: number): number {
  if (halfTable === undefined) {
    halfTable = new Float32Array(65536);
    for (let value = 0; value < 65536; value += 1) halfTable[value] = decodeHalf(value);
  }
  return halfTable[bits & 0xffff] as number;
}

function decodeHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Decoded scene-linear RGB of one HDR frame, row-major without padding. */
export interface HdrRgbFrame {
  readonly width: number;
  readonly height: number;
  readonly rgb: Float32Array;
}

/** Decode a padded `rgba16float` or `rgba32float` readback into dense RGB. */
export function decodeHdrFrame(frame: ExecutionHdrFrameObservation): HdrRgbFrame {
  const { width, height, bytesPerRow, format, bytes } = frame;
  const half = format === 'rgba16float';
  if (!half && format !== 'rgba32float')
    throw new Error(`live-hdr-format-unsupported: linear-hdr format ${String(format)}`);
  const texelBytes = half ? 8 : 16;
  if (
    bytesPerRow < width * texelBytes ||
    bytes.byteLength < bytesPerRow * (height - 1) + width * texelBytes
  )
    throw new Error('live-hdr-layout-invalid: readback is smaller than its declared extent');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * bytesPerRow + x * texelBytes;
      const target = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[target + channel] = half
          ? halfToFloat(view.getUint16(source + channel * 2, true))
          : view.getFloat32(source + channel * 4, true);
      }
    }
  }
  return { width, height, rgb };
}

/** Scene-linear luminance exactly as the bloom high pass computes it. */
export function rec709Luminance(r: number, g: number, b: number): number {
  const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  return Number.isFinite(luma) ? Math.min(luma, HALF_FLOAT_MAX) : luma > 0 ? HALF_FLOAT_MAX : 0;
}

/** EV code: 0 for non-positive luminance, otherwise a clamped 1/8-stop bin. */
export function luminanceEvCode(luminance: number): number {
  if (!(luminance > 0)) return 0;
  const steps = Math.round((Math.log2(luminance) - LUMINANCE_EV_MIN) * LUMINANCE_EV_STEPS_PER_STOP);
  return Math.max(1, Math.min(255, steps + 1));
}

/** Inverse of {@link luminanceEvCode}; code 0 maps to `null` (no light). */
export function evFromCode(code: number): number | null {
  return code === 0 ? null : LUMINANCE_EV_MIN + (code - 1) / LUMINANCE_EV_STEPS_PER_STOP;
}

/**
 * Bloom high-pass class mirroring `bloom-horizontal.wgsl`: zero width is a
 * strict step above the threshold; otherwise smoothstep(threshold,
 * threshold + smoothWidth) has a partial knee and a full-weight region.
 */
export function bloomClass(
  luminance: number,
  bloom: Pick<BloomSettings, 'threshold' | 'smoothWidth'>,
): number {
  if (bloom.smoothWidth === 0)
    return luminance > bloom.threshold ? BLOOM_CLASS_ABOVE : BLOOM_CLASS_BELOW;
  if (luminance <= bloom.threshold) return BLOOM_CLASS_BELOW;
  return luminance >= bloom.threshold + bloom.smoothWidth ? BLOOM_CLASS_ABOVE : BLOOM_CLASS_KNEE;
}

/** The smooth high-pass weight applied to the pixel colour, in [0, 1]. */
export function bloomWeight(
  luminance: number,
  bloom: Pick<BloomSettings, 'threshold' | 'smoothWidth'>,
): number {
  if (bloom.smoothWidth === 0) return luminance > bloom.threshold ? 1 : 0;
  const t = Math.min(1, Math.max(0, (luminance - bloom.threshold) / bloom.smoothWidth));
  return t * t * (3 - 2 * t);
}

export interface LuminanceStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly counts: Readonly<Record<BloomClassName, number>>;
  /** Fraction of pixels that contribute to bloom (knee or above). */
  readonly bloomFraction: number;
}

export interface LuminancePlanes {
  readonly evCode: Uint8Array;
  readonly bloomClass: Uint8Array;
  readonly stats: LuminanceStats;
}

/** Classify every pixel of a decoded frame into EV codes and bloom classes. */
export function classifyLuminance(frame: HdrRgbFrame, bloom: BloomSettings): LuminancePlanes {
  const count = frame.width * frame.height;
  const evCode = new Uint8Array(count);
  const classes = new Uint8Array(count);
  const counts = [0, 0, 0];
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const base = index * 3;
    const luma = rec709Luminance(
      frame.rgb[base] as number,
      frame.rgb[base + 1] as number,
      frame.rgb[base + 2] as number,
    );
    const cls = bloomClass(luma, bloom);
    evCode[index] = luminanceEvCode(luma);
    classes[index] = cls;
    counts[cls] = (counts[cls] as number) + 1;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    sum += luma;
  }
  const [below = 0, knee = 0, above = 0] = counts;
  return {
    evCode,
    bloomClass: classes,
    stats: {
      min: count === 0 ? 0 : min,
      max,
      mean: count === 0 ? 0 : sum / count,
      counts: { below, knee, above },
      bloomFraction: count === 0 ? 0 : (knee + above) / count,
    },
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

/** Read the bloom fields of a Camera row into closed settings. */
export function bloomSettingsFromCamera(camera: Record<string, unknown>): BloomSettings {
  const number = (key: string, fallback: number): number => {
    const value = camera[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  return {
    enabled: number('bloom', 0) !== 0,
    threshold: number('bloomThreshold', 1),
    smoothWidth: number('bloomSmoothWidth', 0.01),
    intensity: number('bloomIntensity', 0.5),
  };
}

/** Minimal asset owner used to name runtime handles; the AssetRegistry satisfies it. */
export interface PixelAssetNames {
  guidOf(handle: number): string | undefined;
  catalogEntry(guid: string): { readonly name?: string; readonly sourcePath?: string } | undefined;
  read(handle: never): { readonly ok: boolean; readonly value?: unknown };
}

export interface PixelObservationDeps {
  readonly world: World;
  readonly observeNextHdrFrame?: (options?: {
    readonly signal?: AbortSignal;
  }) => Promise<ExecutionHdrObservationResult>;
  readonly assets?: PixelAssetNames;
  /** Active camera row (JSON) whose bloom fields classify the frame. */
  readonly camera: () => Record<string, unknown> | undefined;
}

async function nextFrame(deps: PixelObservationDeps): Promise<ExecutionHdrFrameObservation> {
  if (deps.observeNextHdrFrame === undefined)
    throw new Error('live-hdr-unavailable: this App has no Renderer HDR observation');
  const result = await deps.observeNextHdrFrame();
  if (!result.ok) {
    const { code, message } = result.error as { code: string; message?: string };
    throw new Error(`live-hdr-${code}: ${message ?? 'linear-hdr observation failed'}`);
  }
  return result.value;
}

function bloomOf(deps: PixelObservationDeps): BloomSettings {
  return bloomSettingsFromCamera(deps.camera() ?? {});
}

/** One-frame luminance heat-map payload; planes are base64 row-major bytes. */
export interface LuminanceObservation {
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly domain: 'linear-hdr';
  readonly bloom: BloomSettings;
  readonly encoding: {
    readonly evMin: number;
    readonly evMax: number;
    readonly stepsPerStop: number;
    readonly evCode: string;
    readonly bloomClass: string;
  };
  readonly stats: LuminanceStats;
  readonly planes: { readonly evCode: string; readonly bloomClass: string };
}

export async function observeLuminance(deps: PixelObservationDeps): Promise<LuminanceObservation> {
  const frame = await nextFrame(deps);
  const bloom = bloomOf(deps);
  const planes = classifyLuminance(decodeHdrFrame(frame), bloom);
  return {
    frameId: frame.frameId,
    width: frame.width,
    height: frame.height,
    domain: 'linear-hdr',
    bloom,
    encoding: {
      evMin: LUMINANCE_EV_MIN,
      evMax: LUMINANCE_EV_MAX,
      stepsPerStop: LUMINANCE_EV_STEPS_PER_STOP,
      evCode: '0 = no light; n >= 1 => EV = evMin + (n - 1) / stepsPerStop, EV = log2(luminance)',
      bloomClass:
        '0 = below threshold, 1 = knee (threshold, threshold + smoothWidth), 2 = full bloom',
    },
    stats: planes.stats,
    planes: { evCode: base64(planes.evCode), bloomClass: base64(planes.bloomClass) },
  };
}

/** HDR sample at one HDR texel. */
export interface PixelHdrSample {
  readonly texel: readonly [number, number];
  readonly rgb: readonly [number, number, number];
  readonly luminance: number;
  readonly ev: number | null;
  readonly bloomClass: BloomClassName;
  readonly bloomWeight: number;
}

function sampleHdr(
  frame: ExecutionHdrFrameObservation,
  texelX: number,
  texelY: number,
  bloom: BloomSettings,
): PixelHdrSample {
  const one: ExecutionHdrFrameObservation = {
    ...frame,
    width: 1,
    height: 1,
    bytesPerRow: frame.bytesPerRow,
    bytes: frame.bytes.subarray(
      texelY * frame.bytesPerRow + texelX * (frame.format === 'rgba16float' ? 8 : 16),
    ),
  };
  const { rgb } = decodeHdrFrame(one);
  // The relay only carries finite JSON numbers; half-float Inf/NaN saturate.
  const color = [finiteHalf(rgb[0]), finiteHalf(rgb[1]), finiteHalf(rgb[2])] as const;
  const luminance = rec709Luminance(...color);
  const cls = bloomClass(luminance, bloom);
  return {
    texel: [texelX, texelY],
    rgb: color,
    luminance,
    ev: luminance > 0 ? Math.log2(luminance) : null,
    bloomClass: BLOOM_CLASS_NAMES[cls] as BloomClassName,
    bloomWeight: bloomWeight(luminance, bloom),
  };
}

function finiteHalf(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(-HALF_FLOAT_MAX, Math.min(HALF_FLOAT_MAX, value));
}

function entityName(world: World, entity: EntityHandle): string | undefined {
  const name = world.get(entity, Name);
  return name.ok ? name.value.value : undefined;
}

function parentOf(world: World, entity: EntityHandle): EntityHandle | undefined {
  const parent = world.get(entity, ChildOf);
  return parent.ok ? (parent.value.parent as EntityHandle) : undefined;
}

/** Root-first Name chain; glTF sub-scene meshes are reported with their owning hierarchy. */
function entityPath(world: World, entity: EntityHandle): string[] {
  const path: string[] = [];
  const seen = new Set<EntityHandle>();
  let current: EntityHandle | undefined = entity;
  while (current !== undefined && !seen.has(current) && path.length < 64) {
    seen.add(current);
    path.unshift(entityName(world, current) ?? `#${current}`);
    current = parentOf(world, current);
  }
  return path;
}

function describeAsset(assets: PixelAssetNames | undefined, guid: string | undefined) {
  const entry = guid === undefined ? undefined : assets?.catalogEntry(guid);
  return {
    ...(guid === undefined ? {} : { guid }),
    ...(entry?.name === undefined ? {} : { name: entry.name }),
    ...(entry?.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
  };
}

interface MeshSlotView {
  readonly submeshes?: readonly { readonly materialSlot?: number }[];
  readonly materialSlots?: readonly {
    readonly slotName?: string;
    readonly defaultMaterial?: number | Uint8Array;
  }[];
}

function readAsset<T>(assets: PixelAssetNames | undefined, handle: number): T | undefined {
  const value = assets?.read(handle as never);
  return value?.ok ? (value.value as T) : undefined;
}

/** Emissive-related authored values, the knobs that move a pixel across the bloom threshold. */
function emissiveValues(material: unknown): Record<string, unknown> | undefined {
  const values = (material as { values?: Record<string, unknown> } | undefined)?.values;
  if (values === undefined || values === null) return undefined;
  const picked = Object.entries(values).filter(([key]) => /emiss|intensity|exposure/i.test(key));
  if (picked.length === 0) return undefined;
  return Object.fromEntries(
    picked.map(([key, value]) => [
      key,
      ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value,
    ]),
  );
}

function materialAt(deps: PixelObservationDeps, hit: TriangleHit, mesh: MeshSlotView | undefined) {
  const slot = mesh?.submeshes?.[hit.submeshIndex]?.materialSlot ?? hit.submeshIndex;
  const slotRow = mesh?.materialSlots?.[slot];
  const renderer = deps.world.get(hit.entity, MeshRenderer);
  const override = renderer.ok ? (renderer.value.materials[slot] ?? 0) : 0;
  const declared = slotRow?.defaultMaterial;
  const handle = override !== 0 ? override : typeof declared === 'number' ? declared : undefined;
  const source =
    override !== 0
      ? 'renderer-override'
      : declared !== undefined
        ? 'mesh-default'
        : 'engine-default';
  const guid =
    handle !== undefined
      ? deps.assets?.guidOf(handle)
      : declared instanceof Uint8Array
        ? AssetGuid.format(declared as never)
        : undefined;
  const values = handle === undefined ? undefined : emissiveValues(readAsset(deps.assets, handle));
  return {
    slot,
    ...(slotRow?.slotName === undefined ? {} : { slotName: slotRow.slotName }),
    source,
    ...(handle === undefined ? {} : { handle }),
    ...describeAsset(deps.assets, guid),
    ...(values === undefined ? {} : { emissive: values }),
  };
}

function describeHit(deps: PixelObservationDeps, hit: TriangleHit) {
  const filter = deps.world.get(hit.entity, MeshFilter);
  const meshHandle =
    (hit.assetHandle as number | undefined) ??
    (filter.ok ? (filter.value.assetHandle as number) : undefined);
  const mesh =
    meshHandle === undefined ? undefined : readAsset<MeshSlotView>(deps.assets, meshHandle);
  const name = entityName(deps.world, hit.entity);
  return {
    entity: {
      id: hit.entity,
      ...(name === undefined ? {} : { name }),
      path: entityPath(deps.world, hit.entity),
    },
    ...(hit.instanceIndex === undefined ? {} : { instanceIndex: hit.instanceIndex }),
    triangleIndex: hit.triangleIndex,
    submeshIndex: hit.submeshIndex,
    point: Array.from(hit.point as ArrayLike<number>),
    distance: hit.distance,
    mesh: {
      ...(meshHandle === undefined ? {} : { handle: meshHandle }),
      ...describeAsset(
        deps.assets,
        meshHandle === undefined ? undefined : deps.assets?.guidOf(meshHandle),
      ),
    },
    material: materialAt(deps, hit, mesh),
  };
}

export interface PixelPickRequest {
  /** Display pixel column in the presented frame (0 = left). */
  readonly x: number;
  /** Display pixel row in the presented frame (0 = top). */
  readonly y: number;
}

function validatePickRequest(value: unknown): PixelPickRequest {
  const candidate = value as Partial<PixelPickRequest> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.x !== 'number' ||
    typeof candidate.y !== 'number' ||
    !Number.isFinite(candidate.x) ||
    !Number.isFinite(candidate.y)
  )
    throw new TypeError('pick expects { x: number, y: number } display pixel coordinates');
  return { x: candidate.x, y: candidate.y };
}

function displayMapping(frame: ExecutionHdrFrameObservation): BarrelDistortionMapping {
  if (frame.barrelDistortion?.camera === undefined)
    throw new Error('live-pick-unavailable: the observed frame carries no display camera mapping');
  return freezeBarrelDistortionMapping(frame.barrelDistortion);
}

/**
 * Pick the surface visible at one display pixel and report its entity, mesh,
 * material slot and the HDR value the Renderer wrote there. The sample point
 * is the pixel centre; HDR texels are resolved through the same display ->
 * scene mapping as the pick ray, so distortion and render scale agree.
 */
export async function pickPixel(deps: PixelObservationDeps, value: unknown) {
  const request = validatePickRequest(value);
  const frame = await nextFrame(deps);
  const mapping = displayMapping(frame);
  const px = Math.floor(request.x) + 0.5;
  const py = Math.floor(request.y) + 0.5;
  if (px > mapping.width || py > mapping.height || px < 0 || py < 0)
    throw new RangeError(`pick expects 0 <= x < ${mapping.width} and 0 <= y < ${mapping.height}`);
  const scene = { x: 0, y: 0 };
  const inside = mapDisplayToScene(scene, mapping, px, py);
  const header = {
    frameId: frame.frameId,
    display: {
      x: Math.floor(request.x),
      y: Math.floor(request.y),
      width: mapping.width,
      height: mapping.height,
    },
  };
  const bloom = bloomOf(deps);
  const hdr = inside
    ? sampleHdr(
        frame,
        Math.min(frame.width - 1, Math.floor((scene.x / mapping.width) * frame.width)),
        Math.min(frame.height - 1, Math.floor((scene.y / mapping.height) * frame.height)),
        bloom,
      )
    : undefined;
  const result = pickTriangleDisplay(deps.world, px, py, mapping, mapping.width, mapping.height);
  const shared = { ...header, ...(hdr === undefined ? {} : { hdr }), bloom };
  if (result.status === 'unavailable')
    return {
      status: 'unavailable' as const,
      reason: result.reason,
      entities: [...result.entities],
      ...shared,
    };
  if (result.status === 'miss') return { status: 'miss' as const, ...shared };
  return { status: 'hit' as const, ...shared, ...describeHit(deps, result.hit) };
}
