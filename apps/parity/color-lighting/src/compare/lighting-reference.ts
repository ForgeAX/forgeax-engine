import type { IesProfileAsset, TextureAsset } from '@forgeax/engine-types';
import {
  ACESFilmicToneMapping,
  Color,
  DataTexture,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  LightProbe,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RectAreaLight,
  RGBAFormat,
  Scene,
  SpotLight,
  SRGBColorSpace,
  SphereGeometry,
  UnsignedByteType,
  WebGLRenderer,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { evaluateProbeReference, type ProbeReferenceResult } from './probe-reference';

export const LIGHTING_REFERENCE_WIDTH = 760;
export const LIGHTING_REFERENCE_HEIGHT = 540;
export const LIGHTING_REFERENCE_REVISION = 'r184';
export const COOKIE_SOURCE_WIDTH = 280;
export const COOKIE_SOURCE_HEIGHT = 200;
const COOKIE_PRODUCT_SIZE = 256;
const COOKIE_REFERENCE_SIZE = 1024;
const IES_REFERENCE_MAP_WIDTH = 1024;
export type CookieAssetVariant = 'quadrants' | 'opaque-white';

export type LightingReferenceMode = 'rect' | 'ies' | 'cookie' | 'probe';
export type LightingReferenceKind =
  | 'three-r184-native-webgl2-rect-area-plus-finite-range-adapter'
  | 'three-r184-native-webgpu-ies-rotational-symmetric-plus-type-c-analytic'
  | 'three-r184-native-webgl2-spot-cookie-plus-rgba-analytic'
  | 'three-r184-lightprobe-sh9-not-native-local-volume'
  | 'three-r184-native-webgpu-spot-ies-cookie-shadow-combined'
  | 'three-r184-native-webgpu-recovery-lighting-baseline';

export interface LightingSceneManifest {
  readonly schemaVersion: 'lighting-demo-scene-v1';
  readonly sceneId: 'extended-lighting-shared-scene';
  readonly camera: {
    readonly projection: 'perspective';
    readonly fovDeg: 42;
    readonly aspect: number;
    readonly near: 0.1;
    readonly far: 100;
    /** The product's default Camera path is explicitly no-AA. */
    readonly antialias: 'none';
    readonly position: readonly [0, 0.15, 8.7];
    /** ForgeaX camera forward is -Z; identity matches the authored Transform. */
    readonly rotation: readonly [0, 0, 0, 1];
    readonly clearColor: readonly [0.006, 0.009, 0.015, 1];
  };
  readonly geometry: {
    readonly receiverPlane: readonly [10.5, 5.9, 20, 12];
    readonly glossySpheres: readonly { readonly position: readonly [number, number, number]; readonly radius: 0.56 }[];
    readonly probeRow: { readonly startX: -4; readonly step: 1; readonly count: 9; readonly radius: 0.58 };
  };
  readonly materials: {
    /** Authored material RGB values use the same default as Materials.*. */
    readonly colorSpace: 'srgb';
    readonly receiver: { readonly baseColor: readonly [0.54, 0.58, 0.65, 1]; readonly metallic: 0.03; readonly roughness: 0.78 };
    readonly glossy: { readonly baseColor: readonly [0.72, 0.74, 0.78, 1]; readonly metallic: 0.72; readonly roughness: 0.2 };
    readonly probe: { readonly baseColor: readonly [1, 1, 1, 1]; readonly metallic: 0; readonly roughness: 0.92 };
  };
  readonly lighting: {
    readonly rect: {
      readonly emitterPosition: readonly [number, number, number];
      readonly emitterSize: readonly [number, number];
      readonly position: readonly [number, number, number];
      readonly color: readonly [number, number, number];
      readonly intensity: number;
      readonly width: number;
      readonly height: number;
      readonly range: number;
    };
    readonly spot: {
      readonly position: readonly [number, number, number];
      readonly direction: readonly [number, number, number];
      readonly iesColor: readonly [number, number, number];
      readonly cookieColor: readonly [number, number, number];
      readonly intensity: number;
      readonly range: number;
      readonly innerConeDeg: number;
      readonly outerConeDeg: number;
      readonly rollDeg: number;
    };
    readonly skylight: {
      readonly probe: { readonly color: readonly [number, number, number]; readonly intensity: number };
      readonly direct: { readonly color: readonly [number, number, number]; readonly intensity: number };
      readonly recovery: { readonly color: readonly [number, number, number]; readonly intensity: number };
    };
  };
  readonly exposure: { readonly toneMapping: 'ACESFilmic'; readonly value: 1.15; readonly outputColorSpace: 'sRGB' };
  readonly sourceAssets: {
    readonly iesProfileSha256: string;
    readonly iesProfileVariant: 'type-c-asymmetric-standalone' | 'rotationally-symmetric-compare';
    readonly cookieTextureSha256: string;
  };
  readonly referenceKind: LightingReferenceKind;
  readonly three: { readonly revision: 'r184'; readonly backend: 'webgpu' | 'webgl2' | 'none' };
  readonly adapterProvenance: readonly ReferenceAdapterProvenance[];
  readonly exactProductHead: string;
}

export interface ReferenceAdapterProvenance {
  readonly adapterId: string;
  readonly implementation: 'three-native' | 'analytic-reference';
  readonly backend: 'webgpu' | 'webgl2' | 'cpu';
  readonly source: string;
  readonly independentOfForgeaxKernel: boolean;
  readonly semanticScope: string;
}

export interface IesReferenceSample {
  readonly polarDeg: number;
  readonly azimuthDeg: number;
  readonly rollDeg: number;
  readonly typeC: number;
  readonly nativeThreeSymmetric: number;
}

export interface CookieReferenceSample {
  readonly point: readonly [number, number, number];
  readonly visible: boolean;
  readonly uv: readonly [number, number] | null;
  readonly rgba: readonly [number, number, number, number];
  readonly reason: 'projected' | 'backface' | 'outside-cone';
}

export interface LightingReferenceEvidence {
  readonly referenceKind: LightingReferenceKind;
  readonly adapters: readonly ReferenceAdapterProvenance[];
  readonly falsifiers: readonly string[];
  readonly ies?: {
    readonly samples: readonly IesReferenceSample[];
    readonly nativePath: 'three-r184-IESSpotLight-1d';
    readonly profileVariant: 'type-c-asymmetric-standalone' | 'rotationally-symmetric-compare';
  };
  readonly cookie?: { readonly samples: readonly CookieReferenceSample[]; readonly nativePath: 'three-r184-WebGL2-SpotLight-map' | 'three-r184-WebGPU-SpotLight-map' };
  readonly probe?: {
    readonly objects: readonly ProbeReferenceResult[];
    readonly nativePath: 'three-r184-LightProbe-SH9';
    readonly localVolumeSupport: 'not-native';
  };
}

export interface ReferenceRenderReceipt {
  readonly backend: 'webgpu' | 'webgl2';
  readonly referenceKind: LightingReferenceKind;
  readonly rendered: true;
}

const TYPE_C_PROFILE = { polarExponent: 1.6, azimuthalLobes: 3, lobeExponent: 14, minimum: 0.06 } as const;
const IES_PROFILE_WIDTH = 256;
const IES_PROFILE_HEIGHT = 128;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function floatToHalf(value: number): number {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | (mantissa >>> 13);
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >>> 10) & 0x1f;
  const mantissa = value & 0x3ff;
  if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function sampleIesRadialProfile(profileView: DataView, normalizedElevation: number): number {
  const coordinate = clamp(normalizedElevation, 0, 1) * IES_PROFILE_HEIGHT - 0.5;
  const lower = clamp(Math.floor(coordinate), 0, IES_PROFILE_HEIGHT - 1);
  const upper = clamp(lower + 1, 0, IES_PROFILE_HEIGHT - 1);
  const fraction = clamp(coordinate - lower, 0, 1);
  const lowerValue = halfToFloat(profileView.getUint16(lower * IES_PROFILE_WIDTH * 2, true));
  const upperValue = halfToFloat(profileView.getUint16(upper * IES_PROFILE_WIDTH * 2, true));
  return lowerValue * (1 - fraction) + upperValue * fraction;
}

export function evaluateRotationallySymmetricIes(polarDeg: number): number {
  const polar = clamp(polarDeg / 180, 0, 1);
  return Math.max(0, 1 - polar ** TYPE_C_PROFILE.polarExponent);
}

export function createIesProfileAsset(): IesProfileAsset {
  const data = new Uint8Array(IES_PROFILE_WIDTH * IES_PROFILE_HEIGHT * 2);
  const view = new DataView(data.buffer);
  for (let y = 0; y < IES_PROFILE_HEIGHT; y += 1) {
    const radial = evaluateRotationallySymmetricIes((y / (IES_PROFILE_HEIGHT - 1)) * 180);
    for (let x = 0; x < IES_PROFILE_WIDTH; x += 1) {
      const azimuth = (x / IES_PROFILE_WIDTH) * Math.PI * 2;
      const lobes = TYPE_C_PROFILE.minimum + (1 - TYPE_C_PROFILE.minimum) * Math.abs(Math.cos(azimuth * TYPE_C_PROFILE.azimuthalLobes)) ** TYPE_C_PROFILE.lobeExponent;
      view.setUint16((y * IES_PROFILE_WIDTH + x) * 2, floatToHalf(radial * lobes), true);
    }
  }
  return { kind: 'ies-profile', data };
}

export function createSymmetricIesProfileAsset(): IesProfileAsset {
  const data = new Uint8Array(IES_PROFILE_WIDTH * IES_PROFILE_HEIGHT * 2);
  const view = new DataView(data.buffer);
  for (let y = 0; y < IES_PROFILE_HEIGHT; y += 1) {
    const half = floatToHalf(evaluateRotationallySymmetricIes((y / (IES_PROFILE_HEIGHT - 1)) * 180));
    for (let x = 0; x < IES_PROFILE_WIDTH; x += 1) view.setUint16((y * IES_PROFILE_WIDTH + x) * 2, half, true);
  }
  return { kind: 'ies-profile', data };
}

export function evaluateTypeCReference(polarDeg: number, azimuthDeg: number, rollDeg: number): number {
  const azimuth = ((azimuthDeg - rollDeg) * Math.PI) / 180;
  const radial = evaluateRotationallySymmetricIes(polarDeg);
  const lobes = TYPE_C_PROFILE.minimum + (1 - TYPE_C_PROFILE.minimum) * Math.abs(Math.cos(azimuth * TYPE_C_PROFILE.azimuthalLobes)) ** TYPE_C_PROFILE.lobeExponent;
  return radial * lobes;
}

function evaluateNativeThreeSymmetric(polarDeg: number): number {
  return evaluateRotationallySymmetricIes(polarDeg);
}

function cookieRgbaAtUv(u: number, v: number): [number, number, number, number] {
  if (u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0, 0];
  if (u < 0.5 && v < 0.5) return [1, 0.12, 0.06, 0.85];
  if (u >= 0.5 && v < 0.5) return [0.1, 1, 0.12, 0.55];
  if (u < 0.5) return [0.1, 0.2, 1, 0.35];
  return [1, 0.75, 0.05, 1];
}

export function createCookieAsset(variant: CookieAssetVariant = 'quadrants'): TextureAsset {
  const data = new Uint8Array(COOKIE_SOURCE_WIDTH * COOKIE_SOURCE_HEIGHT * 4);
  for (let y = 0; y < COOKIE_SOURCE_HEIGHT; y += 1) {
    for (let x = 0; x < COOKIE_SOURCE_WIDTH; x += 1) {
      const rgba = variant === 'opaque-white'
        ? ([1, 1, 1, 1] as const)
        : cookieRgbaAtUv(
            (x + 0.5) / COOKIE_SOURCE_WIDTH,
            (y + 0.5) / COOKIE_SOURCE_HEIGHT,
          );
      const offset = (y * COOKIE_SOURCE_WIDTH + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) data[offset + channel] = Math.round((rgba[channel] ?? 0) * 255);
    }
  }
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: COOKIE_SOURCE_WIDTH, height: COOKIE_SOURCE_HEIGHT },
    },
    format: 'rgba8unorm',
    data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

