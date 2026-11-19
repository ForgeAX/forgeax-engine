import type { BrowserFrameSubmitted } from '@forgeax/engine/app';
import {
  summarizeSkyGpuPassTiming, type GpuPassTimingFrame, type GpuPassTimingObservation, type Renderer,
} from '@forgeax/engine/render';
import { cloudParameterLabels, conditionReasons, type CloudParameterKey } from './parameter-labels.ts';

export const CLOUD_MODES = ['uniform', 'shape', 'sample-ue', 'band', 'band-wide'] as const;
export type CloudMaterialMode = typeof CLOUD_MODES[number];
export type CloudMode = 'off' | CloudMaterialMode;
export type CloudView = 'normal' | 'transmittance' | 'contour';
export type CameraView = 'ground' | 'shadow' | 'ground-shadow';
export type CloudEdit = { -readonly [K in CloudParameterKey]?: (typeof cloudParameterLabels)[K]['kind'] extends 'boolean' ? boolean : number };
export interface CloudClock {
  readonly referenceTimeSeconds: number;
  readonly elapsedSeconds: number;
  readonly paused: boolean;
  readonly windOffsetMeters: readonly [number, number, number];
}
export interface CloudCamera {
  readonly pose: { x: number; y: number; z: number; yaw: number; pitch: number };
  readonly cameraView: CameraView;
  readonly routeTime: number | null;
  readonly fixtureVisible: boolean;
  readonly viewMode: CloudView;
}
export interface CloudAssets {
  readonly materialGuid: string;
  readonly instanceGuid: string | null;
  readonly cookIdentity: string;
  readonly instanceCookIdentity: string | null;
  readonly programIdentity: string | null;
}
export interface CloudConfiguration {
  readonly materialMode: CloudMaterialMode;
  readonly enabled: boolean;
  readonly parameters: CloudEdit;
  readonly clock: CloudClock;
  readonly camera: CloudCamera;
  readonly assets: CloudAssets;
}
export interface CloudPreset {
  readonly materialMode?: CloudMaterialMode;
  readonly enabled?: boolean;
  readonly parameters?: CloudEdit;
  readonly clock?: Partial<Omit<CloudClock, 'windOffsetMeters'>>;
  readonly camera?: Partial<CloudCamera>;
}
export interface ReadyCloudFrame {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly worldIdentity: string | null;
}
export interface CloudSnapshotV1 {
  readonly version: 1;
  readonly preset: string | null;
  readonly config: CloudConfiguration;
  /** Most recent ready completion at save time; no parameter correlation is implied. */
  readonly frame: ReadyCloudFrame | null;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: unknown, min: number, max: number): value is number =>
  finite(value) && value >= min && value <= max;
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === 'string' && options.some(option => option === value);
const nonnegativeInt = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;

export function validateCloudEdit(value: unknown): { edit: CloudEdit } | { field: string } {
  if (!isRecord(value)) return { field: 'fields' };
  const edit: Record<string, number | boolean> = {};
  for (const [field, next] of Object.entries(value)) {
    if (!Object.hasOwn(cloudParameterLabels, field)) return { field };
    const meta = cloudParameterLabels[field as CloudParameterKey];
    if (meta.kind === 'boolean' ? typeof next !== 'boolean'
      : !bounded(next, meta.min, meta.max) || (meta.integer && !Number.isInteger(next)))
      return { field };
    edit[field] = next as number | boolean;
  }
  return { edit };
}

export function unavailableParameter(key: CloudParameterKey, mode: CloudMode, fields: CloudEdit): string | undefined {
  const condition = cloudParameterLabels[key].condition;
  const enabled = mode !== 'off';
  const program = enabled && mode !== 'uniform';
  const available = {
    always: true, enabled, program, sampled: mode === 'shape' || mode === 'sample-ue',
    ray: program && fields.selfShadow === true && fields.shadowMode === 0,
    map: enabled && (fields.groundShadowEnabled === true || fields.atmosphereShadowEnabled === true ||
      (program && fields.selfShadow === true && fields.shadowMode === 1)),
    surface: enabled && fields.groundShadowEnabled === true,
    atmosphere: enabled && fields.atmosphereShadowEnabled === true,
    multiple: program && (fields.multiScatteringOctaves ?? 0) > 0,
  };
  return available[condition] ? undefined : enabled ? conditionReasons[condition] : conditionReasons.enabled;
}

