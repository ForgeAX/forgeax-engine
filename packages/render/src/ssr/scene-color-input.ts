import { mipDimension, numMipLevels } from '@forgeax/engine-types';

type ColorExtent = { readonly width: number; readonly height: number };

export function ssrColorExtent(scene: ColorExtent): ColorExtent {
  return { width: mipDimension(scene.width, 1), height: mipDimension(scene.height, 1) };
}

export function ssrColorMipCount(size: ColorExtent): number {
  return Math.min(4, numMipLevels(size));
}

/** Level zero is already owned by the scene or retained color producer. */
export function ssrColorMipTailTexels(
  size: ColorExtent,
  mipCount = ssrColorMipCount(size),
): number {
  let texels = 0;
  for (let level = 1; level < mipCount; level += 1)
    texels += mipDimension(size.width, level) * mipDimension(size.height, level);
  return texels;
}

/** Metadata belongs to the selected scene-color producer, independently of SSR history. */
export interface SsrColorViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly referenceWidth: number;
  readonly referenceHeight: number;
}

export interface SsrSceneColorHistoryInput<T> {
  readonly source: T;
  readonly viewport: SsrColorViewport;
  readonly preExposure: number;
  readonly deviceGeneration: number;
  readonly valid: boolean;
}

export type SsrSceneColorSelection<T> =
  | { readonly kind: 'current'; readonly preExposureCorrection: 1 }
  | {
      readonly kind: 'custom' | 'half-taa' | 'taa';
      readonly input: SsrSceneColorHistoryInput<T>;
      readonly preExposureCorrection: number;
    };

export function fullSsrColorViewport(width: number, height: number): SsrColorViewport {
  return { x: 0, y: 0, width, height, referenceWidth: width, referenceHeight: height };
}

export function isSsrColorViewport(viewport: SsrColorViewport): boolean {
  return (
    Object.values(viewport).every(Number.isSafeInteger) &&
    viewport.x >= 0 &&
    viewport.y >= 0 &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    viewport.referenceWidth > 0 &&
    viewport.referenceHeight > 0 &&
    viewport.x + viewport.width <= viewport.referenceWidth &&
    viewport.y + viewport.height <= viewport.referenceHeight
  );
}

function usable<T>(
  input: SsrSceneColorHistoryInput<T> | undefined,
  deviceGeneration: number,
): input is SsrSceneColorHistoryInput<T> {
  if (
    input === undefined ||
    !input.valid ||
    input.deviceGeneration !== deviceGeneration ||
    !Number.isFinite(input.preExposure) ||
    input.preExposure <= 0
  )
    return false;
  return isSsrColorViewport(input.viewport);
}

/** Only actual published producers participate; absence never creates a history capability. */
export function selectSsrSceneColorInput<T>(input: {
  readonly deviceGeneration: number;
  readonly currentPreExposure: number;
  readonly custom?: SsrSceneColorHistoryInput<T>;
  readonly halfTaaEnabled?: boolean;
  readonly halfTaa?: SsrSceneColorHistoryInput<T>;
  readonly taa?: SsrSceneColorHistoryInput<T>;
}): SsrSceneColorSelection<T> {
  if (!Number.isFinite(input.currentPreExposure) || input.currentPreExposure <= 0)
    return { kind: 'current', preExposureCorrection: 1 };
  const candidates = [
    ['custom', input.custom],
    ['half-taa', input.halfTaaEnabled === true ? input.halfTaa : undefined],
    ['taa', input.taa],
  ] as const;
  for (const [kind, candidate] of candidates) {
    if (usable(candidate, input.deviceGeneration))
      return {
        kind,
        input: candidate,
        preExposureCorrection: input.currentPreExposure / candidate.preExposure,
      };
  }
  return { kind: 'current', preExposureCorrection: 1 };
}

/** Screen UV to the producer's saved viewport within its reference allocation. */
export function writeSsrColorViewport(
  output: DataView,
  byteOffset: number,
  viewport: SsrColorViewport,
): void {
  const scaleBias = [
    viewport.width / viewport.referenceWidth,
    viewport.height / viewport.referenceHeight,
    viewport.x / viewport.referenceWidth,
    viewport.y / viewport.referenceHeight,
  ];
  const bounds = [
    (viewport.x + 0.5) / viewport.referenceWidth,
    (viewport.y + 0.5) / viewport.referenceHeight,
    (viewport.x + viewport.width - 0.5) / viewport.referenceWidth,
    (viewport.y + viewport.height - 0.5) / viewport.referenceHeight,
  ];
  for (const [index, value] of [...scaleBias, ...bounds].entries())
    output.setFloat32(byteOffset + index * 4, value, true);
}
export const SSR_SCENE_COLOR_HISTORY_PROGRAM = {
  name: 'forgeax.ssr-scene-color-history',
  kind: 'fullscreen' as const,
  source: `
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let position = positions[index];
  return VertexOutput(vec4<f32>(position, 0.0, 1.0), position * vec2<f32>(0.5, -0.5) + 0.5);
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSampleLevel(scene, sceneSampler, input.uv, 0.0);
}`,
  reads: ['input'] as const,
};

export const SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM = {
  ...SSR_SCENE_COLOR_HISTORY_PROGRAM,
  name: 'forgeax.ssr-hit-color-downsample',
};
