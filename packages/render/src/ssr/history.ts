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
import { MAX_RENDER_FRAMES_IN_FLIGHT } from '../publication/frame-limits';
import type { TemporalFrameStage } from '../temporal/frame-coordinator';
import {
  fullSsrColorViewport,
  isSsrColorViewport,
  type SsrColorViewport,
} from './scene-color-input';

export const SSR_HISTORY_FORMAT = 'rgba16float' as const;
/** Current accepted state plus the publisher's four supported in-flight writes. */
export const SSR_HISTORY_SLOT_COUNT = MAX_RENDER_FRAMES_IN_FLIGHT + 1;
export const WATER_SSR_PARAMS_BYTES = 96;
export type SsrHistoryProfile = 'opaque' | 'single-layer-water';
export type SsrHistoryResetReason =
  | 'first-enable'
  | 'resize'
  | 'camera-cut'
  | 'history-version'
  | 'coverage-loss'
  | 'reflection-generation'
  | 'device-recovery'
  | 'disable';
export type SsrHistoryState =
  | 'first-frame'
  | 'stable'
  | 'reset'
  | 'aborted'
  | 'retiring'
  | 'retired'
  | 'disposed';

interface SsrHistoryColorSlot {
  readonly texture: Texture;
  readonly view: TextureView;
}
export type SsrHistorySlot = SsrHistoryColorSlot &
  (
    | {
        readonly profile: 'opaque';
        readonly surfaceTexture: Texture;
        readonly surfaceView: TextureView;
      }
    | { readonly profile: 'single-layer-water' }
  );