function readCloudClock(clock: unknown): CloudClock | undefined {
  if (!isRecord(clock) || !bounded(clock.referenceTimeSeconds, 0, 9999999) ||
    !bounded(clock.elapsedSeconds, 0, 1e9) || typeof clock.paused !== 'boolean' ||
    !Array.isArray(clock.windOffsetMeters) || clock.windOffsetMeters.length !== 3) return;
  const [x, y, z] = clock.windOffsetMeters;
  if (!bounded(x, -2e11, 2e11) || !bounded(y, -2e11, 2e11) || !bounded(z, -2e11, 2e11)) return;
  return { referenceTimeSeconds: clock.referenceTimeSeconds, elapsedSeconds: clock.elapsedSeconds,
    paused: clock.paused, windOffsetMeters: [x, y, z] };
}

function readCloudCamera(camera: unknown): CloudCamera | undefined {
  if (!isRecord(camera) || !oneOf(camera.cameraView, ['ground', 'shadow', 'ground-shadow']) ||
    !oneOf(camera.viewMode, ['normal', 'transmittance', 'contour']) ||
    !(camera.routeTime === null || bounded(camera.routeTime, 0, 1e9)) || typeof camera.fixtureVisible !== 'boolean' ||
    !isRecord(camera.pose)) return;
  const { pose } = camera;
  if (!finite(pose.x) || !finite(pose.y) || !finite(pose.z) || !finite(pose.yaw) || !finite(pose.pitch)) return;
  return { pose: { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: pose.pitch },
    cameraView: camera.cameraView, routeTime: camera.routeTime, fixtureVisible: camera.fixtureVisible, viewMode: camera.viewMode };
}

function readCloudAssets(assets: unknown): CloudAssets | undefined {
  if (!isRecord(assets) || typeof assets.materialGuid !== 'string' || typeof assets.cookIdentity !== 'string' ||
    !(assets.instanceGuid === null || typeof assets.instanceGuid === 'string') ||
    !(assets.instanceCookIdentity === null || typeof assets.instanceCookIdentity === 'string') ||
    !(assets.programIdentity === null || typeof assets.programIdentity === 'string')) return;
  return { materialGuid: assets.materialGuid, instanceGuid: assets.instanceGuid, cookIdentity: assets.cookIdentity,
    instanceCookIdentity: assets.instanceCookIdentity, programIdentity: assets.programIdentity };
}

function readSnapshotFrame(frame: unknown): ReadyCloudFrame | null | undefined {
  if (frame === null) return null;
  if (!isRecord(frame) || !nonnegativeInt(frame.frameId) || !nonnegativeInt(frame.deviceGeneration) ||
    !(frame.worldIdentity === null || typeof frame.worldIdentity === 'string')) return;
  return { frameId: frame.frameId, deviceGeneration: frame.deviceGeneration, worldIdentity: frame.worldIdentity };
}

export function readCloudSnapshot(value: unknown): CloudSnapshotV1 | undefined {
  if (!isRecord(value) || value.version !== 1 ||
    !(value.preset === null || (typeof value.preset === 'string' && value.preset.length <= 128))) return;
  const { config } = value;
  if (!isRecord(config) || !oneOf(config.materialMode, CLOUD_MODES) || typeof config.enabled !== 'boolean') return;
  const edit = validateCloudEdit(config.parameters);
  if (!('edit' in edit) || edit.edit.referenceTimeSeconds !== undefined) return;
  const clock = readCloudClock(config.clock);
  const camera = readCloudCamera(config.camera);
  const assets = readCloudAssets(config.assets);
  const frame = readSnapshotFrame(value.frame);
  if (!clock || !camera || !assets || frame === undefined) return;
  return { version: 1, preset: value.preset,
    config: { materialMode: config.materialMode, enabled: config.enabled, parameters: edit.edit, clock, camera, assets },
    frame,
  };
}