function rotateBasis(rollDeg: number): { right: readonly [number, number, number]; up: readonly [number, number, number] } {
  const roll = (rollDeg * Math.PI) / 180;
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  return { right: [cosine, sine, 0], up: [-sine, cosine, 0] };
}

export function evaluateCookieReference(input: {
  readonly point: readonly [number, number, number];
  readonly lightPosition?: readonly [number, number, number];
  readonly outerConeDeg?: number;
  readonly aspect?: number;
  readonly rollDeg?: number;
}): CookieReferenceSample {
  const lightPosition = input.lightPosition ?? [0, 0, 3.2];
  const point = [input.point[0] - lightPosition[0], input.point[1] - lightPosition[1], input.point[2] - lightPosition[2]] as const;
  const depth = -point[2];
  if (depth <= 0) return { point: input.point, visible: false, uv: null, rgba: [0, 0, 0, 0], reason: 'backface' };
  const cone = Math.tan(((input.outerConeDeg ?? 57) * Math.PI) / 360);
  const aspect = input.aspect ?? 1;
  const basis = rotateBasis(input.rollDeg ?? 0);
  const projectedX = (point[0] * basis.right[0] + point[1] * basis.right[1]) / (depth * cone * aspect);
  const projectedY = (point[0] * basis.up[0] + point[1] * basis.up[1]) / (depth * cone);
  if (Math.abs(projectedX) > 1 || Math.abs(projectedY) > 1) return { point: input.point, visible: false, uv: null, rgba: [0, 0, 0, 0], reason: 'outside-cone' };
  const uv: [number, number] = [projectedX * 0.5 + 0.5, projectedY * 0.5 + 0.5];
  return { point: input.point, visible: true, uv, rgba: cookieRgbaAtUv(uv[0], uv[1]), reason: 'projected' };
}

