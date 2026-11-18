import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { FixedTime, type World } from '@forgeax/engine-ecs';
import { serveTaskClient } from '@forgeax/engine-platform';
import {
  createDynamicGeometryLifecycle,
  createRenderPublisher,
  DynamicGeometryError,
  type FeatureTextureObservation,
  type FeatureTextureReadbackResult,
  type GpuPassTimingObservation,
  type RenderFeature,
  type RenderFeatureCompletion,
  type RenderInspection,
  type RenderPublicationTargetOwner,
  type RenderSceneBounds,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import {
  captureMeshPipelinePreparation,
  createDynamicGeometrySourceHost,
} from '@forgeax/engine-render/internal';
import { ownPipelineLibrary, textureReadbackLayout } from '@forgeax/engine-rhi';
import {
  type CaptureFrameOptions,
  createRhiDebugError,
  tapeArtifact,
} from '@forgeax/engine-rhi-debug';
import { err, ok, type TaskExecutor, textureFormatBlock } from '@forgeax/engine-types';
import { ConfigurationRequests, staleConfiguration } from '../configuration-apply';
import type { EngineStartupPlan } from '../configuration-types';
import { type RhiCapture, toArtifact, uploadRhiTape } from '../internal/rhi-capture';
import { forwardGpuStub } from './gpu-stub';
import {
  type EngineToHostMessage,
  type ExecutionFrameMessage,
  type ExecutionInitMessage,
  type RetainedExecutionInit,
  renderPipelineCapacityOf,
} from './protocol';
import { forwardRenderBackend } from './render-backend';
import {
  MESH_RESIDENCY_REQUEST_LIMIT,
  type RenderWorkerInput,
  type RenderWorkerOutput,
} from './render-worker-protocol';
import { rendererInspectionFailure } from './renderer-inspection';
import { SourceMeshResidency } from './source-mesh-residency';
import type {
  ExecutionGeometryObservationResult,
  ExecutionHdrObservationResult,
  ExecutionRendererInspectionOptions,
  ExecutionRendererInspectionResult,
} from './types';
import { serializableDetail, workerError } from './worker-error';
import { shutdownWorker } from './worker-shutdown';

type CaptureResult = Awaited<ReturnType<RhiCapture['captureFrame']>>;
interface OneShotRequest<R> {
  readonly id: number;
  finish(result: R): void;
}
type OneShotResult<K extends 'geometry' | 'hdr'> = K extends 'geometry'
  ? ExecutionGeometryObservationResult
  : ExecutionHdrObservationResult;
type RenderReadyHostMessage = Extract<EngineToHostMessage, { readonly kind: 'render-ready' }>;

function validWorkerIdentity(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { source?: unknown }).source === 'string' &&
    Number.isSafeInteger((value as { epoch?: unknown }).epoch)
  );
}

function validWorkerFrame(value: unknown, kind: 'frame-submitted' | 'frame-complete'): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === kind &&
    typeof (value as { worldIdentity?: unknown }).worldIdentity === 'string' &&
    Number.isSafeInteger((value as { frameId?: unknown }).frameId) &&
    Number.isSafeInteger((value as { deviceGeneration?: unknown }).deviceGeneration)
  );
}

function renderReadyLimits(
  limits: Extract<RenderWorkerOutput, { readonly kind: 'ready' }>['limits'],
): Pick<RenderReadyHostMessage, 'limits' | 'maxTextureDimension2D'> {
  const maxStorageBuffersPerShaderStage = limits?.maxStorageBuffersPerShaderStage;
  const maxTextureDimension2D = limits?.maxTextureDimension2D;
  return {
    ...(maxStorageBuffersPerShaderStage === undefined
      ? {}
      : { limits: { maxStorageBuffersPerShaderStage } }),
    ...(maxTextureDimension2D === undefined ? {} : { maxTextureDimension2D }),
  };
}

function featureTextureReadbackResult(
  values: unknown,
  error: unknown,
  completion: RenderFeatureCompletion,
  featureIdentities: readonly string[],
): FeatureTextureReadbackResult | undefined {
  const readFeatureTextureFailure = (error: unknown): FeatureTextureReadbackResult | undefined => {
    if (
      typeof error !== 'object' ||
      error === null ||
      typeof (error as { code?: unknown }).code !== 'string' ||
      typeof (error as { expected?: unknown }).expected !== 'string' ||
      typeof (error as { hint?: unknown }).hint !== 'string' ||
      (values !== undefined && (!Array.isArray(values) || values.length > 0))
    )
      return undefined;
    const row = error as { code: string; expected: string; hint: string; detail?: unknown };
    return {
      ok: false,
      error: {
        code: row.code,
        expected: row.expected,
        hint: row.hint,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
      },
    };
  };
  if (error !== undefined) return readFeatureTextureFailure(error);
  if (values === undefined) return { ok: true, value: [] };
  if (!Array.isArray(values)) return undefined;
  const invalidTextureFrameMetadata = (metadata: FeatureTextureObservation['metadata']) =>
    !Number.isSafeInteger(metadata.frameId) ||
    metadata.frameId < 0 ||
    metadata.frameId !== completion.frameId ||
    !Number.isSafeInteger(metadata.deviceGeneration) ||
    metadata.deviceGeneration < 0 ||
    metadata.deviceGeneration !== completion.deviceGeneration ||
    !Number.isSafeInteger(metadata.graphGeneration) ||
    metadata.graphGeneration < 0 ||
    completion.graphGeneration === undefined ||
    metadata.graphGeneration !== completion.graphGeneration;
  const invalidTextureReadbackMetadata = (metadata: FeatureTextureObservation['metadata']) =>
    !Number.isSafeInteger(metadata.textureIdentity) ||
    metadata.textureIdentity < 0 ||
    !Number.isSafeInteger(metadata.readbackIdentity) ||
    metadata.readbackIdentity < 0 ||
    !Number.isSafeInteger(metadata.width) ||
    metadata.width <= 0 ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.height <= 0 ||
    !Number.isSafeInteger(metadata.bytesPerRow) ||
    !Number.isSafeInteger(metadata.footprint.resourceCount) ||
    metadata.footprint.resourceCount < 0 ||
    !Number.isSafeInteger(metadata.footprint.bindGroupCount) ||
    metadata.footprint.bindGroupCount < 0;
  const accepted = new Set(featureIdentities);
  const invalidFeatureTextureRow = (row: Partial<FeatureTextureObservation>) =>
    row.domain !== 'feature-texture' ||
    typeof row.featureIdentity !== 'string' ||
    !accepted.has(row.featureIdentity) ||
    (row.viewIdentity !== undefined &&
      (typeof row.viewIdentity !== 'string' || row.viewIdentity.length === 0)) ||
    typeof row.name !== 'string' ||
    row.name.length === 0 ||
    typeof row.targetName !== 'string' ||
    row.targetName.length === 0;
  const seen = new Set<string>();
  const observations: FeatureTextureObservation[] = [];
  for (const value of values) {
    if (typeof value !== 'object' || value === null) return undefined;
    const row = value as Partial<FeatureTextureObservation>;
    const metadata = row.metadata;
    if (
      invalidFeatureTextureRow(row) ||
      !(row.bytes instanceof Uint8Array) ||
      metadata === undefined ||
      metadata.footprint === undefined ||
      invalidTextureFrameMetadata(metadata) ||
      invalidTextureReadbackMetadata(metadata)
    )
      return undefined;
    let layout: ReturnType<typeof textureReadbackLayout>;
    try {
      layout = textureReadbackLayout(
        metadata.width,
        metadata.height,
        textureFormatBlock(metadata.format),
      );
    } catch {
      return undefined;
    }
    const key = `${row.featureIdentity}\u0000${row.viewIdentity ?? 'frame'}\u0000${row.name}`;
    if (
      seen.has(key) ||
      metadata.bytesPerRow !== layout.bytesPerRow ||
      row.bytes.byteLength !== layout.byteLength
    )
      return undefined;
    seen.add(key);
    observations.push(row as FeatureTextureObservation);
  }
  return { ok: true, value: observations };
}

