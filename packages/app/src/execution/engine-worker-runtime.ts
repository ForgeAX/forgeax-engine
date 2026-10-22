import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createAudioIntentBackend } from '@forgeax/engine-audio';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { SharedKernelExecutor } from '@forgeax/engine-ecs/shared';
import {
  type CompositeInputLease,
  createGamepadFeedback,
  type InputBackend,
  type InputBackendSample,
  makeCompositeBackend,
} from '@forgeax/engine-input';
import { type Context, Inject, type Plugin } from '@forgeax/engine-plugin';
import {
  createProfiler,
  type ProfileFrameToken,
  type Profiler,
  type RecorderSession,
} from '@forgeax/engine-profiler';
import {
  type Renderer,
  RenderPublicationError,
  RenderPublicationTargetOwner,
} from '@forgeax/engine-render';
import { fullscreenRenderFeatureDeclaration } from '@forgeax/engine-render/internal';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import {
  constructRuntimeRendererHost,
  createPublicationAssets,
} from '@forgeax/engine-runtime/internal/renderer-host';
import { err } from '@forgeax/engine-types';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from '../assets-runtime-assembly';
import { syncCameraAspect } from '../canvas-policy';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';
import { createCanonicalEcsImportModule } from '../internal/ecs-import';
import {
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
} from '../internal/rhi-capture';
import { workerEngineProfile } from '../internal/worker-engine-profile';
import { attachWorkerRhiRecorder } from '../internal/worker-rhi-capture';
import { type AppObservation, createAppObservation } from '../observation';
import { createRenderFeatureHost } from '../renderer-plugin';
import { APP_PHASE_CATALOG, type CanvasDrawingBufferSize } from '../types';
import { commitAttachedWorld, SerializedRebuildQueue } from './attached-world-swap';
import { AudioIntentQueue } from './audio-intent-queue';
import {
  activateExecutionRoot,
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
} from './bootstrap-entry';
import { createKernelPool, type KernelPool } from './kernel-pool';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  ExecutionInitMessage,
  ExecutionInspectMessage,
  ExecutionRebuildMessage,
  ExecutionSurfaceResultMessage,
  HostToEngineMessage,
} from './protocol';
import { readRendererInspection, rendererInspectionFailure } from './renderer-inspection';
import { applyRendererOrderDiagnostic } from './renderer-order-diagnostic';
import { SourceRenderWorker } from './source-render-worker';
import type {
  ExecutionRendererInspectionContext,
  ExecutionRendererInspectionResult,
} from './types';
import { serializableDetail } from './worker-error';

const scope = globalThis as unknown as {
  postMessage(message: EngineToHostMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<HostToEngineMessage>) => void) | null;
  close(): void;
};

let renderer: Renderer | undefined;
let currentSample: InputBackendSample = {
  downKeys: new Set(),
  upKeys: new Set(),
  buttons: [false, false, false],
  movementX: 0,
  movementY: 0,
  wheelDelta: 0,
  focused: true,
  pointerLocked: false,
};
let lastFrameId = 0;
let renderSampleTimeSeconds = 0;
let surfaceRequestId = 0;
let nextKernelWorkerId = 0;
interface WorkerRealm {
  readonly world: World;
  canvas: OffscreenCanvas | undefined;
  drawingBufferSize: CanvasDrawingBufferSize;
  pendingSurface?: {
    readonly requestId: number;
    readonly complete: (result: ExecutionSurfaceResultMessage['result']) => void;
    readonly cancel: () => void;
  };
  renderWorker?: SourceRenderWorker;
  publicationTargets?: RenderPublicationTargetOwner;
  readonly init: ExecutionInitMessage;
  assetAssembly: AssetRuntimeAssembly | undefined;
  readonly pendingAudioIntents: AudioIntentQueue;
  audioBackend: ReturnType<typeof createAudioIntentBackend> | undefined;
  musicState?: import('@forgeax/engine-audio').MusicState;
  audioPreparation?: import('@forgeax/engine-audio').AudioPreparationReceipt;
  feedback: ReturnType<typeof createGamepadFeedback>;
  kernelPool: KernelPool | undefined;
  pluginContext: Context | undefined;
  observation: AppObservation | undefined;
  profiler: Profiler | undefined;
  releaseProfilerCatalog: (() => void) | undefined;
  rhiCapture: RhiCapture | undefined;
  rhiAttachment: RecorderAttachment | undefined;
  profilerCaptureId: string | undefined;
  profilerFrameId: number;
}

let realm: WorkerRealm | undefined;
const rebuildQueue = new SerializedRebuildQueue();
const inspectionQueue: ExecutionInspectMessage[] = [];
let realmTransitions = 0;
let inspectionsClosed = false;
/** Requests admitted against a stable World that may still run asynchronously. */
const activeInspectionIds = new Set<number>();

let executeScriptPromise: Promise<typeof import('@forgeax/engine-remote/execute')> | undefined;

function serializableEvalError(error: unknown): { readonly code: string; readonly hint: string } {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { readonly code?: unknown; readonly message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'worker-eval-error',
      hint: typeof candidate.message === 'string' ? candidate.message : String(error),
    };
  }
  return { code: 'worker-eval-error', hint: String(error) };
}

function profilePhase<T>(session: RecorderSession | undefined, phase: string, action: () => T): T {
  const opened = session?.beginPhase('app', phase).ok ?? false;
  try {
    return action();
  } finally {
    if (opened) {
      try {
        session?.endPhase();
      } catch {
        // Profiling is observational and never changes frame ownership.
      }
    }
  }
}

