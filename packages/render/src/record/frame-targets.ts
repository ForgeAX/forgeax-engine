import type {
  CompiledRenderGraph,
  RenderGraphFrame,
  RenderGraphPassExecution,
  RenderGraphPassInstrumentation,
} from '@forgeax/engine-render-graph';
import {
  compiledRenderGraphGeneration,
  compiledRenderGraphPassDeclarations,
} from '@forgeax/engine-render-graph';
import {
  type RhiCanvasContext,
  RhiError,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { RenderGraphExecutionPhase, RenderGraphPassProfilePhase } from '../render-contract';
import type { ViewLights } from '../world/render-lights';
import { RenderSubmission, renderSubmission } from '../world/render-world';
import { recordContext } from '../world/view-record-context';
import {
  createPassTimingInstrumentation,
  type RenderGraphPassCpuScopeFactory,
} from './gpu-pass-timing/instrumentation';
import type { GpuPassTimingCapture } from './gpu-pass-timing/session';
import {
  configurePipelineSurface,
  type PipelineState,
  type RenderSystemInternals,
} from './render-context';
import { hasShadowPipelineDemand } from './view-pipeline-demand';

/** The stable Render owner dimension for a compiled graph: a view entity or the primary owner. */
export function graphExecutionProfileOwner(internals: RenderSystemInternals): string {
  const viewEntity = internals.viewEntity;
  return viewEntity === undefined ? 'primary' : `view-${viewEntity}`;
}

/** Exact CPU phase key matching one executable graph pass and its GPU timing identity. */
export function graphExecutionProfilePhase(input: {
  readonly owner: string;
  readonly pass: Pick<RenderGraphPassExecution, 'name' | 'kind'>;
}): RenderGraphPassProfilePhase {
  return `record/graph-execute/pass/${input.owner}/${input.pass.kind}/${JSON.stringify(input.pass.name)}`;
}

type GraphPassRoster = {
  readonly passes: readonly Pick<RenderGraphPassExecution, 'name' | 'kind'>[];
};
type PassPhaseNames = Map<string, Map<string, RenderGraphPassProfilePhase>>;
const graphPassPhaseNames = new WeakMap<object, Map<string, PassPhaseNames>>();
const MAX_RENDER_PASS_CPU_IDENTITIES = 2048;

type RecordProfileContext = RenderSystemInternals & { readonly root?: RenderSystemInternals };

/** Finalize one receipt using only this collector and its same-frame GPU execution fact. */
export function finalizeRenderPassCpuIdentityCapture(input: {
  readonly identityCapture: RenderSystemInternals['renderPassCpuIdentityCapture'];
  readonly passTimingCapture?:
    | Pick<GpuPassTimingCapture, 'frameId' | 'nextExecutionIndex'>
    | undefined;
  readonly receiptFrameId: number;
}): void {
  const { identityCapture, passTimingCapture, receiptFrameId } = input;
  if (identityCapture === undefined) return;
  if (!identityCapture.instrumentationAccepted) identityCapture.complete = false;
  if (
    passTimingCapture?.frameId === receiptFrameId &&
    passTimingCapture.nextExecutionIndex !== identityCapture.entries.length
  )
    identityCapture.complete = false;
}

function recordProfileContext(internals: RenderSystemInternals): {
  readonly world: RenderSystemInternals['renderWorld'];
  readonly identityCapture: RenderSystemInternals['renderPassCpuIdentityCapture'];
} {
  const record = recordContext(internals) as RecordProfileContext;
  const root = record.root ?? internals.viewContext?.root ?? internals;
  return {
    world: record.renderWorld ?? root.renderWorld ?? internals.renderWorld,
    identityCapture:
      root.renderPassCpuIdentityCapture ??
      record.renderPassCpuIdentityCapture ??
      internals.renderPassCpuIdentityCapture,
  };
}

/** Read only the session pinned to this recording's RenderSubmission. */
function pinnedRenderProfileSession(
  world: RenderSystemInternals['renderWorld'],
): import('@forgeax/engine-profiler').RecorderSession | undefined {
  if (world === undefined || !world.hasResource(RenderSubmission)) return undefined;
  const submission = renderSubmission(world);
  return submission.profileSessionPinned ? submission.profileSession : undefined;
}

/** Avoid even constructing an instrumentation object on the ordinary graph path. */
export function renderGraphPassInstrumentationActive(internals: RenderSystemInternals): boolean {
  const record = recordContext(internals) as RecordProfileContext;
  const root = record.root ?? internals.viewContext?.root ?? internals;
  const identityCapture =
    root.renderPassCpuIdentityCapture ??
    record.renderPassCpuIdentityCapture ??
    internals.renderPassCpuIdentityCapture;
  return (
    internals.gpuPassTimingCapture !== undefined ||
    root.gpuPassTimingCapture !== undefined ||
    identityCapture !== undefined
  );
}

/** Stable pass names are prepared from the immutable graph before timed execution starts. */
export function graphExecutionProfilePhases(
  graph: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'> | GraphPassRoster,
  owner: string,
): readonly RenderGraphPassProfilePhase[] {
  let compiled: Pick<CompiledRenderGraph<RenderGraphFrame>, 'inspect'> | undefined;
  let passes: GraphPassRoster['passes'];
  if ('inspect' in graph) {
    compiled = graph;
    passes = compiledRenderGraphPassDeclarations(graph);
  } else {
    compiled = undefined;
    passes = graph.passes;
  }
  const names = new Set<RenderGraphPassProfilePhase>();
  for (const pass of passes) {
    if (pass.kind === 'subgraph') continue;
    names.add(
      compiled === undefined
        ? graphExecutionProfilePhase({ owner, pass })
        : cachedGraphPassPhase(compiled, owner, pass),
    );
  }
  return Object.freeze([...names]);
}

/** Shared/composition graphs carry no view identity; a view inherits, a capture supplies its face. */
export function graphPassTimingViewId(input: {
  readonly owner?: string;
  readonly requested?: number;
  readonly inherited?: number;
}): number | undefined {
  if (input.owner === 'shared' || input.owner === 'composition') return undefined;
  if (input.owner === 'capture') return input.requested;
  return input.requested ?? input.inherited;
}

function cachedGraphPassPhase(
  graph: object,
  owner: string,
  pass: Pick<RenderGraphPassExecution, 'name' | 'kind'>,
): RenderGraphPassProfilePhase {
  let owners = graphPassPhaseNames.get(graph);
  if (owners === undefined) {
    owners = new Map();
    graphPassPhaseNames.set(graph, owners);
  }
  let byKind = owners.get(owner);
  if (byKind === undefined) {
    byKind = new Map();
    owners.set(owner, byKind);
  }
  let byName = byKind.get(pass.kind);
  if (byName === undefined) {
    byName = new Map();
    byKind.set(pass.kind, byName);
  }
  let phase = byName.get(pass.name);
  if (phase === undefined) {
    phase = graphExecutionProfilePhase({ owner, pass });
    byName.set(pass.name, phase);
  }
  return phase;
}

/** One graph pass boundary binds the CPU profile phase to its actual GPU timing identity. */
export function createRenderGraphPassInstrumentation<Frame extends RenderGraphFrame>(input: {
  readonly internals: RenderSystemInternals;
  readonly graph: CompiledRenderGraph<Frame>;
  readonly owner?: string;
  readonly viewId?: number;
}): RenderGraphPassInstrumentation<Frame> | undefined {
  const { internals, graph } = input;
  const context = recordContext(internals);
  const recordProfile = recordProfileContext(internals);
  const { world, identityCapture } = recordProfile;
  const profileSession =
    identityCapture === undefined ? undefined : pinnedRenderProfileSession(world);
  const capture = internals.gpuPassTimingCapture;
  const viewId = graphPassTimingViewId({
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.viewId === undefined ? {} : { requested: input.viewId }),
    ...(context.gpuPassTimingViewId === undefined
      ? {}
      : { inherited: context.gpuPassTimingViewId }),
  });
  let cpuScope: RenderGraphPassCpuScopeFactory | undefined;
  if (
    identityCapture !== undefined &&
    (profileSession === undefined || profileSession.detail === 'owner')
  )
    identityCapture.complete = false;
  if (
    identityCapture !== undefined &&
    profileSession !== undefined &&
    profileSession.detail !== 'owner'
  ) {
    const owner = input.owner ?? graphExecutionProfileOwner(internals);
    // Precompute from this immutable graph so the hot pass callback only performs
    // a bounded map lookup for its phase name.
    graphExecutionProfilePhases(graph, owner);
    const deviceGeneration = context.deviceScope?.generation ?? 0;
    const graphGeneration = compiledRenderGraphGeneration(graph);
    if (input.owner === 'capture' && input.viewId === undefined) identityCapture.complete = false;
    cpuScope = (pass, gpuIdentity, gpuIdentityStatus) => {
      if (pass.kind === 'subgraph') return undefined;
      let opened = false;
      try {
        const phase = cachedGraphPassPhase(graph, owner, pass);
        opened = profileSession.beginPhase('render', phase).ok;
        if (!opened) {
          // Receipt completeness means every identity row has a retained CPU
          // span. A pass without an opened span cannot be represented as a join.
          identityCapture.complete = false;
          return undefined;
        }
        const rowLimitReached = identityCapture.entries.length >= MAX_RENDER_PASS_CPU_IDENTITIES;
        if (rowLimitReached) identityCapture.complete = false;
        else {
          const identityViewId = gpuIdentity?.viewId ?? viewId;
          identityCapture.entries.push(
            Object.freeze({
              phase,
              owner,
              ...(identityViewId === undefined ? {} : { viewId: identityViewId }),
              deviceGeneration,
              graphGeneration,
              graphExecutionIndex: pass.executionIndex,
              passName: pass.name,
              passKind: pass.kind,
              gpuIdentityStatus:
                gpuIdentityStatus === 'not-captured'
                  ? internals.gpuPassTimingBeginReason === undefined
                    ? 'not-requested'
                    : 'unavailable'
                  : gpuIdentityStatus,
              ...(gpuIdentity === undefined
                ? {}
                : { gpuIdentity: Object.freeze({ ...gpuIdentity }) }),
            }),
          );
        }
      } catch {
        identityCapture.complete = false;
        if (opened) {
          try {
            if (!profileSession.endPhase().ok) identityCapture.complete = false;
          } catch {
            // Profiler failures cannot alter graph execution.
          }
        }
        return undefined;
      }
      if (!opened) return undefined;
      return () => {
        try {
          if (!profileSession.endPhase().ok) identityCapture.complete = false;
        } catch {
          // Profiler failures cannot alter graph execution.
          identityCapture.complete = false;
        }
      };
    };
  }
  if (capture === undefined && cpuScope === undefined) return undefined;
  if (identityCapture !== undefined && cpuScope !== undefined)
    identityCapture.instrumentationAccepted = true;
  return createPassTimingInstrumentation(capture, viewId, cpuScope);
}

