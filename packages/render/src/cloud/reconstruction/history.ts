import type { RhiDevice } from '@forgeax/engine-rhi';

export interface CloudHistoryLighting {
  readonly directionToLight: readonly [number, number, number];
  readonly illuminance: readonly [number, number, number];
}

export interface CloudHistoryStamp {
  readonly lighting?: CloudHistoryLighting | undefined;
  readonly viewId: string;
  readonly width: number;
  readonly height: number;
  readonly deviceGeneration: number;
  readonly materialIdentity: string;
  readonly policyIdentity: string;
  readonly initializationRevision: number;
  readonly exposure: number;
  readonly cameraCut?: boolean;
}

export type CloudHistoryResetReason =
  | 'history-missing'
  | 'view-changed'
  | 'resize'
  | 'device-generation'
  | 'material-changed'
  | 'policy-changed'
  | 'initialization'
  | 'camera-cut'
  | 'lighting-changed';
// Direction and spectrum are compared numerically, outside the structural policy signature.
const CLOUD_HISTORY_SOLAR_COSINE = Math.cos((0.25 * Math.PI) / 180);

function lightingChanged(
  previous: CloudHistoryLighting | undefined,
  current: CloudHistoryLighting | undefined,
): boolean {
  if (previous === undefined || current === undefined) return previous !== current;
  const a = previous.directionToLight,
    b = current.directionToLight;
  const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  if (!Number.isFinite(cosine) || cosine < CLOUD_HISTORY_SOLAR_COSINE) return true;
  return previous.illuminance.some((value, channel) => {
    const next = current.illuminance[channel] ?? 0;
    return Math.abs(value - next) > 0.1 * Math.max(0.01, value, next);
  });
}

export interface AcceptedCloudHistory<T> {
  readonly stamp: CloudHistoryStamp;
  readonly resource: T;
  readonly frame: number;
}

export interface CloudHistoryCandidate<T> {
  readonly stamp: CloudHistoryStamp;
  readonly phase: number;
  readonly pixelOffset: readonly [number, number];
  readonly history: AcceptedCloudHistory<T> | undefined;
  readonly resetReasons: readonly CloudHistoryResetReason[];
}

export interface CloudHistoryState<T> {
  accepted: AcceptedCloudHistory<T> | undefined;
  prepared: CloudHistoryCandidate<T> | undefined;
  completedFrames: number;
}

export function createCloudHistoryState<T>(): CloudHistoryState<T> {
  return { accepted: undefined, prepared: undefined, completedFrames: 0 };
}

/** Revoke pending receipts before recovery, teardown or a discontinuous input is installed. */
export function invalidateCloudHistory<T>(state: CloudHistoryState<T>): void {
  state.prepared = undefined;
  state.accepted = undefined;
  state.completedFrames = 0;
}

function historyResetReasons(
  previous: CloudHistoryStamp | undefined,
  stamp: CloudHistoryStamp,
): CloudHistoryResetReason[] {
  const reasons: CloudHistoryResetReason[] = [];
  if (previous === undefined) reasons.push('history-missing');
  else {
    if (previous.viewId !== stamp.viewId) reasons.push('view-changed');
    if (previous.width !== stamp.width || previous.height !== stamp.height) reasons.push('resize');
    if (previous.deviceGeneration !== stamp.deviceGeneration) reasons.push('device-generation');
    if (previous.materialIdentity !== stamp.materialIdentity) reasons.push('material-changed');
    if (previous.policyIdentity !== stamp.policyIdentity) reasons.push('policy-changed');
    if (previous.initializationRevision !== stamp.initializationRevision)
      reasons.push('initialization');
    if (lightingChanged(previous.lighting, stamp.lighting)) reasons.push('lighting-changed');
  }
  if (stamp.cameraCut === true) reasons.push('camera-cut');
  return reasons;
}

export function prepareCloudHistory<T>(
  state: CloudHistoryState<T>,
  stamp: CloudHistoryStamp,
): CloudHistoryCandidate<T> {
  if (state.prepared !== undefined) throw new Error('Cloud history already has a prepared frame');
  if (
    !Number.isSafeInteger(stamp.width) ||
    stamp.width <= 0 ||
    !Number.isSafeInteger(stamp.height) ||
    stamp.height <= 0 ||
    !Number.isFinite(stamp.exposure) ||
    stamp.exposure <= 0
  )
    throw new RangeError('Cloud history requires positive integer dimensions and finite exposure');
  const reasons = historyResetReasons(state.accepted?.stamp, stamp);
  const phase = reasons.length > 0 ? 0 : state.completedFrames % 4;
  const offset = [0, 2, 3, 1][phase] ?? 0;
  const candidate: CloudHistoryCandidate<T> = Object.freeze({
    stamp: Object.freeze({
      ...stamp,
      lighting:
        stamp.lighting === undefined
          ? undefined
          : Object.freeze({
              directionToLight: Object.freeze([...stamp.lighting.directionToLight]) as readonly [
                number,
                number,
                number,
              ],
              illuminance: Object.freeze([...stamp.lighting.illuminance]) as readonly [
                number,
                number,
                number,
              ],
            }),
    }),
    phase,
    pixelOffset: Object.freeze([offset % 2, Math.floor(offset / 2)]) as readonly [number, number],
    history: reasons.length === 0 ? state.accepted : undefined,
    resetReasons: Object.freeze(reasons),
  });
  state.prepared = candidate;
  return candidate;
}

/** Only the Renderer receipt accepting this exact candidate can publish its resources. */
export function acceptCloudHistory<T>(
  state: CloudHistoryState<T>,
  candidate: CloudHistoryCandidate<T>,
  resource: T,
): boolean {
  if (state.prepared !== candidate) return false;
  state.completedFrames = candidate.resetReasons.length > 0 ? 1 : state.completedFrames + 1;
  state.accepted = Object.freeze({
    stamp: candidate.stamp,
    resource,
    frame: state.completedFrames,
  });
  state.prepared = undefined;
  return true;
}

export function abortCloudHistory<T>(
  state: CloudHistoryState<T>,
  candidate: CloudHistoryCandidate<T>,
): boolean {
  if (state.prepared !== candidate) return false;
  state.prepared = undefined;
  return true;
}

export type CloudTransportFormat = 'rgba16float' | 'rgba32float';

/** A Mode 0 view needs three 16-byte attachments and a filterable, blendable HDR resolve. */
export function cloudMode0TransportFormat(device: RhiDevice): CloudTransportFormat {
  return device.caps.float32Filterable &&
    device.features.has('float32-blendable') &&
    (device.limits?.maxColorAttachmentBytesPerSample ?? 32) >= 48
    ? 'rgba32float'
    : 'rgba16float';
}

/** Physical transport history extent; signatures retain the full view extent. */
export function cloudHistoryExtent(
  width: number,
  height: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.ceil(width / 2)),
    height: Math.max(1, Math.ceil(height / 2)),
  };
}
