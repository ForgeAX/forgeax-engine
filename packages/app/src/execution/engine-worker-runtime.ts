import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { stepRetainedBytes } from '@forgeax/engine-assets-runtime/internal';
import { createAudioIntentBackend } from '@forgeax/engine-audio';
import {
  createWorldContext,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  World,
} from '@forgeax/engine-ecs';
import type { KernelDispatchResult } from '@forgeax/engine-ecs/shared';
import {
  createVideoFrameEndpoint,
  installWorkerVideoSourceProvider,
  type VideoFrameEndpoint,
} from '@forgeax/engine-graphics-extras';
import {
  type CompositeInputLease,
  createGamepadFeedback,
  type InputBackend,
  type InputBackendSample,
  makeCompositeBackend,
} from '@forgeax/engine-input';
import { PHYSICS_STARTUP_OPTIONS } from '@forgeax/engine-physics';
import {
  createTaskPool,
  type TaskPool,
  type TaskWorkerFactory,
  type TaskWorkerListener,
} from '@forgeax/engine-platform';
import { type Context, Inject, type Plugin } from '@forgeax/engine-plugin';
import {
  createProfiler,
  type ProfileFrameToken,
  type Profiler,
  type RecorderSession,
} from '@forgeax/engine-profiler';
import {
  type FrameReceipt,
  type RenderError,
  type Renderer,
  type RendererOptions,
  type RenderFeature,
  type RenderInspection,
  RenderPublicationError,
  RenderPublicationTargetOwner,
} from '@forgeax/engine-render';
import {
  createWaterInfoSourceFeature,
  createWaterUnderwaterFeature,
  fullscreenRenderFeatureDeclaration,
  WATER_INFO_FEATURE_IDENTITY,
  WATER_UNDERWATER_FEATURE_IDENTITY,
} from '@forgeax/engine-render/internal';
import { builtinTaskKinds } from '@forgeax/engine-render/tasks';
import { ownPipelineLibrary } from '@forgeax/engine-rhi';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import {
  type AssetRegistry,
  type BundlerOptions,
  constructRuntimeRendererHost,
  type RendererHostAssembly,
  stagePublicationAssets,
} from '@forgeax/engine-runtime/internal/renderer-host';
import {
  AudioError,
  addLoadWork,
  beginLoadTimeline,
  beginLoadWork,
  bindLoadProgressScope,
  err,
} from '@forgeax/engine-types';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from '../assets-runtime-assembly';
import { syncCameraAspect } from '../canvas-policy';
import {
  applyRenderConfiguration,
  type ConfigurationApplyRequest,
  configurationApplyResponse,
  staleConfiguration,
} from '../configuration-apply';
import { freezeConfiguration } from '../configuration-data';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';
import {
  createRhiCapture,
  createRhiInstrumentation,
  type RhiCapture,
} from '../internal/rhi-capture';
import { workerEngineProfile } from '../internal/worker-engine-profile';
import { attachWorkerRhiRecorder } from '../internal/worker-rhi-capture';
import { AppLevelOwner } from '../levels/app-level-owner';
import { type AppObservation, createAppObservation } from '../observation';
import { createRenderFeatureHost, type RenderFeatureHost } from '../renderer-plugin';
import { APP_PHASE_CATALOG, type CanvasDrawingBufferSize } from '../types';
import { commitAttachedWorld, SerializedRebuildQueue } from './attached-world-swap';
import { AudioIntentQueue } from './audio-intent-queue';
import {
  activateExecutionRoot,
  type ExecutionBootstrapHost,
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
} from './bootstrap-entry';
import { installCarriedGpuStub } from './gpu-stub';
import { createLocalHdrFrameObserver } from './hdr-frame-observation';
import type {
  EngineToHostMessage,
  ExecutionFrameCompletion,
  ExecutionFrameMessage,
  ExecutionInitMessage,
  ExecutionInspectMessage,
  ExecutionRebuildMessage,
  ExecutionSimulationCompletion,
  ExecutionSurfaceResultMessage,
  HostToEngineMessage,
  RetainedExecutionInit,
} from './protocol';
import { readRendererInspection, rendererInspectionFailure } from './renderer-inspection';
import { applyRendererOrderDiagnostic } from './renderer-order-diagnostic';
import {
  createSharedKernelSliceExecutor,
  type SharedKernelSliceExecutor,
} from './shared-kernel-slices';
import { SourceRenderWorker } from './source-render-worker';
import type {
  ExecutionRendererInspectionOptions,
  ExecutionRendererInspectionResult,
} from './types';
import { serializableDetail } from './worker-error';
import {
  createWorkerFrameResponder,
  type FrameNotice,
  type FrameRequest,
} from './worker-frame-source';

const scope = globalThis as unknown as {
  postMessage(message: EngineToHostMessage | FrameNotice, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<HostToEngineMessage | FrameRequest>) => void) | null;
  close(): void;
};

let nativeFrames: ReturnType<typeof createWorkerFrameResponder> | undefined;
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
let nextTaskWorkerId = 0;
/** Live pool Workers by id, so page-reported failures reach their dispatcher. */
const taskWorkerListeners = new Map<number, TaskWorkerListener>();
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
  levels?: AppLevelOwner;
  stoppingLevels?: true;
  publicationTargets?: RenderPublicationTargetOwner;
  init: RetainedExecutionInit;
  assetAssembly: AssetRuntimeAssembly | undefined;
  readonly pendingAudioIntents: AudioIntentQueue;
  audioBackend: ReturnType<typeof createAudioIntentBackend> | undefined;
  audioState?: import('@forgeax/engine-audio').AudioState;
  feedback: ReturnType<typeof createGamepadFeedback>;
  kernelSlices: SharedKernelSliceExecutor | undefined;
  /** Realm-owned task dispatcher; its Workers spawn on first use. */
  taskPool: TaskPool | undefined;
  pluginContext: Context | undefined;
  observation: AppObservation | undefined;
  profiler: Profiler | undefined;
  releaseProfilerCatalog: (() => void) | undefined;
  rhiCapture: RhiCapture | undefined;
  rhiAttachment: RecorderAttachment | undefined;
}

