import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { RenderResidencyGroup } from '../gpu-driven/batch-residency';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import type {
  ProductionViewPreparation,
  ProductionViewStorage,
} from '../gpu-driven/production-initial-view';
import type { GpuDrivenPrepareInput } from '../gpu-driven/production-raster';
import type { NativeMainGraphPreparation } from '../gpu-driven/source-raster-preparation';
import type { GpuDrivenView, GpuDrivenViewCreationStep } from '../gpu-driven/view-gpu';
import type { GpuViewInputPreparation } from '../gpu-driven/view-input-bindings';
import type { GpuScene } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { gpuShadowViewRequests } from '../record/frame-gpu-driven';
import { buildFrameGpuDrivenInput } from '../record/frame-gpu-driven-input';
import {
  holdPreparedViewGraph,
  type PreparedViewGraph,
  retireRejectedSourceGraph,
} from '../record/graph-adoption';
import { querySceneExecution } from '../record/resident-meshes';
import { shadowViewPlanesByView } from '../record/shadow-culling';
import { compileSourceViewGraph, ensureShadowDepthLayers } from '../record/typed-frame-graph';
import { FrameProjection } from '../scene/frame-list';
import type { CompositionEntry, SceneComposition } from '../scene/scene-composition';
import { viewGpuDrivenSourcesOf } from '../world/gpu-driven-systems';
import { planSourcePasses } from '../world/pass-plan-systems';
import { viewLightsOf } from '../world/render-lights';
import { renderSubmission } from '../world/render-world';
import { viewStandardLightingOf } from '../world/standard-lighting-systems';
import { readSourceViewGraphInput } from '../world/view-graph-input';
import { recordContext } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';
import { viewTopologyOf } from '../world/view-topology-systems';
import type { CameraInputBindings } from './camera-input-bindings';
import { prepareSourceMainBindings } from './source-main-bindings';
import { prepareSourceShadowBindings } from './source-shadow-bindings';

interface SourceViewHost {
  readonly world: World;
  readonly composition: SceneComposition;
  readonly inputBindings: CameraInputBindings;
  owners(): readonly ViewSettlementOwner[];
  entity(owner: ViewSettlementOwner): EntityHandle | undefined;
}

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'retry first View preparation for the original live Source and camera demand',
  });
}

function captureSourceViews(
  host: SourceViewHost,
  group: RenderResidencyGroup,
  current: () => boolean,
) {
  const entry = host.composition.entry;
  const scene = host.composition.gpuSceneResident;
  if (entry === undefined || scene === undefined)
    throw invalid('the original resident Source Scene');
  const cameraCurrent = host.inputBindings.captureCurrent();
  const selected = entry.topology.captureResidencySelection();
  const resident = entry.topology.residentSourcePlan();
  const captured = host.owners();
  const facts = captured.map((owner) => {
    const context = recordContext(owner.internals);
    return {
      owner,
      context,
      scope: context.deviceScope,
      device: owner.internals.device,
      production: owner.gpuDriven,
      pipeline: context.getPipelineState(),
      graph: owner.frameState.compiledFrameGraph,
      graphGeneration: owner.frameState.compiledFrameGraphGeneration,
    };
  });
  const device = facts[0]?.device;
  if (device === undefined) throw invalid('actual Camera owners on the original device');
  const ownersCurrent = () => {
    if (!cameraCurrent()) return false;
    const actual = host.owners();
    return (
      actual.length === captured.length &&
      facts.every(
        (fact, index) =>
          actual[index] === fact.owner &&
          recordContext(fact.owner.internals) === fact.context &&
          fact.context.deviceScope === fact.scope &&
          fact.owner.internals.device === fact.device &&
          fact.context.getPipelineState() === fact.pipeline &&
          fact.owner.gpuDriven === fact.production &&
          fact.scope.isAlive(),
      )
    );
  };
  const live = () => {
    if (!cameraCurrent() || !current() || !cameraCurrent()) return false;
    const actual = host.owners();
    return (
      !renderSubmission(host.world).open &&
      host.composition.entry === entry &&
      host.composition.gpuSceneResident === scene &&
      scene.live &&
      selected.isCurrent() &&
      entry.topology.hasResidencyGroup(group) &&
      entry.topology.residentSourcePlan() === resident &&
      actual.length === captured.length &&
      facts.every(
        (fact, index) =>
          fact.owner === actual[index] &&
          recordContext(fact.owner.internals) === fact.context &&
          fact.context.deviceScope === fact.scope &&
          fact.owner.internals.device === fact.device &&
          fact.context.getPipelineState() === fact.pipeline &&
          fact.owner.gpuDriven === fact.production &&
          fact.owner.frameState.compiledFrameGraph === fact.graph &&
          fact.owner.frameState.compiledFrameGraphGeneration === fact.graphGeneration &&
          (fact.graph === null || !fact.graph.graph.isRetired()) &&
          fact.scope.isAlive(),
      )
    );
  };
  return { entry, scene, captured, device, live, ownersCurrent };
}