async function sha256Hex(bytes: ArrayLike<number>): Promise<string> {
  const input = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function createLightingSceneManifest(
  mode: LightingReferenceMode,
  productHead: string,
  compare = false,
  cookieVariant: CookieAssetVariant = 'quadrants',
): Promise<{ readonly manifest: LightingSceneManifest; readonly ies: IesProfileAsset; readonly cookie: TextureAsset }> {
  const useSymmetricCompareProfile = mode === 'ies' && compare;
  const ies = useSymmetricCompareProfile ? createSymmetricIesProfileAsset() : createIesProfileAsset();
  const cookie = createCookieAsset(cookieVariant);
  const referenceKind = mode === 'ies'
    ? 'three-r184-native-webgpu-ies-rotational-symmetric-plus-type-c-analytic'
    : mode === 'cookie'
      ? 'three-r184-native-webgl2-spot-cookie-plus-rgba-analytic'
      : mode === 'probe'
        ? 'three-r184-lightprobe-sh9-not-native-local-volume'
        : 'three-r184-native-webgl2-rect-area-plus-finite-range-adapter';
  const adapterProvenance = referenceAdapters(mode);
  return {
    ies,
    cookie,
    manifest: {
      schemaVersion: 'lighting-demo-scene-v1',
      sceneId: 'extended-lighting-shared-scene',
      camera: { projection: 'perspective', fovDeg: 42, aspect: LIGHTING_REFERENCE_WIDTH / LIGHTING_REFERENCE_HEIGHT, near: 0.1, far: 100, antialias: 'none', position: [0, 0.15, 8.7], rotation: [0, 0, 0, 1], clearColor: [0.006, 0.009, 0.015, 1] },
      geometry: {
        receiverPlane: [10.5, 5.9, 20, 12],
        glossySpheres: [{ position: [-2.2, -1.15, 0.42], radius: 0.56 }, { position: [2.2, -1.15, 0.42], radius: 0.56 }],
        probeRow: { startX: -4, step: 1, count: 9, radius: 0.58 },
      },
      materials: {
        colorSpace: 'srgb',
        receiver: { baseColor: [0.54, 0.58, 0.65, 1], metallic: 0.03, roughness: 0.78 },
        glossy: { baseColor: [0.72, 0.74, 0.78, 1], metallic: 0.72, roughness: 0.2 },
        probe: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.92 },
      },
      lighting: {
        rect: {
          emitterPosition: [0, 1.72, 1.9],
          emitterSize: [3.7, 0.28],
          position: [0, 1.72, 2],
          color: [1, 0.55, 0.2],
          intensity: 34,
          width: 3.7,
          height: 0.28,
          range: 8,
        },
        spot: {
          position: [0, 0.3, 3.2],
          direction: [0, 0, -1],
          iesColor: [1, 0.63, 0.25],
          cookieColor: [0.35, 0.72, 1],
          intensity: 92,
          range: 7,
          innerConeDeg: 6,
          outerConeDeg: 57,
          rollDeg: 8,
        },
        skylight: {
          probe: { color: [0.22, 0.28, 0.42], intensity: 0.8 },
          direct: { color: [0.035, 0.05, 0.08], intensity: 0.15 },
          recovery: { color: [0.08, 0.12, 0.22], intensity: 0.35 },
        },
      },
      exposure: { toneMapping: 'ACESFilmic', value: 1.15, outputColorSpace: 'sRGB' },
      sourceAssets: {
        iesProfileSha256: await sha256Hex(ies.data),
        iesProfileVariant: useSymmetricCompareProfile ? 'rotationally-symmetric-compare' : 'type-c-asymmetric-standalone',
        cookieTextureSha256: await sha256Hex(cookie.data),
      },
      referenceKind,
      three: { revision: 'r184', backend: mode === 'ies' ? 'webgpu' : mode === 'rect' || mode === 'cookie' || mode === 'probe' ? 'webgl2' : 'none' },
      adapterProvenance,
      exactProductHead: productHead,
    },
  };
}

function referenceAdapters(mode: LightingReferenceMode): ReferenceAdapterProvenance[] {
  if (mode === 'ies') return [
    { adapterId: 'three-r184-ies-spot-light', implementation: 'three-native', backend: 'webgpu', source: 'three/src/lights/webgpu/IESSpotLight.js', independentOfForgeaxKernel: true, semanticScope: 'rotationally symmetric 1D IES attenuation from the shared radial profile asset' },
    { adapterId: 'type-c-analytic-reference', implementation: 'analytic-reference', backend: 'cpu', source: 'parity-owned Type-C angular oracle', independentOfForgeaxKernel: true, semanticScope: 'azimuthal lobes and roll' },
  ];
  if (mode === 'cookie') return [
    { adapterId: 'three-r184-spot-light-map', implementation: 'three-native', backend: 'webgl2', source: 'three/src/lights/SpotLight.js + three/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js', independentOfForgeaxKernel: true, semanticScope: 'native RGB projection; a fixed 256² product projection is sampled and RGBA alpha is folded into a dense 1024² reference RGB because Three ignores map alpha' },
    { adapterId: 'rgba-cookie-analytic-reference', implementation: 'analytic-reference', backend: 'cpu', source: 'parity-owned RGBA projection oracle', independentOfForgeaxKernel: true, semanticScope: 'alpha, aspect, roll, cone edge, backface' },
  ];
  if (mode === 'probe') return [
    { adapterId: 'three-r184-light-probe', implementation: 'three-native', backend: 'webgl2', source: 'three/src/lights/LightProbe.js', independentOfForgeaxKernel: true, semanticScope: 'final SH9 rendering, no local-volume selection' },
    { adapterId: 'finite-volume-probe-analytic-reference', implementation: 'analytic-reference', backend: 'cpu', source: 'parity-owned finite-volume numeric oracle', independentOfForgeaxKernel: true, semanticScope: 'strict active, scaled q, Q, alpha, C, S, SH_preblend, true E_sky residual' },
  ];
  return [{ adapterId: 'three-r184-rect-area-light-plus-product-range', implementation: 'three-native', backend: 'webgl2', source: 'three/src/lights/RectAreaLight.js + parity-owned finite-range fragment adapter', independentOfForgeaxKernel: true, semanticScope: 'native LTC geometry and BRDF with the product finite-range factor applied in the independent reference shader' }];
}