let realm: WorkerRealm | undefined;
const rebuildQueue = new SerializedRebuildQueue();
const inspectionQueue: ExecutionInspectMessage[] = [];
let realmTransitions = 0;
/** One-shot linear-HDR request when the Renderer shares this Worker. */
const localHdr = createLocalHdrFrameObserver();
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
  localHdr.close();
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
    const importModule = async (specifier: string) => {
      // A Worker cannot resolve a bare package specifier from the browser
      // document. Vite's dev module endpoint is the same resolver used by the
      // main-realm bridge and resolves to the realm's canonical module graph.
      const browserSpecifier = specifier.startsWith('@') ? `/@id/${specifier}` : specifier;
      return import(/* @vite-ignore */ browserSpecifier);
    };
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
        observeNextHdrFrame: async (options?: { readonly signal?: AbortSignal }) => {
          if (realm !== target || realmTransitions > 0 || inspectionsClosed)
            return rendererInspectionFailure('not-ready');
          const result =
            target.renderWorker === undefined
              ? renderer === undefined
                ? rendererInspectionFailure('not-ready')
                : await localHdr.request(options)
              : await target.renderWorker.observeNextHdrFrame(options);
          return realm === target && realmTransitions === 0 && !inspectionsClosed
            ? result
            : rendererInspectionFailure('stale-session');
        },
        inspectRenderer: async <K extends keyof RenderInspection = keyof RenderInspection>(
          options?: ExecutionRendererInspectionOptions<K>,
        ): Promise<ExecutionRendererInspectionResult<Pick<RenderInspection, K>>> => {
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
      target.assetAssembly?.registry,
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
  return {
    name: 'shared-kernel-executor',
    inject: ['world'],
    apply(ctx) {
      const executor = createSharedKernelSliceExecutor({
        pool: () => realmTaskPool(target),
        startupTimeoutMs: target.init.startupTimeoutMs,
      });
      target.kernelSlices = executor;
      ctx.effect(() => {
        ctx.world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
        return () => {
          ctx.world.removeResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY);
          executor.dispose();
          if (target.kernelSlices === executor) target.kernelSlices = undefined;
        };
      }, 'execution/shared-kernel');
    },
  };
}

// Pool Workers are page-owned; this realm dispatches to them.
const taskWorkerFactory: TaskWorkerFactory = (listener) => {
  const workerId = nextTaskWorkerId++;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => listener.message(event.data);
  taskWorkerListeners.set(workerId, listener);
  scope.postMessage({ kind: 'task-worker', workerId, port: channel.port2 }, [channel.port2]);
  return {
    postMessage(message, transfer): void {
      channel.port1.postMessage(message, transfer ?? []);
    },
    terminate(): void {
      if (!taskWorkerListeners.delete(workerId)) return;
      channel.port1.onmessage = null;
      channel.port1.close();
      scope.postMessage({ kind: 'task-retire', workerId });
    },
  };
};

