import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { FixedTime, type World } from '@forgeax/engine-ecs';
import {
  createDynamicGeometryLifecycle,
  createRenderPublisher,
  DynamicGeometryError,
  type GpuPassTimingObservation,
  type RenderFeature,
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
import {
  type CaptureFrameOptions,
  createRhiDebugError,
  tapeArtifact,
} from '@forgeax/engine-rhi-debug';
import { err, ok } from '@forgeax/engine-types';
import { type RhiCapture, toArtifact, uploadRhiTape } from '../internal/rhi-capture';
import { forwardGpuStub } from './gpu-stub';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  ExecutionInitMessage,
  RetainedExecutionInit,
} from './protocol';
import {
  MESH_RESIDENCY_REQUEST_LIMIT,
  type RenderWorkerInput,
  type RenderWorkerOutput,
} from './render-worker-protocol';
import { rendererInspectionFailure } from './renderer-inspection';
import { SourceMeshResidency } from './source-mesh-residency';
import type {
  ExecutionGeometryObservationResult,
  ExecutionRendererInspectionOptions,
  ExecutionRendererInspectionResult,
} from './types';
import { workerError } from './worker-error';
import { shutdownWorker } from './worker-shutdown';

type CaptureResult = Awaited<ReturnType<RhiCapture['captureFrame']>>;

