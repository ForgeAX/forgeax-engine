import type { CloudQuality } from '../components/cloud-layer';

export type CloudTemporalResetReason =
  | 'authoring-generation'
  | 'camera-cut'
  | 'resize'
  | 'recovery'
  | 'time-discontinuity'
  | 'cloud-shadow-revision'
  | 'device-generation'
  | 'history-missing'
  | 'reprojection-outside'
  | 'scene-depth-disocclusion';

export interface CloudTemporalSignature {
  readonly sourceKey: string;
  readonly viewId: string;
  readonly authoringGeneration: number;
  readonly cloudShadowRevision: number;
  readonly cameraRevision: number;
  readonly deviceGeneration: number;
  readonly width: number;
  readonly height: number;
  readonly timeSeconds: number;
  readonly quality: CloudQuality;
  /** Scene-depth producer revision used to reject disoccluded history. */
  readonly sceneDepthVersion?: number;
}

export interface CloudHistory {
  readonly width: number;
  readonly height: number;
  readonly signature: string;
  readonly temporal: CloudTemporalSignature;
  readonly generation: number;
  readonly valid: boolean;
}

export interface CloudTemporalDecision {
  readonly reset: boolean;
  readonly reasons: readonly CloudTemporalResetReason[];
  readonly signature: string;
  readonly history: CloudHistory | undefined;
}

export interface CloudTemporalFrame {
  readonly signature: CloudTemporalSignature;
  readonly history: CloudHistory | undefined;
  readonly reset: boolean;
  readonly reasons: readonly CloudTemporalResetReason[];
}

export interface CloudHistoryReprojectionInput {
  readonly currentDepth: number;
  readonly historyDepth: number;
  readonly motion: readonly [number, number];
  readonly currentPixel: readonly [number, number];
  readonly historySize: readonly [number, number];
  readonly depthTolerance?: number;
}

export interface CloudHistoryReprojection {
  readonly accepted: boolean;
  readonly historyUv: readonly [number, number];
  readonly weight: number;
  readonly reason: 'accepted' | 'outside' | 'depth-disocclusion';
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

export function cloudTemporalSignature(input: CloudTemporalSignature): string {
  return [
    'cloud-temporal-v1',
    input.viewId,
    input.sourceKey,
    input.authoringGeneration,
    input.cloudShadowRevision,
    input.cameraRevision,
    input.deviceGeneration,
    input.width,
    input.height,
    input.timeSeconds,
    input.quality,
    input.sceneDepthVersion ?? 0,
  ].join(':');
}

function sameLayout(left: CloudTemporalSignature, right: CloudTemporalSignature): boolean {
  return left.viewId === right.viewId && left.width === right.width && left.height === right.height;
}

/** Compare the facts that make a cloud history safe to reuse. */
export function cloudTemporalResetReasons(
  previous: CloudTemporalSignature | undefined,
  next: CloudTemporalSignature,
  options: { readonly cameraCut?: boolean; readonly recovery?: boolean } = {},
): readonly CloudTemporalResetReason[] {
  if (previous === undefined) return ['history-missing'];
  const reasons: CloudTemporalResetReason[] = [];
  if (
    previous.sourceKey !== next.sourceKey ||
    previous.authoringGeneration !== next.authoringGeneration
  ) {
    reasons.push('authoring-generation');
  }
  if (previous.cloudShadowRevision !== next.cloudShadowRevision)
    reasons.push('cloud-shadow-revision');
  if (previous.deviceGeneration !== next.deviceGeneration) reasons.push('device-generation');
  if (
    previous.sceneDepthVersion !== undefined &&
    next.sceneDepthVersion !== undefined &&
    previous.sceneDepthVersion !== next.sceneDepthVersion
  ) {
    reasons.push('scene-depth-disocclusion');
  }
  if (!sameLayout(previous, next)) reasons.push('resize');
  if (options.cameraCut === true || previous.cameraRevision !== next.cameraRevision)
    reasons.push('camera-cut');
  const dt = next.timeSeconds - previous.timeSeconds;
  if (!Number.isFinite(dt) || dt < 0 || dt > 0.5) reasons.push('time-discontinuity');
  if (options.recovery === true) reasons.push('recovery');
  return Object.freeze(reasons);
}

export function createCloudHistory(
  signature: CloudTemporalSignature,
  generation: number,
  valid = false,
): CloudHistory {
  return Object.freeze({
    width: Math.max(1, Math.floor(signature.width)),
    height: Math.max(1, Math.floor(signature.height)),
    signature: cloudTemporalSignature(signature),
    temporal: Object.freeze({ ...signature }),
    generation,
    valid,
  });
}

/** Per-view histories are keyed by the renderer's view identity. */
export class CloudHistoryStore {
  private readonly maxViews: number;
  private readonly entries = new Map<
    string,
    { readonly history: CloudHistory; readonly signature: CloudTemporalSignature }
  >();