function realmTaskPool(target: WorkerRealm): TaskPool {
  // A host that never adopts pool Workers leaves the pool running inline.
  const startup = target.init.startupTimeoutMs;
  target.taskPool ??= createTaskPool({
    kinds: builtinTaskKinds,
    ...(target.init.startup?.settings.execution?.taskWorkers === undefined
      ? {}
      : { workers: target.init.startup.settings.execution.taskWorkers }),
    workerFactory: taskWorkerFactory,
    ...(startup === null ? {} : { startupTimeoutMs: startup }),
  });
  return target.taskPool;
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
  target.stoppingLevels = true;
  try {
    await target.levels?.closeStopped();
  } catch (cause) {
    renderFailure = cause;
  }
  try {
    await target.renderWorker?.dispose();
  } catch (cause) {
    renderFailure =
      renderFailure === undefined ? cause : new AggregateError([renderFailure, cause]);
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
    // After the Renderers that submit to it, so their tasks settle as cancelled.
    target.taskPool?.dispose();
    target.taskPool = undefined;
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

function createRealmWorld(init: ExecutionInitMessage): World {
  const world = new World({
    ...(init.time !== undefined ? { time: init.time } : {}),
    storage: init.workers.kernels.enabled ? 'shared' : 'local',
  });
  const physics = init.startup?.settings.simulation?.physics;
  if (physics !== undefined) world.insertResource(PHYSICS_STARTUP_OPTIONS, physics);
  return world;
}

function createRealmCandidate(init: RetainedExecutionInit, world: World): WorkerRealm {
  const profiler = init.diagnostics?.profiler === true ? createProfiler() : undefined;
  const profilerCatalog = profiler?.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  return {
    world,
    canvas: init.workers.render.enabled ? undefined : init.canvas,
    drawingBufferSize: { width: init.canvas.width, height: init.canvas.height },
    init,
    assetAssembly: undefined,
    pendingAudioIntents: new AudioIntentQueue(),
    audioBackend: undefined,
    feedback: createGamepadFeedback(),
    kernelSlices: undefined,
    taskPool: undefined,
    pluginContext: undefined,
    observation: undefined,
    profiler,
    releaseProfilerCatalog: profilerCatalog?.ok === true ? profilerCatalog.value : undefined,
    rhiCapture: undefined,
    rhiAttachment: undefined,
  };
}

function createRealmAudioBackend(
  candidate: WorkerRealm,
): ReturnType<typeof createAudioIntentBackend> {
  return createAudioIntentBackend({
    ...candidate.init.startup?.settings.audio?.publication,
    emit: (intent) => {
      candidate.pendingAudioIntents.push(intent);
    },
    state: () => candidate.audioState,
  });
}

function releasePreviousSurface(previousRenderer: Renderer | undefined): boolean {
  if (previousRenderer === undefined) return false;
  const released = previousRenderer.releaseSurface();
  if (!released.ok) throw released.error;
  return true;
}

function realmBundlerOptions(init: ExecutionInitMessage): BundlerOptions | undefined {
  const runtimeBinding = init.assetCatalog?.runtimeBinding;
  if (
    init.shaderManifestUrl === undefined &&
    init.build === undefined &&
    runtimeBinding === undefined
  )
    return undefined;
  return {
    ...(init.shaderManifestUrl === undefined ? {} : { shaderManifestUrl: init.shaderManifestUrl }),
    ...(init.build === undefined ? {} : { build: init.build }),
    ...(runtimeBinding === undefined
      ? {}
      : { importTransport: createDevImportTransport(runtimeBinding) }),
  };
}

function realmRendererOptions(
  candidate: WorkerRealm,
  prepared: PreparedExecutionBootstrap,
  pipelineLibrary: ExecutionInitMessage['pipelineLibrary'],
  backgroundPipelineLibrary: ExecutionInitMessage['backgroundPipelineLibrary'],
): RendererOptions {
  const { init, profiler } = candidate;
  return {
    ...(init.workers.render.enabled
      ? {}
      : {
          resolveRecoveryCanvas: (signal: AbortSignal) => requestRecoveryCanvas(candidate, signal),
        }),
    ...(init.startup?.settings.rendering?.view?.maxRenderShortSide === undefined
      ? {}
      : { maxRenderShortSide: init.startup.settings.rendering.view.maxRenderShortSide }),
    ...(prepared.features === undefined ? {} : { features: prepared.features }),
    ...(prepared.ssrIdentity === undefined ? {} : { ssrIdentity: prepared.ssrIdentity }),
    ...(profiler === undefined ? {} : { profiler }),
    ...(init.diagnostics?.shadowWorkload === true ? { shadowWorkload: true } : {}),
    ...(init.diagnostics?.gpuPassTiming === undefined
      ? {}
      : { gpuPassTiming: init.diagnostics.gpuPassTiming }),
    ...(pipelineLibrary === undefined ? {} : { pipelineLibrary }),
    ...(backgroundPipelineLibrary === undefined ? {} : { backgroundPipelineLibrary }),
    ...(init.backgroundPipelineLibraryConcurrency === undefined
      ? {}
      : { backgroundPipelineLibraryConcurrency: init.backgroundPipelineLibraryConcurrency }),
    ...(init.outputColorSpace === undefined ? {} : { outputColorSpace: init.outputColorSpace }),
    ...(init.renderBackend === undefined ? {} : { renderBackend: init.renderBackend }),
    ...(init.dynamicGeometryMeshBudgetBytes === undefined
      ? {}
      : { dynamicGeometryMeshBudgetBytes: init.dynamicGeometryMeshBudgetBytes }),
    ...(init.assetBudgetBytes === undefined ? {} : { assetBudgetBytes: init.assetBudgetBytes }),
    ...(init.textureMipSkip === undefined ? {} : { textureMipSkip: init.textureMipSkip }),
    ...(init.startup === undefined
      ? {}
      : {
          standardProfile: init.startup.rendering.profile,
        }),
    ...(init.workers.render.enabled ? {} : { tasks: realmTaskPool(candidate) }),
    ...(init.featureTextureReadbackBudgetBytes === undefined
      ? {}
      : { featureTextureReadbackBudgetBytes: init.featureTextureReadbackBudgetBytes }),
  };
}

// RHI capture in a merged realm records the realm-local Renderer device.
async function attachRealmRhiRecorder(
  candidate: WorkerRealm,
  rendererOptions: RendererOptions,
): Promise<void> {
  const { init } = candidate;
  if (init.diagnostics?.rhiCapture !== true || init.workers.render.enabled) return;
  const attachment = await attachWorkerRhiRecorder();
  candidate.rhiAttachment = attachment;
  candidate.rhiCapture = createRhiCapture(attachment);
  Object.assign(rendererOptions, {
    rhi: attachment.backend.rhi,
    rhiInstrumentation: createRhiInstrumentation(attachment),
  });
}

function prepareSplitSource(candidate: WorkerRealm, prepared: PreparedExecutionBootstrap): void {
  candidate.publicationTargets = new RenderPublicationTargetOwner();
  for (const plugin of prepared.plugins ?? []) {
    if ('renderer' in Inject.resolve(plugin.inject))
      throw new RenderPublicationError({
        reason: 'unsupported',
        subject: `source plugin ${plugin.name ?? 'anonymous'} requires the child Renderer`,
      });
  }
}

async function constructRealmRendererHost(
  init: ExecutionInitMessage,
  rendererOptions: RendererOptions,
  bundler: BundlerOptions | undefined,
): Promise<RendererHostAssembly | undefined> {
  if (init.workers.render.enabled) return undefined;
  const constructed = await constructRuntimeRendererHost(init.canvas, rendererOptions, bundler);
  if (!constructed.ok) throw constructed.error;
  return constructed.value;
}

function realmCatalogSource(
  init: ExecutionInitMessage,
): ReturnType<typeof createCatalogSource> | undefined {
  if (init.assetCatalog === undefined) return undefined;
  return createCatalogSource({
    url: init.assetCatalog.url,
    ...(init.assetCatalog.expectedScope === undefined
      ? {}
      : { expectedScope: init.assetCatalog.expectedScope }),
  });
}

function stageRealmAssets(
  init: ExecutionInitMessage,
  host: RendererHostAssembly | undefined,
  bundler: BundlerOptions | undefined,
) {
  if (host !== undefined) return { assets: host.assets, ready: undefined };
  return stagePublicationAssets(
    bundler,
    init.assetBudgetBytes === undefined ? {} : { assetBudgetBytes: init.assetBudgetBytes },
  );
}

function admitRealmAssetAssembly(
  init: ExecutionInitMessage,
  assets: AssetRegistry,
  catalogSource: ReturnType<typeof createCatalogSource> | undefined,
): AssetRuntimeAssembly {
  const runtimeBinding = init.assetCatalog?.runtimeBinding;
  try {
    const assembly = createAssetRuntimeAssembly(assets, {
      ...(catalogSource === undefined ? {} : { catalogSource }),
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
    });
    if (!assembly.ok) throw assembly.error;
    return assembly.value;
  } catch (cause) {
    // Before assembly admission, the split source has no other lifecycle owner.
    if (init.workers.render.enabled) assets.dispose();
    throw cause;
  }
}

// A split source realm has no Renderer: it admits only features the child
// Render Worker will construct, and records them for source publication.
function sourceRenderFeatureHost(
  prepared: PreparedExecutionBootstrap,
  sourceFeatures: RenderFeature<unknown>[],
): RenderFeatureHost {
  return {
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
  };
}

function realmBootstrapHost(
  candidate: WorkerRealm,
  stagedRenderWorker: SourceRenderWorker | undefined,
  renderer: Renderer | undefined,
): ExecutionBootstrapHost {
  const renderTargets = candidate.publicationTargets?.authoring ?? renderer;
  const port = candidate.init.bootstrapPort;
  return {
    ...(stagedRenderWorker === undefined
      ? {}
      : { dynamicGeometry: stagedRenderWorker.dynamicGeometry }),
    ...(candidate.levels === undefined ? {} : { levelCandidates: candidate.levels }),
    ...(renderTargets === undefined ? {} : { renderTargets }),
    get canvas() {
      return candidate.canvas;
    },
    drawingBufferSize: () => candidate.drawingBufferSize,
    ...(port === undefined ? {} : { port }),
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
  };
}

/** Lazily wraps `init.videoPort`; one endpoint serves every realm of this Worker. */
let videoEndpoint: VideoFrameEndpoint | undefined;

/**
 * Feed page-owned `<video>` frames into VideoAsset materials. A realm without
 * WebCodecs `VideoFrame` keeps no provider and reports why once.
 */
function videoFrameBridgePlugin(port: MessagePort): Plugin {
  return {
    name: 'video-frame-bridge',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        videoEndpoint ??= createVideoFrameEndpoint(port);
        const installed = installWorkerVideoSourceProvider(ctx.world, videoEndpoint);
        if (!installed.ok) {
          console.warn(`[forgeax] ${installed.error.code}: ${installed.error.hint}`);
          return () => {};
        }
        const provider = installed.value;
        return () => provider.dispose();
      }, 'execution/video-frame-bridge');
    },
  };
}