export interface SsrHistoryResources {
  readonly profile: SsrHistoryProfile;
  readonly width: number;
  readonly height: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  readonly bytes: number;
  readonly descriptor: TextureDescriptor;
  readonly slots: readonly SsrHistorySlot[];
  /** One renderer-owned parameter block shared by the temporal resolve. */
  readonly paramsBuffer: Buffer;
  waterParamsBuffer?: Buffer;
  readonly childScope: DeviceScope;
}
export interface SsrHistoryCandidate {
  /** Existing immutable TemporalView identity; never an independent camera snapshot. */
  readonly source?: object;
  readonly readSlot: number | null;
  readonly writeSlot: number;
  readonly historyValid: boolean;
  readonly previousResources: SsrHistoryResources;
  readonly viewport: SsrColorViewport;
  readonly previousViewport: SsrColorViewport;
}
export interface SsrHistoryInspection {
  readonly profile: SsrHistoryProfile;
  readonly state: SsrHistoryState;
  readonly width: number;
  readonly height: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  readonly format: typeof SSR_HISTORY_FORMAT;
  readonly historyCount: number;
  readonly historyValid: boolean;
  readonly readSlot: number | null;
  readonly writeSlot: number | null;
  readonly activeBytes: number;
  readonly candidateBytes: number;
  readonly pendingFrames?: number;
  readonly retiringBytes: number;
  readonly resetCount: number;
  readonly resetReason: SsrHistoryResetReason | undefined;
  readonly lastFailure: TemporalFrameStage | undefined;
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
    readonly stage?: TemporalFrameStage;
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
  profile: SsrHistoryProfile,
): Result<SsrHistoryResources, RhiError> {
  const traceWidth = Math.max(1, Math.floor(width));
  const traceHeight = Math.max(1, Math.floor(height));
  const descriptor: TextureDescriptor = {
    label: `${profile === 'single-layer-water' ? 'water-' : ''}ssr-history-rgba16float`,
    size: { width: traceWidth, height: traceHeight, depthOrArrayLayers: 1 },
    format: SSR_HISTORY_FORMAT,
    usage: device.caps.storageTexture
      ? HISTORY_USAGE
      : HISTORY_USAGE & ~GPU_TEXTURE_USAGE_STORAGE_BINDING,
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    viewFormats: undefined,
    textureBindingViewDimension: undefined,
  };
  const childScope = scope.createChild(`${scope.owner}:${profile}:ssr-history`);
  const slots: SsrHistorySlot[] = [];
  for (let index = 0; index < SSR_HISTORY_SLOT_COUNT; index++) {
    const texture = device.createTexture({
      ...descriptor,
      label: `${descriptor.label}-${index}`,
    });
    if (!texture.ok) {
      childScope.abandon();
      return texture;
    }
    childScope._adopt('texture', texture.value, (value) => {
      device.destroyTexture(value);
    });
    const view = device.createTextureView(texture.value, {
      label: `${descriptor.label}-${index}.view`,
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
    if (profile === 'single-layer-water') {
      slots.push({ profile, texture: texture.value, view: view.value });
      continue;
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
      profile,
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
    profile,
    width,
    height,
    traceWidth,
    traceHeight,
    bytes: traceWidth * traceHeight * (profile === 'opaque' ? 12 : 8) * SSR_HISTORY_SLOT_COUNT,
    descriptor,
    slots: Object.freeze(slots),
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

/** Owns bounded SSR history allocations; the shared coordinator owns view identity. */
export class SsrHistoryOwner {
  private activeResources: SsrHistoryResources | undefined;
  private readonly retiringResources = new Set<SsrHistoryResources>();
  private retirementFencePending = false;
  private activeCandidate: SsrHistoryCandidate | undefined;
  private readIndex = 0;
  private epoch = 0;
  private serial = 0;
  private acceptedSerial = 0;
  private readonly submitted = new Map<
    SsrHistoryCandidate,
    { resources: SsrHistoryResources; epoch: number; serial: number }
  >();
  private valid = false;
  private acceptedSource: object | undefined;
  private acceptedResources: SsrHistoryResources | undefined;
  private acceptedViewport: SsrColorViewport | undefined;
  private state: SsrHistoryState = 'first-frame';
  private resetReason: SsrHistoryResetReason | undefined = 'first-enable';
  private lastFailure: TemporalFrameStage | undefined;
  private resetCount = 0;

  private constructor(
    private readonly device: RhiDevice,
    private readonly scope: DeviceScope,
    readonly profile: SsrHistoryProfile,
    resources: SsrHistoryResources,
  ) {
    this.activeResources = resources;
  }

  static create(input: {
    readonly device: RhiDevice;
    readonly scope: DeviceScope;
    readonly width: number;
    readonly height: number;
    readonly profile?: SsrHistoryProfile;
  }): Result<SsrHistoryOwner, RhiError> {
    const width = positiveDimension(input.width, 'width');
    const height = positiveDimension(input.height, 'height');
    const profile = input.profile ?? 'opaque';
    const resources = createResources(input.device, input.scope, width, height, profile);
    return resources.ok
      ? ok(new SsrHistoryOwner(input.device, input.scope, profile, resources.value))
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

  /** Trace parameters remain available when Water has no dedicated temporal resolve. */
  getWaterInputParamsBuffer(): Result<Buffer, RhiError> {
    const resources = this.resources;
    if (resources.waterParamsBuffer !== undefined) return ok(resources.waterParamsBuffer);
    const created = this.device.createBuffer({
      label: 'water-ssr-input-params',
      size: WATER_SSR_PARAMS_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) return created;
    resources.childScope._adopt('buffer', created.value, (value) => {
      this.device.destroyBuffer(value);
    });
    resources.waterParamsBuffer = created.value;
    return created;
  }

  private nextWriteSlot(): number {
    const occupied = new Set<number>();
    if (this.valid) occupied.add(this.readIndex);
    for (const [candidate, submitted] of this.submitted) {
      if (submitted.resources !== this.activeResources) continue;
      occupied.add(candidate.writeSlot);
      if (candidate.readSlot !== null) occupied.add(candidate.readSlot);
    }
    return this.activeResources?.slots.findIndex((_, index) => !occupied.has(index)) ?? -1;
  }

  get previousResources(): SsrHistoryResources {
    return this.activeCandidate?.previousResources ?? this.acceptedResources ?? this.resources;
  }

  beginFrame(
    source?: {
      readonly current: object;
      readonly previous: object | undefined;
    },
    viewport?: SsrColorViewport,
  ): Result<SsrHistoryCandidate, SsrHistoryError> {
    if (
      this.activeResources === undefined ||
      this.state === 'retiring' ||
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
    const writeSlot = this.nextWriteSlot();
    if (writeSlot < 0)
      return err(
        failure(
          'ssr-history-active',
          'a free SSR history slot',
          'await the oldest frame completion before drawing again',
        ),
      );
    // SceneData motion describes the last submitted view. A completed older
    // history cannot be reprojected with that one-step motion under GPU backlog.
    const historyValid =
      this.valid &&
      this.resetReason === undefined &&
      (source === undefined ||
        (source.previous !== undefined && source.previous === this.acceptedSource));
    const nextViewport = Object.freeze({
      ...(viewport ?? fullSsrColorViewport(this.resources.width, this.resources.height)),
    });
    if (!isSsrColorViewport(nextViewport))
      return err(
        failure(
          'ssr-history-unavailable',
          'a valid SSR color viewport',
          'use a viewport inside its history allocation',
        ),
      );
    const publishHistoryCandidate = () => {
      const candidate: SsrHistoryCandidate = Object.freeze({
        ...(source === undefined ? {} : { source: source.current }),
        readSlot: historyValid ? this.readIndex : null,
        writeSlot,
        historyValid,
        previousResources: historyValid
          ? (this.acceptedResources ?? this.resources)
          : this.resources,
        viewport: nextViewport,
        previousViewport: historyValid ? (this.acceptedViewport ?? nextViewport) : nextViewport,
      });
      this.activeCandidate = candidate;
      this.state = this.valid ? 'stable' : this.state === 'aborted' ? 'aborted' : 'first-frame';
      this.lastFailure = undefined;
      return ok(candidate);
    };
    return publishHistoryCandidate();
  }

  /** Accepted submit releases the encoder candidate, but only completion publishes history. */
  submitFrame(candidate: SsrHistoryCandidate, queue: RhiQueue): Result<void, SsrHistoryError> {
    if (this.activeCandidate !== candidate || this.activeResources === undefined)
      return err(
        failure(
          'ssr-history-not-active',
          'the current encoded candidate',
          'submit the candidate returned by beginFrame',
        ),
      );
    const record = { resources: this.activeResources, epoch: this.epoch, serial: ++this.serial };
    this.submitted.set(candidate, record);
    this.activeCandidate = undefined;
    void queue.onSubmittedWorkDone().then(
      () => {
        this.submitted.delete(candidate);
        if (
          record.epoch !== this.epoch ||
          record.resources !== this.activeResources ||
          record.serial <= this.acceptedSerial
        )
          return;
        this.acceptedSerial = record.serial;
        this.readIndex = candidate.writeSlot;
        this.acceptedSource = candidate.source;
        this.acceptedResources = record.resources;
        this.acceptedViewport = candidate.viewport;
        this.valid = true;
        this.state = 'stable';
        this.resetReason = undefined;
        this.lastFailure = undefined;
      },
      () => {
        this.submitted.delete(candidate);
        if (record.resources === this.activeResources) this.reset('device-recovery');
      },
    );
    return ok(undefined);
  }

  /** Direct owner adapters call this only once their frame completion is established. */
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
    this.acceptedSource = candidate.source;
    this.acceptedResources = this.resources;
    this.acceptedViewport = candidate.viewport;
    this.valid = true;
    this.activeCandidate = undefined;
    this.state = 'stable';
    this.resetReason = undefined;
    this.lastFailure = undefined;
    return ok(undefined);
  }

  abortFrame(candidate: SsrHistoryCandidate, stage: TemporalFrameStage): void {
    if (this.activeCandidate !== candidate) return;
    this.activeCandidate = undefined;
    this.state = 'aborted';
    this.lastFailure = stage;
  }

  reset(reason: SsrHistoryResetReason): void {
    this.epoch++;
    this.activeCandidate = undefined;
    this.valid = false;
    this.readIndex = 0;
    this.acceptedResources = undefined;
    this.acceptedViewport = undefined;
    this.acceptedSource = undefined;
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
      this.profile,
    );
    if (!next.ok) return next;
    if (this.activeResources !== undefined) this.retiringResources.add(this.activeResources);
    this.epoch++;
    this.activeResources = next.value;
    this.activeCandidate = undefined;
    this.valid = false;
    this.readIndex = 0;
    this.acceptedResources = undefined;
    this.acceptedViewport = undefined;
    this.acceptedSource = undefined;
    this.resetReason = 'resize';
    this.lastFailure = undefined;
    this.resetCount += 1;
    this.state = 'reset';
    return ok(undefined);
  }

  /** Release replaced allocations only after their final consuming submission. */
  retireReplacedAfterFence(queue: RhiQueue, onFailure: (cause: unknown) => void): void {
    if (this.retirementFencePending) return;
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
      if (
        this.state !== 'disposed' &&
        this.activeResources === undefined &&
        this.retiringResources.size === 0
      ) {
        this.state = 'retired';
      }
      // A second resize may have added the then-active resources while this
      // fence was pending. Chain another fence so every retired generation is
      // eventually drained without making the record stage own a retirement
      // ledger.
      if (this.retiringResources.size > 0) this.retireReplacedAfterFence(queue, onFailure);
    };
    void queue.onSubmittedWorkDone().then(finish, (cause) => {
      onFailure(cause);
      finish();
    });
  }

  retireAfterFence(queue: RhiQueue, onFailure: (cause: unknown) => void): void {
    if (this.activeResources !== undefined) this.retiringResources.add(this.activeResources);
    for (const record of this.submitted.values()) this.retiringResources.add(record.resources);
    this.activeCandidate = undefined;
    this.epoch++;
    this.valid = false;
    this.acceptedResources = undefined;
    this.state = 'retiring';
    this.retireReplacedAfterFence(queue, onFailure);
  }

  retire(): void {
    this.retirementFencePending = false;
    this.activeCandidate = undefined;
    this.epoch++;
    for (const record of this.submitted.values()) this.retiringResources.add(record.resources);
    this.submitted.clear();
    if (this.activeResources !== undefined) {
      this.activeResources.childScope.retire();
      this.activeResources = undefined;
    }
    for (const resources of this.retiringResources) resources.childScope.retire();
    this.retiringResources.clear();
    this.valid = false;
    this.acceptedResources = undefined;
    this.acceptedViewport = undefined;
    this.state = 'retired';
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.retire();
    this.state = 'disposed';
  }

  inspect(): SsrHistoryInspection {
    const active = this.activeResources;
    const available = this.activeCandidate?.writeSlot ?? this.nextWriteSlot();
    return Object.freeze({
      profile: this.profile,
      state: this.state,
      width: active?.width ?? 0,
      height: active?.height ?? 0,
      traceWidth: active?.traceWidth ?? 0,
      traceHeight: active?.traceHeight ?? 0,
      format: SSR_HISTORY_FORMAT,
      historyCount: active?.slots.length ?? 0,
      historyValid: this.activeCandidate?.historyValid ?? this.valid,
      readSlot:
        active === undefined
          ? null
          : this.activeCandidate !== undefined
            ? this.activeCandidate.readSlot
            : this.valid
              ? this.readIndex
              : null,
      writeSlot: active === undefined || available < 0 ? null : available,
      activeBytes: active?.bytes ?? 0,
      candidateBytes: 0,
      pendingFrames: this.submitted.size,
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
  readonly profile?: SsrHistoryProfile;
}): Result<SsrHistoryOwner, RhiError> {
  return SsrHistoryOwner.create(input);
}
