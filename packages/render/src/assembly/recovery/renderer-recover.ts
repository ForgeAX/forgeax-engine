import { adaptDynamicTextureDevice, DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import type {
  BindGroupLayout,
  PipelineLayout,
  RenderPipeline,
  RhiCanvasContext,
  RhiCanvasTarget,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { ShaderCatalog } from '@forgeax/engine-shader';
import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { adoptBackendDevice, DeviceScope } from '../../device/device-scope';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { RecoverError, type RecoverFailure } from '../../errors/recover';
import type { FirstEntryMap } from '../../record/first-entry-map';
import type {
  GpuPassTimingObservation,
  GpuPassTimingSession,
} from '../../record/gpu-pass-timing/index.js';
import type { PipelineState, RenderSystemInternals } from '../../record/render-context';
import type { RecoveryPostProcessResources, RecoveryRootBundle } from '../../recovery/types';
import type { RenderSystem } from '../../render-system';
import {
  prepareMaterialShaders,
  type ShaderDeviceAdapterInternal,
} from '../material-shader-policy';
import type { MeshSsboGrowResult, MeshSsboState } from '../mesh-ssbo-grow';
import { structuredRendererCause } from '../renderer-facade';
import { ensureContextConfigured } from '../renderer-helpers';
import type { RecoveryContinuation, RecoveryDeadline, RecoveryPhase } from '../renderer-lifecycle';
import type { WebGPURendererInternals } from '../webgpu-renderer-contract';
import { attachDeviceLostFanout } from './device-loss-fanout';
import type { RecoveryFailureLocation } from './failure-location';
import { buildGenerationAggregate, type GenerationAggregate } from './generation';
import {
  acquireDeviceGeneration,
  probeCandidateDeviceExecution,
  runRecoveryStep,
} from './recovery-attempt';

export type RendererShaderState = {
  readonly device: RhiDevice;
  shaderInstance: ShaderCatalog | null;
  sharedShaderModuleAdapter: ShaderDeviceAdapterInternal | null;
  sharedImmediateShaderModuleAdapter: ShaderDeviceAdapterInternal | null;
};
export type PerShaderMaterialLayoutCacheEntry = {
  readonly source: string;
  readonly paramSchema: readonly ParamSchemaEntry[];
  readonly layout: { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout } | null;
};
export type PreparedMaterialPipelineLayoutCacheEntry = {
  readonly source: string;
  readonly bindings: import('@forgeax/engine-types').MaterialProgramBindingContract;
  readonly sceneInputKind: 'view' | 'depth' | 'view-depth';
  readonly usesMaterialGroup: boolean;
  meshLayout: PipelineLayout | undefined;
  clusterLayout: PipelineLayout | undefined;
};
export type RendererPipelineCacheState = {
  materialShaderPipelineCache: Map<string, RenderPipeline>;
  /** Deterministic descriptor rejections (e.g. mesh layout lacks a vertex input), reported once. */
  rejectedMaterialPipelineKeys: Set<string>;
  materialShaderVariantResolutionCache: WeakMap<object, Map<string, string | undefined>>;
  group0MaterialLayout: { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout } | null;
  viewOnlyMaterialPipelineLayout: PipelineLayout | null;
  viewAndSceneDepthMaterialPipelineLayout: PipelineLayout | null;
  group0ResourceLayouts: Map<
    string,
    { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout }
  >;
  preparedMaterialPipelineLayoutCache: Map<string, PreparedMaterialPipelineLayoutCacheEntry>;
  perShaderMaterialLayoutCache: Map<
    string,
    FirstEntryMap<number | string, PerShaderMaterialLayoutCacheEntry>
  >;
};
/** Initial construction and recovery start from the same empty generation caches. */
export function createRendererPipelineCacheState(): RendererPipelineCacheState {
  return {
    materialShaderPipelineCache: new Map(),
    rejectedMaterialPipelineKeys: new Set(),
    materialShaderVariantResolutionCache: new WeakMap(),
    group0MaterialLayout: null,
    viewOnlyMaterialPipelineLayout: null,
    viewAndSceneDepthMaterialPipelineLayout: null,
    group0ResourceLayouts: new Map(),
    preparedMaterialPipelineLayoutCache: new Map(),
    perShaderMaterialLayoutCache: new Map(),
  };
}

export type RendererCandidateState = {
  gpuPassTimingSession?: GpuPassTimingSession | undefined;
  gpuPassTimingUnavailable?: GpuPassTimingObservation | undefined;
  readonly device: RhiDevice;
  readonly context: RhiCanvasContext;
  readonly scope: DeviceScope;
  readonly gpuStore: GpuResidencyCache;
  readonly dynamicTextureStore: DynamicTextureStore;
  readonly shaderState: RendererShaderState;
  readonly pipelineCacheState: RendererPipelineCacheState;
  readonly materialShaderUvSetCounts: Map<string, number>;
  pipelineState: PipelineState | null;
  emptyPostProcessBgl: BindGroupLayout | null;
  growMeshSsbo:
    | ((neededMeshSlots: number, neededMaterialSlots: number) => MeshSsboGrowResult)
    | undefined;
  meshSsboState: MeshSsboState | undefined;
};
type RendererGenerationBindings = {
  readonly gpuPassTimingSession?: GpuPassTimingSession | undefined;
  readonly gpuPassTimingUnavailable?: GpuPassTimingObservation | undefined;
  readonly gpuStore: GpuResidencyCache;
  readonly dynamicTextureStore: DynamicTextureStore;
  readonly shaderState: RendererShaderState;
  readonly pipelineCacheState: RendererPipelineCacheState;
  readonly materialShaderUvSetCounts: Map<string, number>;
  readonly emptyPostProcessBgl: BindGroupLayout | null;
  readonly growMeshSsbo:
    | ((neededMeshSlots: number, neededMaterialSlots: number) => MeshSsboGrowResult)
    | undefined;
  readonly meshSsboState: MeshSsboState | undefined;
};
export type RendererGeneration = GenerationAggregate<
  RhiDevice,
  RhiCanvasContext,
  PipelineState,
  RendererGenerationBindings,
  undefined
>;

interface RendererRecoveryDependencies {
  readonly prepareGpuPassTimingState: (
    device: RhiDevice,
  ) => Pick<RendererGenerationBindings, 'gpuPassTimingSession' | 'gpuPassTimingUnavailable'>;
  readonly isDisposed: () => boolean;
  readonly internals: WebGPURendererInternals;
  readonly getActiveDeviceScope: () => DeviceScope;
  readonly getActiveShaderState: () => RendererShaderState;
  readonly getMaterialShaderUvSetCounts: () => Map<string, number>;
  readonly getCandidateBuildState: () => RendererCandidateState | undefined;
  readonly setCandidateBuildState: (state: RendererCandidateState | undefined) => void;
  readonly getCandidateShaderState: () => RendererShaderState | undefined;
  readonly setCandidateShaderState: (state: RendererShaderState | undefined) => void;
  readonly getCandidatePipelineCacheState: () => RendererPipelineCacheState | undefined;
  readonly setCandidatePipelineCacheState: (state: RendererPipelineCacheState | undefined) => void;
  readonly getCandidateMaterialShaderUvSetCounts: () => Map<string, number> | undefined;
  readonly setCandidateMaterialShaderUvSetCounts: (state: Map<string, number> | undefined) => void;
  readonly setCandidateEmptyPostProcessBgl: (layout: BindGroupLayout | null | undefined) => void;
  readonly getShader: () => ShaderCatalog;
  readonly buildPipeline: (
    scope?: DeviceScope,
    device?: RhiDevice,
    residencyStore?: GpuResidencyCache,
  ) => Promise<PipelineState>;
  readonly renderSystem: RenderSystem;
  readonly createRecoveryFailureLocation: (
    phase: RecoveryPhase,
    cause: unknown,
    overrides?: Partial<Omit<RecoveryFailureLocation, 'phase' | 'cause'>>,
  ) => RecoveryFailureLocation;
  readonly publishAndRetireRendererGeneration: (
    candidate: RendererGeneration,
    candidatePostProcessResources: RecoveryPostProcessResources,
    recoveryRootBundle: RecoveryRootBundle,
    canvas: RhiCanvasTarget,
  ) => void;
}

export interface RendererRecovery {
  recoverOnce(
    deadline: RecoveryDeadline,
    deadlineExpired: (phase: RecoveryPhase) => boolean,
    setCandidateCleanup: (cleanup: () => void) => void,
    continuation: RecoveryContinuation,
    setRecoveryPhase: (phase: RecoveryPhase) => void,
    onRootsCommitted: (count: number) => void,
    onFailure: (failure: RecoveryFailureLocation) => void,
  ): Promise<Result<void, RecoverFailure>>;
}

export function createRendererRecovery(deps: RendererRecoveryDependencies): RendererRecovery {
  const {
    prepareGpuPassTimingState,
    isDisposed,
    internals,
    getActiveDeviceScope,
    getActiveShaderState,
    getMaterialShaderUvSetCounts,
    getCandidateBuildState,
    setCandidateBuildState,
    getCandidateShaderState,
    setCandidateShaderState,
    getCandidatePipelineCacheState,
    setCandidatePipelineCacheState,
    getCandidateMaterialShaderUvSetCounts,
    setCandidateMaterialShaderUvSetCounts,
    setCandidateEmptyPostProcessBgl,
    getShader,
    buildPipeline,
    renderSystem,
    createRecoveryFailureLocation,
    publishAndRetireRendererGeneration,
  } = deps;
  const isRendererDisposed = isDisposed;
  async function recoverOnce(
    deadline: RecoveryDeadline,
    deadlineExpired: (phase: RecoveryPhase) => boolean,
    setCandidateCleanup: (cleanup: () => void) => void,
    continuation: RecoveryContinuation,
    setRecoveryPhase: (phase: RecoveryPhase) => void,
    onRootsCommitted: (count: number) => void,
    onFailure: (failure: RecoveryFailureLocation) => void,
  ): Promise<Result<void, RecoverFailure>> {
    // feat-20260622-s5 M3 / w17 (A-IN-3 / D-1): single idempotent device
    // rebuild. One attempt only — no loop, no backoff, no timer, no extra
    // in-flight health state (A-OOS-1); the host owns the cadence of calling
    // this again. Fail-Fast entry guards (architecture-principles #5):
    // isRendererDisposed() renderer or non-device-lost state short-circuits before a
    // GPU work.
    if (isRendererDisposed()) {
      // A-IN-6: isRendererDisposed() latch wins; recover() never rebuilds a dead
      // renderer. `recover-not-needed` is the sentinel (no degraded state to
      // recover from on a isRendererDisposed() renderer).
      return err(new RecoverError('recover-not-needed'));
    }
    const snapshot = internals.healthRegistry.getLastSnapshot();
    // A-AC-08: `alive` (including the alive state after a prior successful
    // recover) is a no-op signal — idempotent second call.
    if (snapshot.reason !== 'device-lost') {
      return err(new RecoverError('recover-not-needed'));
    }

    const recordFailure = (
      phase: RecoveryPhase,
      cause: unknown,
      overrides: Partial<Omit<RecoveryFailureLocation, 'phase' | 'cause'>> = {},
    ): void => onFailure(createRecoveryFailureLocation(phase, cause, overrides));

    let canvas = internals.canvas;
    const resolveCanvas = internals.options?.resolveRecoveryCanvas;
    if (resolveCanvas !== undefined) {
      setRecoveryPhase('quiesce');
      const controller = new AbortController();
      setCandidateCleanup(() => controller.abort());
      const resolved = await runRecoveryStep(
        async () => {
          try {
            return ok(await resolveCanvas(controller.signal));
          } catch (cause) {
            return err(structuredRendererCause(cause, 'Host recovery canvas'));
          }
        },
        'quiesce',
        deadline,
        () => Date.now(),
        continuation,
      );
      if (resolved.kind !== 'value') {
        controller.abort();
        recordFailure('quiesce', resolved.error, {
          retryable: true,
          guidance: 'repair-owner',
          owner: 'renderer',
          resourceKind: 'surface',
        });
        return err(new RecoverError('recover-device-unavailable'));
      }
      if (isRendererDisposed()) {
        controller.abort();
        return err(new RecoverError('recover-not-needed'));
      }
      canvas = resolved.value;
    }

    // Candidate device-bound state is isolated from the active aggregate. The
    // old roots remain authoritative until the final synchronous publication.
    const candidateGpuStore = new GpuResidencyCache();
    const candidateDynamicTextureStore = new DynamicTextureStore();
    // Re-acquire through the SAME backend pack (the
    // idempotent factory primitives tryCreateRendererFromBackend uses). On the
    // adapter / device failure paths, health stays `device-lost` (A-AC-07):
    // recover() never fakes the renderer back to `alive`.
    const acquired = await acquireDeviceGeneration(
      internals.pack,
      canvas,
      deadline,
      continuation,
      setRecoveryPhase,
    );
    if (!acquired.ok) {
      const phase = acquired.error.stage === 'adapter' ? 'acquire-adapter' : 'acquire-device';
      recordFailure(phase, acquired.error.error, {
        retryable: true,
        guidance: 'retry',
        owner: 'backend',
        resourceKind: 'surface',
      });
      return err(
        new RecoverError(
          acquired.error.stage === 'adapter'
            ? 'recover-adapter-unavailable'
            : 'recover-device-unavailable',
        ),
      );
    }
    const { device, context } = acquired.value;
    setRecoveryPhase('rehydrate');
    if (deadlineExpired('rehydrate')) {
      const cause = new RecoverError('recover-device-unavailable');
      recordFailure('rehydrate', cause);
      return err(cause);
    }
    if (isRendererDisposed()) return err(new RecoverError('recover-not-needed'));

    // Build the replacement graph under a fresh renderer-owned scope. The old
    // committed scope remains authoritative until every rebuild step succeeds.
    const recoveryScope = DeviceScope.create(
      getActiveDeviceScope().generation + 1,
      getActiveDeviceScope().owner,
    );
    adoptBackendDevice(recoveryScope, device, internals.pack.disposeDevice);
    candidateGpuStore.bindDeviceScope(recoveryScope);
    const candidateState: RendererCandidateState = {
      device,
      context,
      scope: recoveryScope,
      gpuStore: candidateGpuStore,
      dynamicTextureStore: candidateDynamicTextureStore,
      shaderState: {
        device,
        shaderInstance: null,
        sharedShaderModuleAdapter: null,
        sharedImmediateShaderModuleAdapter: null,
      },
      pipelineCacheState: createRendererPipelineCacheState(),
      materialShaderUvSetCounts: new Map(getMaterialShaderUvSetCounts()),
      pipelineState: null,
      emptyPostProcessBgl: null,
      growMeshSsbo: undefined,
      meshSsboState: undefined,
    };
    setCandidateBuildState(candidateState);
    setCandidateShaderState(candidateState.shaderState);
    setCandidatePipelineCacheState(candidateState.pipelineCacheState);
    setCandidateMaterialShaderUvSetCounts(candidateState.materialShaderUvSetCounts);
    setCandidateEmptyPostProcessBgl(candidateState.emptyPostProcessBgl);
    // getShader forks the admitted CPU catalog into the candidate on first
    // access. Shader modules and all device-bound caches start empty.
    let candidatePostProcessResources: RecoveryPostProcessResources | undefined;
    let recoveryRootBundle: RecoveryRootBundle | undefined;
    let candidateReleased = false;
    const releaseCandidate = (): void => {
      if (candidateReleased) return;
      setRecoveryPhase('cleanup');
      candidateReleased = true;
      if (candidatePostProcessResources !== undefined) {
        renderSystem.discardRecoveryPostProcessResources(candidatePostProcessResources);
        candidatePostProcessResources = undefined;
      }
      const rootBundle = recoveryRootBundle;
      recoveryRootBundle = undefined;
      rootBundle?.discard();
      candidateState.pipelineState?.perPassResources.drainBloomResources?.();
      candidateGpuStore.destroyAll();
      candidateDynamicTextureStore.destroyAll();
      candidateState.gpuPassTimingSession?.dispose();
      recoveryScope.abandon();
      if (getCandidateBuildState() === candidateState) setCandidateBuildState(undefined);
      if (getCandidateShaderState() === candidateState.shaderState)
        setCandidateShaderState(undefined);
      if (getCandidatePipelineCacheState() === candidateState.pipelineCacheState) {
        setCandidatePipelineCacheState(undefined);
      }
      if (getCandidateMaterialShaderUvSetCounts() === candidateState.materialShaderUvSetCounts) {
        setCandidateMaterialShaderUvSetCounts(undefined);
      }
      setCandidateEmptyPostProcessBgl(undefined);
    };
    setCandidateCleanup(releaseCandidate);
    // Re-attach the device.lost fan-out to the new device's lost Promise,
    // reusing the SAME registries the host already subscribed to (SSOT
    // helper). When this device is lost again, health() flips to
    // `device-lost` and the host can call recover() once more.
    let candidatePublished = false;
    let candidateLost = false;
    attachDeviceLostFanout(device, internals.pack, {
      lostRegistry: internals.lostRegistry,
      errorRegistry: internals.errorRegistry,
      healthRegistry: internals.healthRegistry,
      generation: recoveryScope.generation,
      currentGeneration: () =>
        internals.lossObserver.current === null ? undefined : internals.generationState.current,
      onStaleLoss: () => internals.generationState.onStaleLoss?.(),
      onDeviceLost: (detail) => {
        if (candidatePublished) internals.lossObserver.current?.(detail);
        else candidateLost = true;
      },
    });

    // Step (e): rebuild GPU-bound state against the new device. Every cache,
    // shader adapter, hook, and store used by this build belongs to
    // candidateState; the active aggregate remains untouched on every await.
    candidateGpuStore.configureGpuDevice(device, internals.pack.createShaderModule, device.caps);
    candidateGpuStore.configureIblDevice(
      device,
      internals.pack.createShaderModule === undefined
        ? undefined
        : (
            (createShaderModule) => (device, descriptor) =>
              createShaderModule(device, descriptor)
          )(internals.pack.createShaderModule),
    );
    // A device loss invalidates the transient video textures too. Rebind
    // through the store owner so its cached textures are destroyed before
    // the first post-recovery upload; unlike CPU asset payloads, these
    // handles cannot survive a device replacement.
    candidateDynamicTextureStore.configureGpuDevice(adaptDynamicTextureDevice(device));
    const abortDisposedRecovery = (
      phase: RecoveryPhase,
    ): Result<void, RecoverFailure> | undefined => {
      if (!isRendererDisposed() && !candidateLost) return undefined;
      const cause = new RecoverError(
        isRendererDisposed() ? 'recover-not-needed' : 'recover-device-unavailable',
      );
      recordFailure(phase, cause, {
        retryable: !isRendererDisposed(),
        guidance: isRendererDisposed() ? 'rebuild-renderer' : 'retry',
        owner: isRendererDisposed() ? 'renderer' : 'backend',
        resourceKind: 'surface',
      });
      releaseCandidate();
      return err(cause);
    };
    try {
      Object.assign(candidateState, prepareGpuPassTimingState(device));
      setRecoveryPhase('rehydrate');
      const preparation = await runRecoveryStep(
        async (attemptToken) => {
          await prepareMaterialShaders(device, getShader, candidateState.materialShaderUvSetCounts);
          if (attemptToken !== undefined && !attemptToken.isValid('rehydrate', Date.now())) {
            return err(
              new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'recovery shader preparation belongs to the live attempt',
                hint: 'discard the late candidate completion',
                detail: {
                  error: { code: 'recovery-attempt-invalid', message: 'late shader completion' },
                },
              }),
            );
          }
          return ok(undefined);
        },
        'rehydrate',
        deadline,
        () => Date.now(),
        continuation,
      );
      if (preparation.kind === 'timeout') {
        recordFailure('rehydrate', preparation.error);
        releaseCandidate();
        return err(new RecoverError('recover-device-unavailable'));
      }
      if (preparation.kind === 'error') throw preparation.error;
      const abortedAfterShaders = abortDisposedRecovery('rehydrate');
      if (abortedAfterShaders !== undefined) return abortedAfterShaders;
      // Rehydrate manifest-selected builtins before carrying over late-
      // installed user declarations. Builtin material sources are capability
      // variants: copying the active generation first can retain a shader that
      // declares cloud bindings 16/17 while the replacement device only
      // admits the low-limit view layout. The candidate catalog owns fresh CPU
      // declarations and modules; only identifiers still absent after
      // preparation cross the generation boundary.
      const activeShaderCatalog = getActiveShaderState().shaderInstance;
      if (activeShaderCatalog !== null) {
        const candidateShaderCatalog = getShader();
        const installed = new Set(candidateShaderCatalog.materialShaderIdentifiers());
        candidateShaderCatalog.installMaterialArtifactsFrom(
          activeShaderCatalog,
          [...activeShaderCatalog.materialShaderIdentifiers()].filter(
            (identifier) => !installed.has(identifier),
          ),
        );
      }
      setRecoveryPhase('compile-graph');
      const pipeline = await runRecoveryStep(
        async (attemptToken) => {
          const value = await buildPipeline(recoveryScope, device, candidateGpuStore);
          if (attemptToken !== undefined && !attemptToken.isValid('compile-graph', Date.now())) {
            return err(
              new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'recovery pipeline preparation belongs to the live attempt',
                hint: 'discard the late candidate completion',
                detail: {
                  error: { code: 'recovery-attempt-invalid', message: 'late pipeline completion' },
                },
              }),
            );
          }
          return ok(value);
        },
        'compile-graph',
        deadline,
        () => Date.now(),
        continuation,
      );
      if (pipeline.kind === 'timeout') {
        recordFailure('compile-graph', pipeline.error);
        releaseCandidate();
        return err(new RecoverError('recover-device-unavailable'));
      }
      if (pipeline.kind === 'error') throw pipeline.error;
      candidateState.pipelineState = pipeline.value;
      const abortedAfterPipeline = abortDisposedRecovery('compile-graph');
      if (abortedAfterPipeline !== undefined) return abortedAfterPipeline;
      const postProcessResources = renderSystem.prepareRecoveryPostProcessResources(device);
      if (!postProcessResources.ok) throw postProcessResources.error;
      candidatePostProcessResources = postProcessResources.value;
      const abortedAfterPostProcessPreparation = abortDisposedRecovery('compile-graph');
      if (abortedAfterPostProcessPreparation !== undefined) {
        return abortedAfterPostProcessPreparation;
      }
    } catch (cause) {
      // Pipeline rebuild failed against the new device. Treat as a device
      // unavailability (the device was acquired but is not usable); health
      // stays `device-lost` so the host can retry.
      recordFailure('compile-graph', cause);
      if (cause instanceof RhiError) internals.errorRegistry.fire(cause);
      releaseCandidate();
      const aborted = abortDisposedRecovery('compile-graph');
      if (aborted !== undefined) return aborted;
      return err(new RecoverError('recover-device-unavailable'));
    }
    // Promote only after the complete replacement build is ready. The old
    // scope is then retired exactly once; a failed attempt abandons its
    // candidate in the catch path and can be retried with a new generation.
    const candidatePipelineState = candidateState.pipelineState;
    if (candidatePipelineState === null || candidatePostProcessResources === undefined) {
      const cause = new RecoverError('recover-device-unavailable');
      recordFailure('compile-graph', cause);
      releaseCandidate();
      return err(cause);
    }
    // Recovery prepares only the device, context and generation roots. The
    // first frame on the replacement device rebuilds every derived owner
    // through the ordinary extract/prepare/record path from current sources.
    const candidateInternals = Object.create(internals) as WebGPURendererInternals &
      RenderSystemInternals;
    Object.defineProperties(candidateInternals, {
      canvas: { value: canvas },
      device: { value: candidateState.device },
      context: { value: candidateState.context },
      deviceScope: { value: candidateState.scope },
      getPipelineState: { value: () => candidatePipelineState },
    });
    const configured = ensureContextConfigured(
      candidateInternals,
      candidatePipelineState,
      internals.errorRegistry,
    );
    if (!configured.ok) {
      recordFailure('compile-graph', configured.error, {
        owner: 'surface',
        resourceKind: 'surface',
      });
      releaseCandidate();
      return err(new RecoverError('recover-device-unavailable'));
    }
    const abortedAfterPrewarm = abortDisposedRecovery('compile-graph');
    if (abortedAfterPrewarm !== undefined) return abortedAfterPrewarm;
    const preparedRecoveryRoots = renderSystem.prepareRecoveryRoots({ scope: recoveryScope });
    recoveryRootBundle = preparedRecoveryRoots;
    const timingSession = candidateState.gpuPassTimingSession;
    const recoveryRoots = [
      ...preparedRecoveryRoots.roots,
      ...(timingSession === undefined
        ? []
        : [
            {
              kind: 'feature' as const,
              create: () => timingSession,
              cleanup: () => timingSession.dispose(),
            },
          ]),
    ];
    const recoveryRootCount = recoveryRoots.length;
    const candidateGeneration = await runRecoveryStep<RendererGeneration, RhiError>(
      async (attemptToken) => {
        const value = await buildGenerationAggregate<RendererGeneration>({
          scope: recoveryScope,
          device,
          context,
          pipeline: candidatePipelineState,
          producerBindings: {
            gpuPassTimingSession: candidateState.gpuPassTimingSession,
            gpuPassTimingUnavailable: candidateState.gpuPassTimingUnavailable,
            gpuStore: candidateGpuStore,
            dynamicTextureStore: candidateDynamicTextureStore,
            shaderState: candidateState.shaderState,
            pipelineCacheState: candidateState.pipelineCacheState,
            materialShaderUvSetCounts: candidateState.materialShaderUvSetCounts,
            emptyPostProcessBgl: candidateState.emptyPostProcessBgl,
            growMeshSsbo: candidateState.growMeshSsbo,
            meshSsboState: candidateState.meshSsboState,
          },
          roots: recoveryRoots,
        });
        if (attemptToken !== undefined && !attemptToken.isValid('compile-graph', Date.now())) {
          if (value.ok) value.value.scope.abandon();
          return err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'recovery generation aggregate belongs to the live attempt',
              hint: 'discard the late generation aggregate',
            }),
          );
        }
        return value.ok
          ? value
          : err(
              new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'recovery generation aggregate commits every candidate root',
                hint: `discard the candidate after ${value.error.resourceKind} assembly failed`,
                detail: {
                  error: {
                    code: value.error.code,
                    message: `candidate generation failed at ${value.error.resourceKind}`,
                  },
                },
              }),
            );
      },
      'compile-graph',
      deadline,
      () => Date.now(),
      continuation,
    );
    if (candidateGeneration.kind !== 'value') {
      recordFailure(
        'compile-graph',
        candidateGeneration.error,
        candidateGeneration.kind === 'error' ? { owner: 'renderer', resourceKind: 'pipeline' } : {},
      );
      releaseCandidate();
      return err(new RecoverError('recover-device-unavailable'));
    }
    const abortedAfterGeneration = abortDisposedRecovery('compile-graph');
    if (abortedAfterGeneration !== undefined) return abortedAfterGeneration;
    // Device creation, resource creation, and queue.submit are not enough to
    // admit a replacement generation. Prove the exact candidate device can
    // execute and expose one render attachment immediately before publication;
    // the probe has no graph, shader, asset, or surface dependency, so a
    // failure stays owned by backend readiness instead of being misreported as
    // a renderer draw failure.
    const deviceProbe = await runRecoveryStep(
      () => probeCandidateDeviceExecution(candidateGeneration.value.device),
      'compile-graph',
      deadline,
      () => Date.now(),
      continuation,
    );
    if (deviceProbe.kind !== 'value') {
      recordFailure('compile-graph', deviceProbe.error, {
        retryable: true,
        guidance: 'retry',
        owner: 'backend',
        resourceKind: 'texture',
      });
      releaseCandidate();
      return err(new RecoverError('recover-device-unavailable'));
    }
    // Candidate readiness is complete. The owner helper performs the only
    // active swap and retires the previous aggregate synchronously.
    setRecoveryPhase('publish');
    try {
      publishAndRetireRendererGeneration(
        candidateGeneration.value,
        candidatePostProcessResources,
        preparedRecoveryRoots,
        canvas,
      );
    } catch (cause) {
      recordFailure('publish', cause, {
        guidance: 'rebuild-renderer',
      });
      if (cause instanceof RhiError) internals.errorRegistry.fire(cause);
      releaseCandidate();
      return err(new RecoverError('recover-device-unavailable'));
    }
    candidatePostProcessResources = undefined;
    recoveryRootBundle = undefined;
    candidatePublished = true;
    candidateReleased = true;
    onRootsCommitted(recoveryRootCount);
    setCandidateBuildState(undefined);
    setCandidateShaderState(undefined);
    setCandidatePipelineCacheState(undefined);
    setCandidateMaterialShaderUvSetCounts(undefined);
    setCandidateEmptyPostProcessBgl(undefined);

    // Step (f): the renderer is alive again. The next frame rebuilds its
    // graph and residency from current sources on the published device.
    internals.healthRegistry.fire({ reason: 'alive', recoverable: false });
    return ok(undefined);
  }
  return { recoverOnce };
}