type CloudFrameEpoch = Pick<ReadyCloudFrame, 'deviceGeneration' | 'worldIdentity'>;
type TimingSourceFrame = ReadyCloudFrame & { readonly graphGeneration: number | null };
type ReceiptTiming = TimingSourceFrame & {
  readonly observation: GpuPassTimingObservation | null;
  readonly reason: string | null;
};
type MissingTimingStatus = 'warming-up' | 'no-data' | 'unavailable' | 'failed';
type TimingInvalidation = 'epoch-changed' | 'renderer-not-alive';
const SAMPLE_INTERVAL_MS = 500;
const CLOUD_MINIMUM_SAMPLES = 5;
const TIMING_WINDOW_CAPACITY = 60;

/** Time from the earliest pass start to the latest end, including gaps. */
function gpuFrameMilliseconds(frame: GpuPassTimingFrame): number | null {
  if (frame.executedPassCount === 0 || frame.droppedPassCount !== 0 ||
    frame.measuredPassCount !== frame.executedPassCount || frame.passes.length !== frame.executedPassCount) return null;
  let first: bigint | undefined;
  let last: bigint | undefined;
  for (const pass of frame.passes) {
    if (pass.status !== 'measured') return null;
    const start = BigInt(pass.beginningTick);
    const end = BigInt(pass.endTick);
    if (first === undefined || start < first) first = start;
    if (last === undefined || end > last) last = end;
  }
  return first === undefined || last === undefined ? null
    : Number(last - first) * frame.timestampPeriodNanoseconds / 1e6;
}

export function sameCloudFrameEpoch(left: CloudFrameEpoch, right: CloudFrameEpoch): boolean {
  return left.deviceGeneration === right.deviceGeneration && left.worldIdentity === right.worldIdentity;
}

export function receiptTimingMatchesCompletion(source: ReadyCloudFrame, completed: ReadyCloudFrame | null): boolean {
  return completed !== null && sameCloudFrameEpoch(source, completed) && source.frameId <= completed.frameId;
}

export type CloudRenderEvidence = ReturnType<ReturnType<typeof observeCloudRenderer>['read']>;

function missingTiming(
  matching: ReceiptTiming | null, renderer: Renderer | undefined, alive: boolean, hasCompletion: boolean,
): { status: MissingTimingStatus; reason: string } {
  const observation = matching?.observation;
  const status = !alive ? 'unavailable' : matching?.reason || observation?.status === 'failed'
    ? 'failed' : observation?.status === 'unavailable' ? 'unavailable' : hasCompletion ? 'no-data' : 'warming-up';
  const reason = matching?.reason ?? (observation?.status === 'failed' ? observation.error.code
    : observation?.status === 'unavailable' ? observation.reason.code : !renderer
      ? 'receipt-and-renderer-inspection-unavailable-on-presentation-host'
      : !alive ? 'renderer-not-alive' : hasCompletion ? 'waiting-for-timing-observation' : 'waiting-for-ready-frame');
  return { status, reason };
}

function readFrameTiming(
  milliseconds: number | null, observation: GpuPassTimingObservation | null | undefined,
  missingStatus: MissingTimingStatus, reason: string,
) {
  if (milliseconds !== null) return { status: 'ready' as const, reason: null };
  if (observation?.status === 'partial') return { status: 'unavailable' as const, reason: observation.reason.code };
  if (observation?.status === 'complete') return { status: 'unavailable' as const, reason: 'no-complete-pass-coverage' };
  return { status: missingStatus, reason };
}

function readCompleteSky(
  sky: ReturnType<typeof summarizeSkyGpuPassTiming>['completeSky'] | undefined,
  status: MissingTimingStatus, reason: string,
) {
  if (sky?.status === 'ready') return sky;
  return { status: sky?.status ?? status, milliseconds: null, reason: sky?.reason ?? reason };
}

function timingFrameIdentity(receipt: ReceiptTiming | null): TimingSourceFrame | null {
  if (!receipt) return null;
  const { frameId, deviceGeneration, worldIdentity, graphGeneration } = receipt;
  return { frameId, deviceGeneration, worldIdentity, graphGeneration };
}