function rejectStaleInspection(job: ExecutionInspectMessage, actualWorldIdentity: string): void {
  scope.postMessage({
    kind: 'inspect-result',
    requestId: job.requestId,
    worldIdentity: actualWorldIdentity,
    result: {
      ok: false,
      error: {
        code: 'live-world-stale',
        hint: 'The inspection belongs to an older World; fetch status and retry.',
        detail: { expected: job.worldIdentity, actual: actualWorldIdentity },
      },
    },
  });
}

function admitInspections(): void {
  const target = realm;
  if (target === undefined || realmTransitions > 0 || inspectionsClosed) return;
  // Worker messages run between synchronous World updates. A GPU completion
  // wait does not own this World boundary or prevent an inspection response.
  const jobs = inspectionQueue.splice(0, inspectionQueue.length);
  for (const job of jobs) void executeInspection(job, target);
}

async function withRealmTransition(action: () => Promise<void>): Promise<void> {
  ++realmTransitions;
  try {
    await action();
  } finally {
    --realmTransitions;
    admitInspections();
  }
}

async function executeInspection(job: ExecutionInspectMessage, target: WorkerRealm): Promise<void> {
  if (job.worldIdentity !== target.world.identity) {
    rejectStaleInspection(job, target.world.identity);
    return;
  }
  activeInspectionIds.add(job.requestId);
  let inputLease: CompositeInputLease | undefined;
  try {
    // This is the authoritative admission witness consumed by the browser
    // relay for queued versus already-running cancellation semantics.
    scope.postMessage({
      kind: 'inspect-started',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
    });
    executeScriptPromise ??= import('@forgeax/engine-remote/execute');
    const module = await executeScriptPromise;
    // Loading the evaluator yields to rebuild/dispose messages. Do not create
    // an input lease or run code against a World retired during that await.
    if (realm !== target || realmTransitions > 0 || inspectionsClosed) {
      rejectStaleInspection(job, realm?.world.identity ?? '');
      return;
    }
    const importModule = createCanonicalEcsImportModule(target.world, async (specifier: string) => {
      // A Worker cannot resolve a bare package specifier from the browser
      // document. Vite's dev module endpoint is the same resolver used by the
      // main-realm bridge; canonicalize component exports back to this
      // Worker-owned World's catalog before returning them to eval.
      const browserSpecifier = specifier.startsWith('@') ? `/@id/${specifier}` : specifier;
      return import(/* @vite-ignore */ browserSpecifier);
    });
    inputLease = inputBackend.createInjectedLease();
    const simulation = {
      pluginContext: target.pluginContext,
      world: target.world,
      renderer,
      assets: target.assetAssembly?.registry,
      input: inputLease,
      rhiCapture: target.rhiCapture,
      profiler: target.profiler,
      execution: {
        report: () => ({
          workers: target.init.workers,
          engine: { realm: 'worker' },
          world: { identity: target.world.identity },
        }),
        observeNextGeometry: async (options?: { readonly signal?: AbortSignal }) => {
          if (
            realm !== target ||
            realmTransitions > 0 ||
            inspectionsClosed ||
            target.renderWorker === undefined
          )
            return rendererInspectionFailure('not-ready');
          const result = await target.renderWorker.observeNextGeometry(options);
          return realm === target && realmTransitions === 0 && !inspectionsClosed
            ? result
            : rendererInspectionFailure('stale-session');
        },
        inspectRenderer: async (
          options?: Parameters<ExecutionRendererInspectionContext['inspectRenderer']>[0],
        ): Promise<ExecutionRendererInspectionResult> => {
          if (realm !== target || realmTransitions > 0 || inspectionsClosed)
            return rendererInspectionFailure('stale-session');
          const result =
            target.renderWorker === undefined
              ? readRendererInspection(renderer, options?.signal, options)
              : await target.renderWorker.inspectRenderer(options);
          return realm === target && realmTransitions === 0 && !inspectionsClosed
            ? result
            : rendererInspectionFailure('stale-session');
        },
        gpuPassTiming: () => target.renderWorker?.inspectGpuPassTiming(),
        querySubmittedTerrainHeight: (
          frameId: number,
          request: import('@forgeax/engine-render').SubmittedTerrainHeightRequest,
        ) => {
          if (target.renderWorker === undefined)
            return Promise.resolve(
              err({
                code: 'terrain-query-unavailable',
                expected: 'an active Render Worker',
                hint: 'use the local Renderer receipt in local render mode',
                detail: { field: 'Worker' },
              }),
            );
          return target.renderWorker.querySubmittedTerrainHeight(frameId, request);
        },
      },
    };
    target.observation ??= createAppObservation(
      target.world,
      renderer ?? {
        bounds: (_world, entity) => {
          if (target.renderWorker === undefined) throw new Error('Render Worker session ended');
          return target.renderWorker.bounds(entity);
        },
      },
      simulation.execution,
    );
    const observation = target.observation;
    const result = await module.executeScript(job.code, {
      world: target.world,
      renderer,
      assets: target.assetAssembly?.registry,
      simulation: { ...simulation, observation },
      rhiCapture: target.rhiCapture,
      profiler: target.profiler,
      execution: simulation.execution,
      importModule,
    });
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result,
    });
  } catch (error) {
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result: { ok: false, error: serializableEvalError(error) },
    });
  } finally {
    // The lease is lexical to this admitted execution. A later job may already
    // own the backend; the lease's generation fence makes this revoke a no-op
    // in that case, so an old async script cannot clear newer input.
    inputLease?.revokeInjectedLease();
    activeInspectionIds.delete(job.requestId);
  }
}