function initialSourcePlan(
  host: SourceViewHost,
  owner: ViewSettlementOwner,
  entry: CompositionEntry,
  scene: GpuScene,
  group: RenderResidencyGroup,
  current: () => boolean,
): {
  readonly plan: SubmissionPlan;
  readonly surfaceRows: boolean;
  readonly shadow: SubmissionPlan | undefined;
  readonly request: GpuDrivenPrepareInput;
} {
  const state = owner.scene.compositionGpuDrivenState(group);
  const entity = host.entity(owner);
  const sources = entity === undefined ? undefined : viewGpuDrivenSourcesOf(host.world, entity);
  const lighting = entity === undefined ? undefined : viewStandardLightingOf(host.world, entity);
  if (
    state?.scene !== scene ||
    sources === undefined ||
    lighting?.kind !== 'prepared' ||
    !lighting.lighting.ok ||
    lighting.fence.pipelineState === null ||
    !current()
  )
    throw invalid('current original Camera, lighting and prospective Scene inputs');
  const prospective = { ...sources.gpuDriven, scene: querySceneExecution(state) };
  const request = buildFrameGpuDrivenInput(
    { ...sources, sourceScope: entry.source },
    prospective,
    prospective,
    lighting.lighting.value.standard,
    lighting.fence.pipelineState,
    'resident-only',
  ).request;
  if (request === undefined) throw invalid('the actual prospective GPU request');
  const plans = owner.gpuDriven.prepareInitialPlan(request, current).unwrap();
  return {
    request,
    shadow: plans.shadow,
    plan: plans.main,
    surfaceRows: request.visibleSurface !== undefined,
  };
}