export function buildLightingReferenceEvidence(mode: LightingReferenceMode, compare = false): LightingReferenceEvidence {
  const adapters = referenceAdapters(mode);
  if (mode === 'ies') {
    const sampleAngles: readonly [number, number, number][] = [
      [24, 0, 8], [24, 30, 8], [24, 60, 8], [70, 0, 8], [110, 45, 8],
    ];
    const samples = sampleAngles.map(([polarDeg, azimuthDeg, rollDeg]) => ({ polarDeg, azimuthDeg, rollDeg, typeC: evaluateTypeCReference(polarDeg, azimuthDeg, rollDeg), nativeThreeSymmetric: evaluateNativeThreeSymmetric(polarDeg) }));
    return {
      referenceKind: 'three-r184-native-webgpu-ies-rotational-symmetric-plus-type-c-analytic',
      adapters,
      falsifiers: ['ies-azimuthal-lobes', 'ies-roll', 'ies-native-1d-is-not-type-c-2d'],
      ies: {
        samples,
        nativePath: 'three-r184-IESSpotLight-1d',
        profileVariant: compare ? 'rotationally-symmetric-compare' : 'type-c-asymmetric-standalone',
      },
    };
  }
  if (mode === 'cookie') {
    const samplePoints: readonly [number, number, number][] = [
      [0, 0, 2.8], [1.1, 0, 2.8], [-1.1, 0, 2.8], [0, 0, 3.8], [0, 0, 3.2],
    ];
    const samples = samplePoints.map(([x, y, z]) => evaluateCookieReference({ point: [x, y, z], aspect: COOKIE_SOURCE_WIDTH / COOKIE_SOURCE_HEIGHT, rollDeg: 22 }));
    return { referenceKind: 'three-r184-native-webgl2-spot-cookie-plus-rgba-analytic', adapters, falsifiers: ['cookie-rgb-projection', 'cookie-alpha', 'cookie-aspect', 'cookie-roll', 'cookie-cone-edge', 'cookie-backface'], cookie: { samples, nativePath: 'three-r184-WebGL2-SpotLight-map' } };
  }
  if (mode === 'probe') {
    const probes = [
      { identity: 'probe-red', position: [-2.7, 0, 0] as const, radius: 4.2, irradiance: [18 / 0.28209479177387814, 0.12 / 0.28209479177387814, 0.04 / 0.28209479177387814, ...new Array<number>(24).fill(0)] },
      { identity: 'probe-blue', position: [2.7, 0, 0] as const, radius: 4.2, irradiance: [0.04 / 0.28209479177387814, 0.2 / 0.28209479177387814, 18 / 0.28209479177387814, ...new Array<number>(24).fill(0)] },
    ];
    const objects = Array.from({ length: 9 }, (_, index) => evaluateProbeReference({ objectKey: `probe-object-${index}`, position: [-4 + index, -0.05, 0], normal: [0, 0, 1], skyIrradiance: [0.176, 0.224, 0.336] }, probes));
    return { referenceKind: 'three-r184-lightprobe-sh9-not-native-local-volume', adapters, falsifiers: ['probe-strict-active-boundary', 'probe-scaled-q', 'probe-sky-residual', 'probe-no-full-sky-add', 'probe-no-local-volume-in-three'], probe: { objects, nativePath: 'three-r184-LightProbe-SH9', localVolumeSupport: 'not-native' } };
  }
  return { referenceKind: 'three-r184-native-webgl2-rect-area-plus-finite-range-adapter', adapters, falsifiers: ['rect-single-sided', 'rect-finite-range'] };
}

export function buildSpotCombinedLightingReferenceEvidence(compare = false): LightingReferenceEvidence {
  const ies = buildLightingReferenceEvidence('ies', compare);
  const cookie = buildLightingReferenceEvidence('cookie', compare);
  return {
    referenceKind: 'three-r184-native-webgpu-spot-ies-cookie-shadow-combined',
    adapters: [
      {
        adapterId: 'three-r184-ies-spot-light',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/lights/webgpu/IESSpotLight.js + three/src/nodes/lighting/IESSpotLightNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'native IESSpotLight radial attenuation in the same SpotLight node composition',
      },
      {
        adapterId: 'three-r184-webgpu-spot-light-map',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/nodes/lighting/SpotLightNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'native projected SpotLight.map with a dense product-equivalent RGB texture and explicit roll pre-rotation',
      },
      {
        adapterId: 'three-r184-webgpu-spot-shadow',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/nodes/lighting/ShadowNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'native castShadow path on the same IESSpotLight and receiver geometry',
      },
    ],
    falsifiers: [...ies.falsifiers, ...cookie.falsifiers, 'combined-cookie-roll', 'combined-shadow'],
    ...(ies.ies === undefined ? {} : { ies: ies.ies }),
    ...(cookie.cookie === undefined ? {} : { cookie: { ...cookie.cookie, nativePath: 'three-r184-WebGPU-SpotLight-map' as const } }),
  };
}

export function buildRecoveryLightingReferenceEvidence(compare = false): LightingReferenceEvidence {
  const ies = buildLightingReferenceEvidence('ies', compare);
  const cookie = buildLightingReferenceEvidence('cookie', compare);
  return {
    referenceKind: 'three-r184-native-webgpu-recovery-lighting-baseline',
    adapters: [
      {
        adapterId: 'three-r184-webgpu-rect-area-light',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/lights/RectAreaLight.js + three/src/nodes/lighting/RectAreaLightNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'native RectAreaLight LTC baseline; recovery lifecycle is not represented by Three',
      },
      {
        adapterId: 'three-r184-ies-spot-light',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/lights/webgpu/IESSpotLight.js + three/src/nodes/lighting/IESSpotLightNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'native IESSpotLight radial attenuation in the baseline scene',
      },
      {
        adapterId: 'three-r184-webgpu-spot-light-map',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/nodes/lighting/SpotLightNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'native projected SpotLight.map; the recovery scene has no native local-volume or LKG record equivalent',
      },
      {
        adapterId: 'three-r184-webgpu-light-probe',
        implementation: 'three-native',
        backend: 'webgpu',
        source: 'three/src/lights/LightProbe.js + three/src/nodes/lighting/LightProbeNode.js',
        independentOfForgeaxKernel: true,
        semanticScope: 'one native SH9 LightProbe encoding the recovery Sky baseline, not per-object local probe selection',
      },
    ],
    falsifiers: [
      'recovery-native-rect-area',
      'recovery-native-ies-cookie-shadow',
      'recovery-native-light-probe',
      'recovery-no-local-volume-equivalent',
      'recovery-no-lkg-equivalent',
      'recovery-device-generation-forgeax-owned',
    ],
    ...(ies.ies === undefined ? {} : { ies: ies.ies }),
    ...(cookie.cookie === undefined ? {} : { cookie: { ...cookie.cookie, nativePath: 'three-r184-WebGPU-SpotLight-map' as const } }),
  };
}