/** Sealed publications bounded by the same finite capacity as Host admission. */
/**
 * GPU completion watchdog of one published frame: never sooner than the App frame deadline
 * (a slow software frame inside its budget is not a lost Renderer) nor than 30 s; none when
 * the App waits without a deadline.
 */
export function renderFrameDeadlineMs(frameTimeoutMs: number | null | undefined): number | null {
  return frameTimeoutMs === null ? null : Math.max(30_000, frameTimeoutMs ?? 0);
}

export class SourceRenderWorker {
  private worker: Worker | undefined;
  private publisher: ReturnType<typeof createRenderPublisher> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private epoch = 1;
  private initializationSent = false;
  private preloadFailure:
    | { readonly kind: 'constructor'; readonly cause: unknown }
    | { readonly kind: 'module'; readonly cause: string }
    | undefined;
  private readonly source = crypto.randomUUID();
  private readonly publicationCapacity: 2 | 3 | 4;
  private disposed = false;
  private inspectionReady = false;
  private readonly inspectionRequests = new Map<
    number,
    { finish(result: ExecutionRendererInspectionResult<Partial<RenderInspection>>): void }
  >();
  private disposal: Promise<void> | undefined;
  private retirement: ReturnType<typeof shutdownWorker> | undefined;
  private readyWait: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | undefined;
  private replacementsWithoutFrame = 0;
  private nextRequestId = 0;
  private latestCompletedTerrainFrame: number | undefined;
  private readonly boundsRequests = new Map<
    number,
    {
      finish(bounds: RenderSceneBounds | undefined): void;
      fail(cause: Error): void;
    }
  >();
  private readonly terrainRequests = new Map<
    number,
    {
      finish(
        result: import('@forgeax/engine-types').Result<
          number | undefined,
          import('@forgeax/engine-types').TerrainError
        >,
      ): void;
    }
  >();
  /** At most one in-flight one-shot diagnostic frame per kind. */
  private readonly oneShotRequests: {
    geometry?: OneShotRequest<ExecutionGeometryObservationResult>;
    hdr?: OneShotRequest<ExecutionHdrObservationResult>;
  } = {};
  private captureRequest: { id: number; finish(result: CaptureResult): void } | undefined;
  private latestGpuPassTiming:
    | {
        readonly frameId: number;
        readonly observation: GpuPassTimingObservation;
        /** Frames rendered untimed because every timing slot was in flight. */
        readonly skippedFrames: number;
      }
    | undefined;
  private deviceGeneration: number | undefined;
  private captureCandidatePipelines:
    | Parameters<typeof createDynamicGeometrySourceHost>[0]['capturePipelinePreparation']
    | undefined;
  private readonly publishedFrames = new Map<
    number,
    {
      readonly frameId: number;
      readonly fixedStep: number;
      readonly deviceGeneration?: number;
      readonly graphGeneration?: number;
      readonly featureIdentities?: readonly string[];
    }
  >();
  private capacityWaiters: (() => void)[] = [];
  private readonly meshResidency: SourceMeshResidency;
  readonly dynamicGeometry: ReturnType<typeof createDynamicGeometrySourceHost>;
  constructor(
    private readonly world: World,
    private readonly assets: AssetRegistry,
    private init: RetainedExecutionInit,
    private readonly post: (message: EngineToHostMessage, transfer?: Transferable[]) => void,
    private readonly features: readonly RenderFeature<unknown>[] = [],
    private readonly targets?: RenderPublicationTargetOwner,
    private readonly tasks?: TaskExecutor,
  ) {
    this.publicationCapacity = renderPipelineCapacityOf(
      init.startup?.settings.execution?.renderPipelineCapacity ??
        init.diagnostics?.renderPipelineCapacity,
    );
    this.meshResidency = new SourceMeshResidency(world, () => {
      const worker = this.worker,
        epoch = this.epoch,
        generation = this.deviceGeneration,
        publisher = this.publisher;
      if (
        this.disposed ||
        !this.inspectionReady ||
        worker === undefined ||
        generation === undefined
      )
        return undefined;
      return {
        source: this.source,
        epoch,
        generation,
        acknowledgePrograms: (programs) => publisher?.acknowledgePrograms(programs),
        post: (message, transfers) => {
          if (this.worker !== worker || this.epoch !== epoch)
            throw new Error('Render mesh session ended');
          if (transfers === undefined) worker.postMessage(message);
          else worker.postMessage(message, [...transfers]);
        },
      };
    });
    this.dynamicGeometry = createDynamicGeometrySourceHost({
      lifecycle: createDynamicGeometryLifecycle(
        MESH_RESIDENCY_REQUEST_LIMIT,
        init.dynamicGeometryMeshBudgetBytes,
      ),
      attachedWorlds: new Set([world]),
      currentGeneration: () => this.deviceGeneration,
      residency: this.meshResidency,
      capturePipelinePreparation: (input) =>
        this.captureCandidatePipelines?.(input) ??
        err(
          new DynamicGeometryError(
            'dynamic-geometry-gpu-not-ready',
            'candidate pipelines use the active Render Worker capabilities',
            'wait for Render readiness before preparing geometry',
          ),
        ),
      isConsumedByRenderFrame: (candidate) =>
        this.meshResidency.recordStageLane(candidate) !== undefined,
      recordStageLane: (candidate) => this.meshResidency.recordStageLane(candidate),
      publishedFixedStep: (world) => this.meshResidency.publishedFixedStep(world),
    });
  }

