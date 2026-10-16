import { err, ok, type Result } from '@forgeax/engine-types';
import type { Antialias } from '../components/camera';
import { motionBlurTemporalDemand } from '../features/motion-blur/motion-blur-params';
import type { CameraSnapshot } from '../render-contract';
import { classifySceneDataCoverage, type SceneDataContributor } from './coverage';
import { type TaaHistoryAttempt, TaaHistoryStore } from './taa-history-store';
import {
  projectTemporalView,
  type SubmittedTemporalView,
  snapshotSubmittedTemporalView,
  type TemporalView,
} from './temporal-view';

/** The only stages that may publish a temporal frame. */
export type TemporalFrameStage = 'build' | 'encode' | 'finish' | 'submit';

/** Closed list of consumers that share the renderer temporal transaction. */
export type TemporalFrameConsumerId = 'taa' | 'motion-blur' | 'ssr';

export type TemporalFrameErrorCode = 'taa-unavailable' | 'temporal-active' | 'temporal-not-active';

export interface TemporalFrameError {
  readonly code: TemporalFrameErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface TemporalFrameSnapshot<T = unknown> {
  readonly epoch: number;
  readonly previous: T | undefined;
  readonly consumerIds: readonly TemporalFrameConsumerId[];
  readonly historyAttempt: 'none' | 'active' | 'committed' | 'aborted';
  readonly attempt: 'none' | 'active' | 'committed' | 'aborted';
  readonly lastFailure: TemporalFrameStage | undefined;
  readonly coverage: {
    readonly exactContributorIds: readonly string[];
    readonly reactiveContributorIds: readonly string[];
    readonly missingContributorIds: readonly string[];
    readonly omittedMissingContributorCount: number;
  };
}

export interface TemporalFrameBeginInput<T = unknown> {
  readonly current: T;
  readonly antialias: Antialias;
  /** Enables the shared transaction for a temporal feature without TAA. */
  readonly temporalDemand?: boolean;
  /** Consumers registered on this one renderer-owned frame transaction. */
  readonly consumerIds?: readonly TemporalFrameConsumerId[];
  readonly available?: boolean;
  readonly contributors?: readonly SceneDataContributor[];
  readonly requiredContributorIds?: readonly string[];
  /** Projection produced before record uploads; it commits with the frame. */
  readonly temporalView?: TemporalView;
}

export interface TemporalFrameCandidate<T = unknown> {
  readonly epoch: number;
  readonly current: T;
  readonly previous: T | undefined;
  readonly history: { readonly direction: 'a-to-b' | 'b-to-a'; readonly valid: boolean };
  readonly contributors: readonly SceneDataContributor[];
  readonly requiredContributorIds: readonly string[];
  readonly consumerIds: readonly TemporalFrameConsumerId[];
  readonly temporalView?: TemporalView;
}

export interface TemporalFramePhases<T = unknown> {
  readonly build: () => T;
  readonly encode: (built: T) => void;
  readonly finish: () => void;
  readonly submit: () => void;
}

export interface TemporalFrameReceipt<T = unknown> {
  readonly epoch: number;
  readonly previous: T;
  readonly historyDirection: 'a-to-b' | 'b-to-a';
}

function failure(code: TemporalFrameErrorCode, hint: string): TemporalFrameError {
  return {
    code,
    expected:
      code === 'taa-unavailable'
        ? 'TAA resources and capability are available'
        : 'one temporal frame is active',
    hint,
  };
}

/**
 * Renderer-owned temporal transaction. It has no graph or backend dependency:
 * graph assembly supplies the four phase callbacks and only submit publishes
 * the candidate snapshot.
 */
export class TemporalFrameCoordinator<T = unknown> {
  readonly historyStore: TaaHistoryStore;
  private epoch: number;
  private previous: T | undefined;
  private consumerIds: readonly TemporalFrameConsumerId[] = [];
  private active: TemporalFrameCandidate<T> | undefined;
  private attempt: TemporalFrameSnapshot<T>['attempt'] = 'none';
  private historyAttempt: TemporalFrameSnapshot<T>['historyAttempt'] = 'none';
  private lastFailure: TemporalFrameStage | undefined;
  private historyDirection: 'a-to-b' | 'b-to-a' = 'a-to-b';
  private temporalFrameIndex = 0;
  private lastSubmittedView: SubmittedTemporalView | undefined;
  private coverage: TemporalFrameSnapshot<T>['coverage'] = {
    exactContributorIds: [],
    reactiveContributorIds: [],
    missingContributorIds: [],
    omittedMissingContributorCount: 0,
  };
  private readonly historyAttempts = new WeakMap<object, TaaHistoryAttempt>();