function readCloudBudget(
  cloud: ReturnType<typeof summarizeSkyGpuPassTiming>['cloud'] | undefined, p95GpuMs: number | null,
  status: MissingTimingStatus, reason: string,
) {
  if (cloud?.status !== 'ready') {
    return { status: cloud?.status ?? status, reason: cloud?.reason ?? reason, p95GpuMs,
      latestGpuMs: null, passCount: null };
  }
  const timing = { p95GpuMs, latestGpuMs: cloud.milliseconds, passCount: cloud.passCount };
  return p95GpuMs === null
    ? { status: 'warming-up' as const, reason: 'collecting-cloud-samples', ...timing }
    : { status: 'ready' as const, reason: null, ...timing };
}

/** The App supplies the exact receipt and the World that submitted it. */
export function observeCloudRenderer(
  renderer: Renderer | undefined,
  now = () => performance.now(),
  onInvalidated?: (reason: TimingInvalidation) => void,
) {
  let epoch: CloudFrameEpoch | null = null;
  const retiredWorlds = new Set<string | null>();
  let raw: ReceiptTiming | null = null;
  let staged: ReceiptTiming | null = null;
  let pending: TimingSourceFrame | null = null;
  let lastRequestedFrame = -1;
  let at = -Infinity;
  let active = true;
  let summary: ReturnType<typeof summarizeSkyGpuPassTiming> | null = null;
  const cloudSamples: { frameId: number; milliseconds: number }[] = [];
  let p95GpuMs: number | null = null;
  const gpuSamples: number[] = [];
  let frameGpuMs: number | null = null;
  let p50GpuMs: number | null = null;
  const clear = () => {
    raw = staged = pending = summary = null;
    at = -Infinity;
    lastRequestedFrame = -1;
    cloudSamples.length = 0;
    p95GpuMs = null;
    gpuSamples.length = 0;
    frameGpuMs = p50GpuMs = null;
  };
  const acceptEpoch = (worldIdentity: string | null, deviceGeneration: number) => {
    if (retiredWorlds.has(worldIdentity)) return false;
    if (epoch?.worldIdentity === worldIdentity) {
      if (deviceGeneration === epoch.deviceGeneration) return true;
      if (deviceGeneration < epoch.deviceGeneration) return false;
    } else if (epoch) {
      retiredWorlds.add(epoch.worldIdentity);
    }
    const replaced = epoch !== null;
    clear();
    epoch = { worldIdentity, deviceGeneration };
    if (replaced) onInvalidated?.('epoch-changed');
    return true;
  };
  const unsubscribe = renderer?.subscribe(event => {
    if (event.kind === 'state-changed' && event.current !== 'alive') {
      clear();
      onInvalidated?.('renderer-not-alive');
    }
  });
  const acceptTiming = (accepted: ReceiptTiming) => {
    if (raw?.graphGeneration !== accepted.graphGeneration) gpuSamples.length = 0;
    raw = accepted;
    staged = null;
    const timed = accepted.observation;
    summary = timed && 'frame' in timed ? summarizeSkyGpuPassTiming(timed.frame) : null;
    frameGpuMs = timed?.status === 'complete' ? gpuFrameMilliseconds(timed.frame) : null;
    if (frameGpuMs !== null) {
      gpuSamples.push(frameGpuMs);
      if (gpuSamples.length > TIMING_WINDOW_CAPACITY) gpuSamples.shift();
      const ordered = gpuSamples.slice().sort((a, b) => a - b);
      const middle = Math.floor(ordered.length / 2);
      p50GpuMs = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
    } else {
      gpuSamples.length = 0;
      p50GpuMs = null;
    }
    const cloud = summary?.cloud;
    if (cloud?.status === 'ready') {
      cloudSamples.push({ frameId: accepted.frameId, milliseconds: cloud.milliseconds });
      if (cloudSamples.length > TIMING_WINDOW_CAPACITY) cloudSamples.shift();
      if (cloudSamples.length >= CLOUD_MINIMUM_SAMPLES) {
        const ordered = cloudSamples.map(sample => sample.milliseconds).sort((a, b) => a - b);
        p95GpuMs = ordered[Math.ceil(0.95 * ordered.length) - 1];
      }
    } else {
      // A missing cloud timing breaks the window; never show an older cohort as current.
      cloudSamples.length = 0;
      p95GpuMs = null;
    }
  };
  return {
    submit(event: BrowserFrameSubmitted) {
      const { receipt, worldIdentity, deviceGeneration, frameId } = event;
      if (!active || !renderer || worldIdentity === undefined || renderer.state() !== 'alive' ||
        !acceptEpoch(worldIdentity, deviceGeneration) || receipt?.presentation !== 'ready' ||
        receipt.frameId !== frameId || receipt.deviceGeneration !== deviceGeneration ||
        event.graphGeneration !== receipt.graphGeneration || pending || staged || frameId <= lastRequestedFrame) return;
      const timestamp = now();
      if (timestamp - at < SAMPLE_INTERVAL_MS) return;
      const source = { worldIdentity, deviceGeneration, frameId, graphGeneration: receipt.graphGeneration ?? null };
      pending = source;
      lastRequestedFrame = frameId;
      at = timestamp;
      const settle = (observation: GpuPassTimingObservation | null, reason: string | null) => {
        if (pending !== source) return;
        pending = null;
        if (active && renderer.state() === 'alive' &&
          renderer.inspect({ fields: ['frame'] }).frame.deviceGeneration === deviceGeneration) {
          staged = { ...source, observation, reason };
        }
      };
      void renderer.observe(receipt, { include: ['timings'] }).then(result => {
        if (!result.ok) return settle(null, result.error.code);
        const { timings } = result.value;
        const frame = timings && 'frame' in timings ? timings.frame : undefined;
        if (result.value.frameId !== frameId || result.value.deviceGeneration !== deviceGeneration ||
          (frame && (frame.frameId !== frameId || frame.deviceGeneration !== deviceGeneration ||
            frame.graphGeneration !== source.graphGeneration))) {
          return settle(null, 'timing-receipt-mismatch');
        }
        settle(timings ?? null, timings ? null : 'timing-observation-missing');
      }).catch(() => settle(null, 'observation-failed'));
    },
    acceptCompletedEpoch(completed: ReadyCloudFrame) {
      if (active && renderer?.state() === 'alive') acceptEpoch(completed.worldIdentity, completed.deviceGeneration);
    },
    read(completed: ReadyCloudFrame | null) {
      const layer = renderer?.inspect({ fields: ['cloudLayer'] }).cloudLayer;
      const alive = renderer?.state() === 'alive';
      const currentCompletion = alive && completed && acceptEpoch(completed.worldIdentity, completed.deviceGeneration)
        ? completed : null;
      if (staged && receiptTimingMatchesCompletion(staged, currentCompletion)) acceptTiming(staged);
      const matching = raw && receiptTimingMatchesCompletion(raw, currentCompletion) ? raw : null;
      const observation = matching?.observation;
      const { status: missingStatus, reason } = missingTiming(matching, renderer, alive, currentCompletion !== null);
      const sourceFrame = timingFrameIdentity(matching);
      const currentSummary = matching ? summary : null;
      const currentFrameMs = matching ? frameGpuMs : null;
      const frameTiming = readFrameTiming(currentFrameMs, observation, missingStatus, reason);
      const completeSky = readCompleteSky(currentSummary?.completeSky, missingStatus, reason);
      const cloudBudget = readCloudBudget(currentSummary?.cloud, matching ? p95GpuMs : null, missingStatus, reason);
      return {
        renderer: {
          status: layer ? 'observed' : 'unavailable',
          layer: layer ?? null,
          parameterAdoption: null,
          reason: renderer ? 'presentation-host-does-not-correlate-current-world-requests'
            : 'receipt-and-renderer-inspection-unavailable-on-presentation-host',
        },
        gpu: {
          sourceFrame,
          frameTiming: {
            ...frameTiming,
            milliseconds: currentFrameMs,
            p50Milliseconds: matching ? p50GpuMs : null,
            sampleCount: matching ? gpuSamples.length : 0,
          },
          completeSky,
          raw: matching,
          rawStatus: observation?.status ?? missingStatus,
          cloudBudget: {
            ...cloudBudget,
            sampleCount: matching ? cloudSamples.length : 0,
            firstFrameId: matching ? cloudSamples[0]?.frameId ?? null : null,
            minimumSamples: CLOUD_MINIMUM_SAMPLES,
            capacity: TIMING_WINDOW_CAPACITY,
          },
        },
      };
    },
    dispose() { active = false; clear(); unsubscribe?.(); },
  };
}