const inputBackendBase: InputBackend = {
  sample: () => currentSample,
  detach: () => {},
};
const inputBackend = makeCompositeBackend(inputBackendBase);

function sharedKernelPlugin(target: WorkerRealm): Plugin {
  const workerFactory = (): Pick<Worker, 'postMessage' | 'terminate'> => {
    const workerId = nextKernelWorkerId++;
    const channel = new MessageChannel();
    scope.postMessage({ kind: 'kernel-worker', workerId, port: channel.port2 }, [channel.port2]);
    return {
      postMessage(message): void {
        channel.port1.postMessage(message);
      },
      terminate(): void {
        channel.port1.close();
        scope.postMessage({ kind: 'kernel-retire', workerId });
      },
    };
  };
  return {
    name: 'shared-kernel-executor',
    inject: ['world'],
    apply(ctx) {
      const executor: SharedKernelExecutor = {
        warmup(kernel) {
          target.kernelPool ??= createKernelPool({
            workerFactory,
            startupTimeoutMs: target.init.startupTimeoutMs,
          });
          target.kernelPool.warmup?.(kernel);
        },
        execute(kernel, spans) {
          target.kernelPool ??= createKernelPool({
            workerFactory,
            startupTimeoutMs: target.init.startupTimeoutMs,
          });
          return target.kernelPool.execute(kernel, spans);
        },
      };
      ctx.effect(() => {
        ctx.world.insertResource('SharedKernelExecutor', executor);
        return () => {
          ctx.world.removeResource('SharedKernelExecutor');
          target.kernelPool?.dispose();
          target.kernelPool = undefined;
        };
      }, 'execution/shared-kernel');
    },
  };
}

function postFault(
  source: 'bootstrap' | 'runtime' | 'world' | 'rebuild',
  code: string,
  expected: string,
  hint: string,
  cause: unknown,
  partialWrite = false,
): void {
  scope.postMessage({
    kind: 'fault',
    worldIdentity: realm?.world.identity ?? null,
    source,
    code,
    expected,
    hint,
    detail: serializableDetail(cause),
    partialWrite,
    retryable: false,
  });
}

function requestRecoveryCanvas(target: WorkerRealm, signal: AbortSignal): Promise<OffscreenCanvas> {
  if (realm !== target || realmTransitions > 0 || target.canvas === undefined || signal.aborted) {
    return Promise.reject(
      new AppError({
        code: 'app-not-started',
        expected: APP_EXPECTED['app-not-started'],
        hint: APP_ERROR_HINTS['app-not-started'],
        detail: {},
      }),
    );
  }
  return new Promise((resolve, reject) => {
    const requestId = ++surfaceRequestId;
    const finish = (result: ExecutionSurfaceResultMessage['result']): void => {
      if (target.pendingSurface?.requestId !== requestId) return;
      delete target.pendingSurface;
      signal.removeEventListener('abort', cancel);
      if (!result.ok) {
        reject(result.error);
        return;
      }
      if (realm !== target || realmTransitions > 0) {
        reject(
          new AppError({
            code: 'app-not-started',
            expected: APP_EXPECTED['app-not-started'],
            hint: APP_ERROR_HINTS['app-not-started'],
            detail: {},
          }),
        );
        return;
      }
      target.canvas = result.value;
      resolve(result.value);
    };
    const cancel = (): void =>
      finish(
        err(
          new AppError({
            code: 'app-not-started',
            expected: APP_EXPECTED['app-not-started'],
            hint: APP_ERROR_HINTS['app-not-started'],
            detail: {},
          }),
        ),
      );
    // Renderer owns recovery single-flight; this slot only owns the native reply.
    target.pendingSurface?.cancel();
    target.pendingSurface = { requestId, complete: finish, cancel };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      scope.postMessage({
        kind: 'surface-request',
        worldIdentity: target.world.identity,
        requestId,
      });
    } catch (cause) {
      delete target.pendingSurface;
      signal.removeEventListener('abort', cancel);
      reject(cause);
    }
  });
}

async function disposeRealm(target: WorkerRealm): Promise<void> {
  target.pendingSurface?.cancel();
  let renderFailure: unknown;
  try {
    await target.renderWorker?.dispose();
  } catch (cause) {
    renderFailure = cause;
  }
  target.observation?.release();
  target.observation = undefined;
  try {
    target.profiler?.activeSession()?.finish();
  } catch {
    // Diagnostics never turn realm disposal into a second failure.
  }
  target.releaseProfilerCatalog?.();
  target.releaseProfilerCatalog = undefined;
  try {
    await target.pluginContext?.fiber.dispose();
  } finally {
    target.pluginContext = undefined;
    target.publicationTargets?.dispose();
    target.assetAssembly?.dispose();
    // A split source realm creates its CPU Registry without a Renderer host.
    if (target.init.workers.render.enabled) target.assetAssembly?.registry.dispose();
    target.assetAssembly = undefined;
    await target.rhiAttachment?.dispose();
    target.rhiAttachment = undefined;
    target.rhiCapture = undefined;
    target.pendingAudioIntents.clear();
    target.feedback.dispose();
  }
  if (renderFailure !== undefined) throw renderFailure;
}

function postBootstrapFault(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}): void {
  postFault('bootstrap', error.code, error.expected, error.hint, error.detail);
}