  constructor(
    initial: {
      readonly epoch?: number;
      readonly previous?: T;
      readonly historyStore?: TaaHistoryStore;
    } = {},
  ) {
    this.historyStore = initial.historyStore ?? new TaaHistoryStore();
    this.epoch = initial.epoch ?? 0;
    this.previous = initial.previous;
  }

  begin(input: TemporalFrameBeginInput<T>): Result<TemporalFrameCandidate<T>, TemporalFrameError> {
    const consumerIds = Object.freeze([...(input.consumerIds ?? [])]);
    const demanded =
      input.antialias === 'taa' || input.temporalDemand === true || consumerIds.length > 0;
    if (!demanded) {
      return ok({
        epoch: this.epoch,
        current: input.current,
        previous: this.previous,
        history: { direction: this.historyDirection, valid: false },
        contributors: Object.freeze([...(input.contributors ?? [])]),
        requiredContributorIds: Object.freeze([...(input.requiredContributorIds ?? [])]),
        consumerIds,
        ...(input.temporalView === undefined ? {} : { temporalView: input.temporalView }),
      });
    }
    if (input.available === false) {
      return err(
        failure('taa-unavailable', 'enable rgba16float temporal targets and retry the frame'),
      );
    }
    if (this.active !== undefined) {
      return err(
        failure(
          'temporal-active',
          'commit or abort the active temporal frame before beginning another',
        ),
      );
    }
    const candidate: TemporalFrameCandidate<T> = {
      epoch: this.epoch + 1,
      current: input.current,
      previous: this.previous,
      history: { direction: this.historyDirection, valid: this.previous !== undefined },
      contributors: Object.freeze([...(input.contributors ?? [])]),
      requiredContributorIds: Object.freeze([...(input.requiredContributorIds ?? [])]),
      consumerIds,
      ...(input.temporalView === undefined ? {} : { temporalView: input.temporalView }),
    };
    if (input.antialias === 'taa') {
      this.historyAttempts.set(candidate, this.historyStore.begin());
    }
    this.active = candidate;
    this.attempt = 'active';
    this.historyAttempt = input.antialias === 'taa' ? 'active' : 'none';
    this.lastFailure = undefined;
    return ok(candidate);
  }

  commit(
    candidate: TemporalFrameCandidate<T>,
  ): Result<TemporalFrameReceipt<T>, TemporalFrameError> {
    if (this.active !== candidate) {
      return err(failure('temporal-not-active', 'commit the candidate returned by begin'));
    }
    this.epoch = candidate.epoch;
    this.previous = candidate.current;
    if (candidate.temporalView !== undefined) {
      this.lastSubmittedView = snapshotSubmittedTemporalView(candidate.temporalView);
      this.temporalFrameIndex += 1;
    }
    this.historyDirection = candidate.history.direction === 'a-to-b' ? 'b-to-a' : 'a-to-b';
    this.consumerIds = candidate.consumerIds;
    const historyAttempt = this.historyAttempts.get(candidate);
    historyAttempt?.commit({
      deviceGeneration: this.historyStore.inspect().deviceGeneration,
      completed: true,
    });
    this.coverage = classifySceneDataCoverage({
      contributors: candidate.contributors,
      requiredContributorIds: candidate.requiredContributorIds,
    });
    this.active = undefined;
    historyAttempt?.abort();
    this.historyAttempts.delete(candidate);
    this.attempt = 'committed';
    this.historyAttempt = historyAttempt === undefined ? 'none' : 'committed';
    return ok({
      epoch: this.epoch,
      previous: candidate.current,
      historyDirection: candidate.history.direction,
    });
  }

