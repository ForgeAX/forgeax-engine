// @forgeax/engine-runtime - RenderSystem record stage: view-ubo.
// feat-20260704 M3/w18: the View UBO + CSM/spot-shadow matrix pack assembly
// extracted verbatim from `recordFrame` (frame.ts). Builds the 292-float View
// UBO payload (worldViewProj, directional light, camera pos, per-cascade
// lightViewProj matrices, split planes, shadow bias, folded spot lightViewProj
// lanes) and flushes it in one queue.writeBuffer round-trip. Kept as a
// standalone function so recordFrame stays an orchestration skeleton (D-2).

import { mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { normalizeClippingPlanes } from '@forgeax/engine-types';
import {
  DirectionalShadowFilterValue,
  type DirectionalShadowQuality,
} from '../components/directional-shadow-filter';
import { LIGHTING_CHANNELS_DEFAULT } from '../components/lighting-channels';
import { LineCapValue, LineWidthUnitsValue } from '../components/lines';
import { writeAtmosphereUniform } from '../environment/uniform';
import type { AtmosphereParameters, FogFrame } from '../extract/environment';
import type { PointsLinesStyle } from '../points-lines/snapshot';
import type { CameraSnapshot } from '../render-contract';
import type {
  DirectionalLightSnapshot,
  ExtractedLights,
  SpotLightSnapshot,
} from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import type { TemporalView as LegacyTemporalView } from '../temporal/temporal-view';
import type { TemporalView } from '../temporal/view';
import { computeProjectionMatrix, computeViewMatrix } from './helpers';

export const VIEW_UNIFORM_BYTES = 1280;
export const POINTS_LINES_VIEW_BYTES = 176;
export const POINTS_LINES_VIEW_SLOT_STRIDE = 256;
export const POINTS_LINES_VIEW_SLOT_COUNT = 1024;
export const POINTS_LINES_VIEW_BUFFER_SIZE =
  POINTS_LINES_VIEW_SLOT_STRIDE * POINTS_LINES_VIEW_SLOT_COUNT;
export const VIEW_UNIFORM_SLOT_STRIDE = 1280;
export const POINT_SHADOW_VIEW_SLOT_COUNT = 24;
export const CUBE_CAPTURE_VIEW_SLOT_BASE = 1 + POINT_SHADOW_VIEW_SLOT_COUNT;
export const REFLECTION_PROBE_VIEW_SLOT_BASE = CUBE_CAPTURE_VIEW_SLOT_BASE + 6 + 1;
export const REFLECTION_PROBE_VIEW_SLOT_COUNT = 16;
/**
 * How a blended writer's color reaches the target, which decides how fog at
 * its own depth composes with it (UE `FogStruct` per blend mode).
 */
export type TranslucentFogComposition = 'straight' | 'premultiplied' | 'additive';
const TRANSLUCENT_FOG_COMPOSITIONS: readonly TranslucentFogComposition[] = [
  'straight',
  'premultiplied',
  'additive',
];
/**
 * Display View copies whose `fogHeightOpacity.z` names one composition
 * (1 + its index). Blended draws bind the copy matching their blend state, so
 * shared material programs fog only translucent writers without a per-blend
 * shader variant; slot 0 stays unfogged for opaque draws, which the opaque fog
 * pass covers.
 */
export const TRANSLUCENT_VIEW_SLOT_BASE =
  REFLECTION_PROBE_VIEW_SLOT_BASE + REFLECTION_PROBE_VIEW_SLOT_COUNT;
export const PLANAR_REFLECTION_UNIFORM_OFFSET =
  VIEW_UNIFORM_SLOT_STRIDE * (TRANSLUCENT_VIEW_SLOT_BASE + TRANSLUCENT_FOG_COMPOSITIONS.length);
export const VIEW_UNIFORM_BUFFER_SIZE = PLANAR_REFLECTION_UNIFORM_OFFSET + VIEW_UNIFORM_SLOT_STRIDE;

export function translucentViewOffset(composition: TranslucentFogComposition): number {
  return (
    VIEW_UNIFORM_SLOT_STRIDE *
    (TRANSLUCENT_VIEW_SLOT_BASE + TRANSLUCENT_FOG_COMPOSITIONS.indexOf(composition))
  );
}

/** Classify a color blend; blends fog cannot compose with (multiply, min/max) return undefined. */
export function translucentFogComposition(
  blend: GPUBlendState | undefined,
): TranslucentFogComposition | undefined {
  const color = blend?.color;
  if (color === undefined || (color.operation ?? 'add') !== 'add') return undefined;
  const src = color.srcFactor ?? 'one';
  const dst = color.dstFactor ?? 'zero';
  if (dst === 'one' && (src === 'one' || src === 'src-alpha')) return 'additive';
  if (dst !== 'one-minus-src-alpha') return undefined;
  if (src === 'src-alpha') return 'straight';
  return src === 'one' ? 'premultiplied' : undefined;
}

export function pointShadowViewOffset(layer: number, face: number): number {
  return VIEW_UNIFORM_SLOT_STRIDE * (1 + layer * 6 + face);
}

/** Project the accepted Directional quality union into the frozen View ABI. */
function directionalShadowFilterCarrier(
  quality: DirectionalShadowQuality | undefined,
): readonly [number, number, number] {
  if (quality === undefined) return [0, 0, 0];
  if (quality.kind === 'pcf-vogel') return [DirectionalShadowFilterValue.pcfVogel, 0, 0];
  if (quality.kind === 'pcss') {
    return [
      quality.preset === 'medium'
        ? DirectionalShadowFilterValue.pcssMedium
        : DirectionalShadowFilterValue.pcssHigh,
      quality.angularRadiusRadians,
      quality.maxPenumbraTexels,
    ];
  }
  return [DirectionalShadowFilterValue[`pcf${quality.kernel}`], 0, 0];
}

export function writePointsLinesViewUbo(
  queue: RhiQueue,
  buffer: Buffer,
  camera: CameraSnapshot,
  width: number,
  height: number,
  model?: ArrayLike<number>,
  style?: PointsLinesStyle,
  byteOffset = 0,
): void {
  const projection = computeProjectionMatrix(camera);
  const view = computeViewMatrix(camera);
  const worldViewProj = mat4.create();
  mat4.multiply(worldViewProj, projection, view);
  const payload = new Float32Array(POINTS_LINES_VIEW_BYTES / 4);
  payload.set(worldViewProj);
  if (model === undefined) {
    payload[16] = 1;
    payload[21] = 1;
    payload[26] = 1;
    payload[31] = 1;
  } else {
    for (let index = 0; index < 16; index += 1) {
      payload[16 + index] = model[index] ?? 0;
    }
  }
  payload[32] = width;
  payload[33] = height;
  if (style?.kind === 'points') {
    payload[36] = style.sizePx;
    payload[38] = style.shape === 'circle' ? 1 : 0;
  } else if (style?.kind === 'lines') {
    payload[36] = style.width;
    payload[37] = 1;
    // World widths scale by the projection's vertical focal factor; the shader
    // divides by each endpoint's clip w (1 for orthographic cameras).
    payload[39] =
      style.widthUnits === LineWidthUnitsValue.world
        ? Math.abs(projection[5] ?? 0) * height * 0.5
        : 0;
    payload[40] = style.dashSize ?? 1;
    payload[41] = style.gapSize ?? 0;
    payload[42] = style.dashOffset ?? 0;
    payload[43] = style.cap === LineCapValue.round ? 1 : 0;
  } else {
    payload[36] = 1;
  }
  const uploaded = queue.writeBuffer(buffer, byteOffset, payload);
  if (!uploaded.ok) throw uploaded.error;
}

/**
 * feat-20260704 M3/w18: assemble + upload the per-frame View UBO payload.
 *
 * feat-20260518 M3 / w14 (AC-07 / AC-09): builds the full view UBO payload.
 * Single queue.writeBuffer covers the whole payload (one round-trip per frame,
 * charter P5 consistent abstraction). Outgoing-direction convention
 * (DirectionalLight @semantics outgoing): the host uploads light.direction
 * verbatim; the shader negates it internally via
 * `let l = normalize(-view.lightDir)` to get the L vector for BRDF (single
 * SSOT, no double-negation).
 *
 * feat-20260520-directional-light-shadow-mapping M1b / w7 + feat-20260613-csm
 * M4 / w16+w25: viewPayload is 292 floats. Layout matches common.wgsl View
 * struct byte-for-byte:
 *   [ 0..15] worldViewProj, [16..18] lightDir, [20..22] lightColor,
 *   [24..26] cameraPos, [28..43] lightViewProj0 (was lightSpaceMatrix),
 *   [44..59] inverseViewProj, [60..75] lightViewProj1,
 *   [76..91] lightViewProj2, [92..107] lightViewProj3,
 *   [108..123] splitPlanes (vec4 lanes: split/world texel/depth span/reserved),
 *   [124] cascadeCount, [125] cascadeBlend,
 *   [126] depthBias, [127] normalBias,
 *   [128..131] directionalShadowFilter (profile/radius/max penumbra/contact length),
 *   [132..195] spotLightViewProj array<mat4x4<f32>, 4> (feat-20260625 w25:
 *   folded from standalone binding 9 to fix WebGL2 fragment uniform-buffer
 *   overflow; lane N = spot with shadowAtlasTile === N, 16 f32 / lane,
 *   16 B-aligned at byte 528 = float 132).
 *   [228..231] temporalProjection (near, far, orthographic, cloud solar
 *   transmittance), [232..235] temporalPreviousCameraPos, [236..239]
 *   ssrParams (maxDistance, thickness, maxRoughness, enabled).
 *   [240..255] cloud shadow projection, [256..279] clippingPlanes,
 *   [280..283] clippingControl, [284..287] fogColorDensity,
 *   [288..291] fogHeightOpacity (heightFalloff, maxOpacity, translucent-fog slot, frame time).
 *
 * @internal
 */
export function writeViewUbo(
  queue: RhiQueue,
  viewUniformBuffer: Buffer,
  camera: CameraSnapshot,
  light: DirectionalLightSnapshot,
  lights: ExtractedLights,
  spotShadowSnapshots: readonly SpotLightSnapshot[],
  temporalOrOffset?: TemporalView | LegacyTemporalView | number,
  projectorSpotIndex?: number,
  cloudShadowProjection?: {
    readonly origin: readonly [number, number, number];
    readonly right: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    readonly range: number;
    readonly lowSun: boolean;
    readonly baseHeight?: number;
    readonly thickness?: number;
  },
  fog?: Pick<FogFrame, 'color' | 'density' | 'heightFalloff' | 'maxOpacity'>,
  atmosphere?: AtmosphereParameters,
  atmosphereCapture = false,
  /** Render sample elapsed seconds; the existing fogHeightOpacity.w lane. */
  frameTimeSeconds?: number,
  viewport?: { readonly width: number; readonly height: number },
): void {
  const byteOffset = typeof temporalOrOffset === 'number' ? temporalOrOffset : 0;
  const resolvedTemporal = typeof temporalOrOffset === 'number' ? undefined : temporalOrOffset;
  // Compose worldViewProj once per frame (view * proj).
  const projMatrix = computeProjectionMatrix(camera);
  const viewMatrix = computeViewMatrix(camera);
  const unjitteredViewProjection = mat4.create();
  mat4.multiply(unjitteredViewProjection, projMatrix, viewMatrix);
  const jitteredProjection = mat4.create();
  if (resolvedTemporal?.currentJitterUv !== undefined) {
    const jitter = mat4.identity(mat4.create());
    jitter[12] = resolvedTemporal.currentJitterUv[0] * 2;
    jitter[13] = resolvedTemporal.currentJitterUv[1] * -2;
    mat4.multiply(jitteredProjection, jitter, projMatrix);
  } else {
    for (let i = 0; i < 16; i += 1) jitteredProjection[i] = projMatrix[i] ?? 0;
  }
  const mainProjection = mat4.create();
  mat4.multiply(mainProjection, jitteredProjection, viewMatrix);

  const VIEW_PAYLOAD_FLOATS = VIEW_UNIFORM_BYTES / 4;
  const viewPayload = new Float32Array(VIEW_PAYLOAD_FLOATS);
  if (camera.clipping !== undefined) {
    const planes = normalizeClippingPlanes(camera.clipping.planes);
    for (const [index, plane] of planes.entries()) viewPayload.set(plane, 256 + index * 4);
    viewPayload.set(
      [
        planes.length,
        camera.clipping.intersection === true ? 1 : 0,
        camera.clipping.clipShadows === true ? 1 : 0,
        0,
      ],
      280,
    );
  }
  // Analytic fog is one per-view fact: the opaque fog pass and every
  // translucent writer evaluate the same lanes at their own depth.
  if (fog !== undefined && fog.density > 0 && fog.maxOpacity > 0) {
    viewPayload.set([fog.color[0], fog.color[1], fog.color[2], fog.density], 284);
    viewPayload.set([fog.heightFalloff, fog.maxOpacity, 0, 0], 288);
  }
  // The clock is available even when fog is disabled; no per-material publication.
  const frameTime = Math.fround(frameTimeSeconds ?? 0);
  viewPayload[291] = Number.isFinite(frameTime) ? frameTime : 0;
  if (atmosphere !== undefined)
    writeAtmosphereUniform(viewPayload, 292, atmosphere, camera.far, atmosphereCapture ? 64 : 0);
  for (let i = 0; i < 16; i++) viewPayload[i] = mainProjection[i] ?? 0;
  viewPayload[16] = light.direction[0] ?? 0;
  viewPayload[17] = light.direction[1] ?? -1;
  viewPayload[18] = light.direction[2] ?? 0;
  new Uint32Array(viewPayload.buffer, viewPayload.byteOffset, viewPayload.length)[19] =
    light.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT;
  viewPayload[20] = light.color[0] ?? 0;
  viewPayload[21] = light.color[1] ?? 0;
  viewPayload[22] = light.color[2] ?? 0;
  viewPayload[23] = viewport?.width ?? 1;
  viewPayload[24] = camera.position[0] ?? 0;
  viewPayload[25] = camera.position[1] ?? 0;
  viewPayload[26] = camera.position[2] ?? 0;
  viewPayload[27] = viewport?.height ?? 1;
  // lightViewProj[0] at [28..43] (replaces lightSpaceMatrix).
  if (lights.lightViewProj !== undefined && lights.lightViewProj[0] !== undefined) {
    for (let i = 0; i < 16; i++) viewPayload[28 + i] = lights.lightViewProj[0][i] ?? 0;
  }
  // inverseViewProj at [44..59] — unchanged position.
  // Host pre-computes mat4.invert so the skybox fragment shader avoids
  // per-pixel matrix inversion (charter P4 consistent abstraction).
  const inverseViewProj = mat4.create();
  mat4.invert(inverseViewProj, mainProjection);
  for (let i = 0; i < 16; i++) viewPayload[44 + i] = inverseViewProj[i] ?? 0;
  // lightViewProj[1..3] at [60..107].
  if (lights.lightViewProj !== undefined) {
    for (let c = 1; c <= 3; c++) {
      const base = 60 + (c - 1) * 16;
      const lvp = lights.lightViewProj[c];
      if (lvp !== undefined) {
        for (let i = 0; i < 16; i++) viewPayload[base + i] = lvp[i] ?? 0;
      }
    }
  }

  // Temporal ABI tail: current and last-successful unjittered projections
  // stay separate from the jittered main projection and never advance on a
  // failed submission. The fixed 240-float payload already reserves these
  // 36 slots at byte offsets 784..920.
  const previous = resolvedTemporal?.previousUnjitteredViewProjection;
  for (let i = 0; i < 16; i += 1) {
    viewPayload[196 + i] = unjitteredViewProjection[i] ?? 0;
    // No previous successful frame exists on first frame/reset. Keep this
    // lane zeroed instead of copying current state into a history slot.
    viewPayload[212 + i] = previous?.[i] ?? 0;
  }
  viewPayload[228] = camera.near;
  viewPayload[229] = camera.far;
  viewPayload[230] = camera.projection === 'orthographic' ? 1 : 0;
  const previousCameraPosition =
    resolvedTemporal !== undefined && 'previousCameraPosition' in resolvedTemporal
      ? resolvedTemporal.previousCameraPosition
      : undefined;
  if (previousCameraPosition !== undefined) {
    viewPayload[232] = previousCameraPosition[0] ?? 0;
    viewPayload[233] = previousCameraPosition[1] ?? 0;
    viewPayload[234] = previousCameraPosition[2] ?? 0;
    viewPayload[235] = 1;
  }
  // SSR uses the fixed View tail as its single per-camera parameter carrier.
  // Admission has already validated these values; the enabled lane remains
  // zero when the component is absent so disabled frames carry no demand.
  const ssr = camera.screenSpaceReflection;
  if (ssr !== undefined) {
    viewPayload[236] = ssr.maxDistance;
    viewPayload[237] = ssr.thickness;
    viewPayload[238] = ssr.maxRoughness;
    viewPayload[239] = 1;
  }
  if (cloudShadowProjection !== undefined) {
    viewPayload[240] = cloudShadowProjection.origin[0] ?? 0;
    viewPayload[241] = cloudShadowProjection.origin[1] ?? 0;
    viewPayload[242] = cloudShadowProjection.origin[2] ?? 0;
    viewPayload[243] = cloudShadowProjection.baseHeight ?? 0;
    viewPayload[247] = cloudShadowProjection.thickness ?? 0;
    viewPayload[244] = cloudShadowProjection.right[0] ?? 0;
    viewPayload[245] = cloudShadowProjection.right[1] ?? 0;
    viewPayload[246] = cloudShadowProjection.right[2] ?? 0;
    viewPayload[248] = cloudShadowProjection.up[0] ?? 0;
    viewPayload[249] = cloudShadowProjection.up[1] ?? 0;
    viewPayload[250] = cloudShadowProjection.up[2] ?? 0;
    viewPayload[252] = cloudShadowProjection.range;
    viewPayload[253] = cloudShadowProjection.lowSun ? 0 : 1;
    viewPayload[254] = cloudShadowProjection.lowSun ? 1 : 0;
  }
  // splitPlanes at [108..123] (four vec4 lanes: split/world texel/depth span/reserved).
  if (lights.splitPlanes !== undefined) {
    for (let s = 0; s < 4; s++) {
      for (let lane = 0; lane < 4; lane++) {
        viewPayload[108 + s * 4 + lane] = lights.splitPlanes[s * 4 + lane] ?? 0;
      }
    }
  }
  // cascadeCount / cascadeBlend at [124..125].
  viewPayload[124] = lights.cascadeCount ?? 0;
  viewPayload[125] = lights.cascadeBlend ?? 0;
  // M1 directional shadow carrier: bias remains at [126]/[127], while the
  // accepted quality union occupies the existing four-float tail [128..131].
  // Point and Spot pcfKernelSize stay in their own snapshot paths and never
  // enter this Directional View projection.
  viewPayload[126] = lights.depthBias ?? 0.00001;
  viewPayload[127] = lights.normalBias ?? 0.05;
  const filterCarrier = directionalShadowFilterCarrier(lights.directionalShadowQuality);
  viewPayload[128] = filterCarrier[0] ?? 0;
  viewPayload[129] = filterCarrier[1] ?? 0;
  viewPayload[130] = filterCarrier[2] ?? 0;
  viewPayload[131] = light.contactShadowLength;

  // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
  // spotLightViewProj array<mat4x4<f32>, 4> at floats [132..195] (byte 528,
  // 16 B-aligned after directionalShadowFilter). Lane N = the spot with
  // `shadowAtlasTile === N` (cap = 4); the perspective matrix was already
  // computed by the extract stage (SpotLightSnapshot.lightViewProj) — record
  // never recomputes it (Derive). The accepted projector is identified by its
  // spot index, not by a negative shadow tile: a projector-only spot publishes
  // its matrix in lane 0 so the shader never samples a zero matrix. Shadowed
  // projector spots keep their shadow tile lane and carry the projector bit in
  // the DirectLightSlot identity word.
  // Folded from the former standalone binding 9 UBO to keep the WebGL2
  // fallback fragment uniform-buffer count <= 11 (GLES 3.0).
  {
    const SPOT_LVP_BASE_FLOAT = 132;
    const SPOT_LVP_LANE_COUNT = 4;
    const SPOT_LVP_FLOATS_PER_LANE = 16;
    const spotSnaps = spotShadowSnapshots;
    for (let i = 0; i < spotSnaps.length; i++) {
      const ss = spotSnaps[i];
      if (ss === undefined) continue;
      const tile = ss.shadowAtlasTile;
      const lvp = ss.lightViewProj;
      if (lvp === undefined) continue;
      const lane =
        tile >= 0 && tile < SPOT_LVP_LANE_COUNT ? tile : i === projectorSpotIndex ? 0 : -1;
      if (lane < 0) continue;
      const base = SPOT_LVP_BASE_FLOAT + lane * SPOT_LVP_FLOATS_PER_LANE;
      for (let f = 0; f < SPOT_LVP_FLOATS_PER_LANE; f++) {
        viewPayload[base + f] = lvp[f] ?? 0;
      }
    }
  }

  if (atmosphereCapture && atmosphere !== undefined) {
    viewPayload[290] = 1;
    viewPayload[317] = 0;
  }
  const viewUploadResult = queue.writeBuffer(viewUniformBuffer, byteOffset, viewPayload);
  if (!viewUploadResult.ok) throw viewUploadResult.error;

  // Auxiliary captures must not overwrite the display shadow view slots.
  if (byteOffset !== 0) return;
  for (const [index, composition] of TRANSLUCENT_FOG_COMPOSITIONS.entries()) {
    const translucentPayload = viewPayload.slice();
    translucentPayload[290] = index + 1;
    const uploaded = queue.writeBuffer(
      viewUniformBuffer,
      translucentViewOffset(composition),
      translucentPayload,
    );
    if (!uploaded.ok) throw uploaded.error;
  }
  for (const snapshot of lights.pointShadow ?? []) {
    if (snapshot.shadowAtlasLayer < 0 || snapshot.shadowAtlasLayer >= SHADOW_ATLAS_DEFAULT_LAYERS)
      continue;
    for (let face = 0; face < 6; face += 1) {
      const facePayload = viewPayload.slice();
      const matrix = snapshot.shadowMatrices.subarray(face * 16, (face + 1) * 16);
      facePayload.set(matrix, 28);
      const uploaded = queue.writeBuffer(
        viewUniformBuffer,
        pointShadowViewOffset(snapshot.shadowAtlasLayer, face),
        facePayload,
      );
      if (!uploaded.ok) throw uploaded.error;
    }
  }
}