  /** Load only this worker's module; initialization remains owned by start(). */
  preloadModule(): void {
    if (this.disposed || this.worker !== undefined || this.preloadFailure !== undefined) return;
    try {
      const worker = new Worker(new URL('./render-worker-runtime.mjs', import.meta.url), {
        type: 'module',
        name: 'forgeax-render',
      });
      this.worker = worker;
      worker.onerror = (event) => {
        // Staged errors remain owned here, including queued events after disposal.
        event.preventDefault();
        if (this.worker === worker && this.preloadFailure === undefined)
          this.preloadFailure = { kind: 'module', cause: event.message };
      };
    } catch (cause) {
      this.preloadFailure = { kind: 'constructor', cause };
    }
  }
  async start(
    canvas: OffscreenCanvas,
    pipelineLibrary?: ExecutionInitMessage['pipelineLibrary'],
    backgroundPipelineLibrary?: ExecutionInitMessage['backgroundPipelineLibrary'],
  ): Promise<void> {
    if (this.disposed) return;
    const epoch = this.epoch;
    const preloadFailure = this.preloadFailure;
    if (preloadFailure?.kind === 'constructor') throw preloadFailure.cause;
    const worker =
      this.worker ??
      new Worker(new URL('./render-worker-runtime.mjs', import.meta.url), {
        type: 'module',
        name: 'forgeax-render',
      });
    this.worker = worker;
    // Session closures outlive startup and must not capture the library.
    this.startupPipelineLibrary =
      pipelineLibrary === undefined ? undefined : ownPipelineLibrary(pipelineLibrary);
    this.startupBackgroundPipelineLibrary =
      backgroundPipelineLibrary === undefined
        ? undefined
        : ownPipelineLibrary(backgroundPipelineLibrary);
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let failurePending = false;
      const failure = (
        cause: unknown,
        failure?: Extract<RenderWorkerOutput, { kind: 'failed' }>,
        recoverable = failure?.recoverable ?? true,
      ): void => {
        const error = failure?.error ?? workerError(cause);
        const detail = {
          ...error,
          stage: failure?.stage ?? 'transport',
          publication: failure?.publication,
        };
        if (this.worker !== worker || failurePending) return;
        failurePending = true;
        const meshReleaseUnconfirmed = this.meshResidency.hasUnreleasedMeshes;
        const finish = (
          unconfirmed: boolean,
          retirementError?: ReturnType<typeof workerError>,
        ): void => {
          if (this.worker !== worker) return;
          if (meshReleaseUnconfirmed && !unconfirmed) this.meshResidency.confirmRetirement();
          this.clear();
          if (!ready) {
            reject(Object.assign(new Error(typeof cause === 'string' ? cause : error.code), error));
            return;
          }
          if (this.disposed) return;
          // Only the receiver's successful disposal attests GPU release. A
          // lost transport, cleanup error or timeout retains the fatal path.
          if (!recoverable || unconfirmed || ++this.replacementsWithoutFrame > 1) {
            this.post({
              kind: 'fault',
              source: 'runtime',
              worldIdentity: this.world.identity,
              ...error,
              detail: {
                cause: error.detail,
                stage: detail.stage,
                publication: detail.publication,
                ...(unconfirmed ? { meshReleaseUnconfirmed: true } : {}),
                ...(retirementError === undefined ? {} : { retirement: retirementError }),
                ...(failure?.renderer === undefined ? {} : { renderer: failure.renderer }),
              },
              partialWrite: false,
              retryable: false,
            });
            return;
          }
          this.readyWait = new Promise((resolve) => {
            this.resolveReady = resolve;
          });
          this.epoch++;
          this.post({ kind: 'render-lost', epoch: this.epoch, detail: JSON.stringify(detail) });
        };
        if (
          ready &&
          recoverable &&
          meshReleaseUnconfirmed &&
          failure?.renderer?.state === 'device-lost'
        ) {
          this.inspectionReady = false;
          this.releaseCapacityWaiters();
          this.retirement = shutdownWorker(worker).then((result) => {
            finish(!result.ok, result.ok ? undefined : workerError(result.error));
            return result;
          });
          return;
        }
        finish(meshReleaseUnconfirmed);
      };
      if (this.init.startupTimeoutMs !== null) {
        this.deadline = setTimeout(
          () => failure('Render Worker initialization timed out'),
          this.init.startupTimeoutMs,
        );
      }
      const acceptsSceneMessages = (): boolean => !this.disposed && !failurePending;
      worker.onerror = (event) => failure(event.message);
      worker.onmessage = (event: MessageEvent<RenderWorkerOutput>) => {
        if (this.worker !== worker || this.epoch !== epoch) return;
        const message = event.data;
        if (this.receiveResourceControl(message)) return;
        if (!acceptsSceneMessages()) return;
        const validateSceneMessage = () => {
          if (
            (message.kind === 'geometry-observation-result' ||
              message.kind === 'inspect-result' ||
              message.kind === 'renderer-error' ||
              message.kind === 'submitted' ||
              message.kind === 'completed') &&
            !validWorkerIdentity(message.identity)
          ) {
            failure(
              {
                code: 'render-worker-protocol-invalid',
                expected: 'Render Worker messages carrying a valid source and epoch identity',
                hint: 'repair the Render Worker message producer and retry the frame',
                detail: { kind: message.kind },
              },
              undefined,
              false,
            );
            return false;
          }
          if (
            message.kind === 'submitted' &&
            (!Number.isSafeInteger(message.revision) ||
              message.revision < 0 ||
              !validWorkerFrame(message.frame, 'frame-submitted'))
          ) {
            failure(
              {
                code: 'render-worker-protocol-invalid',
                expected: 'a submitted frame identity and non-negative revision',
                hint: 'repair the Render Worker submitted receipt and retry the frame',
                detail: { kind: message.kind },
              },
              undefined,
              false,
            );
            return false;
          }
          if (
            message.kind === 'completed' &&
            (!Number.isSafeInteger(message.revision) ||
              message.revision < 0 ||
              !validWorkerFrame(message.frame, 'frame-complete') ||
              typeof message.completion !== 'object' ||
              message.completion === null ||
              !Array.isArray(message.buffers))
          ) {
            failure(
              {
                code: 'render-worker-protocol-invalid',
                expected:
                  'a completed source frame, actual Renderer receipt and returned publication storage',
                hint: 'repair the Render Worker completion notice and retry the frame',
                detail: { kind: message.kind },
              },
              undefined,
              false,
            );
            return false;
          }

          return true;
        };
        if (!validateSceneMessage()) return;
        const receiveSceneResult = () => {
          if (
            message.kind === 'geometry-observation-result' ||
            message.kind === 'hdr-observation-result'
          ) {
            this.receiveOneShotResult(message, epoch);
            return true;
          }
          if (message.kind === 'inspect-result') {
            if (
              message.identity.source === this.source &&
              message.identity.epoch === epoch &&
              message.worldIdentity === this.world.identity
            )
              this.inspectionRequests.get(message.requestId)?.finish(message.result);
            return true;
          }
          if (message.kind === 'terrain-height-result') {
            this.terrainRequests
              .get(message.requestId)
              ?.finish(message.result.ok ? ok(message.result.value) : err(message.result.error));
            return true;
          }
          if (message.kind === 'bounds-result') {
            this.boundsRequests.get(message.requestId)?.finish(message.bounds);
            return true;
          }
          if (message.kind === 'capture-result') {
            if (this.captureRequest?.id === message.requestId)
              this.captureRequest.finish(
                message.result.ok
                  ? ok(
                      toArtifact(
                        tapeArtifact([message.result.value.bytes]),
                        message.result.value.submittedFrame,
                      ),
                    )
                  : err(message.result.error),
              );
            return true;
          }
          if (message.kind === 'renderer-error') {
            if (
              this.disposed ||
              message.identity.source !== this.source ||
              message.identity.epoch !== epoch
            )
              return true;
            if (!ready) {
              failure(message.error, undefined, false);
              return true;
            }
            this.post({
              kind: 'render-error',
              identity: message.identity,
              worldIdentity: this.world.identity,
              error: message.error,
              ...(message.renderer === undefined ? {} : { renderer: message.renderer }),
            });
            return true;
          }
          if (message.kind === 'failed') {
            failure(message.error, message);
            return true;
          }

          return false;
        };
        if (receiveSceneResult()) return;
        if (message.kind === 'ready') {
          const acceptReady = () => {
            if (ready) return;
            clearTimeout(this.deadline);
            this.deviceGeneration = message.deviceGeneration;
            this.captureCandidatePipelines = (input) => {
              const captured = captureMeshPipelinePreparation({
                ...input,
                assets: this.assets,
                capabilities: message.capabilities,
                ...(message.limits === undefined ? {} : { limits: message.limits }),
              });
              if (!captured.ok) return captured;
              return ok({
                ...captured.value,
                programs:
                  this.publisher?.unpublishedPrograms(captured.value.programs) ??
                  captured.value.programs,
              });
            };
            this.publisher = createRenderPublisher(
              this.world,
              this.assets,
              {
                source: this.source,
                epoch,
              },
              message.capabilities,
              this.features,
              this.targets,
              message.limits,
              this.publicationCapacity,
              (handle, revision) => this.meshResidency.holdsPrepared(handle, revision),
              (handle) => this.dynamicGeometry.pendingMeshPreparation(this.world, handle),
            );
            ready = true;
            this.inspectionReady = true;
            this.resolveReady?.();
            this.resolveReady = undefined;
            this.post({
              kind: 'render-ready',
              epoch,
              capabilities: {
                backendKind: message.capabilities.backendKind,
                compute: message.capabilities.compute,
                storageBuffer: message.capabilities.storageBuffer,
              },
              ...renderReadyLimits(message.limits),
            });
            resolve();
          };
          acceptReady();
        } else if (message.kind === 'submitted') {
          const acceptSubmitted = () => {
            if (message.identity.source !== this.source || message.identity.epoch !== epoch) return;
            const submitted = this.publishedFrames.get(message.revision);
            if (
              submitted === undefined ||
              submitted.frameId !== message.frame.frameId ||
              message.frame.worldIdentity !== this.world.identity
            ) {
              failure(
                new Error('Feature acknowledgment differs from its submitted source frame'),
                undefined,
                false,
              );
              return;
            }
            try {
              const accepted = this.publisher?.acknowledgeFeatures(
                message.revision,
                message.features,
              );
              if (accepted?.ok !== true) {
                failure(
                  accepted?.error ?? new Error('Invalid feature acknowledgment'),
                  undefined,
                  false,
                );
                return;
              }
              this.publishedFrames.set(message.revision, {
                ...submitted,
                deviceGeneration: message.frame.deviceGeneration,
                ...(message.frame.graphGeneration === undefined
                  ? {}
                  : { graphGeneration: message.frame.graphGeneration }),
                featureIdentities: message.features.map((feature) => feature.identity),
              });
            } catch (cause) {
              failure(cause, undefined, false);
              return;
            }
          };
          acceptSubmitted();
        } else if (message.kind === 'gpu-pass-timing') {
          this.receiveGpuPassTiming(message);
        } else if (message.kind === 'completed') {
          const completeSourceFrame = () => {
            if (message.identity.source !== this.source || message.identity.epoch !== epoch) return;
            const submitted = this.publishedFrames.get(message.revision);
            const invalidCompletedIdentity = (submitted: {
              readonly deviceGeneration?: number;
              readonly graphGeneration?: number;
            }) =>
              message.completion.deviceGeneration !== this.deviceGeneration ||
              (submitted.deviceGeneration !== undefined &&
                message.completion.deviceGeneration !== submitted.deviceGeneration) ||
              message.completion.deviceGeneration !== message.frame.deviceGeneration ||
              (submitted.graphGeneration !== undefined &&
                message.completion.graphGeneration !== submitted.graphGeneration) ||
              (message.frame.graphGeneration !== undefined &&
                message.frame.graphGeneration !== message.completion.graphGeneration) ||
              message.buffers.length !== 1 ||
              !(message.buffers[0] instanceof ArrayBuffer);
            if (
              submitted === undefined ||
              submitted.frameId !== message.frame.frameId ||
              message.frame.worldIdentity !== this.world.identity ||
              invalidCompletedIdentity(submitted)
            ) {
              failure(
                new Error('Feature completion differs from its submitted source frame'),
                undefined,
                false,
              );
              return;
            }
            const featureReadbacks = featureTextureReadbackResult(
              message.featureTextureReadbacks,
              message.featureTextureReadbackError,
              message.completion,
              submitted.featureIdentities ?? [],
            );
            if (featureReadbacks === undefined) {
              failure(
                new Error('Feature texture readbacks differ from their completed receipt'),
                undefined,
                false,
              );
              return;
            }
            const proof = message.meshConsumption;
            const invalidMeshCompletion = () =>
              proof !== undefined &&
              (submitted.fixedStep !== proof.sourceFixedStep ||
                proof.deviceGeneration !== this.deviceGeneration ||
                proof.deviceGeneration !== message.frame.deviceGeneration ||
                !Number.isSafeInteger(proof.frameId) ||
                proof.frameId !== message.completion.frameId);
            if (invalidMeshCompletion()) {
              failure(
                new Error('Mesh completion differs from its submitted publication'),
                undefined,
                false,
              );
              return;
            }
            const retireCompletedPublication = () => {
              try {
                const completed = this.publisher?.completeFeatures(
                  message.revision,
                  message.completion,
                  featureReadbacks,
                );
                if (completed?.ok !== true) {
                  failure(
                    completed?.error ?? new Error('Invalid feature completion'),
                    undefined,
                    false,
                  );
                  return false;
                }
              } catch (cause) {
                failure(cause, undefined, false);
                return false;
              }
              clearTimeout(this.deadline);
              const recycled = this.publisher?.recycle(message.revision, message.buffers);
              if (recycled?.ok !== true) {
                failure(
                  recycled?.error ?? new Error('Invalid Render Worker buffer return'),
                  undefined,
                  false,
                );
                return false;
              }

              return true;
            };
            if (!retireCompletedPublication()) return;
            this.publishedFrames.delete(message.revision);
            this.releaseCapacityWaiters();
            if (proof !== undefined) {
              this.meshResidency.complete(proof);
              if (message.frame.presentation === 'ready')
                this.dynamicGeometry.publishDynamicGeometry(
                  Object.freeze({
                    frameId: proof.frameId,
                    deviceGeneration: proof.deviceGeneration,
                  }),
                  this.world,
                  proof.sourceFixedStep,
                );
            }
            this.replacementsWithoutFrame = 0;
            if (
              message.frame.presentation === 'ready' &&
              (this.latestCompletedTerrainFrame === undefined ||
                message.frame.frameId > this.latestCompletedTerrainFrame)
            )
              this.latestCompletedTerrainFrame = message.frame.frameId;
            if (this.publisher?.inspect().inFlight) this.armFrameDeadline();
          };
          completeSourceFrame();
        }
      };
      if (preloadFailure?.kind === 'module') {
        failure(preloadFailure.cause);
        return;
      }
      this.sendInitialization(worker, canvas, epoch);
      // The same failure owner handles a GPU queue that never completes.
      const frameDeadlineMs = renderFrameDeadlineMs(this.init.frameTimeoutMs);
      this.armFrameDeadline = () => {
        if (frameDeadlineMs === null) return;
        this.deadline = setTimeout(() => failure('Render Worker frame timed out'), frameDeadlineMs);
      };
    });
  }
  /** Transfers startup constructor inputs once per Render Worker session. */
  private sendInitialization(worker: Worker, canvas: OffscreenCanvas, epoch: number): void {
    this.initializationSent = true;
    // Render notices go straight to the Host; the Host port precedes the session's first notice.
    const hostChannel = new MessageChannel();
    this.post({ kind: 'render-host-port', epoch, port: hostChannel.port2 }, [hostChannel.port2]);
    const taskPort = this.openTaskPort();
    worker.postMessage(
      {
        kind: 'init',
        hostPort: hostChannel.port1,
        ...taskPort.fields,
        worldIdentity: this.world.identity,
        ...(this.init.diagnostics?.rhiCapture === true ? { rhiCapture: true } : {}),
        ...forwardGpuStub(this.init),
        ...(this.init.diagnostics?.shadowWorkload === true ? { shadowWorkload: true } : {}),
        ...(this.init.diagnostics?.gpuPassTiming === undefined
          ? {}
          : { gpuPassTiming: this.init.diagnostics.gpuPassTiming }),
        ...(this.init.diagnostics?.featureReadOnlyDepthBatchDiagnostic === undefined
          ? {}
          : {
              featureReadOnlyDepthBatchDiagnostic:
                this.init.diagnostics.featureReadOnlyDepthBatchDiagnostic,
            }),
        ...(this.init.diagnostics?.gbufferBatchOrderDiagnostic === undefined
          ? {}
          : { gbufferBatchOrderDiagnostic: this.init.diagnostics.gbufferBatchOrderDiagnostic }),
        ...(this.init.diagnostics?.geometryLane === undefined
          ? {}
          : { geometryLane: this.init.diagnostics.geometryLane }),
        ...(this.init.diagnostics?.renderTaskYield === undefined
          ? {}
          : { renderTaskYield: this.init.diagnostics.renderTaskYield }),
        renderPipelineCapacity: this.publicationCapacity,
        ...this.takeStartupPipelineLibrary(),
        ...(this.init.backgroundPipelineLibraryConcurrency === undefined
          ? {}
          : {
              backgroundPipelineLibraryConcurrency: this.init.backgroundPipelineLibraryConcurrency,
            }),
        ...(this.init.outputColorSpace === undefined
          ? {}
          : { outputColorSpace: this.init.outputColorSpace }),
        ...forwardRenderBackend(this.init),
        ...(this.init.dynamicGeometryMeshBudgetBytes === undefined
          ? {}
          : { dynamicGeometryMeshBudgetBytes: this.init.dynamicGeometryMeshBudgetBytes }),
        ...(this.init.assetBudgetBytes === undefined
          ? {}
          : { assetBudgetBytes: this.init.assetBudgetBytes }),
        ...(this.init.featureTextureReadbackBudgetBytes === undefined
          ? {}
          : { featureTextureReadbackBudgetBytes: this.init.featureTextureReadbackBudgetBytes }),
        ...(this.init.textureMipSkip === undefined
          ? {}
          : { textureMipSkip: this.init.textureMipSkip }),
        ...(this.init.loadProgressScope === undefined
          ? {}
          : { loadProgressScope: this.init.loadProgressScope }),
        ...(this.init.startup === undefined ? {} : { startup: this.init.startup }),
        bootstrapUrl: this.init.bootstrapUrl,
        ...(this.init.bootstrapData === undefined
          ? {}
          : { bootstrapData: this.init.bootstrapData }),
        canvas,
        identity: { source: this.source, epoch },
        ...(this.init.shaderManifestUrl === undefined
          ? {}
          : { shaderManifestUrl: this.init.shaderManifestUrl }),
        ...(this.init.build === undefined ? {} : { build: this.init.build }),
      } satisfies RenderWorkerInput,
      [canvas, hostChannel.port1, ...taskPort.transfer],
    );
  }
  private armFrameDeadline: () => void = () => {};
  /** Ends the session's task port; its unfinished tasks are cancelled. */
  private releaseTaskPort: (() => void) | undefined;
  /** The Render Worker submits background work through this realm's dispatcher. */
  private openTaskPort(): {
    readonly fields: { readonly taskPort?: MessagePort };
    readonly transfer: readonly Transferable[];
  } {
    this.releaseTaskPort?.();
    this.releaseTaskPort = undefined;
    if (this.tasks === undefined) return { fields: {}, transfer: [] };
    const channel = new MessageChannel();
    this.releaseTaskPort = serveTaskClient(channel.port2, this.tasks);
    return { fields: { taskPort: channel.port1 }, transfer: [channel.port1] };
  }
  private startupPipelineLibrary: ExecutionInitMessage['pipelineLibrary'];
  private startupBackgroundPipelineLibrary: ExecutionInitMessage['backgroundPipelineLibrary'];
  private takeStartupPipelineLibrary(): Pick<
    ExecutionInitMessage,
    'pipelineLibrary' | 'backgroundPipelineLibrary'
  > {
    const pipelineLibrary = this.startupPipelineLibrary;
    const backgroundPipelineLibrary = this.startupBackgroundPipelineLibrary;
    this.startupPipelineLibrary = undefined;
    this.startupBackgroundPipelineLibrary = undefined;
    return {
      ...(pipelineLibrary === undefined ? {} : { pipelineLibrary }),
      ...(backgroundPipelineLibrary === undefined ? {} : { backgroundPipelineLibrary }),
    };
  }
  get hasPublicationCapacity(): boolean {
    return this.inspectionReady && this.publishedFrames.size < this.publicationCapacity;
  }
  /**
   * Host credit returns directly from the Render Worker, so a Host frame can
   * arrive before this Engine has processed the matching completion. Resolve
   * only when the current session is ready and has a publication slot. Loss
   * clears the old queue; that is not capacity in the replacement session.
   */
  async waitForPublicationCapacity(onWait?: () => void): Promise<boolean> {
    while (!this.disposed) {
      if (!this.hasPublicationCapacity) onWait?.();
      const ready = this.readyWait;
      await ready;
      if (ready !== this.readyWait) continue;
      if (!this.inspectionReady) return false;
      if (this.hasPublicationCapacity) return true;
      onWait?.();
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    return false;
  }
  private releaseCapacityWaiters(): void {
    if (this.capacityWaiters.length === 0) return;
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const resolve of waiters) resolve();
  }
  /**
   * `engineUpdateMs` / `engineCreditWaitMs` ride on the draw message for the
   * Render Worker's always-on stall accounting; they do not affect drawing.
   */
  publish(
    frame: ExecutionFrameMessage,
    sampleTimeSeconds: number,
    engineUpdateMs = 0,
    engineCreditWaitMs = 0,
  ): void {
    const publisher = this.publisher,
      worker = this.worker;
    if (publisher === undefined || worker === undefined)
      throw new Error('Render Worker is not ready');
    const geometryFault = this.dynamicGeometry.dynamicGeometryFault(this.world);
    if (geometryFault !== undefined) throw geometryFault;
    const wasIdle = !publisher.inspect().inFlight;
    const candidate = publisher
      .prepare(sampleTimeSeconds, frame.temporalReset === true, {
        frameId: frame.frameId,
        waterMeshViewFacts: {
          version: 1,
          canvasExtent: { width: frame.canvasWidth, height: frame.canvasHeight },
          maxRenderShortSide: 0,
        },
      })
      .unwrap();
    const sourceFixedStep = this.world.getResource(FixedTime).tick;
    this.publishedFrames.set(candidate.packet.revision, {
      frameId: frame.frameId,
      fixedStep: sourceFixedStep,
    });
    try {
      if (candidate.observation === undefined) {
        worker.postMessage(
          {
            kind: 'draw',
            worldIdentity: this.world.identity,
            frameId: frame.frameId,
            width: frame.canvasWidth,
            height: frame.canvasHeight,
            publication: candidate.message,
            sourceFixedStep,
            engineUpdateMs,
            engineCreditWaitMs,
          } satisfies RenderWorkerInput,
          [
            ...renderPublicationTransfers(candidate.message),
            ...renderPublicationAssetTransfers(candidate.message),
          ],
        );
      } else {
        // Keep the original callee -> message -> transfers evaluation order.
        const postMessage = worker.postMessage;
        const message = {
          kind: 'draw',
          worldIdentity: this.world.identity,
          frameId: frame.frameId,
          width: frame.canvasWidth,
          height: frame.canvasHeight,
          publication: candidate.message,
          sourceFixedStep,
          engineUpdateMs,
          engineCreditWaitMs,
        } satisfies RenderWorkerInput;
        candidate.observation.phase('transfer-list');
        const transfers = [
          ...renderPublicationTransfers(candidate.message),
          ...renderPublicationAssetTransfers(candidate.message),
        ];
        candidate.observation.phase('send');
        Reflect.apply(postMessage, worker, [message, transfers]);
        candidate.observation.count('send-returned');
      }
      candidate.accept();
      if (wasIdle) this.armFrameDeadline();
    } catch (cause) {
      this.publishedFrames.delete(candidate.packet.revision);
      candidate.observation?.count('send-or-accept-error');
      candidate.observation?.finish('discarded');
      candidate.discard();
      throw cause;
    }
  }
  queryLatestSubmittedTerrainHeight(
    request: import('@forgeax/engine-render').SubmittedTerrainHeightRequest,
  ) {
    const frameId = this.latestCompletedTerrainFrame;
    if (frameId === undefined)
      return Promise.resolve(
        err({
          code: 'terrain-query-unavailable' as const,
          expected: 'a completed ready picture in the current Render Worker session',
          hint: 'keep dependent gameplay isolated until the new terrain has rendered',
          detail: { field: 'FrameReceipt' },
        }),
      );
    return this.querySubmittedTerrainHeight(frameId, request);
  }
  querySubmittedTerrainHeight(
    frameId: number,
    request: import('@forgeax/engine-render').SubmittedTerrainHeightRequest,
  ): Promise<
    import('@forgeax/engine-types').Result<
      number | undefined,
      import('@forgeax/engine-types').TerrainError
    >
  > {
    const unavailable = (cause: string) =>
      err({
        code: 'terrain-query-unavailable' as const,
        expected: 'a retained successful frame in the active Render Worker session',
        hint: 'wait for frame completion and query its exact frame ID',
        detail: { field: 'Worker', actual: cause },
      });
    const worker = this.worker;
    if (worker === undefined || this.terrainRequests.size >= 32)
      return Promise.resolve(unavailable('session ended or request budget exhausted'));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve) => {
      const finish = (
        result: import('@forgeax/engine-types').Result<
          number | undefined,
          import('@forgeax/engine-types').TerrainError
        >,
      ) => {
        clearTimeout(deadline);
        this.terrainRequests.delete(requestId);
        resolve(result);
      };
      const deadline = setTimeout(() => finish(unavailable('query deadline exceeded')), 30_000);
      this.terrainRequests.set(requestId, { finish });
      try {
        worker.postMessage({
          kind: 'terrain-height',
          requestId,
          frameId,
          request,
        } satisfies RenderWorkerInput);
      } catch (cause) {
        finish(unavailable(String(cause)));
      }
    });
  }
  private receiveResourceControl(message: RenderWorkerOutput): boolean {
    if (message.kind === 'mesh-ready' || message.kind === 'mesh-released') {
      this.meshResidency.receive(message);
      return true;
    }
    if (message.kind === 'configuration-result') {
      this.configurationRequests.receive(message);
      return true;
    }
    return false;
  }
  private readonly configurationRequests = new ConfigurationRequests();
  async applyConfiguration(plan: EngineStartupPlan, previousRevision: number) {
    const worker = this.worker;
    const epoch = this.epoch;
    if (worker === undefined || this.disposed)
      return err(staleConfiguration('the Render Worker is unavailable'));
    const result = await this.configurationRequests.request(
      plan,
      previousRevision,
      this.world.identity,
      (message) => worker.postMessage(message),
    );
    if (this.worker !== worker || this.epoch !== epoch)
      return err(staleConfiguration('the Render Worker was replaced'));
    if (result.ok) this.init = { ...this.init, startup: plan };
    return result;
  }
  /** Ask the Render Worker to release its completed read caches. */
  trimReadCache(): void {
    this.worker?.postMessage({ kind: 'memory-pressure' } satisfies RenderWorkerInput);
  }
  bounds(entity: number): Promise<RenderSceneBounds | undefined> {
    const worker = this.worker;
    if (worker === undefined) return Promise.reject(new Error('Render Worker session ended'));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(deadline);
        this.boundsRequests.delete(requestId);
      };
      const fail = (cause: Error) => {
        remove();
        reject(cause);
      };
      const deadline = setTimeout(
        () => fail(new Error('Render Worker bounds request timed out')),
        30_000,
      );
      this.boundsRequests.set(requestId, {
        finish: (bounds) => {
          remove();
          resolve(bounds);
        },
        fail,
      });
      try {
        worker.postMessage({ kind: 'bounds', requestId, entity } satisfies RenderWorkerInput);
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
  observeNextGeometry(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ExecutionGeometryObservationResult> {
    return this.observeNextFrame('geometry', options);
  }
  /** Arm the next submitted frame for a `linear-hdr` copy and return its detached bytes. */
  observeNextHdrFrame(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ExecutionHdrObservationResult> {
    return this.observeNextFrame('hdr', options);
  }
  private observeNextFrame<K extends 'geometry' | 'hdr'>(
    kind: K,
    options: { readonly signal?: AbortSignal },
  ): Promise<OneShotResult<K>> {
    type R = OneShotResult<K>;
    const worker = this.worker,
      epoch = this.epoch;
    const requests = this.oneShotRequests as { [P in K]?: OneShotRequest<R> };
    if (options.signal?.aborted) return Promise.resolve(rendererInspectionFailure('cancelled'));
    if (this.disposed || !this.inspectionReady || worker === undefined)
      return Promise.resolve(rendererInspectionFailure('not-ready'));
    if (requests[kind] !== undefined)
      return Promise.resolve(rendererInspectionFailure('request-limit'));
    const id = ++this.nextRequestId;
    const cancelKind = kind === 'geometry' ? 'geometry-observe-cancel' : 'hdr-observe-cancel';
    const nextKind = kind === 'geometry' ? 'geometry-observe-next' : 'hdr-observe-next';
    return new Promise((resolve) => {
      const finish = (result: R) => {
        if (requests[kind]?.id !== id) return;
        delete requests[kind];
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        resolve(
          this.worker === worker && this.epoch === epoch && !this.disposed
            ? result
            : rendererInspectionFailure('stale-session'),
        );
      };
      const abandon = (reason: 'cancelled' | 'timeout') => {
        try {
          worker.postMessage({ kind: cancelKind, requestId: id } satisfies RenderWorkerInput);
        } finally {
          finish(rendererInspectionFailure(reason));
        }
      };
      const cancel = () => abandon('cancelled');
      const timer = setTimeout(() => abandon('timeout'), 30000);
      requests[kind] = { id, finish };
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        worker.postMessage({
          kind: nextKind,
          requestId: id,
          identity: { source: this.source, epoch },
          worldIdentity: this.world.identity,
        } satisfies RenderWorkerInput);
      } catch (error) {
        finish(rendererInspectionFailure('transport', error));
      }
    });
  }
  /** Delivers a one-shot diagnostic result only to the matching session and request. */
  private receiveOneShotResult(
    message: Extract<
      RenderWorkerOutput,
      { kind: 'geometry-observation-result' | 'hdr-observation-result' }
    >,
    epoch: number,
  ): void {
    if (
      message.identity.source !== this.source ||
      message.identity.epoch !== epoch ||
      message.worldIdentity !== this.world.identity
    )
      return;
    if (message.kind === 'geometry-observation-result') {
      if (this.oneShotRequests.geometry?.id === message.requestId)
        this.oneShotRequests.geometry.finish(message.result);
    } else if (this.oneShotRequests.hdr?.id === message.requestId)
      this.oneShotRequests.hdr.finish(message.result);
  }
  private finishOneShotRequests(): void {
    this.oneShotRequests.geometry?.finish(rendererInspectionFailure('session-ended'));
    this.oneShotRequests.hdr?.finish(rendererInspectionFailure('session-ended'));
  }
  /** This read never consumes publication credit or starts another Renderer. */
  inspectRenderer<K extends keyof RenderInspection = keyof RenderInspection>(
    options: ExecutionRendererInspectionOptions<K> = {},
  ): Promise<ExecutionRendererInspectionResult<Pick<RenderInspection, K>>> {
    const worker = this.worker,
      epoch = this.epoch,
      worldIdentity = this.world.identity;
    if (options.signal?.aborted) return Promise.resolve(rendererInspectionFailure('cancelled'));
    if (this.disposed || !this.inspectionReady || worker === undefined)
      return Promise.resolve(rendererInspectionFailure('not-ready'));
    if (this.inspectionRequests.size >= 32)
      return Promise.resolve(rendererInspectionFailure('request-limit'));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve) => {
      const finish = (result: ExecutionRendererInspectionResult<Partial<RenderInspection>>) => {
        if (!this.inspectionRequests.has(requestId)) return;
        this.inspectionRequests.delete(requestId);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        const current =
          this.worker === worker &&
          this.epoch === epoch &&
          this.world.identity === worldIdentity &&
          !this.disposed;
        // The child projects the requested fields before transport; the request owns K.
        resolve(
          (result.ok && !current
            ? rendererInspectionFailure('stale-session')
            : result) as ExecutionRendererInspectionResult<Pick<RenderInspection, K>>,
        );
      };
      const cancel = () => finish(rendererInspectionFailure('cancelled'));
      // New inspection read bound follows existing child-read policy; caller abort may close sooner.
      const timer = setTimeout(() => finish(rendererInspectionFailure('timeout')), 30_000);
      this.inspectionRequests.set(requestId, { finish });
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        worker.postMessage({
          kind: 'inspect',
          ...(options.fields === undefined ? {} : { fields: options.fields }),
          ...(options.pipelineLibrary === undefined
            ? {}
            : { pipelineLibrary: options.pipelineLibrary }),
          ...(options.pipelineLibraryCollection === undefined
            ? {}
            : { pipelineLibraryCollection: options.pipelineLibraryCollection }),
          ...(options.pipelineLibraryLimits === undefined
            ? {}
            : { pipelineLibraryLimits: options.pipelineLibraryLimits }),
          ...(options.pipelineLibraryRequestedOnly === undefined
            ? {}
            : { pipelineLibraryRequestedOnly: options.pipelineLibraryRequestedOnly }),
          ...(options.runtimeRequests === undefined
            ? {}
            : { runtimeRequests: options.runtimeRequests }),
          requestId,
          identity: { source: this.source, epoch },
          worldIdentity,
        } satisfies RenderWorkerInput);
      } catch (cause) {
        finish(rendererInspectionFailure('transport', cause));
      }
    });
  }
  readonly upload: RhiCapture['upload'] = uploadRhiTape;

  captureFrame(options: CaptureFrameOptions = {}): Promise<CaptureResult> {
    const unavailable = (cause: string): CaptureResult =>
      err(createRhiDebugError('capture-unavailable', { stage: 'capture', cause }));
    const worker = this.worker;
    if (
      worker === undefined ||
      this.init.diagnostics?.rhiCapture !== true ||
      options.signal?.aborted
    )
      return Promise.resolve(unavailable('Render Worker capture is unavailable or cancelled'));
    if (this.captureRequest !== undefined)
      return Promise.resolve(
        err(
          createRhiDebugError('capture-busy', {
            stage: 'capture',
            cause: 'a Render Worker capture is active',
          }),
        ),
      );
    const id = ++this.nextRequestId;
    return new Promise((resolve) => {
      const cancel = () => {
        worker.postMessage({ kind: 'capture-cancel', requestId: id } satisfies RenderWorkerInput);
        finish(
          unavailable(
            'Render Worker capture was cancelled or did not complete before its deadline',
          ),
        );
      };
      const deadline = setTimeout(cancel, (options.snapshotTimeoutMs ?? 30_000) + 30_000);
      const finish = (result: CaptureResult) => {
        if (this.captureRequest?.id !== id) return;
        this.captureRequest = undefined;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      this.captureRequest = { id, finish };
      options.signal?.addEventListener('abort', cancel, { once: true });
      const { signal: _signal, ...configuration } = options;
      try {
        worker.postMessage({
          kind: 'capture',
          requestId: id,
          options: configuration,
        } satisfies RenderWorkerInput);
      } catch (cause) {
        finish(unavailable(String(cause)));
      }
    });
  }
  private receiveGpuPassTiming(
    message: Extract<RenderWorkerOutput, { kind: 'gpu-pass-timing' }>,
  ): void {
    // Readback resolves after credit and may land after a newer frame's timing.
    const latest = this.latestGpuPassTiming;
    if (latest !== undefined && latest.frameId > message.frameId) return;
    this.latestGpuPassTiming = {
      frameId: message.frameId,
      observation: message.gpuPassTiming,
      skippedFrames: message.skippedFrames,
    };
  }
  inspectGpuPassTiming():
    | {
        readonly frameId: number;
        readonly observation: GpuPassTimingObservation;
        /** Frames rendered untimed because every timing slot was in flight. */
        readonly skippedFrames: number;
      }
    | undefined {
    return this.latestGpuPassTiming;
  }
  async replace(
    epoch: number,
    canvas: OffscreenCanvas,
    pipelineLibrary?: ExecutionInitMessage['pipelineLibrary'],
    backgroundPipelineLibrary?: ExecutionInitMessage['backgroundPipelineLibrary'],
  ): Promise<void> {
    if (epoch !== this.epoch || this.worker !== undefined || this.disposed) return;
    await this.start(canvas, pipelineLibrary, backgroundPipelineLibrary);
  }
  private clear(): void {
    this.configurationRequests.invalidate('the Render Worker session ended');
    this.retirement = undefined;
    this.startupPipelineLibrary = undefined;
    this.startupBackgroundPipelineLibrary = undefined;
    this.finishOneShotRequests();
    this.inspectionReady = false;
    this.deviceGeneration = undefined;
    this.captureCandidatePipelines = undefined;
    try {
      this.dynamicGeometry.invalidateDynamicGeometryWorld(this.world);
    } finally {
      this.meshResidency.clear('Render Worker session ended');
    }
    this.publishedFrames.clear();
    this.releaseCapacityWaiters();
    for (const request of this.inspectionRequests.values())
      request.finish(rendererInspectionFailure('session-ended'));
    for (const request of this.terrainRequests.values())
      request.finish(
        err({
          code: 'terrain-query-unavailable',
          expected: 'an active Render Worker session',
          hint: 'query after recovery completes',
          detail: { field: 'Worker' },
        }),
      );
    for (const request of this.boundsRequests.values())
      request.fail(new Error('Render Worker session ended'));
    this.captureRequest?.finish(
      err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: 'Render Worker session ended',
        }),
      ),
    );
    clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = undefined;
    this.initializationSent = false;
    this.preloadFailure = undefined;
    this.latestGpuPassTiming = undefined;
    this.latestCompletedTerrainFrame = undefined;
    this.publisher?.dispose();
    this.publisher = undefined;
    this.releaseTaskPort?.();
    this.releaseTaskPort = undefined;
  }
  dispose(): Promise<void> {
    this.configurationRequests.dispose();
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    const retirement = this.retirement;
    this.finishOneShotRequests();
    this.inspectionReady = false;
    this.deviceGeneration = undefined;
    this.captureCandidatePipelines = undefined;
    if (retirement === undefined) this.dynamicGeometry.invalidateDynamicGeometryWorld(this.world);
    for (const request of this.inspectionRequests.values())
      request.finish(rendererInspectionFailure('disposed'));
    this.resolveReady?.();
    clearTimeout(this.deadline);
    const worker = this.worker;
    this.disposal = (async () => {
      let failure: unknown;
      const traceDisposal = (stage: 'mesh-release' | 'retirement' | 'child-ack' | 'clear') => {
        console.warn(
          JSON.stringify({
            kind: 'render-worker-disposal',
            owner: 'source',
            stage,
            source: this.source,
            epoch: this.epoch,
            worldIdentity: this.world.identity,
          }),
        );
      };
      try {
        // Keep mesh ACK delivery live until all receiver release fences finish.
        try {
          if (retirement === undefined) {
            traceDisposal('mesh-release');
            await this.meshResidency.dispose();
          } else {
            traceDisposal('retirement');
            (await retirement).unwrap();
          }
        } catch (cause) {
          console.error('[render-worker-disposal-failed]', serializableDetail(cause));
          failure = cause;
        }
        // Fence late frame/capture messages before waiting for the dedicated ACK.
        this.worker = undefined;
        if (worker !== undefined && retirement === undefined) {
          try {
            if (this.initializationSent) {
              traceDisposal('child-ack');
              (await shutdownWorker(worker)).unwrap();
            } else worker.terminate();
          } catch (cause) {
            console.error('[render-worker-disposal-failed]', serializableDetail(cause));
            failure ??= cause;
          }
        }
      } finally {
        traceDisposal('clear');
        this.clear();
      }
      if (failure !== undefined) throw failure;
    })();
    return this.disposal;
  }
}