async function createRealm(init: ExecutionInitMessage): Promise<boolean> {
  const preparedResult = await prepareBootstrapEntry(init.bootstrapUrl, init.bootstrapData);
  if (!preparedResult.ok) {
    postBootstrapFault(preparedResult.error);
    return false;
  }
  const prepared: PreparedExecutionBootstrap = preparedResult.value;
  const sourceFeatures = [...(prepared.features ?? [])];
  const nextWorld = new World({
    ...(init.time !== undefined ? { time: init.time } : {}),
    storage: init.workers.kernels.enabled ? 'shared' : 'local',
  });
  const profiler = init.diagnostics?.profiler === true ? createProfiler() : undefined;
  const profilerCatalog = profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  const candidate: WorkerRealm = {
    world: nextWorld,
    canvas: init.workers.render.enabled ? undefined : init.canvas,
    drawingBufferSize: { width: init.canvas.width, height: init.canvas.height },
    init,
    assetAssembly: undefined,
    pendingAudioIntents: new AudioIntentQueue(),
    audioBackend: undefined,
    feedback: createGamepadFeedback(),
    kernelPool: undefined,
    pluginContext: undefined,
    observation: undefined,
    profiler,
    releaseProfilerCatalog: profilerCatalog?.ok === true ? profilerCatalog.value : undefined,
    rhiCapture: undefined,
    rhiAttachment: undefined,
    profilerCaptureId: undefined,
    profilerFrameId: 0,
  };
  const feedback = candidate.feedback;
  const realmInput = { ...inputBackend, feedback };
  const audioBackend = createAudioIntentBackend({
    emit: (intent) => {
      candidate.pendingAudioIntents.push(intent);
    },
    state: () => ({
      contextState: 'suspended',
      activeSourceCount: 0,
      lastError: null,
      ...(candidate.musicState ? { music: candidate.musicState } : {}),
      ...(candidate.audioPreparation ? { preparation: candidate.audioPreparation } : {}),
    }),
  });
  candidate.audioBackend = audioBackend;
  let candidateRenderer: Renderer | undefined;
  let rendererLifecycleTransferred = false;
  let rhiLifecycleTransferred = false;
  const previousRenderer = renderer;
  let previousSurfaceReleased = false;
  let stagedRenderWorker: SourceRenderWorker | undefined;
  let stagedRenderFailure: { readonly cause: unknown } | undefined;
  try {
    if (previousRenderer !== undefined) {
      const released = previousRenderer.releaseSurface();
      if (!released.ok) throw released.error;
      previousSurfaceReleased = true;
    }
    const runtimeBinding = init.assetCatalog?.runtimeBinding;
    const bundler =
      init.shaderManifestUrl === undefined &&
      init.build === undefined &&
      runtimeBinding === undefined
        ? undefined
        : {
            ...(init.shaderManifestUrl === undefined
              ? {}
              : { shaderManifestUrl: init.shaderManifestUrl }),
            ...(init.build === undefined ? {} : { build: init.build }),
            ...(runtimeBinding === undefined
              ? {}
              : { importTransport: createDevImportTransport(runtimeBinding) }),
          };
    const rendererOptions: import('@forgeax/engine-render').RendererOptions = {
      ...(init.workers.render.enabled
        ? {}
        : {
            resolveRecoveryCanvas: (signal: AbortSignal) =>
              requestRecoveryCanvas(candidate, signal),
          }),
      ...(prepared.features === undefined ? {} : { features: prepared.features }),
      ...(prepared.ssrIdentity === undefined ? {} : { ssrIdentity: prepared.ssrIdentity }),
      ...(profiler === undefined ? {} : { profiler }),
      ...(init.diagnostics?.shadowWorkload === true ? { shadowWorkload: true } : {}),
      ...(init.diagnostics?.gpuPassTiming === undefined
        ? {}
        : { gpuPassTiming: init.diagnostics.gpuPassTiming }),
      ...(init.pipelineLibrary === undefined ? {} : { pipelineLibrary: init.pipelineLibrary }),
      ...(init.outputColorSpace === undefined ? {} : { outputColorSpace: init.outputColorSpace }),
      ...(init.dynamicGeometryMeshBudgetBytes === undefined
        ? {}
        : { dynamicGeometryMeshBudgetBytes: init.dynamicGeometryMeshBudgetBytes }),
      ...(init.assetBudgetBytes === undefined ? {} : { assetBudgetBytes: init.assetBudgetBytes }),
    };
    if (init.diagnostics?.rhiCapture === true && !init.workers.render.enabled) {
      const attachment = await attachWorkerRhiRecorder();
      candidate.rhiAttachment = attachment;
      candidate.rhiCapture = createRhiCapture(attachment);
      Object.assign(rendererOptions, {
        rhi: attachment.backend.rhi,
        rhiInstrumentation: createRhiInstrumentation(attachment),
      });
    }
    const split = init.workers.render.enabled;
    if (split) candidate.publicationTargets = new RenderPublicationTargetOwner();
    if (split) {
      for (const plugin of prepared.plugins ?? []) {
        if ('renderer' in Inject.resolve(plugin.inject))
          throw new RenderPublicationError({
            reason: 'unsupported',
            subject: `source plugin ${plugin.name ?? 'anonymous'} requires the child Renderer`,
          });
      }
    }
    const constructed = split
      ? undefined
      : await constructRuntimeRendererHost(init.canvas, rendererOptions, bundler);
    if (constructed !== undefined && !constructed.ok) throw constructed.error;
    const host = constructed?.ok === true ? constructed.value : undefined;
    candidateRenderer = host?.renderer;
    if (candidateRenderer !== undefined) await prepared.configureRenderer?.(candidateRenderer);
    const catalogSource =
      init.assetCatalog === undefined
        ? undefined
        : createCatalogSource({
            url: init.assetCatalog.url,
            ...(init.assetCatalog.expectedScope === undefined
              ? {}
              : { expectedScope: init.assetCatalog.expectedScope }),
          });
    const assets =
      host?.assets ??
      (await createPublicationAssets(
        bundler,
        init.assetBudgetBytes === undefined ? {} : { assetBudgetBytes: init.assetBudgetBytes },
      ));
    try {
      const assembly = createAssetRuntimeAssembly(assets, {
        ...(catalogSource === undefined ? {} : { catalogSource }),
        ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
      });
      if (!assembly.ok) throw assembly.error;
      candidate.assetAssembly = assembly.value;
    } catch (cause) {
      // Before assembly admission, the split source has no other lifecycle owner.
      if (split) assets.dispose();
      throw cause;
    }
    const renderTargets = candidate.publicationTargets?.authoring ?? candidateRenderer;
    if (split) {
      // Construct the source service before plugin apply; physical initialization
      // still waits for the existing root/World commit boundary below.
      stagedRenderWorker = new SourceRenderWorker(
        nextWorld,
        assets,
        init,
        (message) => scope.postMessage(message),
        sourceFeatures,
        candidate.publicationTargets,
      );
    }
    const pluginContext = await createWorldContext(
      nextWorld,
      workerEngineProfile({
        ...(candidateRenderer === undefined ? {} : { renderer: candidateRenderer }),
        rendererFeatureHost:
          host === undefined
            ? {
                async installFeature(feature) {
                  if (
                    prepared.features?.includes(feature) ||
                    fullscreenRenderFeatureDeclaration(feature) !== undefined
                  ) {
                    if (!sourceFeatures.includes(feature)) sourceFeatures.push(feature);
                    let released = false;
                    return {
                      ok: true,
                      value: {
                        async release() {
                          if (!released) {
                            released = true;
                            const index = sourceFeatures.indexOf(feature);
                            if (index >= 0) sourceFeatures.splice(index, 1);
                          }
                          return { ok: true, value: undefined };
                        },
                      },
                    };
                  }
                  return {
                    ok: false,
                    error: new RenderPublicationError({
                      reason: 'unsupported',
                      subject: `RenderFeature ${feature.identity}`,
                    }),
                  };
                },
              }
            : createRenderFeatureHost(host.featureHost),
        assets,
        input: realmInput,
        audio: audioBackend,
        assetAssembly: candidate.assetAssembly,
        ...(prepared.pluginPrograms === undefined
          ? {}
          : { pluginPrograms: prepared.pluginPrograms }),
        ...(prepared.runtimePacks === undefined ? {} : { runtimePacks: prepared.runtimePacks }),
        ...(init.animation === undefined ? {} : { animation: init.animation }),
        extensions: [
          ...(init.workers.kernels.enabled ? [sharedKernelPlugin(candidate)] : []),
          executionBootstrapHostPlugin(
            {
              ...(stagedRenderWorker === undefined
                ? {}
                : { dynamicGeometry: stagedRenderWorker.dynamicGeometry }),
              ...(renderTargets === undefined ? {} : { renderTargets }),
              get canvas() {
                return candidate.canvas;
              },
              drawingBufferSize: () => candidate.drawingBufferSize,
              ...(init.bootstrapPort === undefined ? {} : { port: init.bootstrapPort }),
              querySubmittedTerrainHeight: (request) => {
                if (candidate.renderWorker === undefined)
                  return Promise.resolve(
                    err({
                      code: 'terrain-query-unavailable',
                      expected: 'an active Render Worker',
                      hint: 'wait for renderer readiness',
                      detail: { field: 'Worker' },
                    }),
                  );
                return candidate.renderWorker.queryLatestSubmittedTerrainHeight(request);
              },
              setPointerLockAllowed(allowed): void {
                scope.postMessage({
                  kind: 'host-control',
                  command: 'set-pointer-lock-allowed',
                  allowed,
                });
              },
            },
            candidateRenderer,
          ),
          ...(prepared.plugins ?? []),
        ],
      }),
    );
    candidate.pluginContext = pluginContext;
    rendererLifecycleTransferred = true;
    if (split) {
      try {
        stagedRenderWorker?.preloadModule();
      } catch (cause) {
        // Retain the original root/commit failure order before the old start boundary.
        stagedRenderFailure = { cause };
      }
    }
    if (prepared.root)
      await activateExecutionRoot(pluginContext, prepared.root, {
        timeoutMs: init.startupTimeoutMs,
      });
    if (candidateRenderer !== undefined)
      applyRendererOrderDiagnostic(
        candidateRenderer,
        init.diagnostics?.gbufferBatchOrderDiagnostic,
        init.diagnostics?.featureReadOnlyDepthBatchDiagnostic,
      );
    const activeRenderer = candidateRenderer;
    const previousRealm = realm;
    await candidate.kernelPool?.ready();
    const committed =
      candidateRenderer === undefined
        ? true
        : await commitAttachedWorld(candidateRenderer, nextWorld, async () => true);
    if (!committed) {
      await disposeRealm(candidate);
      if (previousSurfaceReleased) previousRenderer?.restoreSurface();
      return false;
    }
    // A successful World replacement is a lease boundary too. Revoke only
    // after the candidate is committed so a failed rebuild cannot clear input
    // still owned by the live previous World; the generation fence then makes
    // every old async inspection handle permanently read-only.
    if (split) {
      if (stagedRenderFailure !== undefined) throw stagedRenderFailure.cause;
      if (stagedRenderWorker === undefined) {
        throw new Error('Split renderer reached its start boundary without a staged Render Worker');
      }
      candidate.renderWorker = stagedRenderWorker;
      stagedRenderWorker = undefined;
      await candidate.renderWorker.start(init.canvas);
      if (init.diagnostics?.rhiCapture === true) candidate.rhiCapture = candidate.renderWorker;
    }
    inputBackend.revokeInjectedLease();
    realm = candidate;
    renderer = activeRenderer;
    rhiLifecycleTransferred = candidate.rhiAttachment !== undefined;
    lastFrameId = 0;
    renderSampleTimeSeconds = 0;
    submitRejectionsWithoutFrame = 0;
    if (previousRealm !== undefined) await disposeRealm(previousRealm);
    return true;
  } catch (cause) {
    await disposeRealm(candidate);
    if (!rendererLifecycleTransferred) candidateRenderer?.dispose();
    if (!rhiLifecycleTransferred) candidate.rhiAttachment = undefined;
    if (previousSurfaceReleased) previousRenderer?.restoreSurface();
    throw cause;
  } finally {
    await stagedRenderWorker?.dispose();
  }
}

