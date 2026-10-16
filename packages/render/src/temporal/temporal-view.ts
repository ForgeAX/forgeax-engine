import { mat4 } from '@forgeax/engine-math';
import { cameraLensProjection } from '../camera-projection';
import type { CameraProjection } from '../components/camera';
import type { CameraSnapshot } from '../render-contract';

export const TEMPORAL_JITTER_SAMPLE_COUNT = 8;

/** TAAU shares the temporal view owner; its internal dimensions are optional. */
export const TEMPORAL_TAAU_DEPENDENCY_STATUS = 'available' as const;

export type TemporalViewResetReason =
  | 'first-frame'
  | 'camera-switch'
  | 'history-version-changed'
  | 'projection-kind-changed'
  | 'projection-range-changed';

export interface SubmittedTemporalView {
  readonly viewId: string;
  readonly historyVersion: number;
  readonly projection: CameraProjection;
  readonly near: number;
  readonly far: number;
  readonly jitterUv: readonly [number, number];
  readonly unjitteredViewProjection: Float32Array;
}

export interface TemporalView {
  readonly viewId: string;
  readonly historyVersion: number;
  readonly temporalFrameIndex: number;
  readonly historyValid: boolean;
  readonly resetReason: TemporalViewResetReason | undefined;
  readonly currentJitterUv: readonly [number, number];
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly previousJitterUv: readonly [number, number];
  readonly currentJitteredViewProjection: Float32Array;
  readonly currentUnjitteredViewProjection: Float32Array;
  readonly previousUnjitteredViewProjection: Float32Array;
  readonly projection: CameraProjection;
  readonly near: number;
  readonly far: number;
}

export interface TemporalViewInput {
  readonly camera: CameraSnapshot;
  readonly temporalFrameIndex: number;
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
  readonly internalWidth?: number;
  readonly internalHeight?: number;
  readonly lastSubmitted?: SubmittedTemporalView;
}

export function temporalViewId(worldId: number, entityKey: number): string {
  const raw = entityKey >>> 0;
  const index = raw & 0x00ffffff;
  const generation = (raw >>> 24) & 0xff;
  return `${worldId}:${index}:${generation}`;
}

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let value = index;
  while (value > 0) {
    result += fraction * (value % base);
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

export function temporalJitterSample(temporalFrameIndex: number): readonly [number, number] {
  const sampleIndex =
    ((Math.trunc(temporalFrameIndex) % TEMPORAL_JITTER_SAMPLE_COUNT) +
      TEMPORAL_JITTER_SAMPLE_COUNT) %
    TEMPORAL_JITTER_SAMPLE_COUNT;
  const haltonIndex = sampleIndex + 1;
  return [halton(haltonIndex, 2) - 0.5, halton(haltonIndex, 3) - 0.5];
}

function temporalJitterUv(
  temporalFrameIndex: number,
  surfaceWidth: number,
  surfaceHeight: number,
): readonly [number, number] {
  const sample = temporalJitterSample(temporalFrameIndex);
  return [sample[0] / Math.max(1, surfaceWidth), sample[1] / Math.max(1, surfaceHeight)];
}

function resetReason(
  current: CameraSnapshot,
  viewId: string,
  previous: SubmittedTemporalView | undefined,
): TemporalViewResetReason | undefined {
  if (previous === undefined) return 'first-frame';
  if (previous.viewId !== viewId) return 'camera-switch';
  if (previous.historyVersion !== (current.historyVersion ?? 0)) {
    return 'history-version-changed';
  }
  if (previous.projection !== current.projection) return 'projection-kind-changed';
  if (!Object.is(previous.near, current.near) || !Object.is(previous.far, current.far)) {
    return 'projection-range-changed';
  }
  return undefined;
}

export function projectTemporalView(input: TemporalViewInput): TemporalView {
  const { camera } = input;
  const viewId = temporalViewId(camera.worldId ?? 0, camera.entityKey ?? 0);
  const currentJitterUv = temporalJitterUv(
    input.temporalFrameIndex,
    input.internalWidth ?? input.surfaceWidth,
    input.internalHeight ?? input.surfaceHeight,
  );
  const view = mat4.invert(mat4.create(), camera.world);
  const projection = cameraLensProjection(camera);
  const currentUnjitteredViewProjection = mat4.multiply(mat4.create(), projection, view);
  const clipJitter = mat4.identity(mat4.create());
  clipJitter[12] = currentJitterUv[0] * 2;
  clipJitter[13] = currentJitterUv[1] * -2;
  const jitteredProjection = mat4.multiply(mat4.create(), clipJitter, projection);
  const currentJitteredViewProjection = mat4.multiply(mat4.create(), jitteredProjection, view);
  const reason = resetReason(camera, viewId, input.lastSubmitted);
  const historyValid = reason === undefined;
  return {
    viewId,
    historyVersion: camera.historyVersion ?? 0,
    temporalFrameIndex: input.temporalFrameIndex,
    historyValid,
    resetReason: reason,
    currentJitterUv,
    internalWidth: input.internalWidth ?? input.surfaceWidth,
    internalHeight: input.internalHeight ?? input.surfaceHeight,
    previousJitterUv: historyValid
      ? (input.lastSubmitted?.jitterUv ?? currentJitterUv)
      : currentJitterUv,
    currentJitteredViewProjection,
    currentUnjitteredViewProjection,
    previousUnjitteredViewProjection: historyValid
      ? (input.lastSubmitted?.unjitteredViewProjection ?? currentUnjitteredViewProjection)
      : currentUnjitteredViewProjection,
    projection: camera.projection,
    near: camera.near,
    far: camera.far,
  };
}

export function snapshotSubmittedTemporalView(view: TemporalView): SubmittedTemporalView {
  return {
    viewId: view.viewId,
    historyVersion: view.historyVersion,
    projection: view.projection,
    near: view.near,
    far: view.far,
    jitterUv: [view.currentJitterUv[0], view.currentJitterUv[1]],
    unjitteredViewProjection: new Float32Array(view.currentUnjitteredViewProjection),
  };
}
