import { mat4 } from '@forgeax/engine-math';
import { cameraLensProjection, jitterCameraProjection } from '../camera-projection';
import type { CameraSnapshot } from '../render-contract';
import { temporalJitterSample, temporalJitterSampleCount } from './view';

/** TAAU shares the temporal view owner; its internal dimensions are optional. */
export const TEMPORAL_TAAU_DEPENDENCY_STATUS = 'available' as const;

export type TemporalViewResetReason =
  | 'first-frame'
  | 'camera-switch'
  | 'history-version-changed'
  | 'projection-kind-changed'
  | 'projection-range-changed';

export interface SubmittedTemporalView extends Pick<CameraSnapshot, 'projection' | 'near' | 'far'> {
  readonly viewId: string;
  readonly historyVersion: number;
  readonly jitterUv: readonly [number, number];
  readonly unjitteredViewProjection: Float32Array;
}

export interface TemporalView extends Pick<CameraSnapshot, 'projection' | 'near' | 'far'> {
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

export function temporalViewId(entityKey: number): string {
  const raw = entityKey >>> 0;
  const index = raw & 0x00ffffff;
  const generation = (raw >>> 24) & 0xff;
  return `${index}:${generation}`;
}

function temporalJitterUv(
  camera: CameraSnapshot,
  temporalFrameIndex: number,
  internalWidth: number,
  internalHeight: number,
  outputWidth: number,
): readonly [number, number] {
  const mode = camera.antialias === 'tsr' ? 'tsr' : 'taa';
  const count = temporalJitterSampleCount(mode, internalWidth / Math.max(1, outputWidth));
  const sample = temporalJitterSample(Math.max(0, Math.trunc(temporalFrameIndex)) % count);
  return [sample[0] / Math.max(1, internalWidth), sample[1] / Math.max(1, internalHeight)];
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

function createTemporalScratch() {
  return { view: mat4.create(), projection: mat4.create(), jitteredProjection: mat4.create() };
}
let temporalScratch: ReturnType<typeof createTemporalScratch> | undefined;
let projectingTemporal = false;

export function projectTemporalView(input: TemporalViewInput): TemporalView {
  const outer = projectingTemporal;
  if (!outer && temporalScratch === undefined) temporalScratch = createTemporalScratch();
  const scratch = outer
    ? createTemporalScratch()
    : (temporalScratch as ReturnType<typeof createTemporalScratch>);
  projectingTemporal = true;
  try {
    const { camera } = input;
    const viewId = temporalViewId(camera.entityKey ?? 0);
    const currentJitterUv = temporalJitterUv(
      camera,
      input.temporalFrameIndex,
      input.internalWidth ?? input.surfaceWidth,
      input.internalHeight ?? input.surfaceHeight,
      input.surfaceWidth,
    );
    const view = mat4.invert(scratch.view, camera.world);
    const projection = cameraLensProjection(camera, scratch.projection);
    const currentUnjitteredViewProjection = mat4.multiply(mat4.create(), projection, view);
    const jitteredProjection = jitterCameraProjection(
      scratch.jitteredProjection,
      projection,
      currentJitterUv,
    );
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
  } finally {
    projectingTemporal = outer;
  }
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