export function graphExecutionPhase(passName: string): RenderGraphExecutionPhase {
  if (passName.startsWith('shadowCascade')) return 'record/graph-execute/shadow';
  if (passName.startsWith('point-shadow')) return 'record/graph-execute/point-shadow';
  if (passName.startsWith('spot-shadow')) return 'record/graph-execute/spot-shadow';
  if (passName === 'depth-pyramid-seed' || passName.startsWith('depth-pyramid-reduce-')) {
    return 'record/graph-execute/depth-pyramid';
  }
  if (passName === 'ssr-trace') return 'record/graph-execute/ssr-trace';
  if (passName === 'ssr-temporal') return 'record/graph-execute/ssr-temporal';
  if (passName.startsWith('ssr-reflection-mip-')) {
    return 'record/graph-execute/ssr-reflection-mip';
  }
  if (passName === 'ssr-compose') return 'record/graph-execute/ssr-compose';
  if (passName.startsWith('bloom-horizontal-')) {
    return 'record/graph-execute/bloom-horizontal';
  }
  if (passName.startsWith('bloom-vertical-')) {
    return 'record/graph-execute/bloom-vertical';
  }
  switch (passName) {
    case 'cluster-binner-upload':
    case 'cluster-membership-producer':
      return 'record/graph-execute/cluster-binner-upload';
    case 'g-buffer':
      return 'record/graph-execute/g-buffer';
    case 'ssao-calc':
      return 'record/graph-execute/ssao-calc';
    case 'ssao-blur':
      return 'record/graph-execute/ssao-blur';
    case 'lighting':
      return 'record/graph-execute/lighting';
    case 'forward':
    case 'transmission-forward':
      return 'record/graph-execute/forward';
    case 'output-transform':
      return 'record/graph-execute/output-transform';
    case 'present':
      return 'record/graph-execute/present';
    case 'debug-overlay':
      return 'record/graph-execute/debug-overlay';
    case 'shadow':
      return 'record/graph-execute/shadow';
    case 'skybox':
      return 'record/graph-execute/skybox';
    case 'main':
      return 'record/graph-execute/main';
    case 'fxaa':
      return 'record/graph-execute/fxaa';
    case 'bloom-horizontal':
      return 'record/graph-execute/bloom-horizontal';
    case 'bloom-vertical':
      return 'record/graph-execute/bloom-vertical';
    case 'bloom-composite':
      return 'record/graph-execute/bloom-composite';
    default:
      return 'record/graph-execute/other';
  }
}