function realmExtensionPlugins(
  candidate: WorkerRealm,
  prepared: PreparedExecutionBootstrap,
  stagedRenderWorker: SourceRenderWorker | undefined,
  renderer: Renderer | undefined,
): Plugin[] {
  return [
    ...(candidate.init.workers.kernels.enabled ? [sharedKernelPlugin(candidate)] : []),
    ...(candidate.init.videoPort === undefined
      ? []
      : [videoFrameBridgePlugin(candidate.init.videoPort)]),
    executionBootstrapHostPlugin(
      realmBootstrapHost(candidate, stagedRenderWorker, renderer),
      renderer,
    ),
    ...(prepared.plugins ?? []),
  ];
}

function bootstrapProgramOptions(
  init: ExecutionInitMessage,
  prepared: PreparedExecutionBootstrap,
): Pick<
  Parameters<typeof workerEngineProfile>[0],
  'pluginPrograms' | 'runtimePacks' | 'animation'
> {
  return {
    ...(prepared.pluginPrograms === undefined ? {} : { pluginPrograms: prepared.pluginPrograms }),
    ...(prepared.runtimePacks === undefined ? {} : { runtimePacks: prepared.runtimePacks }),
    ...(init.animation === undefined ? {} : { animation: init.animation }),
  };
}

// Construct the source service before plugin apply; physical initialization
// still waits for the existing root/World commit boundary.
function stageSourceRenderWorker(
  candidate: WorkerRealm,
  assets: AssetRegistry,
  sourceFeatures: RenderFeature<unknown>[],
): SourceRenderWorker | undefined {
  if (!candidate.init.workers.render.enabled) return undefined;
  const worker = new SourceRenderWorker(
    candidate.world,
    assets,
    candidate.init,
    (message, transfer) => scope.postMessage(message, transfer ?? []),
    sourceFeatures,
    candidate.publicationTargets,
    realmTaskPool(candidate),
  );
  candidate.levels = new AppLevelOwner({
    world: candidate.world,
    assets,
    render: () => worker.levelRenderHost(),
    now: () => performance.now(),
    physics: () => candidate.pluginContext?.get('physics'),
    stopped: () => candidate.stoppingLevels === true,
  });
  return worker;
}

// Retain the original root/commit failure order before the start boundary.
function preloadStagedRenderWorker(
  stagedRenderWorker: SourceRenderWorker | undefined,
): { readonly cause: unknown } | undefined {
  try {
    stagedRenderWorker?.preloadModule();
  } catch (cause) {
    return { cause };
  }
  return undefined;
}

function adoptStagedRenderWorker(
  candidate: WorkerRealm,
  stagedRenderWorker: SourceRenderWorker | undefined,
  stagedRenderFailure: { readonly cause: unknown } | undefined,
): SourceRenderWorker {
  if (stagedRenderFailure !== undefined) throw stagedRenderFailure.cause;
  if (stagedRenderWorker === undefined) {
    throw new Error('Split renderer reached its start boundary without a staged Render Worker');
  }
  candidate.renderWorker = stagedRenderWorker;
  return stagedRenderWorker;
}

async function startAdoptedRenderWorker(
  candidate: WorkerRealm,
  renderWorker: SourceRenderWorker,
  pipelineLibrary: ExecutionInitMessage['pipelineLibrary'],
  backgroundPipelineLibrary: ExecutionInitMessage['backgroundPipelineLibrary'],
): Promise<void> {
  await renderWorker.start(candidate.init.canvas, pipelineLibrary, backgroundPipelineLibrary);
  if (candidate.init.diagnostics?.rhiCapture === true) candidate.rhiCapture = renderWorker;
}

function ownRealmPipelineInputs(startup: ExecutionInitMessage): ExecutionInitMessage {
  return {
    ...startup,
    ...(startup.pipelineLibrary === undefined
      ? {}
      : { pipelineLibrary: ownPipelineLibrary(startup.pipelineLibrary) }),
    ...(startup.backgroundPipelineLibrary === undefined
      ? {}
      : { backgroundPipelineLibrary: ownPipelineLibrary(startup.backgroundPipelineLibrary) }),
  };
}