function* prepareInitialInputs(
  host: SourceViewHost,
  scene: GpuScene,
  device: RhiDevice,
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep> {
  const uploaded = scene.inputs.uploadedBuffer();
  if (
    uploaded !== undefined &&
    host.owners().every((owner) => owner.gpuDriven.currentInputBindings(scene, uploaded.buffer))
  ) {
    if (!current()) throw invalid('current already uploaded View Inputs and consumers');
    yield device.queue.onSubmittedWorkDone();
    return;
  }
  const input = scene.inputs.prepareBuffer().unwrap();
  let binding: GpuViewInputPreparation | undefined;
  const causes: unknown[] = [];
  try {
    while (input.inspect().phase !== 'current') {
      if (!current()) throw invalid('current first View Inputs demand');
      input.step(64 * 1024).unwrap();
      yield;
    }
    binding = host.inputBindings.prepare(scene, input).unwrap();
    if (!current() || !binding.isCurrent()) throw invalid('current first View Inputs and bindings');
    binding.publish().unwrap();
    yield device.queue.onSubmittedWorkDone();
  } catch (cause) {
    causes.push(cause);
    throw cause;
  } finally {
    releaseInitialInputs(binding, input, causes);
  }
}

function releaseInitialInputs(
  binding: GpuViewInputPreparation | undefined,
  input: GpuSceneInputPreparation,
  causes: readonly unknown[],
): void {
  const failures: unknown[] = [];
  try {
    binding?.release();
  } catch (cause) {
    failures.push(cause);
  }
  try {
    input.release();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0)
    throw new AggregateError([...causes, ...failures], 'Initial View Inputs cleanup failed');
}

export interface SourceViewPreparation extends Generator<GpuDrivenViewCreationStep> {
  /** Completed native demand, independent of its group's current execution gate. */
  isCurrent(): boolean;
  /** The original captured view/selection demand changed while this Source stayed valid. */
  isObsolete(): boolean;
  /** Stop this exact attempt and wait for original parents to confirm every partial retirement. */
  retire(): Promise<Result<void, RhiError>>;
}
interface InitialSourceScope {
  ready: boolean;
  readonly graphs: Pick<PreparedViewGraph, 'isCurrent' | 'retire'>[];
  readonly preparations: ProductionViewPreparation[];
  readonly storages: ProductionViewStorage[];
  readonly undo: (() => void)[];
  readonly bindings: (() => boolean)[];
  readonly demands: (() => boolean)[];
  readonly native: NativeMainGraphPreparation[];
  readonly releases: (() => void)[];
}

/** Actual first-Source compute Views, not complete graph/Pass or Level readiness. */
export function prepareInitialSourceViews(
  host: SourceViewHost,
  group: RenderResidencyGroup,
  current: () => boolean,
  capture?: (view: GpuDrivenView) => void,
): SourceViewPreparation {
  let closing = false;
  const owners = captureSourceViews(host, group, () => !closing && current() && !closing);
  const scope: InitialSourceScope = {
    ready: false,
    graphs: [],
    preparations: [],
    storages: [],
    undo: [],
    bindings: [],
    demands: [],
    native: [],
    releases: [],
  };
  const work = initialSourceViews(host, group, owners, scope, capture);
  let retiring: Promise<Result<void, RhiError>> | undefined;
  return Object.freeze(
    Object.assign(work, {
      isObsolete: () =>
        !closing && current() && (!owners.live() || !scope.demands.every((demand) => demand())),
      isCurrent: () =>
        scope.ready &&
        scope.demands.every((demand) => demand()) &&
        !closing &&
        current() &&
        !closing &&
        owners.ownersCurrent() &&
        host.composition.entry === owners.entry &&
        host.composition.gpuSceneResident === owners.scene &&
        scope.native.every((native) => native.isCurrent()) &&
        scope.bindings.every((binding) => binding()) &&
        scope.graphs.every((graph) => graph.isCurrent()),

      retire: () => {
        if (retiring !== undefined) return retiring;
        closing = true;
        // A native/current callback may retire during next(). Close immediately,
        // but return the generator only after that synchronous resume unwinds.
        retiring = Promise.resolve().then(async () => {
          const failures: unknown[] = [];
          for (const release of scope.releases.splice(0)) {
            try {
              release();
            } catch (cause) {
              failures.push(cause);
            }
          }
          try {
            work.return(undefined);
          } catch (cause) {
            failures.push(cause);
          }
          const graphs = await Promise.allSettled(
            scope.graphs.map(async (graph) => graph.retire()),
          );
          for (const result of graphs) {
            if (result.status === 'rejected') failures.push(result.reason);
            else if (!result.value.ok) failures.push(result.value.error);
          }
          try {
            releaseInitialViews(scope.storages, scope.undo, []);
          } catch (cause) {
            failures.push(cause);
          }
          const results = await Promise.allSettled(
            scope.preparations.map(async (preparation) => preparation.settleRetirement()),
          );
          for (const result of results) {
            if (result.status === 'rejected') failures.push(result.reason);
            else if (!result.value.ok) failures.push(result.value.error);
          }
          if (failures.length === 0) {
            scope.preparations.length = 0;
            scope.graphs.length = 0;
            scope.bindings.length = 0;
            scope.demands.length = 0;
            scope.native.length = 0;
          }
          return failures.length === 0
            ? ok(undefined)
            : err(
                Object.assign(invalid('confirmed initial Source View retirement'), {
                  cause: new AggregateError(failures, 'Initial Source View retirement failed'),
                }),
              );
        });
        return retiring;
      },
    }),
  );
}

function* initialSourceViews(
  host: SourceViewHost,
  group: RenderResidencyGroup,
  owners: ReturnType<typeof captureSourceViews>,
  scope: InitialSourceScope,
  capture: ((view: GpuDrivenView) => void) | undefined,
): Generator<GpuDrivenViewCreationStep> {
  const { entry, scene, captured, device } = owners;
  const live = () => owners.live() && scope.demands.every((demand) => demand());
  const initial: InitialSourceView[] = [];
  const { storages, undo } = scope;
  let accepted = false;
  const causes: unknown[] = [];
  try {
    for (const owner of captured) {
      if (!live()) throw invalid('current first View demand');
      const { plan, surfaceRows, request, shadow } = initialSourcePlan(
        host,
        owner,
        entry,
        scene,
        group,
        live,
      );
      yield;
      if (!live()) throw invalid('current first View storage demand');
      const preparation = owner.gpuDriven.prepareInitialViewStorage(
        plan,
        scene,
        live,
        { surfaceRows, lateMirror: true },
        (view) => {
          initial.push({ view, plan, owner, request, shadow });
          capture?.(view);
        },
      );
      scope.preparations.push(preparation);
      const prepared = yield* preparation;
      storages.push(prepared.unwrap());
    }
    yield* prepareInitialShadowViews(host, initial, scope, scene, live);
    for (const { view, plan } of initial) {
      if (!live()) throw invalid('current initial topology demand');
      view.prepareInitialTopology(plan, scene, live).unwrap();
      yield;
    }
    yield* prepareInitialInputs(host, scene, device, live);
    yield* prepareInitialMainGraphs(host, initial, scope, device, live);
    if (
      !live() ||
      !storages.every((storage) => storage.isCurrent()) ||
      !scope.graphs.every((graph) => graph.isCurrent()) ||
      !scope.bindings.every((current) => current())
    )
      throw invalid('current first Source View demand');
    for (const storage of storages) undo.push(storage.accept().unwrap());
    if (
      !live() ||
      !storages.every((storage) => storage.isCurrent()) ||
      !scope.graphs.every((graph) => graph.isCurrent()) ||
      !scope.bindings.every((current) => current())
    )
      throw invalid('current first Source View adoption');
    for (const native of scope.native) scope.releases.push(native.retain());
    if (
      !live() ||
      !scope.bindings.every((current) => current()) ||
      !scope.graphs.every((graph) => graph.isCurrent())
    )
      throw invalid('current retained Source native consumers');
    accepted = true;
    scope.ready = true;
  } catch (cause) {
    causes.push(cause);
    throw cause;
  } finally {
    releaseSourcePreparation(scope, accepted, causes);
  }
}

function* prepareInitialShadowViews(
  host: SourceViewHost,
  initial: readonly InitialSourceView[],
  scope: InitialSourceScope,
  scene: GpuScene,
  live: () => boolean,
): Generator<GpuDrivenViewCreationStep> {
  const { storages } = scope;
  for (const { owner, shadow, request: sourceInput } of initial) {
    if (shadow === undefined) continue;
    const entity = host.entity(owner),
      lights = entity === undefined ? undefined : viewLightsOf(host.world, entity);
    const topology = viewTopologyOf(host.world, entity);
    if (lights === undefined || topology?.kind !== 'planned')
      throw invalid('actual fitted shadow lights and View topology');
    const requests = gpuShadowViewRequests(
      lights,
      shadowViewPlanesByView(lights.shadowViews),
      topology.topology.shadowMapSize,
      owner.frameState.compiledFrameGraphGeneration,
      lights.cascades?.cascadeCount,
    );
    const projected = owner.gpuDriven.prepareSourceShadowLayers(sourceInput, requests);
    scope.demands.push(projected.current);
    for (const request of projected.layers) {
      const preparation = owner.gpuDriven.prepareSourceShadowStorage(
        request.identity,
        shadow,
        scene,
        live,
      );
      scope.preparations.push(preparation);
      const storage = (yield* preparation).unwrap();
      storages.push(storage);
      const layer = owner.gpuDriven.prepareSourceShadowTopology(
        request.identity,
        shadow,
        request.candidatePrimitiveIndices,
        scene,
      );
      scope.releases.push(layer.release);
      storage.view.prepareInitialTopology(layer.plan, scene, live).unwrap();
      yield;
    }
  }
}

interface InitialSourceView {
  readonly shadow: SubmissionPlan | undefined;
  readonly view: GpuDrivenView;
  readonly plan: SubmissionPlan;
  readonly owner: ViewSettlementOwner;
  readonly request: GpuDrivenPrepareInput;
}

function* prepareInitialMainGraphs(
  host: SourceViewHost,
  initial: readonly InitialSourceView[],
  scope: InitialSourceScope,
  device: RhiDevice,
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep> {
  for (const { owner, view, request } of initial) {
    if (!current()) throw invalid('current prospective main graph demand');
    const entity = host.entity(owner);
    if (entity === undefined) throw invalid('the actual main graph Camera');
    const native = owner.gpuDriven.prepareMainGraphProjection(request, view, current).unwrap();
    scope.native.push(native);
    yield;
    if (!current() || !native.isCurrent()) throw invalid('current main graph inputs');
    const lighting = viewStandardLightingOf(host.world, entity);
    const entry = host.composition.entry;
    if (entry === undefined || lighting?.kind !== 'prepared' || !lighting.lighting.ok)
      throw invalid('the actual Source and main lighting');
    const slots = entry.projection.slotsSnapshot();
    const pass = planSourcePasses({
      requested: request.camera.transparency ?? 'sorted',
      rgba16floatRenderable: device.caps.rgba16floatRenderable,
      renderables: new FrameProjection(slots, (row) => row.snapshot),
      dispatch: entry.materialDispatch.query(
        slots,
        entry.projection.meshFrame(),
        undefined,
        entry.topology.captureResidencySelection(),
      ),
      materials: native.materials,
      renderPath: lighting.lighting.value.standard.prepared.renderPath,
      gpuOcclusion: owner.frameState.installedPipelineConfig?.gpuOcclusion,
    });
    const actual = readSourceViewGraphInput(
      host.world,
      entity,
      owner,
      {
        camera: request.camera,
        clearOnly: false,
        subsurfaceClass: 'none',
        rendererRecording: true,
        shadowDepthLayers: ensureShadowDepthLayers(owner.frameState, device),
      },
      pass,
    ).unwrap();
    const outcome = compileSourceViewGraph({
      ...actual,
      gpuDriven: native.projection,
    });
    const graph = holdSourceMainGraph(owner, outcome, scope);
    scope.graphs.push({
      isCurrent: () =>
        graph.isCurrent() && native.isCurrent() && graph.installed.graph.preparedResourcesCurrent(),
      retire: () => graph.retire(),
    });
    yield;
    if (!current() || !native.isCurrent()) throw invalid('current compiled main graph');
    (yield* native.attachGraph(graph.installed)).unwrap();
    graph.accept().unwrap();
    yield;
    yield* prepareSourceMainPipelines(owner, native, graph, current);
    (yield* native.prepareWindows()).unwrap();
    (yield* graph.installed.graph.prepareResources(
      () => current() && graph.isCurrent() && native.isCurrent(),
    )).unwrap();
    const bindings = yield* prepareSourceMainBindings(
      host.world,
      entity,
      owner,
      entry.source,
      native,
      graph.installed,
      () => current() && graph.isCurrent() && native.isCurrent(),
    );
    scope.bindings.push(bindings.isCurrent);
    scope.releases.push(bindings.release);
    const shadows = yield* prepareSourceShadowBindings(
      owner,
      entry.source,
      request.camera,
      native,
      () => current() && graph.isCurrent() && native.isCurrent(),
    );
    scope.bindings.push(shadows.isCurrent);
    scope.releases.push(shadows.release);
    if (!current() || !graph.isCurrent() || !native.isCurrent() || !bindings.isCurrent())
      throw invalid('current prepared main graph');
    yield;
  }
}

function releaseInitialViews(
  storages: ProductionViewStorage[],
  undo: (() => void)[],
  causes: readonly unknown[],
): void {
  const failures: unknown[] = [];
  while (undo.length > 0) {
    const rollback = undo.pop();
    try {
      rollback?.();
    } catch (cause) {
      failures.push(cause);
    }
  }
  while (storages.length > 0) {
    const storage = storages.pop();
    try {
      storage?.release();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0)
    throw new AggregateError([...causes, ...failures], 'Initial Source View cleanup failed');
}

function* prepareSourceMainPipelines(
  owner: ViewSettlementOwner,
  native: ReturnType<ViewSettlementOwner['gpuDriven']['prepareMainGraphProjection']> extends Result<
    infer T,
    unknown
  >
    ? T
    : never,
  graph: PreparedViewGraph,
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep> {
  const live = () => current() && graph.isCurrent() && native.isCurrent();
  const stale = () => invalid('current main graph pipeline demand');
  let requests = native.pipelineRequests().unwrap();
  for (;;) {
    const retry: (() => boolean)[] = [];
    const pending = new Set<Promise<Result<void, RhiError>>>();
    for (const request of requests) {
      if (!live()) throw stale();
      let ready = false;
      const prepare = () => {
        ready = request();
      };
      if (owner.internals.withPipelinePreparationErrors === undefined) prepare();
      else
        owner.internals.withPipelinePreparationErrors(prepare, (completion) => {
          if (completion !== undefined) pending.add(completion);
        });
      if (!live()) throw stale();
      if (!ready) retry.push(request);
      yield;
    }
    if (retry.length === 0) return;
    if (pending.size === 0) throw invalid('an actual pending main shader or pipeline compilation');
    yield Promise.all(pending).then((results) => {
      for (const result of results) result.unwrap();
    });
    requests = retry;
  }
}

/** Borrow existing graphs and retain every newly allocated rejection under its real parent. */
function holdSourceMainGraph(
  owner: ViewSettlementOwner,
  outcome: ReturnType<typeof compileSourceViewGraph>,
  scope: InitialSourceScope,
): PreparedViewGraph {
  if (outcome.kind !== 'failed' && outcome.effects.rejectedGraph !== undefined) {
    const retired = retireRejectedSourceGraph(
      owner.internals,
      owner.frameState,
      outcome.effects.rejectedGraph,
    );
    scope.graphs.push({ isCurrent: () => false, retire: () => retired });
  }
  if (outcome.kind === 'failed') throw outcome.cause;
  if (outcome.kind !== 'compiled' && outcome.kind !== 'reused' && outcome.kind !== 'promoted')
    throw outcome.effects.error?.error ?? invalid('a complete cold main graph candidate');
  const installed =
    outcome.kind === 'compiled'
      ? outcome.installed
      : outcome.kind === 'promoted'
        ? outcome.stash
        : owner.frameState.compiledFrameGraph;
  if (installed === null || installed.graph !== outcome.graph)
    throw invalid('the original existing or compiled main graph');
  return holdPreparedViewGraph(owner.internals, owner.frameState, installed);
}

function releaseSourcePreparation(
  scope: InitialSourceScope,
  accepted: boolean,
  causes: readonly unknown[],
): void {
  const failures: unknown[] = [];
  if (!accepted)
    for (const release of scope.releases.splice(0)) {
      try {
        release();
      } catch (cause) {
        failures.push(cause);
      }
    }
  try {
    releaseInitialViews(scope.storages, accepted ? [] : scope.undo, []);
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0)
    throw new AggregateError([...causes, ...failures], 'Source native cleanup failed');
}