export function acquireSwapChainTarget(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
): { texture: Texture; view: TextureView; targetW: number; targetH: number } | null {
  const output = recordContext(internals).viewOutput?.texture ?? internals.presentationOutput;
  if (output !== undefined) {
    const view = internals.device.createTextureView(output, {
      format: pipelineState.colorAttachmentFormat,
    });
    if (!view.ok) {
      internals.errorRegistry.fire(view.error);
      return null;
    }
    return {
      texture: output,
      view: view.value,
      targetW: recordContext(internals).viewOutput?.width ?? recordContext(internals).canvas.width,
      targetH:
        recordContext(internals).viewOutput?.height ?? recordContext(internals).canvas.height,
    };
  }
  const canvasContext: RhiCanvasContext | null = internals.context;
  if (canvasContext === null) return null;

  let currentTextureResult = canvasContext.getCurrentTexture();
  if (!currentTextureResult.ok) {
    const configuredDevice = internals.resolveSurfaceDevice?.(internals.device);
    if (configuredDevice !== undefined && !configuredDevice.ok) {
      internals.errorRegistry.fire(configuredDevice.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: { message: 'surface device resolution failed; current frame skipped' },
        recoverable: true,
      });
      return null;
    }
    const configured = configurePipelineSurface(
      canvasContext,
      configuredDevice?.value ?? internals.device,
      pipelineState,
      recordContext(internals).outputColorSpace,
    );
    if (!configured.ok) {
      internals.errorRegistry.fire(configured.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: { message: 'surface configure candidate failed; current frame skipped' },
        recoverable: true,
      });
      return null;
    }
    const retry = canvasContext.getCurrentTexture();
    if (!retry.ok) {
      internals.errorRegistry.fire(retry.error);
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: {
          message:
            'surface-configure-failed after retry: getCurrentTexture failed twice consecutively',
        },
        recoverable: false,
      });
      return null;
    }
    currentTextureResult = retry;
  }
  const format =
    pipelineState.colorAttachmentFormat === pipelineState.format
      ? undefined
      : (pipelineState.colorAttachmentFormat as GPUTextureFormat);
  const view = swapChainView(internals, currentTextureResult.value, format);
  if (view === null) return null;
  return {
    texture: currentTextureResult.value,
    view,
    targetW: recordContext(internals).canvas.width | 0,
    targetH: recordContext(internals).canvas.height | 0,
  };
}