async function initialize(message: ExecutionInitMessage): Promise<void> {
  try {
    if (!(await createRealm(message))) return;
    scope.postMessage({
      kind: 'ready',
      worldIdentity: realm?.world.identity ?? '',
      realm: 'worker',
      workerWebGpu: typeof navigator === 'object' && navigator.gpu !== undefined,
    });
  } catch (cause) {
    postFault(
      'bootstrap',
      'app-execution-bootstrap-failed',
      'Engine Worker creates a realm-local World, Renderer and GPU owner',
      'inspect the worker bootstrap cause and module URL',
      cause,
    );
  }
}

function waitUntilRendererAlive(activeRenderer: Renderer): Promise<boolean> {
  return new Promise((resolve) => {
    let stop = () => {};
    const inspect = () => {
      const state = activeRenderer.state();
      if (state === 'device-lost' || state === 'recovering') return;
      stop();
      resolve(state === 'alive');
    };
    stop = activeRenderer.subscribe((event) => {
      if (event.kind === 'state-changed') inspect();
    });
    inspect();
  });
}

let submitRejectionsWithoutFrame = 0;
async function runFrame(message: ExecutionFrameMessage): Promise<void> {
  const activeRealm = realm;
  const activeRenderer = renderer;
  if (
    activeRealm === undefined ||
    (activeRenderer === undefined && activeRealm.renderWorker === undefined)
  )
    return;
  const { world } = activeRealm;
  if (message.worldIdentity !== world.identity || message.frameId <= lastFrameId) return;
  // A frame dispatched before native loss still owns Host credit. Keep it
  // pending without advancing the World until explicit recovery is complete.
  if (
    activeRenderer !== undefined &&
    activeRenderer.state() !== 'alive' &&
    !(await waitUntilRendererAlive(activeRenderer))
  )
    return;
  if (activeRealm.renderWorker !== undefined && !(await activeRealm.renderWorker.waitUntilReady()))
    return;
  if (realm !== activeRealm) return;
  // Reject an invalid request before even input/camera writes can advance its World.
  if (activeRealm.renderWorker?.hasPublicationCapacity === false) {
    postFault(
      'runtime',
      'app-frame-step-invalid',
      'source publication capacity before a World update',
      'wait for a current Render Worker completion before admitting another frame',
      { state: 'running', deltaSeconds: message.deltaSeconds, reason: 'credit' },
    );
    return;
  }
  if (message.musicState) activeRealm.musicState = message.musicState;
  else delete activeRealm.musicState;
  if (message.audioPreparation) activeRealm.audioPreparation = message.audioPreparation;
  else delete activeRealm.audioPreparation;
  for (const asset of message.rejectedAudioPublications ?? [])
    activeRealm.audioBackend?.rejectPublication(asset);
  currentSample = message.inputSample;
  const sampleTimeSeconds =
    message.sampleTimeSeconds === undefined
      ? renderSampleTimeSeconds + message.deltaSeconds
      : message.sampleTimeSeconds;
  const canvasWidth =
    Number.isFinite(message.canvasWidth) && message.canvasWidth > 0
      ? Math.max(1, Math.floor(message.canvasWidth))
      : undefined;
  const canvasHeight =
    Number.isFinite(message.canvasHeight) && message.canvasHeight > 0
      ? Math.max(1, Math.floor(message.canvasHeight))
      : undefined;
  activeRealm.drawingBufferSize = { width: canvasWidth ?? 0, height: canvasHeight ?? 0 };
  if (canvasWidth !== undefined && canvasHeight !== undefined) {
    if (activeRealm.canvas !== undefined) {
      if (activeRealm.canvas.width !== canvasWidth) activeRealm.canvas.width = canvasWidth;
      if (activeRealm.canvas.height !== canvasHeight) activeRealm.canvas.height = canvasHeight;
    }
    syncCameraAspect(world, canvasWidth, canvasHeight);
  }
  admitInspections();
  const started = performance.now();
  const profileSession = activeRealm.profiler?.activeSession();
  let profileFrame: ProfileFrameToken | undefined;
  if (profileSession !== undefined) {
    if (activeRealm.profilerCaptureId !== profileSession.captureId) {
      activeRealm.profilerCaptureId = profileSession.captureId;
      activeRealm.profilerFrameId = 0;
    }
    const frame = profileSession.beginFrame(++activeRealm.profilerFrameId);
    if (frame.ok) {
      profileFrame = {
        captureId: profileSession.captureId,
        frameId: activeRealm.profilerFrameId,
      };
    }
  }
  try {
    const update = profilePhase(profileSession, 'world-update-primary', () =>
      world.update(message.deltaSeconds),
    );
    if (!update.ok) throw update.error;
    if (world.execution.health === 'poisoned') {
      const fault = world.execution.fault;
      postFault(
        'world',
        fault?.code ?? 'world-poisoned',
        'World remains healthy through update',
        'rebuild the poisoned World explicitly',
        fault,
        fault?.partialWrite ?? true,
      );
      return;
    }
    const updateFinished = performance.now();
    const kernelDispatch = activeRealm.kernelPool?.takeLastDispatch() ?? null;
    const kernelMetrics =
      kernelDispatch === null
        ? {}
        : {
            kernelDispatch: {
              eligible: true,
              usedShared: kernelDispatch.mode === 'shared',
              reason:
                kernelDispatch.mode === 'shared' ? ('shared' as const) : ('forced-inline' as const),
              dispatched: kernelDispatch.dispatched,
              completed: kernelDispatch.completed,
            },
          };
    activeRealm.observation?.prepareFrame();
    if (activeRealm.renderWorker !== undefined) {
      activeRealm.renderWorker.publish(message, sampleTimeSeconds);
      renderSampleTimeSeconds = sampleTimeSeconds;
      lastFrameId = message.frameId;
      const audioIntents = activeRealm.pendingAudioIntents.drain();
      scope.postMessage({
        kind: 'simulation-complete',
        worldIdentity: world.identity,
        frameId: message.frameId,
        engineUpdateMs: updateFinished - started,
        kernelWaitMs: kernelDispatch?.waitMs ?? 0,
        ...kernelMetrics,
        ...(audioIntents.length ? { audioIntents } : {}),
        feedbackIntents: activeRealm.feedback.drainIntents(),
      });
      return;
    }
    if (activeRenderer === undefined) return;
    while (true) {
      const attached = activeRenderer.attach(world);
      if (!attached.ok) throw attached.error;
      const draw = profilePhase(profileSession, 'renderer-draw', () =>
        activeRenderer.draw({
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
          sampleTimeSeconds,
          ...(message.temporalReset ? { temporalReset: true } : {}),
          ...(profileFrame === undefined ? {} : { profileFrame }),
          ...(activeRealm.init.diagnostics?.geometryLane === undefined
            ? {}
            : { geometryLane: activeRealm.init.diagnostics.geometryLane }),
        }),
      );
      if (!draw.ok) {
        if (
          draw.error.code === 'frame-submit-rejected' &&
          draw.error.detail.accepted === false &&
          activeRenderer.state() === 'alive' &&
          ++submitRejectionsWithoutFrame === 1
        ) {
          lastFrameId = message.frameId;
          const audioIntents = activeRealm.pendingAudioIntents.drain();
          scope.postMessage({
            kind: 'simulation-complete',
            worldIdentity: world.identity,
            frameId: message.frameId,
            engineUpdateMs: updateFinished - started,
            kernelWaitMs: kernelDispatch?.waitMs ?? 0,
            ...kernelMetrics,
            ...(audioIntents.length ? { audioIntents } : {}),
            feedbackIntents: activeRealm.feedback.drainIntents(),
            renderRejection: {
              code: draw.error.code,
              expected: draw.error.expected,
              hint: draw.error.hint,
              detail: draw.error.detail,
            },
          });
          return;
        }
        throw draw.error;
      }
      submitRejectionsWithoutFrame = 0;
      // Publish the fallback worker clock only after the renderer accepted this
      // frame. A rejected submit must leave the temporal sample pair and the
      // next implicit timestamp unchanged.
      if (Number.isFinite(sampleTimeSeconds)) renderSampleTimeSeconds = sampleTimeSeconds;
      scope.postMessage({
        kind: 'frame-submitted',
        worldIdentity: world.identity,
        frameId: message.frameId,
        deviceGeneration: draw.value.deviceGeneration,
        ...(draw.value.shadowWorkload === undefined
          ? {}
          : { shadowWorkload: draw.value.shadowWorkload }),
        ...(draw.value.graphGeneration === undefined
          ? {}
          : { graphGeneration: draw.value.graphGeneration }),
        ...(draw.value.barrelDistortion === undefined
          ? {}
          : { barrelDistortion: draw.value.barrelDistortion }),
      });
      const completed = await draw.value.completed;
      if (!completed.ok) {
        const failure = completed.error;
        if (
          failure.code !== 'device-operation-failed' ||
          failure.detail.operation !== 'complete-frame' ||
          failure.detail.cause.code !== 'device-lost'
        )
          throw failure;
        // The World has already advanced. Wait for its caller's explicit
        // Renderer recovery, then retry only rendering with the same sample.
        const recovered = await waitUntilRendererAlive(activeRenderer);
        if (realm !== activeRealm) return;
        if (!recovered) throw failure;
        continue;
      }
      lastFrameId = message.frameId;
      const audioIntents = activeRealm.pendingAudioIntents.drain();
      scope.postMessage({
        kind: 'frame-complete',
        worldIdentity: world.identity,
        frameId: message.frameId,
        deviceGeneration: draw.value.deviceGeneration,
        ...(draw.value.shadowWorkload === undefined
          ? {}
          : { shadowWorkload: draw.value.shadowWorkload }),
        ...(draw.value.graphGeneration === undefined
          ? {}
          : { graphGeneration: draw.value.graphGeneration }),
        ...(draw.value.barrelDistortion === undefined
          ? {}
          : { barrelDistortion: draw.value.barrelDistortion }),
        presentation: draw.value.presentation,
        ...(draw.value.presentation !== 'pending' ||
        draw.value.presentationPendingReason === undefined
          ? {}
          : { presentationPendingReason: draw.value.presentationPendingReason }),
        engineUpdateMs: updateFinished - started,
        kernelWaitMs: kernelDispatch?.waitMs ?? 0,
        ...(audioIntents.length > 0 ? { audioIntents } : {}),
        feedbackIntents: activeRealm.feedback.drainIntents(),
        ...kernelMetrics,
      });
      return;
    }
  } catch (cause) {
    const fault = world.execution.fault;
    postFault(
      fault === null ? 'runtime' : 'world',
      fault?.code ?? 'app-system-update-failed',
      'World update completes before Renderer draw',
      fault === null ? 'inspect the runtime cause' : 'rebuild the poisoned World explicitly',
      cause,
      fault?.partialWrite ?? false,
    );
  } finally {
    if (profileFrame !== undefined) {
      try {
        profileSession?.endFrame();
      } catch {
        // Profiling is observational and never changes Worker frame ownership.
      }
    }
  }
}