async function createRealm(startup: ExecutionInitMessage): Promise<boolean> {
  startup = ownRealmPipelineInputs(startup);
  // Realm-owned facts exclude the library forwarded to the renderer for this start.
  const { pipelineLibrary, backgroundPipelineLibrary, ...init } = startup;
  const endImport = beginLoadTimeline('boot', 'bootstrap-import');
  const preparedResult = await prepareBootstrapEntry(
    init.bootstrapUrl,
    init.bootstrapData,
    undefined,
    init.startup,
  );
  endImport();
  if (!preparedResult.ok) {
    postBootstrapFault(preparedResult.error);
    return false;
  }
  const prepared: PreparedExecutionBootstrap = preparedResult.value;
  const sourceFeatures = [...(prepared.features ?? [])];
  const appendRealmSourceFeatures = () => {
    if (
      init.workers.render.enabled &&
      !sourceFeatures.some((feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY)
    )
      sourceFeatures.push(createWaterInfoSourceFeature());
    if (
      init.workers.render.enabled &&
      !sourceFeatures.some((feature) => feature.identity === WATER_UNDERWATER_FEATURE_IDENTITY)
    )
      sourceFeatures.push(createWaterUnderwaterFeature());
  };
  appendRealmSourceFeatures();
  const nextWorld = createRealmWorld(init);
  const candidate = createRealmCandidate(init, nextWorld);
  const realmInput = { ...inputBackend, feedback: candidate.feedback };
  const audioBackend = createRealmAudioBackend(candidate);
  candidate.audioBackend = audioBackend;
  let candidateRenderer: Renderer | undefined;
  let rendererLifecycleTransferred = false;
  let rhiLifecycleTransferred = false;
  const previousRenderer = renderer;
  let previousSurfaceReleased = false;
  let stagedRenderWorker: SourceRenderWorker | undefined;
  // Load progress: Renderer creation belongs to starting workers; plugin
  // bootstrap through World commit builds the scene.
  const rendererWork = beginLoadWork('workers');
  let sceneWork: (() => void) | undefined;
  try {
    previousSurfaceReleased = releasePreviousSurface(previousRenderer);
    const bundler = realmBundlerOptions(init);
    const rendererOptions = realmRendererOptions(
      candidate,
      prepared,
      pipelineLibrary,
      backgroundPipelineLibrary,
    );
    await attachRealmRhiRecorder(candidate, rendererOptions);
    const split = init.workers.render.enabled;
    if (split) prepareSplitSource(candidate, prepared);
    const endRenderer = beginLoadTimeline('boot', 'renderer');
    const host = await constructRealmRendererHost(init, rendererOptions, bundler);
    candidateRenderer = host?.renderer;
    if (candidateRenderer !== undefined && init.startup === undefined)
      await prepared.configureRenderer?.(candidateRenderer);
    rendererWork();
    endRenderer();
    sceneWork = beginLoadWork('scene');
    const catalogSource = realmCatalogSource(init);
    const { assets, ready: assetReadiness } = stageRealmAssets(init, host, bundler);
    candidate.assetAssembly = admitRealmAssetAssembly(init, assets, catalogSource);
    stagedRenderWorker = stageSourceRenderWorker(candidate, assets, sourceFeatures);
    const stagedRenderFailure = preloadStagedRenderWorker(stagedRenderWorker);
    if (assetReadiness !== undefined) await assetReadiness;
    const endPlugins = beginLoadTimeline('boot', 'plugin-bootstrap');
    const pluginContext = await createWorldContext(
      nextWorld,
      workerEngineProfile({
        ...(candidateRenderer === undefined ? {} : { renderer: candidateRenderer }),
        rendererFeatureHost:
          host === undefined
            ? sourceRenderFeatureHost(prepared, sourceFeatures)
            : createRenderFeatureHost(host.featureHost),
        assets,
        input: realmInput,
        audio: audioBackend,
        assetAssembly: candidate.assetAssembly,
        ...bootstrapProgramOptions(init, prepared),
        extensions: realmExtensionPlugins(
          candidate,
          prepared,
          stagedRenderWorker,
          candidateRenderer,
        ),
      }),
    );
    endPlugins();
    candidate.pluginContext = pluginContext;
    rendererLifecycleTransferred = true;
    if (prepared.root) {
      const endRoot = beginLoadTimeline('boot', 'root-activation');
      await activateExecutionRoot(pluginContext, prepared.root, {
        timeoutMs: init.startupTimeoutMs,
      });
      endRoot();
    }
    if (candidateRenderer !== undefined)
      applyRendererOrderDiagnostic(
        candidateRenderer,
        init.diagnostics?.gbufferBatchOrderDiagnostic,
        init.diagnostics?.featureReadOnlyDepthBatchDiagnostic,
      );
    const activeRenderer = candidateRenderer;
    const previousRealm = realm;
    const endCommit = beginLoadTimeline('boot', 'world-commit');
    await candidate.kernelSlices?.ready();
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
      const adopted = adoptStagedRenderWorker(candidate, stagedRenderWorker, stagedRenderFailure);
      stagedRenderWorker = undefined;
      const renderWorkerWork = beginLoadWork('workers');
      await startAdoptedRenderWorker(
        candidate,
        adopted,
        pipelineLibrary,
        backgroundPipelineLibrary,
      );
      renderWorkerWork();
    }
    sceneWork?.();
    endCommit();
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
    // A failed or superseded realm settles its load work too.
    rendererWork();
    sceneWork?.();
    await stagedRenderWorker?.dispose();
  }
}