// A surface that hands back the same texture again (native hosts, headless
// carriers) reuses its view; a browser's per-frame texture misses and is
// released with that texture.
const swapChainViews = new WeakMap<
  Texture,
  { readonly format: GPUTextureFormat | undefined; readonly view: TextureView }
>();

function swapChainView(
  internals: RenderSystemInternals,
  texture: Texture,
  format: GPUTextureFormat | undefined,
): TextureView | null {
  const cached = swapChainViews.get(texture);
  if (cached !== undefined && cached.format === format) return cached.view;
  const viewResult = internals.device.createTextureView(
    texture,
    format === undefined ? {} : { format },
  );
  if (!viewResult.ok) {
    internals.errorRegistry.fire(viewResult.error);
    return null;
  }
  swapChainViews.set(texture, { format, view: viewResult.value });
  return viewResult.value;
}

/** Preparation reads dimensions without acquiring the canvas's next texture. */
export function frameTargetExtent(
  internals: RenderSystemInternals,
  captureOnly: boolean,
  captureTarget?: { readonly width: number; readonly height: number },
): { targetW: number; targetH: number } {
  const capture = captureOnly ? captureTarget : undefined;
  return {
    targetW:
      (capture?.width ??
        recordContext(internals).viewOutput?.width ??
        recordContext(internals).canvas.width) | 0,
    targetH:
      (capture?.height ??
        recordContext(internals).viewOutput?.height ??
        recordContext(internals).canvas.height) | 0,
  };
}

export function requireFrameTarget(target: ReturnType<typeof acquireSwapChainTarget> | undefined) {
  if (target == null)
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'the presentation target is acquired after pipeline preparation',
      hint: 'resolve surface resources only while executing ready frame passes',
    });
  return target;
}

/** The exact light projections consumed by GPU and raster shadow views. */
export function hasShadowViewDemand(lights: ViewLights): boolean {
  return hasShadowPipelineDemand(lights, lights.cascades?.lightViewProj?.length ?? 0);
}

export function resolveShadowMapSize(
  internals: RenderSystemInternals,
  lights: ViewLights,
): number | undefined {
  if (lights.cascades?.cascadeCount === undefined) return undefined;
  const requested = lights.cascades?.shadowMapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  const depthTextureDimension =
    internals.device.caps?.backendKind === 'wgpu-webgl2'
      ? Math.max(1, Math.floor(maxDimension / 2))
      : maxDimension;
  return Math.max(1, Math.min(Math.floor(requested), depthTextureDimension));
}

/**
 * Resolve the per-layer size for the graph-owned spot shadow array independently
 * of directional maps. Both graph allocation and the raster viewport consume
 * this value, including frames with differently sized directional shadows.
 */
export function resolveSpotShadowMapSize(
  internals: RenderSystemInternals,
  lights: ViewLights,
): number | undefined {
  const requested = lights.spot.find(
    (spot) => spot.shadowAtlasTile >= 0 && spot.lightViewProj !== undefined,
  )?.mapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  return Math.max(1, Math.min(Math.floor(requested), Math.floor(maxDimension)));
}