function setupCamera(manifest: LightingSceneManifest, aspect: number): any {
  const camera = new PerspectiveCamera(
    manifest.camera.fovDeg,
    aspect,
    manifest.camera.near,
    manifest.camera.far,
  );
  camera.position.set(...manifest.camera.position);
  camera.quaternion.set(...manifest.camera.rotation);
  return camera;
}

function materialColor(
  value: readonly [number, number, number, number],
  colorSpace: LightingSceneManifest['materials']['colorSpace'],
): any {
  return new Color().setRGB(
    value[0],
    value[1],
    value[2],
    colorSpace === 'srgb' ? SRGBColorSpace : LinearSRGBColorSpace,
  );
}

function applyFiniteRectRange(material: any, range: number): void {
  const rangeLiteral = Number(range).toFixed(6);
  material.onBeforeCompile = (shader: { fragmentShader: string }) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_begin>',
      `#include <lights_fragment_begin>
	float rectDistanceSquared = dot(rectAreaLight.position - geometryPosition, rectAreaLight.position - geometryPosition);
	float rectRangeTerm = rectDistanceSquared / (${rangeLiteral} * ${rangeLiteral});
	float rectRangeFactor = clamp(1.0 - rectRangeTerm * rectRangeTerm, 0.0, 1.0);
	 rectRangeFactor *= rectRangeFactor;
	 reflectedLight.directDiffuse *= rectRangeFactor;
	 reflectedLight.directSpecular *= rectRangeFactor;`,
    );
  };
  material.customProgramCacheKey = () => `forgeax-finite-rect-range-${rangeLiteral}`;
}

function toneMappedBackgroundLinear(
  color: readonly [number, number, number, number],
  exposure: number,
): readonly [number, number, number] {
  // WebGL Scene.background bypasses Three's tone-mapping shader, while the
  // ForgeaX camera clear is written to HDR and then passes through ACES. Use
  // the exact r184 ACES matrices/fit to put the WebGL clear into the same
  // linear display domain before its normal sRGB output conversion.
  const exposed: [number, number, number] = [
    (color[0] * exposure) / 0.6,
    (color[1] * exposure) / 0.6,
    (color[2] * exposure) / 0.6,
  ];
  const input: [number, number, number] = [
    0.59719 * exposed[0] + 0.35458 * exposed[1] + 0.04823 * exposed[2],
    0.076 * exposed[0] + 0.90834 * exposed[1] + 0.01566 * exposed[2],
    0.0284 * exposed[0] + 0.13383 * exposed[1] + 0.83777 * exposed[2],
  ];
  const fit: [number, number, number] = [0, 1, 2].map((index) => {
    const value = input[index] ?? 0;
    const a = value * (value + 0.0245786) - 0.000090537;
    const b = value * (0.983729 * value + 0.432951) + 0.238081;
    return a / b;
  }) as [number, number, number];
  return [
    clamp(1.60475 * fit[0] - 0.53108 * fit[1] - 0.07367 * fit[2], 0, 1),
    clamp(-0.10208 * fit[0] + 1.10813 * fit[1] - 0.00605 * fit[2], 0, 1),
    clamp(-0.00327 * fit[0] - 0.07276 * fit[1] + 1.07602 * fit[2], 0, 1),
  ];
}

function setupSharedScene(
  manifest: LightingSceneManifest,
  normalizeWebglBackground = false,
  finiteRectRange = false,
): any {
  const scene = new Scene();
  const clearColor = manifest.camera.clearColor;
  const background = normalizeWebglBackground
    ? toneMappedBackgroundLinear(clearColor, manifest.exposure.value)
    : clearColor;
  scene.background = new Color().setRGB(background[0], background[1], background[2], LinearSRGBColorSpace);
  const receiver = new MeshStandardMaterial({
    color: materialColor(manifest.materials.receiver.baseColor, manifest.materials.colorSpace),
    metalness: manifest.materials.receiver.metallic,
    roughness: manifest.materials.receiver.roughness,
    side: DoubleSide,
  });
  if (finiteRectRange) applyFiniteRectRange(receiver, manifest.lighting.rect.range);
  const [receiverWidth, receiverHeight, receiverWidthSegments, receiverHeightSegments] = manifest.geometry.receiverPlane;
  const receiverMesh = new Mesh(
    new PlaneGeometry(receiverWidth, receiverHeight, receiverWidthSegments, receiverHeightSegments),
    receiver,
  );
  receiverMesh.receiveShadow = true;
  scene.add(receiverMesh);
  const glossy = new MeshStandardMaterial({
    color: materialColor(manifest.materials.glossy.baseColor, manifest.materials.colorSpace),
    metalness: manifest.materials.glossy.metallic,
    roughness: manifest.materials.glossy.roughness,
  });
  if (finiteRectRange) applyFiniteRectRange(glossy, manifest.lighting.rect.range);
  for (const sphereSpec of manifest.geometry.glossySpheres) {
    // Match the product-side HANDLE_SPHERE payload: BUILTIN_SPHERE is
    // synthesized from createSphereGeometry(1, 16, 12), then scaled per
    // instance. This is an input-equivalence requirement, not a visual tune.
    const sphere = new Mesh(new SphereGeometry(1, 16, 12), glossy);
    sphere.scale.setScalar(sphereSpec.radius);
    sphere.position.set(...sphereSpec.position);
    sphere.receiveShadow = true;
    scene.add(sphere);
  }
  return scene;
}

function configureRenderer(renderer: any, canvas: HTMLCanvasElement, manifest: LightingSceneManifest): void {
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = manifest.exposure.value;
}

function aimThreeSpotTarget(light: any, spot: LightingSceneManifest['lighting']['spot']): void {
  // ForgeaX stores the emitted direction explicitly on SpotLight. Three's
  // native SpotLight derives the same axis from light.position - target.position,
  // so target must be placed at position + direction. Targeting the world
  // origin would introduce a second, unowned direction and makes the A/B
  // compare measure an input mismatch instead of the light implementation.
  light.target.position.set(
    spot.position[0] + spot.direction[0],
    spot.position[1] + spot.direction[1],
    spot.position[2] + spot.direction[2],
  );
}