  abort(candidate: TemporalFrameCandidate<T>, stage: TemporalFrameStage = 'submit'): void {
    if (this.active !== candidate) return;
    this.historyAttempts.get(candidate)?.abort();
    this.historyAttempts.delete(candidate);
    this.active = undefined;
    this.attempt = 'aborted';
    this.historyAttempt = 'aborted';
    this.lastFailure = stage;
  }

  run(
    input: TemporalFrameBeginInput<T>,
    phases: TemporalFramePhases<T>,
  ): Result<TemporalFrameReceipt<T> | undefined, TemporalFrameError> {
    const started = this.begin(input);
    if (!started.ok) return started;
    const candidate = started.value;
    if (
      input.antialias !== 'taa' &&
      input.temporalDemand !== true &&
      (input.consumerIds?.length ?? 0) === 0
    ) {
      return ok(undefined);
    }
    try {
      const built = phases.build();
      phases.encode(built);
      phases.finish();
      phases.submit();
    } catch (cause) {
      const stage = this.stageFromError(cause);
      this.abort(candidate, stage);
      return err({
        code: 'temporal-not-active',
        expected: `temporal ${stage} succeeds before commit`,
        hint: 'inspect the underlying stage failure and retry the frame',
        detail: { stage, cause },
      });
    }
    return this.commit(candidate);
  }

  inspect(): TemporalFrameSnapshot<T> {
    return {
      epoch: this.epoch,
      previous: this.previous,
      consumerIds: this.consumerIds,
      historyAttempt: this.historyAttempt,
      attempt: this.attempt,
      lastFailure: this.lastFailure,
      coverage: this.coverage,
    };
  }

  /**
   * Derive the current/previous camera matrices without mutating history.
   * `commit()` is the only operation that publishes the returned view, so a
   * graph/finish/submit failure leaves the last successful view intact.
   */
  prepareTemporalView(
    camera: CameraSnapshot,
    surfaceWidth: number,
    surfaceHeight: number,
  ): TemporalView | undefined {
    const demanded =
      camera.antialias === 'taa' ||
      (camera.motionBlur !== undefined &&
        motionBlurTemporalDemand({
          shutterAngle: camera.motionBlur.shutterAngle,
          maxRadiusPixels: camera.motionBlur.maxRadiusPixels,
          sampleCount: camera.motionBlur.sampleCount,
          targetFps: camera.motionBlur.targetFps ?? 60,
        }));
    if (!demanded) return undefined;
    return projectTemporalView({
      camera,
      temporalFrameIndex: this.temporalFrameIndex,
      surfaceWidth,
      surfaceHeight,
      ...(this.lastSubmittedView === undefined ? {} : { lastSubmitted: this.lastSubmittedView }),
    });
  }

  reset(
    reason:
      | 'cut'
      | 'resize'
      | 'camera-switch'
      | 'detach'
      | 'recover'
      | 'device-loss'
      | 'device-generation' = 'recover',
  ): void {
    void reason;
    this.active = undefined;
    this.epoch = 0;
    this.previous = undefined;
    this.temporalFrameIndex = 0;
    this.lastSubmittedView = undefined;
    this.historyDirection = 'a-to-b';
    this.historyStore.reset(
      reason === 'cut' || reason === 'camera-switch'
        ? 'camera-cut'
        : reason === 'resize'
          ? 'resize'
          : reason === 'device-generation' || reason === 'device-loss'
            ? 'device-generation'
            : 'recover',
    );
    this.attempt = 'none';
    this.historyAttempt = 'none';
    this.lastFailure = undefined;
    this.coverage = {
      exactContributorIds: [],
      reactiveContributorIds: [],
      missingContributorIds: [],
      omittedMissingContributorCount: 0,
    };
    this.consumerIds = [];
  }

  private stageFromError(cause: unknown): TemporalFrameStage {
    if (typeof cause === 'object' && cause !== null && 'stage' in cause) {
      const stage = (cause as { stage?: unknown }).stage;
      if (stage === 'build' || stage === 'encode' || stage === 'finish' || stage === 'submit')
        return stage;
    }
    return 'submit';
  }
}