async function initialize(message: ExecutionInitMessage): Promise<void> {
  try {
    if (message.loadProgressScope !== undefined) bindLoadProgressScope(message.loadProgressScope);
    addLoadWork('workers', { done: 1 });
    installCarriedGpuStub(message);
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

type FrameSimulationTiming = Pick<
  ExecutionFrameCompletion,
  'engineUpdateMs' | 'kernelWaitMs' | 'kernelDispatch'
>;

// Reject an invalid request before even input/camera writes can advance its World.
function admitSourcePublication(activeRealm: WorkerRealm, message: ExecutionFrameMessage): boolean {
  if (activeRealm.renderWorker?.hasPublicationCapacity !== false) return true;
  postFault(
    'runtime',
    'app-frame-step-invalid',
    'source publication capacity before a World update',
    'wait for a current Render Worker completion before admitting another frame',
    { state: 'running', deltaSeconds: message.deltaSeconds, reason: 'credit' },
  );
  return false;
}

function applyHostFrameState(activeRealm: WorkerRealm, message: ExecutionFrameMessage): void {
  if (message.audioState) {
    const { owner: _owner, lastError, ...state } = message.audioState;
    activeRealm.audioState = {
      ...state,
      lastError: lastError
        ? new AudioError({
            code: lastError.code,
            expected: lastError.expected,
            hint: lastError.hint,
            ...(lastError.detail === undefined ? {} : { detail: lastError.detail }),
          })
        : null,
    };
  } else delete activeRealm.audioState;
  for (const asset of message.rejectedAudioPublications ?? [])
    activeRealm.audioBackend?.rejectPublication(asset);
  currentSample = message.inputSample;
}

function frameSampleTimeSeconds(message: ExecutionFrameMessage): number {
  return message.sampleTimeSeconds === undefined
    ? renderSampleTimeSeconds + message.deltaSeconds
    : message.sampleTimeSeconds;
}

function drawingBufferExtent(extent: number): number | undefined {
  return Number.isFinite(extent) && extent > 0 ? Math.max(1, Math.floor(extent)) : undefined;
}

function applyDrawingBufferSize(activeRealm: WorkerRealm, message: ExecutionFrameMessage): void {
  const canvasWidth = drawingBufferExtent(message.canvasWidth);
  const canvasHeight = drawingBufferExtent(message.canvasHeight);
  activeRealm.drawingBufferSize = { width: canvasWidth ?? 0, height: canvasHeight ?? 0 };
  if (canvasWidth === undefined || canvasHeight === undefined) return;
  if (activeRealm.canvas !== undefined) {
    if (activeRealm.canvas.width !== canvasWidth) activeRealm.canvas.width = canvasWidth;
    if (activeRealm.canvas.height !== canvasHeight) activeRealm.canvas.height = canvasHeight;
  }
  syncCameraAspect(activeRealm.world, canvasWidth, canvasHeight);
}

function beginProfileFrame(
  profileSession: RecorderSession | undefined,
): ProfileFrameToken | undefined {
  if (profileSession === undefined) return undefined;
  const frame = profileSession.beginFrame();
  return frame.ok ? frame.value : undefined;
}

function endProfileFrame(
  profileSession: RecorderSession | undefined,
  profileFrame: ProfileFrameToken | undefined,
): void {
  if (profileFrame === undefined) return;
  try {
    profileSession?.endFrame();
  } catch {
    // Profiling is observational and never changes Worker frame ownership.
  }
}

function postWorldPoisoned(world: World): boolean {
  if (world.execution.health !== 'poisoned') return false;
  const fault = world.execution.fault;
  postFault(
    'world',
    fault?.code ?? 'world-poisoned',
    'World remains healthy through update',
    'rebuild the poisoned World explicitly',
    fault,
    fault?.partialWrite ?? true,
  );
  return true;
}

function postFrameFault(world: World, cause: unknown): void {
  const fault = world.execution.fault;
  postFault(
    fault === null ? 'runtime' : 'world',
    fault?.code ?? 'app-system-update-failed',
    'World update completes before Renderer draw',
    fault === null ? 'inspect the runtime cause' : 'rebuild the poisoned World explicitly',
    cause,
    fault?.partialWrite ?? false,
  );
}

function frameSimulationTiming(
  engineUpdateMs: number,
  kernelDispatch: KernelDispatchResult | null,
): FrameSimulationTiming {
  if (kernelDispatch === null) return { engineUpdateMs, kernelWaitMs: 0 };
  return {
    engineUpdateMs,
    kernelWaitMs: kernelDispatch.waitMs,
    kernelDispatch: {
      eligible: true,
      usedShared: kernelDispatch.mode === 'shared',
      reason: kernelDispatch.mode === 'shared' ? 'shared' : 'forced-inline',
      dispatched: kernelDispatch.dispatched,
      completed: kernelDispatch.completed,
    },
  };
}

function postSimulationComplete(
  activeRealm: WorkerRealm,
  frameId: number,
  simulation: FrameSimulationTiming,
  renderRejection?: ExecutionSimulationCompletion['renderRejection'],
): void {
  const audioIntents = activeRealm.pendingAudioIntents.drain();
  scope.postMessage({
    kind: 'simulation-complete',
    worldIdentity: activeRealm.world.identity,
    frameId,
    ...simulation,
    ...(audioIntents.length ? { audioIntents } : {}),
    feedbackIntents: activeRealm.feedback.drainIntents(),
    ...(renderRejection === undefined ? {} : { renderRejection }),
  });
}

function publishSourceFrame(
  activeRealm: WorkerRealm,
  renderWorker: SourceRenderWorker,
  message: ExecutionFrameMessage,
  sampleTimeSeconds: number,
  simulation: FrameSimulationTiming,
  creditWaitMs: number,
): void {
  renderWorker.publish(message, sampleTimeSeconds, simulation.engineUpdateMs, creditWaitMs);
  renderSampleTimeSeconds = sampleTimeSeconds;
  lastFrameId = message.frameId;
  postSimulationComplete(activeRealm, message.frameId, simulation);
}

function drawFrame(
  activeRealm: WorkerRealm,
  activeRenderer: Renderer,
  message: ExecutionFrameMessage,
  sampleTimeSeconds: number,
  profileSession: RecorderSession | undefined,
  profileFrame: ProfileFrameToken | undefined,
): ReturnType<Renderer['draw']> {
  const attached = activeRenderer.attach(activeRealm.world);
  if (!attached.ok) throw attached.error;
  localHdr.beforeDraw(activeRenderer);
  const geometryLane = activeRealm.init.diagnostics?.geometryLane;
  return profilePhase(profileSession, 'renderer-draw', () =>
    activeRenderer.draw({
      source: attached.value,
      sampleTimeSeconds,
      ...(message.temporalReset ? { temporalReset: true } : {}),
      ...(profileFrame === undefined ? {} : { profileFrame }),
      ...(geometryLane === undefined ? {} : { geometryLane }),
    }),
  );
}

function isDeviceLostCompletion(failure: RenderError): boolean {
  return (
    failure.code === 'device-operation-failed' &&
    failure.detail.operation === 'complete-frame' &&
    failure.detail.cause.code === 'device-lost'
  );
}

function postFrameSubmitted(world: World, frameId: number, receipt: FrameReceipt): void {
  scope.postMessage({
    kind: 'frame-submitted',
    worldIdentity: world.identity,
    frameId,
    deviceGeneration: receipt.deviceGeneration,
    presentation: receipt.presentation,
    ...(receipt.editorAssistance === undefined
      ? {}
      : { editorAssistance: { ...receipt.editorAssistance, frameId: frameId } }),
    ...(receipt.shadowWorkload === undefined ? {} : { shadowWorkload: receipt.shadowWorkload }),
    ...(receipt.configurationRevision === undefined
      ? {}
      : { configurationRevision: receipt.configurationRevision }),
    ...(receipt.graphGeneration === undefined ? {} : { graphGeneration: receipt.graphGeneration }),
    ...(receipt.barrelDistortion === undefined
      ? {}
      : { barrelDistortion: receipt.barrelDistortion }),
  });
}

function postFrameComplete(
  activeRealm: WorkerRealm,
  frameId: number,
  receipt: FrameReceipt,
  simulation: FrameSimulationTiming,
): void {
  const audioIntents = activeRealm.pendingAudioIntents.drain();
  scope.postMessage({
    kind: 'frame-complete',
    worldIdentity: activeRealm.world.identity,
    frameId,
    deviceGeneration: receipt.deviceGeneration,
    ...(receipt.shadowWorkload === undefined ? {} : { shadowWorkload: receipt.shadowWorkload }),
    ...(receipt.configurationRevision === undefined
      ? {}
      : { configurationRevision: receipt.configurationRevision }),
    ...(receipt.graphGeneration === undefined ? {} : { graphGeneration: receipt.graphGeneration }),
    ...(receipt.barrelDistortion === undefined
      ? {}
      : { barrelDistortion: receipt.barrelDistortion }),

    presentation: receipt.presentation,
    ...(receipt.presentation !== 'pending' || receipt.presentationPendingReason === undefined
      ? {}
      : { presentationPendingReason: receipt.presentationPendingReason }),
    ...simulation,
    ...(audioIntents.length > 0 ? { audioIntents } : {}),
    feedbackIntents: activeRealm.feedback.drainIntents(),
  });
}

async function renderFrame(
  activeRealm: WorkerRealm,
  activeRenderer: Renderer,
  message: ExecutionFrameMessage,
  sampleTimeSeconds: number,
  simulation: FrameSimulationTiming,
  profileSession: RecorderSession | undefined,
  profileFrame: ProfileFrameToken | undefined,
): Promise<void> {
  while (true) {
    const draw = drawFrame(
      activeRealm,
      activeRenderer,
      message,
      sampleTimeSeconds,
      profileSession,
      profileFrame,
    );
    if (!draw.ok) {
      // An unaccepted submit while the Renderer stays alive settles simulation
      // credit once; a repeated rejection without a frame escalates.
      if (
        draw.error.code === 'frame-submit-rejected' &&
        draw.error.detail.accepted === false &&
        activeRenderer.state() === 'alive' &&
        ++submitRejectionsWithoutFrame === 1
      ) {
        lastFrameId = message.frameId;
        postSimulationComplete(activeRealm, message.frameId, simulation, {
          code: draw.error.code,
          expected: draw.error.expected,
          hint: draw.error.hint,
          detail: draw.error.detail,
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
    postFrameSubmitted(activeRealm.world, message.frameId, draw.value);
    localHdr.submitted(activeRenderer, draw.value);
    const completed = await draw.value.completed;
    if (!completed.ok) {
      const failure = completed.error;
      if (!isDeviceLostCompletion(failure)) throw failure;
      // The World has already advanced. Wait for its caller's explicit
      // Renderer recovery, then retry only rendering with the same sample.
      const recovered = await waitUntilRendererAlive(activeRenderer);
      if (realm !== activeRealm) return;
      if (!recovered) throw failure;
      continue;
    }
    lastFrameId = message.frameId;
    postFrameComplete(activeRealm, message.frameId, draw.value, simulation);
    return;
  }
}

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
  stepRetainedBytes();
  // A frame dispatched before native loss still owns Host credit. Keep it
  // pending without advancing the World until explicit recovery is complete.
  if (
    activeRenderer !== undefined &&
    activeRenderer.state() !== 'alive' &&
    !(await waitUntilRendererAlive(activeRenderer))
  )
    return;
  // Host credit returns from the Render Worker directly; its completion may still be
  // queued here. Recheck current readiness and capacity together after every await:
  // loss can release an old queue while its replacement is not ready yet.
  // The time spent here is this frame's publication-credit wait (engineCreditWaitMs).
  // An update-only step (render: false) publishes nothing to the Render Worker, so it
  // needs neither a publication slot nor admission and never reaches frame-submitted
  // stall/counter accounting.
  let creditWaitMs = 0;
  const renderWorker = activeRealm.renderWorker;
  if (message.render !== false && renderWorker !== undefined) {
    const waitStarted = performance.now();
    let waiting = false;
    const onWait = () => {
      if (waiting) return;
      waiting = true;
      scope.postMessage({
        kind: 'frame-admission',
        worldIdentity: world.identity,
        frameId: message.frameId,
        phase: 'render-wait',
      });
    };
    do {
      if (!(await renderWorker.waitForPublicationCapacity(onWait))) return;
      if (realm !== activeRealm || message.frameId <= lastFrameId) return;
    } while (!renderWorker.hasPublicationCapacity);
    if (waiting)
      scope.postMessage({
        kind: 'frame-admission',
        worldIdentity: world.identity,
        frameId: message.frameId,
        phase: 'source',
      });
    creditWaitMs = performance.now() - waitStarted;
  }
  if (realm !== activeRealm) return;
  if (message.render !== false && !admitSourcePublication(activeRealm, message)) return;
  // Advance synchronously from admission: no tick may separate the stale-frame check above
  // from the World update that claims this frame.
  await advanceFrame(activeRealm, activeRenderer, message, creditWaitMs);
}

/** Updates the admitted frame's World, then publishes or renders it. */
async function advanceFrame(
  activeRealm: WorkerRealm,
  activeRenderer: Renderer | undefined,
  message: ExecutionFrameMessage,
  creditWaitMs = 0,
): Promise<void> {
  const { world } = activeRealm;
  applyHostFrameState(activeRealm, message);
  const sampleTimeSeconds = frameSampleTimeSeconds(message);
  applyDrawingBufferSize(activeRealm, message);
  admitInspections();
  const started = performance.now();
  const profileSession = activeRealm.profiler?.activeSession();
  const profileFrame = beginProfileFrame(profileSession);
  try {
    activeRealm.levels?.beginFrame(message.render !== false);
    const update = profilePhase(profileSession, 'world-update-primary', () =>
      world.update(message.deltaSeconds),
    );
    if (!update.ok) throw update.error;
    if (postWorldPoisoned(world)) return;
    const updateFinished = performance.now();
    const simulation = frameSimulationTiming(
      updateFinished - started,
      activeRealm.kernelSlices?.takeLastDispatch() ?? null,
    );
    activeRealm.levels?.step();
    activeRealm.observation?.prepareFrame();
    if (message.render === false) {
      // The skipped picture still advances the implicit render-sample clock.
      renderSampleTimeSeconds = sampleTimeSeconds;
      lastFrameId = message.frameId;
      postSimulationComplete(activeRealm, message.frameId, simulation);
      return;
    }
    if (activeRealm.renderWorker !== undefined) {
      publishSourceFrame(
        activeRealm,
        activeRealm.renderWorker,
        message,
        sampleTimeSeconds,
        simulation,
        creditWaitMs,
      );
      return;
    }
    if (activeRenderer === undefined) return;
    await renderFrame(
      activeRealm,
      activeRenderer,
      message,
      sampleTimeSeconds,
      simulation,
      profileSession,
      profileFrame,
    );
  } catch (cause) {
    postFrameFault(world, cause);
  } finally {
    endProfileFrame(profileSession, profileFrame);
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
    const init: ExecutionInitMessage = {
      ...activeRealm.init,
      canvas,
      ...(message.pipelineLibrary === undefined
        ? {}
        : { pipelineLibrary: message.pipelineLibrary }),
    };
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

function receiveWorkerLifecycle(message: HostToEngineMessage | FrameRequest): boolean {
  switch (message.kind) {
    case 'native-frame-request':
      nativeFrames?.receive(message);
      return true;
    case 'init':
      if (message.workers.render.enabled) nativeFrames = createWorkerFrameResponder(scope);
      void withRealmTransition(() => initialize(message));
      return true;
    case 'dispose':
      nativeFrames?.dispose();
      nativeFrames = undefined;
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
          videoEndpoint?.close();
          scope.close();
        }
      });
      return true;
    default:
      return receiveTaskWorkerFailure(message);
  }
}

/** A page-owned pool Worker failed; its dispatcher rejects the running task and replaces it. */
function receiveTaskWorkerFailure(message: HostToEngineMessage | FrameRequest): boolean {
  if (message.kind !== 'task-worker-error') return false;
  taskWorkerListeners.get(message.workerId)?.error(new Error(message.message));
  return true;
}

async function applyRealmConfiguration(message: ConfigurationApplyRequest): Promise<void> {
  freezeConfiguration(message.plan);
  const target = realm;
  const currentRenderer = renderer;
  const result =
    target === undefined ||
    realmTransitions > 0 ||
    target.world.identity !== message.worldIdentity ||
    target.init.startup?.revision !== message.previousRevision ||
    message.plan.revision <= message.previousRevision
      ? {
          ok: false as const,
          error: staleConfiguration('the Engine realm or configuration revision changed'),
        }
      : target.renderWorker !== undefined
        ? await target.renderWorker.applyConfiguration(message.plan, message.previousRevision)
        : currentRenderer === undefined
          ? { ok: false as const, error: staleConfiguration('the Renderer is unavailable') }
          : applyRenderConfiguration(currentRenderer, message.plan);
  if (result.ok && realm === target && target !== undefined)
    target.init = { ...target.init, startup: message.plan };
  scope.postMessage(
    configurationApplyResponse(
      message,
      realm === target
        ? result
        : { ok: false, error: staleConfiguration('the World was replaced during configuration') },
    ),
  );
}

scope.onmessage = (event): void => {
  const message = event.data;
  if (receiveWorkerLifecycle(message)) return;
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
        ?.replace(
          message.epoch,
          message.canvas,
          message.pipelineLibrary,
          message.backgroundPipelineLibrary,
        )
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
    case 'configuration-apply':
      void applyRealmConfiguration(message);
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
    case 'input-clear':
      inputBackend.revokeInjectedLease();
      return;
    case 'input-lease-open':
      inputBackend.beginInjectedLease();
      return;
    case 'memory-pressure':
      receiveMemoryPressure();
      return;
    case 'profile-finish':
      receiveProfileFinish(message);
      return;
  }
};

function receiveMemoryPressure(): void {
  realm?.assetAssembly?.registry.trimReadCache();
  try {
    realm?.renderWorker?.trimReadCache();
  } catch {
    // A terminated Render Worker holds no read caches.
  }
}

function receiveProfileFinish(
  message: Extract<HostToEngineMessage, { kind: 'profile-finish' }>,
): void {
  try {
    const current = realm;
    const active = current?.profiler?.activeSession();
    if (
      active !== undefined &&
      (message.worldIdentity === undefined || current?.world.identity === message.worldIdentity) &&
      (message.captureId === undefined || active.captureId === message.captureId)
    ) {
      active.finish();
    }
  } catch {
    // Diagnostic cleanup is best effort and never changes the Worker state.
  }
}