function sourceCookieChannel(asset: TextureAsset, x: number, y: number, channel: number): number {
  return (asset.data[(y * asset.shape.extent.width + x) * 4 + channel] ?? 0) / 255;
}

function sampleSourceCookieChannel(asset: TextureAsset, x: number, y: number, channel: number): number {
  const sourceX = clamp((x + 0.5) / COOKIE_PRODUCT_SIZE, 0, 1) * (asset.shape.extent.width - 1);
  const sourceY = clamp((y + 0.5) / COOKIE_PRODUCT_SIZE, 0, 1) * (asset.shape.extent.height - 1);
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const x1 = Math.min(asset.shape.extent.width - 1, x0 + 1);
  const y1 = Math.min(asset.shape.extent.height - 1, y0 + 1);
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const top = sourceCookieChannel(asset, x0, y0, channel) * (1 - tx) + sourceCookieChannel(asset, x1, y0, channel) * tx;
  const bottom = sourceCookieChannel(asset, x0, y1, channel) * (1 - tx) + sourceCookieChannel(asset, x1, y1, channel) * tx;
  return top * (1 - ty) + bottom * ty;
}

function productCookieProjection(asset: TextureAsset): Uint8Array {
  const projection = new Uint8Array(COOKIE_PRODUCT_SIZE * COOKIE_PRODUCT_SIZE * 4);
  for (let y = 0; y < COOKIE_PRODUCT_SIZE; y += 1) {
    for (let x = 0; x < COOKIE_PRODUCT_SIZE; x += 1) {
      const offset = (y * COOKIE_PRODUCT_SIZE + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        projection[offset + channel] = Math.round(clamp(sampleSourceCookieChannel(asset, x, y, channel), 0, 1) * 255);
      }
    }
  }
  return projection;
}