  constructor(maxViews = 4) {
    this.maxViews = Math.max(1, Math.floor(maxViews));
  }

  begin(
    signature: CloudTemporalSignature,
    options: { readonly cameraCut?: boolean; readonly recovery?: boolean } = {},
  ): CloudTemporalDecision {
    const key = signature.viewId;
    const previousEntry = this.entries.get(key);
    const previous = previousEntry?.history;
    const reasons = cloudTemporalResetReasons(previousEntry?.signature, signature, options);
    const reset = reasons.length > 0;
    return Object.freeze({
      reset,
      reasons,
      signature: cloudTemporalSignature(signature),
      history: reset ? undefined : previous,
    });
  }

  commit(signature: CloudTemporalSignature, history: CloudHistory): void {
    if (
      history.width !== Math.max(1, Math.floor(signature.width)) ||
      history.height !== Math.max(1, Math.floor(signature.height))
    ) {
      this.entries.delete(signature.viewId);
      return;
    }
    this.entries.set(signature.viewId, { history, signature: Object.freeze({ ...signature }) });
    while (this.entries.size > this.maxViews) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  retain(viewIds: ReadonlySet<string>): void {
    for (const viewId of this.entries.keys()) {
      if (!viewIds.has(viewId)) this.entries.delete(viewId);
    }
  }

  reset(viewId?: string): void {
    if (viewId === undefined) this.entries.clear();
    else this.entries.delete(viewId);
  }

  get(viewId: string): CloudHistory | undefined {
    return this.entries.get(viewId)?.history;
  }

  dispose(): void {
    this.entries.clear();
  }
}

/** Project one current pixel into the previous cloud history. */
export function reprojectCloudHistory(
  input: CloudHistoryReprojectionInput,
  historyWeight = 0.9,
): CloudHistoryReprojection {
  const width = Math.max(1, input.historySize[0] ?? 1);
  const height = Math.max(1, input.historySize[1] ?? 1);
  const uv: [number, number] = [
    ((input.currentPixel[0] ?? 0) - (input.motion[0] ?? 0)) / width,
    ((input.currentPixel[1] ?? 0) - (input.motion[1] ?? 0)) / height,
  ];
  if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) {
    return { accepted: false, historyUv: uv, weight: 0, reason: 'outside' };
  }
  const depthTolerance =
    input.depthTolerance ?? Math.max(0.01, Math.abs(input.currentDepth) * 0.02);
  if (
    !Number.isFinite(input.currentDepth) ||
    !Number.isFinite(input.historyDepth) ||
    Math.abs(input.currentDepth - input.historyDepth) > depthTolerance
  ) {
    return { accepted: false, historyUv: uv, weight: 0, reason: 'depth-disocclusion' };
  }
  return {
    accepted: true,
    historyUv: uv,
    weight: Math.min(0.99, Math.max(0, historyWeight)),
    reason: 'accepted',
  };
}
