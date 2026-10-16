import type {
  Buffer,
  RhiDevice,
  RhiError,
  RhiQueue,
  Texture,
  TextureDescriptor,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';

export const SSR_HISTORY_FORMAT = 'rgba16float' as const;
export type SsrHistoryResetReason =
  | 'first-enable'
  | 'resize'
  | 'camera-cut'
  | 'history-version'
  | 'coverage-loss'
  | 'reflection-generation'
  | 'device-recovery'
  | 'disable';
export type SsrHistoryFailureStage = 'build' | 'encode' | 'finish' | 'submit';
export type SsrHistoryState =
  | 'first-frame'
  | 'stable'
  | 'reset'
  | 'aborted'
  | 'retiring'
  | 'retired'
  | 'disposed';

export interface SsrHistorySlot {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly surfaceTexture: Texture;
  readonly surfaceView: TextureView;
}
export interface SsrHistoryResources {
  readonly width: number;
  readonly height: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly bytes: number;
  readonly descriptor: TextureDescriptor;
  readonly slots: readonly [SsrHistorySlot, SsrHistorySlot];
  /** One renderer-owned parameter block shared by the temporal resolve. */
  readonly paramsBuffer: Buffer;
  readonly childScope: DeviceScope;
}
export interface SsrHistoryCandidate {
  readonly readSlot: 0 | 1 | null;
  readonly writeSlot: 0 | 1;
  readonly historyValid: boolean;
}
export interface SsrHistoryInspection {
  readonly state: SsrHistoryState;
  readonly width: number;
  readonly height: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly format: typeof SSR_HISTORY_FORMAT;
  readonly historyCount: 0 | 2;
  readonly historyValid: boolean;
  readonly readSlot: 0 | 1 | null;
  readonly writeSlot: 0 | 1;
  readonly activeBytes: number;
  readonly candidateBytes: number;
  readonly retiringBytes: number;
  readonly resetCount: number;
  readonly resetReason: SsrHistoryResetReason | undefined;
  readonly lastFailure: SsrHistoryFailureStage | undefined;
}
export interface SsrHistoryError {
  readonly code:
    | 'ssr-history-unavailable'
    | 'ssr-history-active'
    | 'ssr-history-not-active'
    | 'ssr-history-retired';
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<{
    readonly stage?: SsrHistoryFailureStage;
    readonly reason?: SsrHistoryResetReason;
  }>;
}

const HISTORY_USAGE =
  GPU_TEXTURE_USAGE_COPY_SRC |
  GPU_TEXTURE_USAGE_COPY_DST |
  GPU_TEXTURE_USAGE_TEXTURE_BINDING |
  GPU_TEXTURE_USAGE_STORAGE_BINDING |
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT;

function positiveDimension(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function createResources(
  device: RhiDevice,
  scope: DeviceScope,
  width: number,
  height: number,
): Result<SsrHistoryResources, RhiError> {
  const halfWidth = Math.max(1, Math.floor(width / 2));
  const halfHeight = Math.max(1, Math.floor(height / 2));
  const descriptor: TextureDescriptor = {
    label: 'ssr-history-rgba16float',
    size: { width: halfWidth, height: halfHeight, depthOrArrayLayers: 1 },
    format: SSR_HISTORY_FORMAT,
    usage: HISTORY_USAGE,
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    viewFormats: undefined,
    textureBindingViewDimension: undefined,
  };
  const childScope = scope.createChild(`${scope.owner}:ssr-history`);
  const slots: SsrHistorySlot[] = [];
  for (const index of [0, 1] as const) {
    const texture = device.createTexture({
      ...descriptor,
      label: `ssr-history-rgba16float-${index}`,
    });
    if (!texture.ok) {
      childScope.abandon();
      return texture;
    }
    childScope._adopt('texture', texture.value, (value) => {
      device.destroyTexture(value);
    });
    const view = device.createTextureView(texture.value, {
      label: `ssr-history-rgba16float-${index}.view`,
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    });
    if (!view.ok) {
      childScope.abandon();
      return view;
    }
    const surfaceTexture = device.createTexture({
      ...descriptor,
      label: `ssr-history-surface-${index}`,
      format: 'rgba8unorm',
    });
    if (!surfaceTexture.ok) {
      childScope.abandon();
      return surfaceTexture;
    }
    childScope._adopt('texture', surfaceTexture.value, (value) => {
      device.destroyTexture(value);
    });
    const surfaceView = device.createTextureView(surfaceTexture.value, { dimension: '2d' });
    if (!surfaceView.ok) {
      childScope.abandon();
      return surfaceView;
    }
    slots.push({
      texture: texture.value,
      view: view.value,
      surfaceTexture: surfaceTexture.value,
      surfaceView: surfaceView.value,
    });
  }
  const params = device.createBuffer({
    label: 'ssr-temporal-params',
    size: 32,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!params.ok) {
    childScope.abandon();
    return params;
  }
  childScope._adopt('buffer', params.value, (value) => {
    device.destroyBuffer(value);
  });
  const cleared = device.queue.writeBuffer(params.value, 0, new Uint8Array(32));
  if (!cleared.ok) {
    childScope.abandon();
    return cleared;
  }
  return ok({
    width,
    height,
    halfWidth,
    halfHeight,
    bytes: halfWidth * halfHeight * 12 * 2,
    descriptor,
    slots: slots as [SsrHistorySlot, SsrHistorySlot],
    paramsBuffer: params.value,
    childScope,
  });
}

function failure(
  code: SsrHistoryError['code'],
  expected: string,
  hint: string,
  detail?: SsrHistoryError['detail'],
): SsrHistoryError {
  return { code, expected, hint, ...(detail === undefined ? {} : { detail }) };
}

/** Owns only SSR's two physical history slots; the shared coordinator owns epochs. */
export class SsrHistoryOwner {
  private activeResources: SsrHistoryResources | undefined;
  private readonly retiringResources = new Set<SsrHistoryResources>();
  private retirementFencePending = false;
  private activeCandidate: SsrHistoryCandidate | undefined;
  private readIndex: 0 | 1 = 0;
  private valid = false;
  private state: SsrHistoryState = 'first-frame';
  private resetReason: SsrHistoryResetReason | undefined = 'first-enable';
  private lastFailure: SsrHistoryFailureStage | undefined;
  private resetCount = 0;

  private constructor(
    private readonly device: RhiDevice,
    private readonly scope: DeviceScope,
    resources: SsrHistoryResources,
  ) {
    this.activeResources = resources;
  }

  static create(input: {
    readonly device: RhiDevice;
    readonly scope: DeviceScope;
    readonly width: number;
    readonly height: number;
  }): Result<SsrHistoryOwner, RhiError> {
    const width = positiveDimension(input.width, 'width');
    const height = positiveDimension(input.height, 'height');
    const resources = createResources(input.device, input.scope, width, height);
    return resources.ok
      ? ok(new SsrHistoryOwner(input.device, input.scope, resources.value))
      : resources;
  }

  /** The begun frame awaiting `commitFrame` / `abortFrame`; the only candidate copy. */
  get candidate(): SsrHistoryCandidate | undefined {
    return this.activeCandidate;
  }

  get resources(): SsrHistoryResources {
    if (this.activeResources === undefined) throw new Error('SSR history resources are retired.');
    return this.activeResources;
  }

  beginFrame(): Result<SsrHistoryCandidate, SsrHistoryError> {
    if (
      this.activeResources === undefined ||
      this.state === 'retired' ||
      this.state === 'disposed'
    ) {
      return err(
        failure(
          'ssr-history-retired',
          'SSR history resources are active',
          'recreate the renderer-owned SSR history after device recovery',
        ),
      );
    }
    if (this.activeCandidate !== undefined) {
      return err(
        failure(
          'ssr-history-active',
          'one SSR history candidate is active',
          'commit or abort the active SSR history candidate before beginning another',
        ),
      );
    }
    const writeSlot: 0 | 1 = this.valid ? (this.readIndex === 0 ? 1 : 0) : 0;
    const candidate = Object.freeze({
      readSlot: this.valid ? this.readIndex : null,
      writeSlot,
      historyValid: this.valid && this.resetReason === undefined,
    }) as SsrHistoryCandidate;
    this.activeCandidate = candidate;
    this.state = this.valid ? 'stable' : this.state === 'aborted' ? 'aborted' : 'first-frame';
    this.lastFailure = undefined;
    return ok(candidate);
  }

  commitFrame(candidate: SsrHistoryCandidate): Result<void, SsrHistoryError> {
    if (this.activeCandidate !== candidate) {
      return err(
        failure(
          'ssr-history-not-active',
          'commit the candidate returned by beginFrame',
          'keep one candidate from beginFrame until the shared queue submit succeeds',
        ),
      );
    }
    this.readIndex = candidate.writeSlot;
    this.valid = true;
    this.activeCandidate = undefined;
    this.state = 'stable';
    this.resetReason = undefined;
    this.lastFailure = undefined;
    return ok(undefined);
  }

  abortFrame(candidate: SsrHistoryCandidate, stage: SsrHistoryFailureStage): void {
    if (this.activeCandidate !== candidate) return;
    this.activeCandidate = undefined;
    this.state = 'aborted';
    this.lastFailure = stage;
  }

  reset(reason: SsrHistoryResetReason): void {
    this.activeCandidate = undefined;
    this.valid = false;
    this.readIndex = 0;
    this.resetReason = reason;
    this.lastFailure = undefined;
    this.resetCount += 1;
    if (this.activeResources !== undefined) this.state = 'reset';
  }

  resize(width: number, height: number): Result<void, RhiError> {
    const next = createResources(
      this.device,
      this.scope,
      positiveDimension(width, 'width'),
      positiveDimension(height, 'height'),
    );
    if (!next.ok) return next;
    if (this.activeResources !== undefined) this.retiringResources.add(this.activeResources);
    this.activeResources = next.value;
    this.activeCandidate = undefined;
    this.valid = false;
    this.readIndex = 0;
    this.resetReason = 'resize';
    this.lastFailure = undefined;
    this.resetCount += 1;
    this.state = 'reset';
    return ok(undefined);
  }

  /** Retire pending allocations after the queue's already-submitted work. */
  retireAfterFence(queue: RhiQueue, onFailure: (cause: unknown) => void): void {
    if (this.retirementFencePending) return;
    if (this.retiringResources.size === 0 && this.activeResources !== undefined) {
      this.retiringResources.add(this.activeResources);
      this.activeCandidate = undefined;
      this.valid = false;
      this.state = 'retiring';
    }
    const pending = [...this.retiringResources];
    for (const resources of pending) resources.childScope.beginRetire();
    if (pending.length === 0) return;
    this.retirementFencePending = true;
    const finish = (): void => {
      this.retirementFencePending = false;
      for (const resources of pending) {
        this.retiringResources.delete(resources);
        resources.childScope.retire();
        if (this.activeResources === resources) this.activeResources = undefined;
      }
      if (this.activeResources === undefined && this.retiringResources.size === 0) {
        this.state = 'retired';
      }
      // A second resize may have added the then-active resources while this
      // fence was pending. Chain another fence so every retired generation is
      // eventually drained without making the record stage own a retirement
      // ledger.
      if (this.retiringResources.size > 0) this.retireAfterFence(queue, onFailure);
    };
    void queue.onSubmittedWorkDone().then(finish, (cause) => {
      onFailure(cause);
      finish();
    });
  }

  retire(): void {
    this.retirementFencePending = false;
    this.activeCandidate = undefined;
    if (this.activeResources !== undefined) {
      this.activeResources.childScope.retire();
      this.activeResources = undefined;
    }
    for (const resources of this.retiringResources) resources.childScope.retire();
    this.retiringResources.clear();
    this.valid = false;
    this.state = 'retired';
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.retire();
    this.state = 'disposed';
  }

  inspect(): SsrHistoryInspection {
    const active = this.activeResources;
    return Object.freeze({
      state: this.state,
      width: active?.width ?? 0,
      height: active?.height ?? 0,
      halfWidth: active?.halfWidth ?? 0,
      halfHeight: active?.halfHeight ?? 0,
      format: SSR_HISTORY_FORMAT,
      historyCount: active === undefined ? 0 : 2,
      historyValid: this.valid,
      readSlot: active === undefined ? null : this.valid ? this.readIndex : null,
      writeSlot: active === undefined ? 0 : this.valid ? (this.readIndex === 0 ? 1 : 0) : 0,
      activeBytes: active?.bytes ?? 0,
      candidateBytes: 0,
      retiringBytes: [...this.retiringResources]
        .filter((entry) => entry !== active)
        .reduce((sum, entry) => sum + entry.bytes, 0),
      resetCount: this.resetCount,
      resetReason: this.resetReason,
      lastFailure: this.lastFailure,
    });
  }
}

export function createSsrHistoryOwner(input: {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly width: number;
  readonly height: number;
}): Result<SsrHistoryOwner, RhiError> {
  return SsrHistoryOwner.create(input);
}