async function rebuild(message: ExecutionRebuildMessage): Promise<void> {
  const activeRealm = realm;
  if (
    activeRealm === undefined ||
    (renderer === undefined && activeRealm.renderWorker === undefined) ||
    message.worldIdentity !== activeRealm.world.identity
  )
    return;
  const previousWorldIdentity = activeRealm.world.identity;
  try {
    const cancelled = inspectionQueue.splice(0, inspectionQueue.length);
    for (const job of cancelled) {
      scope.postMessage({
        kind: 'inspect-result',
        requestId: job.requestId,
        worldIdentity: previousWorldIdentity,
        result: {
          ok: false,
          error: {
            code: 'live-world-stale',
            hint: 'The World was rebuilt before inspection admission.',
            detail: { worldIdentity: previousWorldIdentity },
          },
        },
      });
    }
    const canvas = message.canvas ?? activeRealm.canvas;
    if (canvas === undefined) throw new Error('World rebuild requires a fresh rendering canvas');
    await activeRealm.renderWorker?.dispose();
    const init: ExecutionInitMessage = { ...activeRealm.init, canvas };
    if (!(await createRealm(init))) return;
    scope.postMessage({
      kind: 'rebuilt',
      previousWorldIdentity,
      worldIdentity: realm?.world.identity ?? '',
    });
  } catch (cause) {
    postFault(
      'rebuild',
      'app-execution-rebuild-failed',
      'bootstrap creates a fresh World identity',
      'inspect the bootstrap cause or create a new App',
      cause,
    );
  }
}