function sampleProductCookieChannel(projection: Uint8Array, u: number, v: number, channel: number): number {
  const x = clamp(u, 0, 1) * COOKIE_PRODUCT_SIZE - 0.5;
  const y = clamp(v, 0, 1) * COOKIE_PRODUCT_SIZE - 0.5;
  const x0 = clamp(Math.floor(x), 0, COOKIE_PRODUCT_SIZE - 1);
  const y0 = clamp(Math.floor(y), 0, COOKIE_PRODUCT_SIZE - 1);
  const x1 = Math.min(COOKIE_PRODUCT_SIZE - 1, x0 + 1);
  const y1 = Math.min(COOKIE_PRODUCT_SIZE - 1, y0 + 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  const at = (px: number, py: number) => (projection[(py * COOKIE_PRODUCT_SIZE + px) * 4 + channel] ?? 0) / 255;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

function createCookieTexture(asset: TextureAsset, rollDeg = 0): any {
  const projection = productCookieProjection(asset);
  const data = new Uint8Array(COOKIE_REFERENCE_SIZE * COOKIE_REFERENCE_SIZE * 4);
  // Three r184's WebGL spot-map shader consumes `spotColor.rgb` only. The
  // product contract samples the fixed 256² linear RGBA projection and then
  // multiplies sampled RGB by sampled alpha. Pre-fold that same function into
  // a dense independent reference map; its 1024² resolution makes the
  // reference interpolation error negligible without changing authored input.
  // Three's native SpotLight projector has no roll field. When the product
  // combines IES and Cookie, pre-rotate only the independent reference map so
  // its unrolled projector samples the same rolled local basis. The regular
  // Cookie showcase passes rollDeg=0 and therefore remains a direct native map
  // comparison.
  const roll = (rollDeg * Math.PI) / 180;
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  for (let y = 0; y < COOKIE_REFERENCE_SIZE; y += 1) {
    for (let x = 0; x < COOKIE_REFERENCE_SIZE; x += 1) {
      const u = (x + 0.5) / COOKIE_REFERENCE_SIZE;
      const v = (y + 0.5) / COOKIE_REFERENCE_SIZE;
      const centeredX = u - 0.5;
      const centeredY = v - 0.5;
      // The product shader rotates the light-local direction as
      // (rolledX, rolledY) = R(+roll) * (localX, localY). Bake that same
      // forward rotation into the native Three map; using R(-roll) here
      // mirrors the Cookie boundary and creates a false sign mismatch.
      const sourceU = clamp(0.5 + cosine * centeredX - sine * centeredY, 0, 1);
      const sourceV = clamp(0.5 + sine * centeredX + cosine * centeredY, 0, 1);
      const alpha = sampleProductCookieChannel(projection, sourceU, sourceV, 3);
      const offset = (y * COOKIE_REFERENCE_SIZE + x) * 4;
      data[offset] = Math.round(sampleProductCookieChannel(projection, sourceU, sourceV, 0) * alpha * 255);
      data[offset + 1] = Math.round(sampleProductCookieChannel(projection, sourceU, sourceV, 1) * alpha * 255);
      data[offset + 2] = Math.round(sampleProductCookieChannel(projection, sourceU, sourceV, 2) * alpha * 255);
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, COOKIE_REFERENCE_SIZE, COOKIE_REFERENCE_SIZE, RGBAFormat, UnsignedByteType);
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function renderThreeCookieReference(
  canvas: HTMLCanvasElement,
  asset: TextureAsset,
  manifest: LightingSceneManifest,
  plainSpot = false,
): ReferenceRenderReceipt {
  const renderer = new WebGLRenderer({ canvas, antialias: manifest.camera.antialias !== 'none' });
  configureRenderer(renderer, canvas, manifest);
  renderer.shadowMap.enabled = true;
  const scene = setupSharedScene(manifest, true);
  const spot = manifest.lighting.spot;
  const lightColor = plainSpot ? spot.iesColor : spot.cookieColor;
  const light = new SpotLight(
    new Color().setRGB(lightColor[0], lightColor[1], lightColor[2], LinearSRGBColorSpace),
    spot.intensity,
    spot.range,
    (spot.outerConeDeg * Math.PI) / 180,
    1 - spot.innerConeDeg / spot.outerConeDeg,
    2,
  );
  light.position.set(...spot.position);
  // The product Cookie showcase has castShadow=false. Three still updates a
  // projection matrix for SpotLight.map without enabling a shadow test; keep
  // the shadow contribution out of this A/B so it does not add another scene
  // variable to the cookie comparison.
  light.castShadow = false;
  if (!plainSpot) light.map = createCookieTexture(asset);
  // SpotLight.map reuses the SpotLightShadow projector even when shadows are
  // disabled. Set its explicit texture aspect so Three's native matrix and
  // ForgeaX's slice-keyed aspect matrix receive the same authored fact.
  light.shadow.aspect = asset.shape.extent.width / asset.shape.extent.height;
  aimThreeSpotTarget(light, spot);
  scene.add(light, light.target);
  renderer.render(scene, setupCamera(manifest, canvas.width / canvas.height));
  return { backend: 'webgl2', referenceKind: 'three-r184-native-webgl2-spot-cookie-plus-rgba-analytic', rendered: true };
}

export function renderThreeRectReference(
  canvas: HTMLCanvasElement,
  manifest: LightingSceneManifest,
): ReferenceRenderReceipt {
  RectAreaLightUniformsLib.init();
  const renderer = new WebGLRenderer({ canvas, antialias: manifest.camera.antialias !== 'none' });
  configureRenderer(renderer, canvas, manifest);
  const scene = setupSharedScene(manifest, true, true);
  const rect = manifest.lighting.rect;
  const emitter = new Mesh(
    new PlaneGeometry(rect.emitterSize[0], rect.emitterSize[1]),
    new MeshBasicMaterial({
      color: materialColor([1, 0.68, 0.26, 1], manifest.materials.colorSpace),
      side: DoubleSide,
    }),
  );
  emitter.position.set(...rect.emitterPosition);
  scene.add(emitter);
  const light = new RectAreaLight(
    new Color().setRGB(rect.color[0], rect.color[1], rect.color[2], LinearSRGBColorSpace),
    rect.intensity,
    rect.width,
    rect.height,
  );
  light.position.set(...rect.position);
  scene.add(light);
  renderer.render(scene, setupCamera(manifest, canvas.width / canvas.height));
  return { backend: 'webgl2', referenceKind: 'three-r184-native-webgl2-rect-area-plus-finite-range-adapter', rendered: true };
}

const THREE_SH_L00_IRRADIANCE = 0.886227;
const FORGEAX_SH_BAND_SCALE_TO_THREE = [1 / Math.PI, 3 / (2 * Math.PI), 4 / Math.PI] as const;

export function buildThreeLightProbeSh(result: ProbeReferenceResult): number[] {
  const coefficients = Array.from(result.SH_preblend, (value, index) => {
    const band = index < 3 ? 0 : index < 12 ? 1 : 2;
    return value * FORGEAX_SH_BAND_SCALE_TO_THREE[band];
  });
  coefficients[0] = (coefficients[0] ?? 0) + result.trueE_skyResidual[0] / THREE_SH_L00_IRRADIANCE;
  coefficients[1] = (coefficients[1] ?? 0) + result.trueE_skyResidual[1] / THREE_SH_L00_IRRADIANCE;
  coefficients[2] = (coefficients[2] ?? 0) + result.trueE_skyResidual[2] / THREE_SH_L00_IRRADIANCE;
  return coefficients;
}

export function renderThreeProbeReference(
  canvas: HTMLCanvasElement,
  results: readonly ProbeReferenceResult[],
  manifest: LightingSceneManifest,
): ReferenceRenderReceipt {
  if (results.length !== 9) throw new Error('probe reference requires nine object-specific results');
  const renderer = new WebGLRenderer({ canvas, antialias: manifest.camera.antialias !== 'none' });
  configureRenderer(renderer, canvas, manifest);
  renderer.autoClear = false;
  const clearColor = manifest.camera.clearColor;
  const background = toneMappedBackgroundLinear(clearColor, manifest.exposure.value);
  renderer.setClearColor(new Color().setRGB(background[0], background[1], background[2], LinearSRGBColorSpace), clearColor[3]);
  renderer.clear();
  const camera = setupCamera(manifest, canvas.width / canvas.height);
  const material = new MeshStandardMaterial({
    color: materialColor(manifest.materials.probe.baseColor, manifest.materials.colorSpace),
    metalness: manifest.materials.probe.metallic,
    roughness: manifest.materials.probe.roughness,
  });
  const sphereRadius = manifest.geometry.probeRow.radius;
  for (const result of results) {
    const scene = new Scene();
    // Match HANDLE_SPHERE / BUILTIN_SPHERE's representation: the builtin is
    // a unit sphere and ForgeaX applies the authored radius through Transform
    // scale. Keeping that split also preserves the same f32 multiplication
    // point at the vertex stage instead of baking radius into Three's CPU
    // geometry attributes.
    const sphere = new Mesh(new SphereGeometry(1, 16, 12), material);
    sphere.scale.setScalar(sphereRadius);
    sphere.position.set(result.position[0], result.position[1], result.position[2]);
    const probe = new LightProbe();
    probe.sh.fromArray(buildThreeLightProbeSh(result));
    scene.add(sphere, probe);
    // Keep depth across the per-object scenes. Each LightProbe is intentionally
    // isolated to its receiver, but the receivers still share one physical
    // depth buffer just like the product's single World render.
    renderer.render(scene, camera);
  }
  return { backend: 'webgl2', referenceKind: 'three-r184-lightprobe-sh9-not-native-local-volume', rendered: true };
}

function createIesReferenceMap(profile: IesProfileAsset, spot: LightingSceneManifest['lighting']['spot']): any {
  const profileView = new DataView(profile.data.buffer, profile.data.byteOffset, profile.data.byteLength);
  const mapData = new Uint16Array(IES_REFERENCE_MAP_WIDTH * 4);
  const cosInner = Math.cos((spot.innerConeDeg * Math.PI) / 180);
  const cosOuter = Math.cos((spot.outerConeDeg * Math.PI) / 180);
  for (let index = 0; index < IES_REFERENCE_MAP_WIDTH; index += 1) {
    const normalizedElevation = (index + 0.5) / IES_REFERENCE_MAP_WIDTH;
    const profileValue = sampleIesRadialProfile(profileView, normalizedElevation);
    const polarDeg = normalizedElevation * 180;
    // Three r184's IESSpotLightNode replaces SpotLight's smoothstep cone with
    // the IES sample. ForgeaX's contract composes both factors. Fold the same
    // explicit cone into the native 1D reference map so this adapter preserves
    // product inputs without changing either side's authored light values.
    const cone = smoothstep(cosOuter, cosInner, Math.cos((polarDeg * Math.PI) / 180));
    const encoded = floatToHalf(clamp(profileValue * cone, 0, 1));
    mapData[index * 4] = encoded;
    mapData[index * 4 + 1] = encoded;
    mapData[index * 4 + 2] = encoded;
    mapData[index * 4 + 3] = floatToHalf(1);
  }
  const map = new DataTexture(mapData, IES_REFERENCE_MAP_WIDTH, 1, RGBAFormat, HalfFloatType);
  map.colorSpace = LinearSRGBColorSpace;
  map.minFilter = LinearFilter;
  map.magFilter = LinearFilter;
  map.needsUpdate = true;
  return map;
}

export async function renderThreeIesReference(
  canvas: HTMLCanvasElement,
  profile: IesProfileAsset,
  manifest: LightingSceneManifest,
  plainSpot = false,
): Promise<ReferenceRenderReceipt> {
  const { IESSpotLight, WebGPURenderer } = await import('three/webgpu');
  const renderer = new WebGPURenderer({ canvas, antialias: manifest.camera.antialias !== 'none' });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = manifest.exposure.value;
  const scene = setupSharedScene(manifest);
  const spot = manifest.lighting.spot;
  const light = (plainSpot ? new SpotLight(
    new Color().setRGB(spot.iesColor[0], spot.iesColor[1], spot.iesColor[2], LinearSRGBColorSpace),
    spot.intensity,
    spot.range,
    (spot.outerConeDeg * Math.PI) / 180,
    1 - spot.innerConeDeg / spot.outerConeDeg,
  ) : new IESSpotLight(
    new Color().setRGB(spot.iesColor[0], spot.iesColor[1], spot.iesColor[2], LinearSRGBColorSpace),
    spot.intensity,
    spot.range,
    (spot.outerConeDeg * Math.PI) / 180,
    1 - spot.innerConeDeg / spot.outerConeDeg,
    2,
  )) as any;
  light.position.set(...spot.position);
  aimThreeSpotTarget(light, spot);
  if (!plainSpot) {
    light.iesMap = createIesReferenceMap(profile, spot);
  }
  scene.add(light, light.target);
  renderer.render(scene, setupCamera(manifest, canvas.width / canvas.height));
  return { backend: 'webgpu', referenceKind: 'three-r184-native-webgpu-ies-rotational-symmetric-plus-type-c-analytic', rendered: true };
}

/**
 * Native Three.js WebGPU control for the real `spot-modifiers` composition.
 * IESSpotLightNode inherits SpotLightNode's map path, so one Three light can
 * exercise IES attenuation, the projected Cookie, and shadowing together.
 */
export async function renderThreeSpotCombinedReference(
  canvas: HTMLCanvasElement,
  profile: IesProfileAsset,
  asset: TextureAsset,
  manifest: LightingSceneManifest,
): Promise<ReferenceRenderReceipt> {
  const { IESSpotLight, WebGPURenderer } = await import('three/webgpu');
  const renderer = new WebGPURenderer({ canvas, antialias: manifest.camera.antialias !== 'none' });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = manifest.exposure.value;
  renderer.shadowMap.enabled = true;
  const scene = setupSharedScene(manifest);
  const spot = manifest.lighting.spot;
  const light = new IESSpotLight(
    new Color().setRGB(spot.cookieColor[0], spot.cookieColor[1], spot.cookieColor[2], LinearSRGBColorSpace),
    spot.intensity,
    spot.range,
    (spot.outerConeDeg * Math.PI) / 180,
    1 - spot.innerConeDeg / spot.outerConeDeg,
    2,
  ) as any;
  light.position.set(...spot.position);
  light.castShadow = true;
  light.shadow.aspect = asset.shape.extent.width / asset.shape.extent.height;
  light.iesMap = createIesReferenceMap(profile, spot);
  light.map = createCookieTexture(asset, spot.rollDeg);
  aimThreeSpotTarget(light, spot);
  scene.add(light, light.target);
  renderer.render(scene, setupCamera(manifest, canvas.width / canvas.height));
  return { backend: 'webgpu', referenceKind: 'three-r184-native-webgpu-spot-ies-cookie-shadow-combined', rendered: true };
}

/**
 * Recovery's lifecycle and LKG transitions are ForgeaX-owned. This reference
 * renders the same authored geometry and the native Three direct-light
 * baseline (Rect + IES/Cookie Spot + shadow), plus the recovery Sky irradiance
 * as one SH9 LightProbe. It is deliberately not presented as a native Three
 * equivalent of the per-object local-volume records or device generations.
 */
export async function renderThreeRecoveryReference(
  canvas: HTMLCanvasElement,
  profile: IesProfileAsset,
  asset: TextureAsset,
  manifest: LightingSceneManifest,
): Promise<ReferenceRenderReceipt> {
  const { IESSpotLight, RectAreaLightNode, WebGPURenderer } = await import('three/webgpu');
  // Three r184 keeps WebGPU RectAreaLight's LTC library opt-in. The recovery
  // baseline contains a native RectAreaLight, so initialize the same official
  // texture path before the renderer builds its lighting graph.
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  const renderer = new WebGPURenderer({ canvas, antialias: manifest.camera.antialias !== 'none' });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = manifest.exposure.value;
  renderer.shadowMap.enabled = true;
  const scene = setupSharedScene(manifest);
  const rect = manifest.lighting.rect;
  const emitter = new Mesh(
    new PlaneGeometry(rect.emitterSize[0], rect.emitterSize[1]),
    new MeshBasicMaterial({
      color: materialColor([1, 0.68, 0.26, 1], manifest.materials.colorSpace),
      side: DoubleSide,
    }),
  );
  emitter.position.set(...rect.emitterPosition);
  scene.add(emitter);
  const rectLight = new RectAreaLight(
    new Color().setRGB(rect.color[0], rect.color[1], rect.color[2], LinearSRGBColorSpace),
    rect.intensity,
    rect.width,
    rect.height,
  );
  rectLight.position.set(...rect.position);
  scene.add(rectLight);

  const spot = manifest.lighting.spot;
  const spotLight = new IESSpotLight(
    new Color().setRGB(spot.cookieColor[0], spot.cookieColor[1], spot.cookieColor[2], LinearSRGBColorSpace),
    spot.intensity,
    spot.range,
    (spot.outerConeDeg * Math.PI) / 180,
    1 - spot.innerConeDeg / spot.outerConeDeg,
    2,
  ) as any;
  spotLight.position.set(...spot.position);
  spotLight.castShadow = true;
  spotLight.shadow.aspect = asset.shape.extent.width / asset.shape.extent.height;
  spotLight.iesMap = createIesReferenceMap(profile, spot);
  spotLight.map = createCookieTexture(asset, spot.rollDeg);
  aimThreeSpotTarget(spotLight, spot);
  scene.add(spotLight, spotLight.target);

  const sky = manifest.lighting.skylight.recovery;
  const skyProbe = new LightProbe();
  skyProbe.sh.fromArray([
    sky.color[0] * sky.intensity / THREE_SH_L00_IRRADIANCE,
    sky.color[1] * sky.intensity / THREE_SH_L00_IRRADIANCE,
    sky.color[2] * sky.intensity / THREE_SH_L00_IRRADIANCE,
    ...new Array<number>(24).fill(0),
  ]);
  scene.add(skyProbe);
  renderer.render(scene, setupCamera(manifest, canvas.width / canvas.height));
  return { backend: 'webgpu', referenceKind: 'three-r184-native-webgpu-recovery-lighting-baseline', rendered: true };
}