/** Sealed publications bounded by the same finite capacity as Host admission. */
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
  private geometryRequest:
    | { id: number; finish(result: ExecutionGeometryObservationResult): void }
    | undefined;
  private captureRequest: { id: number; finish(result: CaptureResult): void } | undefined;
  private latestGpuPassTiming:
    | { readonly frameId: number; readonly observation: GpuPassTimingObservation }
    | undefined;
  private deviceGeneration: number | undefined;
  private captureCandidatePipelines:
    | Parameters<typeof createDynamicGeometrySourceHost>[0]['capturePipelinePreparation']
    | undefined;
  private readonly publishedFrames = new Map<number, { frameId: number; fixedStep: number }>();
  private capacityWaiters: (() => void)[] = [];
  private readonly meshResidency: SourceMeshResidency;
  readonly dynamicGeometry: ReturnType<typeof createDynamicGeometrySourceHost>;
  constructor(
    private readonly world: World,
    private readonly assets: AssetRegistry,
    private readonly init: RetainedExecutionInit,
    private readonly post: (message: EngineToHostMessage, transfer?: Transferable[]) => void,
    private readonly features: readonly RenderFeature<unknown>[] = [],
    private readonly targets?: RenderPublicationTargetOwner,
  ) {
    this.publicationCapacity =
      init.diagnostics?.renderPipelineCapacity === 4
        ? 4
        : init.diagnostics?.renderPipelineCapacity === 3
          ? 3
          : 2;
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
    this.startupPipelineLibrary = pipelineLibrary;
    this.startupBackgroundPipelineLibrary = backgroundPipelineLibrary;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
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
        if (this.worker !== worker) return;
        const meshReleaseUnconfirmed = this.meshResidency.hasUnreleasedMeshes;
        this.clear();
        if (!ready) {
          reject(Object.assign(new Error(typeof cause === 'string' ? cause : error.code), error));
          return;
        }
        // A lost transport cannot attest that remote allocations were released.
        // Keep the paired World faulted and use the existing fatal/rebuild path.
        if (!recoverable || meshReleaseUnconfirmed || ++this.replacementsWithoutFrame > 1) {
          this.post({
            kind: 'fault',
            source: 'runtime',
            worldIdentity: this.world.identity,
            ...error,
            detail: {
              cause: error.detail,
              stage: detail.stage,
              publication: detail.publication,
              ...(meshReleaseUnconfirmed ? { meshReleaseUnconfirmed: true } : {}),
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
      if (this.init.startupTimeoutMs !== null) {
        this.deadline = setTimeout(
          () => failure('Render Worker initialization timed out'),
          this.init.startupTimeoutMs,
        );
      }
      worker.onerror = (event) => failure(event.message);
      worker.onmessage = (event: MessageEvent<RenderWorkerOutput>) => {
        if (this.worker !== worker || this.epoch !== epoch) return;
        const message = event.data;
        if (message.kind === 'mesh-ready' || message.kind === 'mesh-released') {
          this.meshResidency.receive(message);
          return;
        }
        if (this.disposed) return;
        if (message.kind === 'geometry-observation-result') {
          if (
            message.identity.source === this.source &&
            message.identity.epoch === epoch &&
            message.worldIdentity === this.world.identity &&
            this.geometryRequest?.id === message.requestId
          )
            this.geometryRequest.finish(message.result);
          return;
        }
        if (message.kind === 'inspect-result') {
          if (
            message.identity.source === this.source &&
            message.identity.epoch === epoch &&
            message.worldIdentity === this.world.identity
          )
            this.inspectionRequests.get(message.requestId)?.finish(message.result);
          return;
        }
        if (message.kind === 'terrain-height-result') {
          this.terrainRequests
            .get(message.requestId)
            ?.finish(message.result.ok ? ok(message.result.value) : err(message.result.error));
          return;
        }
        if (message.kind === 'bounds-result') {
          this.boundsRequests.get(message.requestId)?.finish(message.bounds);
          return;
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
          return;
        }
        if (message.kind === 'renderer-error') {
          if (
            this.disposed ||
            message.identity.source !== this.source ||
            message.identity.epoch !== epoch
          )
            return;
          if (!ready) {
            failure(message.error, undefined, false);
            return;
          }
          this.post({
            kind: 'render-error',
            identity: message.identity,
            worldIdentity: this.world.identity,
            error: message.error,
            ...(message.renderer === undefined ? {} : { renderer: message.renderer }),
          });
          return;
        }
        if (message.kind === 'failed') {
          failure(message.error, message);
          return;
        }
        if (message.kind === 'ready') {
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
          const maxStorageBuffersPerShaderStage = message.limits?.maxStorageBuffersPerShaderStage;
          this.post({
            kind: 'render-ready',
            epoch,
            capabilities: {
              backendKind: message.capabilities.backendKind,
              compute: message.capabilities.compute,
              storageBuffer: message.capabilities.storageBuffer,
            },
            ...(maxStorageBuffersPerShaderStage === undefined
              ? {}
              : { limits: { maxStorageBuffersPerShaderStage } }),
          });
          resolve();
        } else if (message.kind === 'submitted') {
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
          } catch (cause) {
            failure(cause, undefined, false);
            return;
          }
        } else if (message.kind === 'completed') {
          clearTimeout(this.deadline);
          const submitted = this.publishedFrames.get(message.revision);
          const recycled = this.publisher?.recycle(message.revision, message.buffers);
          if (recycled?.ok !== true) {
            failure(
              recycled?.error ?? new Error('Invalid Render Worker buffer return'),
              undefined,
              false,
            );
            return;
          }
          this.publishedFrames.delete(message.revision);
          this.releaseCapacityWaiters();
          const proof = message.meshConsumption;
          if (proof !== undefined) {
            if (
              submitted === undefined ||
              submitted.frameId !== message.frame.frameId ||
              submitted.fixedStep !== proof.sourceFixedStep ||
              proof.deviceGeneration !== this.deviceGeneration ||
              proof.deviceGeneration !== message.frame.deviceGeneration ||
              !Number.isSafeInteger(proof.frameId)
            ) {
              failure(
                new Error('Mesh completion differs from its submitted publication'),
                undefined,
                false,
              );
              return;
            }
            this.meshResidency.complete(proof);
            if (message.frame.presentation === 'ready')
              this.dynamicGeometry.publishDynamicGeometry(
                Object.freeze({
                  frameId: proof.frameId,
                  deviceGeneration: proof.deviceGeneration,
                }),
                [this.world],
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
          if (message.gpuPassTiming !== undefined) {
            this.latestGpuPassTiming = {
              frameId: message.frame.frameId,
              observation: message.gpuPassTiming,
            };
          }
          if (this.publisher?.inspect().inFlight) this.armFrameDeadline();
        }
      };
      if (preloadFailure?.kind === 'module') {
        failure(preloadFailure.cause);
        return;
      }
      this.initializationSent = true;
      // Render notices go straight to the Host; the Host port precedes the session's first notice.
      const hostChannel = new MessageChannel();
      this.post({ kind: 'render-host-port', epoch, port: hostChannel.port2 }, [hostChannel.port2]);
      worker.postMessage(
        {
          kind: 'init',
          hostPort: hostChannel.port1,
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
          ...(this.init.outputColorSpace === undefined
            ? {}
            : { outputColorSpace: this.init.outputColorSpace }),
          ...(this.init.dynamicGeometryMeshBudgetBytes === undefined
            ? {}
            : { dynamicGeometryMeshBudgetBytes: this.init.dynamicGeometryMeshBudgetBytes }),
          ...(this.init.assetBudgetBytes === undefined
            ? {}
            : { assetBudgetBytes: this.init.assetBudgetBytes }),
          ...(this.init.loadProgressScope === undefined
            ? {}
            : { loadProgressScope: this.init.loadProgressScope }),
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
        [canvas, hostChannel.port1],
      );
      // The same failure owner handles a GPU queue that never completes.
      this.armFrameDeadline = () => {
        this.deadline = setTimeout(() => failure('Render Worker frame timed out'), 30_000);
      };
    });
  }
  private armFrameDeadline: () => void = () => {};
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
  async waitForPublicationCapacity(): Promise<boolean> {
    while (!this.disposed) {
      const ready = this.readyWait;
      await ready;
      if (ready !== this.readyWait) continue;
      if (!this.inspectionReady) return false;
      if (this.hasPublicationCapacity) return true;
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
      .prepare(sampleTimeSeconds, frame.temporalReset === true, frame)
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
    const worker = this.worker,
      epoch = this.epoch;
    if (options.signal?.aborted) return Promise.resolve(rendererInspectionFailure('cancelled'));
    if (this.disposed || !this.inspectionReady || worker === undefined)
      return Promise.resolve(rendererInspectionFailure('not-ready'));
    if (this.geometryRequest !== undefined)
      return Promise.resolve(rendererInspectionFailure('request-limit'));
    const id = ++this.nextRequestId;
    return new Promise((resolve) => {
      const finish = (result: ExecutionGeometryObservationResult) => {
        if (this.geometryRequest?.id !== id) return;
        this.geometryRequest = undefined;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        resolve(
          this.worker === worker && this.epoch === epoch && !this.disposed
            ? result
            : rendererInspectionFailure('stale-session'),
        );
      };
      const cancel = () => {
        try {
          worker.postMessage({
            kind: 'geometry-observe-cancel',
            requestId: id,
          } satisfies RenderWorkerInput);
        } finally {
          finish(rendererInspectionFailure('cancelled'));
        }
      };
      const timer = setTimeout(() => {
        try {
          worker.postMessage({
            kind: 'geometry-observe-cancel',
            requestId: id,
          } satisfies RenderWorkerInput);
        } finally {
          finish(rendererInspectionFailure('timeout'));
        }
      }, 30000);
      this.geometryRequest = { id, finish };
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        worker.postMessage({
          kind: 'geometry-observe-next',
          requestId: id,
          identity: { source: this.source, epoch },
          worldIdentity: this.world.identity,
        } satisfies RenderWorkerInput);
      } catch (error) {
        finish(rendererInspectionFailure('transport', error));
      }
    });
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
  inspectGpuPassTiming():
    | { readonly frameId: number; readonly observation: GpuPassTimingObservation }
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
    this.startupPipelineLibrary = undefined;
    this.startupBackgroundPipelineLibrary = undefined;
    this.geometryRequest?.finish(rendererInspectionFailure('session-ended'));
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
  }
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    this.geometryRequest?.finish(rendererInspectionFailure('session-ended'));
    this.inspectionReady = false;
    this.deviceGeneration = undefined;
    this.captureCandidatePipelines = undefined;
    this.dynamicGeometry.invalidateDynamicGeometryWorld(this.world);
    for (const request of this.inspectionRequests.values())
      request.finish(rendererInspectionFailure('disposed'));
    this.resolveReady?.();
    clearTimeout(this.deadline);
    const worker = this.worker;
    this.disposal = (async () => {
      let failure: unknown;
      try {
        // Keep mesh ACK delivery live until all receiver release fences finish.
        try {
          await this.meshResidency.dispose();
        } catch (cause) {
          failure = cause;
        }
        // Fence late frame/capture messages before waiting for the dedicated ACK.
        this.worker = undefined;
        if (worker !== undefined) {
          try {
            if (this.initializationSent) (await shutdownWorker(worker)).unwrap();
            else worker.terminate();
          } catch (cause) {
            failure ??= cause;
          }
        }
      } finally {
        this.clear();
      }
      if (failure !== undefined) throw failure;
    })();
    return this.disposal;
  }
}