scope.onmessage = (event): void => {
  const message = event.data;
  switch (message.kind) {
    case 'surface-result': {
      const target = realm;
      if (
        target?.world.identity !== message.worldIdentity ||
        target.pendingSurface?.requestId !== message.requestId
      )
        return;
      target.pendingSurface.complete(message.result);
      return;
    }
    case 'render-replace':
      void realm?.renderWorker
        ?.replace(message.epoch, message.canvas)
        .catch((cause) =>
          postFault(
            'runtime',
            'render-worker-recovery-failed',
            'replacement Renderer starts',
            'inspect replacement failure',
            cause,
          ),
        );
      return;
    case 'init':
      void withRealmTransition(() => initialize(message));
      return;
    case 'frame':
      void runFrame(message);
      return;
    case 'inspect':
      inspectionQueue.push(message);
      admitInspections();
      return;
    case 'inspect-cancel': {
      // A request absent from the queue has either started or already posted
      // its terminal result. Keep the caller attached to that execution rather
      // than falsely claiming it was cancelled before admission.
      const index = inspectionQueue.findIndex((job) => job.requestId === message.requestId);
      if (index >= 0) inspectionQueue.splice(index, 1);
      scope.postMessage({
        kind: 'inspect-canceled',
        requestId: message.requestId,
        worldIdentity: realm?.world.identity ?? message.worldIdentity,
        admitted: index < 0,
      });
      return;
    }
    case 'rebuild':
      void withRealmTransition(() => rebuildQueue.enqueue(() => rebuild(message)));
      return;
    case 'dispose':
      inspectionsClosed = true;
      void withRealmTransition(async () => {
        const target = realm;
        realm = undefined;
        inspectionQueue.length = 0;
        try {
          if (target !== undefined) await disposeRealm(target);
          scope.postMessage({ kind: 'disposed' });
        } catch (cause) {
          scope.postMessage({ kind: 'disposed', error: serializableDetail(cause) });
        } finally {
          target?.init.bootstrapPort?.close();
          scope.close();
        }
      });
      return;
    case 'input-clear':
      inputBackend.revokeInjectedLease();
      return;
    case 'input-lease-open':
      inputBackend.beginInjectedLease();
      return;
    case 'profile-finish':
      try {
        const current = realm;
        const active = current?.profiler?.activeSession();
        if (
          active !== undefined &&
          (message.worldIdentity === undefined ||
            current?.world.identity === message.worldIdentity) &&
          (message.captureId === undefined || active.captureId === message.captureId)
        ) {
          active.finish();
        }
      } catch {
        // Diagnostic cleanup is best effort and never changes the Worker state.
      }
      return;
  }
};
