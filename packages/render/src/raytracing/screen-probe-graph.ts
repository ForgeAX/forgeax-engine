import {
  type GraphAccess,
  type GraphBuffer,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RayDiffuseTargets } from './diffuse-graph';
import {
  addIrradianceFieldPasses,
  type FieldRadianceGraphHandles,
  type IrradianceFieldGraphHandles,
  irradianceFieldGraphShape,
} from './irradiance-field-graph';
import { IRRADIANCE_FIELD_PROBE_BYTES } from './irradiance-field-plan';
import {
  type KernelGraphHandle,
  kernelGraphAccess,
  resolveKernelBinding,
} from './kernel-graph-access';
import { addRayDiffuseCompositePass } from './ray-graph-shared';
import type { PreparedScreenProbe, ScreenProbeExtent } from './renderer-screen-probe';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_IRRADIANCE_SLOTS,
  SCREEN_PROBE_IRRADIANCE_TEXELS,
  SCREEN_PROBE_STAGES,
  SCREEN_PROBE_TRACE_STAGES,
  type ScreenProbeKernel,
  type ScreenProbePreintegration,
  type ScreenProbeSlot,
  type ScreenProbeStage,
  type ScreenProbeTraceStage,
} from './screen-probe-kernels';
import { SCREEN_PROBE_TEXELS } from './screen-probe-plan';
import { SCREEN_PROBE_SCATTER_NOISE_DESCRIPTOR } from './screen-probe-scatter-noise';

/** Graph identity: field topology, view extent and the filter pass count. */
export function screenProbeGraphShape(prepared: PreparedScreenProbe) {
  const layout = prepared.extent().layout;
  return [
    prepared.generation,
    irradianceFieldGraphShape(prepared.field),
    layout.width,
    layout.height,
    prepared.profile.probes.filterPasses,
    prepared.profile.field.radiosity,
    prepared.roots === undefined ? 'legacy' : 'paid-root',
    prepared.extent().receiverSource?.descriptor.size.width ?? 0,
    prepared.extent().receiverSource?.descriptor.size.height ?? 0,
  ];
}

type Handle = KernelGraphHandle;
type ProbeWork =
  | ((value: PreparedScreenProbe) => number)
  | { readonly args: GraphBuffer; readonly offset: number };

type WorldPassInstaller = (
  label: string,
  select: (value: PreparedScreenProbe) => ScreenProbeKernel,
  work?: (value: PreparedScreenProbe) => number,
) => ReturnType<RenderGraphBuilder<RenderPipelineFrame>['addComputePass']>;
/** Optional stages remain part of the same graph, source tuple and request
 * lifetime. The ordinary World pass always follows their completed writes. */
function addWorldPreparationPasses(prepared: PreparedScreenProbe, add: WorldPassInstaller) {
  if (prepared.receiver !== undefined) {
    const receiver = add(
      'prepare-receivers',
      (value) => {
        if (value.receiver === undefined) throw new Error('canonical receiver pipeline retired');
        return value.receiver;
      },
      (value) => value.extent().layout.probeCount,
    );
    if (!receiver.ok) return receiver;
  }
  if (prepared.roots === undefined) return ok(undefined);
  for (const [index, label] of ['prepare-root', 'refine-root'].entries()) {
    const result = add(label, (value) => {
      const kernel = value.roots?.[index];
      if (kernel === undefined) throw new Error('missing Screen root pipeline');
      return kernel;
    });
    if (!result.ok) return result;
  }
  return ok(undefined);
}

type BufferImport = (
  name: string,
  size: number,
  resolve: (value: ScreenProbeExtent, parity: 0 | 1) => Buffer,
) => GraphBuffer;

function importScreenRoot(extent: ScreenProbeExtent, imported: BufferImport) {
  if (extent.rootRequests === undefined) return undefined;
  return imported('root-requests', extent.rootRequests.size, (value) => {
    if (value.rootRequests === undefined) throw new Error('missing Screen root request allocation');
    return value.rootRequests.buffer;
  });
}

/** Receiver resources have their own admission and retain the same graph's
 * lifetime/fence. This introduces no second source or identity authority. */
function importScreenReceiver(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  current: () => PreparedScreenProbe,
  target: RayDiffuseTargets,
) {
  const prepared = current(),
    source = prepared.extent().receiverSource;
  if (prepared.receiver !== undefined && target.identity === undefined)
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected:
          'the same-frame visible-surface attachment for canonical software Screen receivers',
        hint: 'enable the ordinary rigid deferred identity producer; unavailable identity is not an empty World',
      }),
    );
  const receiverSource =
    source === undefined
      ? undefined
      : (() => {
          const live = () => {
            const value = current().extent().receiverSource;
            if (value === undefined) throw new Error('receiver source retired');
            return value;
          };
          const texture = graph
            .importTexture('screen-probe.receiver-source', source.descriptor, () => live().texture)
            .unwrap();
          return graph.importView(texture, { dimension: '2d' }, () => live().view).unwrap();
        })();
  return ok({ visibleSurface: target.identity?.view, receiverSource });
}

/** Field cache -> placement -> importance rays -> HZB screen trace -> Global
 * world traversal/Card trace -> resolve (field fallback) -> probe history -> spatial filter -> probe
 * irradiance -> per-pixel integrate (bent normal, short-range AO) -> temporal
 * -> the shared additive diffuse composite -> scene history for next frame. */
export function addScreenProbePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedScreenProbe,
  target: RayDiffuseTargets,
) {
  if (target.depthPyramid === undefined)
    return err(
      new RenderGraphError({
        code: 'dangling-read',
        expected: 'the view closest-depth pyramid for the screen-probe HZB trace',
        hint: 'contribute screen-probe GI from the Standard deferred pipeline, which shares its depth pyramid',
        detail: { resourceKey: 'depth-pyramid', passName: 'screen-probe.trace-screen' },
      }),
    );
  const pyramid = target.depthPyramid();
  if (!pyramid.ok) return pyramid;
  return addIrradianceFieldPasses(graph, prepared.field, target, (fieldHandles, far) =>
    addProbePasses(graph, prepared, target, pyramid.value, fieldHandles, far),
  );
}

function radianceAtlasExtent(probes: number) {
  // An 8x8 map, folded gutters, and a coverage marker beside the gutter.
  // A 256-tile row fits the field's storage binding capacity within the base texture limits.
  const columns = Math.min(256, probes);
  // Retain the near atlas in the first bank; the far producer owns the second.
  return { width: columns * 11, height: Math.ceil(probes / columns) * 20 };
}

function addProbePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedScreenProbe,
  target: RayDiffuseTargets,
  depthPyramid: GraphTextureView,
  field: IrradianceFieldGraphHandles,
  far: FieldRadianceGraphHandles | undefined,
) {
  const current = () => {
    if (prepared.fence.currentGeneration() !== prepared.generation)
      throw new Error('stale screen-probe graph; prepare the current scene');
    return prepared;
  };
  const extent = prepared.extent();
  const layout = extent.layout;
  const pixelCount = layout.width * layout.height;
  const imported = (
    name: string,
    size: number,
    resolve: (value: ScreenProbeExtent, parity: 0 | 1) => Buffer,
  ) =>
    graph
      .importBuffer(`screen-probe.${name}`, { size, usage: 128 | 12 }, () => {
        const value = current();
        return resolve(value.extent(), value.parity());
      })
      .unwrap();
  const b = extent.buffers;
  const aoMode = prepared.profile.probes.shortRangeAoMode;
  const aoFactor = aoMode === 'half-scalar' ? 2 : 1;
  const aoWidth = Math.ceil(layout.width / aoFactor);
  const aoHeight = Math.ceil(layout.height / aoFactor);
  const aoPixels = aoWidth * aoHeight;
  const shortRangeAo =
    aoMode === undefined
      ? undefined
      : graph.createBuffer('screen-probe.short-range-ao', { size: aoPixels * 16 }).unwrap();
  const traceResolve =
    prepared.field.traversal === 'ray-query' &&
    prepared.profile.probes.integration === 'screen-space';
  const trace = traceResolve
    ? {
        fallback: graph
          .createBuffer('screen-probe.trace-list', {
            size: (layout.probeCount * SCREEN_PROBE_TEXELS + 1) * 4,
          })
          .unwrap(),
        dispatch: graph.createBuffer('screen-probe.trace-dispatch', { size: 24 }).unwrap(),
        cells: graph
          .createBuffer('screen-probe.trace-cells', {
            size: layout.probeCount * SCREEN_PROBE_TEXELS * 8,
          })
          .unwrap(),
      }
    : undefined;
  const hardwareWorld = target.motionWithDepth === undefined ? undefined : prepared.worldMotion;
  const receiverMotion =
    hardwareWorld === undefined
      ? undefined
      : graph
          .createBuffer('screen-probe.receiver-motion', { size: layout.probeCount * 8 })
          .unwrap();
  const probeMoving =
    receiverMotion === undefined
      ? undefined
      : graph.createBuffer('screen-probe.probe-moving', { size: layout.probeCount * 4 }).unwrap();
  const pixelMoving =
    probeMoving === undefined || !prepared.pixelOwnedHistory
      ? undefined
      : graph
          .createBuffer('screen-probe.pixel-moving', { size: layout.width * layout.height * 4 })
          .unwrap();
  const fieldProbeCount = prepared.field.buffers.irradiance.size / IRRADIANCE_FIELD_PROBE_BYTES;
  const atlas =
    trace === undefined || prepared.kernels.packRadianceAtlas === undefined
      ? undefined
      : radianceAtlasExtent(fieldProbeCount);
  const atlasAllocation =
    atlas === undefined
      ? undefined
      : graph
          .createTexture('screen-probe.radiance-atlas', { format: 'rgba16float', size: atlas })
          .unwrap();
  const atlasView =
    atlasAllocation === undefined ? undefined : graph.view(atlasAllocation).unwrap();
  const fixed = (slot: keyof ScreenProbeExtent['buffers']) =>
    imported(slot, b[slot].size, (value) => value.buffers[slot].buffer);
  const probes = fixed('probes');
  const adaptiveCount = fixed('adaptiveCount');
  const tileAdaptive = fixed('tileAdaptive');
  const rays = fixed('rays');
  const rootRequests = importScreenRoot(extent, imported);
  const radianceA = fixed('radianceA');
  const radianceB = fixed('radianceB');
  const integrated = fixed('integrated');
  const previousScene = fixed('previousScene');
  const depthHistory = extent.previousScreenDepth;
  const previousScreenDepth =
    depthHistory === undefined
      ? undefined
      : imported('previous-screen-depth', depthHistory.size, (value) => {
          const depth = value.previousScreenDepth;
          if (depth === undefined) throw new Error('screen trace depth history retired');
          return depth.buffer;
        });
  const probeHistoryIn = imported('probe-history-in', b.probeHistoryA.size, (value, parity) =>
    parity === 0 ? value.buffers.probeHistoryA.buffer : value.buffers.probeHistoryB.buffer,
  );
  const probeHistoryOut = imported('probe-history-out', b.probeHistoryB.size, (value, parity) =>
    parity === 0 ? value.buffers.probeHistoryB.buffer : value.buffers.probeHistoryA.buffer,
  );
  const historyIn = imported('history-in', b.historyA.size, (value, parity) =>
    parity === 0 ? value.buffers.historyA.buffer : value.buffers.historyB.buffer,
  );
  const historyOut = imported('history-out', b.historyB.size, (value, parity) =>
    parity === 0 ? value.buffers.historyB.buffer : value.buffers.historyA.buffer,
  );
  const metaIn = imported('meta-in', b.metaA.size, (value, parity) =>
    parity === 0 ? value.buffers.metaA.buffer : value.buffers.metaB.buffer,
  );
  const metaOut = imported('meta-out', b.metaB.size, (value, parity) =>
    parity === 0 ? value.buffers.metaB.buffer : value.buffers.metaA.buffer,
  );
  const frame = graph
    .importBuffer(
      'screen-probe.frame',
      { size: prepared.frame.size, usage: 64 | 8 },
      () => current().frame.buffer,
    )
    .unwrap();
  const view = graph
    .importBuffer(
      'screen-probe.view',
      { size: VIEW_UNIFORM_BYTES, usage: 64 | 8 },
      (f) => f.pipelineState.viewUniformBuffer,
    )
    .unwrap();
  const receiver = importScreenReceiver(graph, current, target);
  if (!receiver.ok) return receiver;
  const noise = prepared.scatterNoise;
  const scatterNoise =
    noise === undefined
      ? undefined
      : graph
          .importView(
            graph
              .importTexture(
                'screen-probe.scatter-noise',
                SCREEN_PROBE_SCATTER_NOISE_DESCRIPTOR,
                () => noise.texture,
              )
              .unwrap(),
            { dimension: '2d' },
            () => noise.view,
          )
          .unwrap();
  const base: Partial<Record<ScreenProbeSlot, Handle>> = {
    ...(scatterNoise === undefined ? {} : { scatterNoise }),
    ...(receiverMotion === undefined
      ? {}
      : {
          receiverMotionOut: receiverMotion,
          receiverMotionIn: receiverMotion,
        }),
    ...(probeMoving === undefined
      ? {}
      : { probeMovingOut: probeMoving, probeMovingIn: probeMoving }),
    ...(pixelMoving === undefined
      ? {}
      : { pixelMovingOut: pixelMoving, pixelMovingIn: pixelMoving }),
    frame,
    view,
    depth: target.depth,
    normal: target.normal.view,
    albedo: target.albedo.view,
    depthPyramid,
    scene: target.scene.view,
    ...(target.reflection === undefined
      ? {}
      : { directionalReflection: target.reflection.fallback.view }),
    probes,
    probesIn: probes,
    adaptiveCount,
    adaptiveCountIn: adaptiveCount,
    tileAdaptive,
    tileAdaptiveIn: tileAdaptive,
    rays,
    raysIn: rays,
    previousScene,
    previousSceneOut: previousScene,
    screenMotion: target.motion.view,
    ...(target.motionWithDepth === undefined
      ? {}
      : { motionWithDepth: target.motionWithDepth.view }),
    ...(previousScreenDepth === undefined
      ? {}
      : { previousScreenDepth, previousScreenDepthOut: previousScreenDepth }),
    integratedOut: integrated,
    integrated,
    probeHistoryIn,
    probeHistoryOut,
    historyIn,
    historyOut,
    metaIn,
    metaOut,
    ...(shortRangeAo === undefined
      ? {}
      : { shortRangeAoIn: shortRangeAo, shortRangeAoOut: shortRangeAo }),
    ...(atlasView === undefined ? {} : { atlasIn: atlasView, atlasOut: atlasView }),
    ...(trace === undefined
      ? {}
      : {
          fallbackList: trace.fallback,
          fallbackListIn: trace.fallback,
          traceDispatch: trace.dispatch,
          traceCells: trace.cells,
          traceCellsIn: trace.cells,
        }),
  };
  const fieldReads = (domain: FieldRadianceGraphHandles): GraphAccess[] => [
    { resource: domain.field as GraphBuffer, usage: 'uniform-read' },
    { resource: field.visibilityInputs, usage: 'uniform-read' },
    { resource: field.visibility, usage: 'sampled-read' },
    { resource: field.canonical, usage: 'sampled-read' },
    ...(['irradiance', 'moments', 'meta'] as const).map(
      (name): GraphAccess => ({ resource: domain[name] as GraphBuffer, usage: 'storage-read' }),
    ),
  ];
  const stagePass = (
    label: string,
    stage: ScreenProbeStage | ScreenProbeTraceStage | ScreenProbePreintegration,
    work: ProbeWork,
    overrides: Partial<Record<ScreenProbeSlot, Handle>> = {},
    before?: (value: PreparedScreenProbe) => void,
    farAtlasSource = false,
  ) => {
    const handles = { ...base, ...overrides };
    const handle = (slot: ScreenProbeSlot): Handle => {
      const value = handles[slot];
      if (value === undefined) throw new Error(`screen-probe ${stage} has no ${slot} resource`);
      return value;
    };
    const traceStage = SCREEN_PROBE_TRACE_STAGES[stage as ScreenProbeTraceStage];
    const isPreintegration = stage === 'preintegrate' || stage === 'preintegrateScattered';
    const slots: readonly ScreenProbeSlot[] = isPreintegration
      ? SCREEN_PROBE_IRRADIANCE_SLOTS
      : (traceStage?.slots ?? SCREEN_PROBE_STAGES[stage as ScreenProbeStage].slots);
    const readsField =
      traceStage?.field ??
      (!isPreintegration &&
        (stage !== 'integrateScreenProbes' ||
          prepared.profile.probes.integration !== 'screen-space'));
    const storage =
      stage === 'beginTraceResolve' ||
      stage === 'scatterProbeTraces' ||
      stage === 'scatterProbeTracesWithMotion' ||
      stage === 'integrateScreenSpaceScreenProbesWithMotion' ||
      stage === 'resetTraceList' ||
      stage === 'prepareScreenProbeReceiverMotion' ||
      stage === 'computeScreenProbeShortRangeAo'
        ? 'storage-write'
        : 'storage-read-write';
    return graph.addComputePass(`screen-probe.${label}`, {
      accesses: [
        ...slots.map((slot) =>
          kernelGraphAccess(SCREEN_PROBE_BINDINGS[slot][1], handle(slot), storage),
        ),
        ...(readsField ? fieldReads(farAtlasSource ? (far ?? field) : field) : []),
        ...(typeof work === 'function'
          ? []
          : [{ resource: work.args, usage: 'indirect-read' as const }]),
      ],
      encodeDirect: (pass, _graphframe, resources) => {
        const value = current();
        before?.(value);
        const kernel = value.kernels[stage];
        if (kernel === undefined) throw new Error('screen-probe irradiance kernel is not prepared');
        kernel
          .record(
            pass,
            (slot) => {
              const kind = SCREEN_PROBE_BINDINGS[slot as ScreenProbeSlot][1];
              const bound = resolveKernelBinding(resources, kind, handle(slot as ScreenProbeSlot));
              return slot === 'view' && 'buffer' in bound
                ? { buffer: bound.buffer, size: VIEW_UNIFORM_BYTES }
                : bound;
            },
            farAtlasSource ? value.field.farRadiance?.sample : value.field.sample,
            typeof work === 'function'
              ? work(value)
              : { buffer: resources.buffer(work.args).unwrap(), offset: work.offset },
          )
          .unwrap();
      },
    });
  };
  const probeCount = (value: PreparedScreenProbe) => value.extent().layout.probeCount;
  const pixels = (value: PreparedScreenProbe) =>
    value.extent().layout.width * value.extent().layout.height;
  function addProbePlacement() {
    if (atlas !== undefined) {
      const packed = stagePass('pack-radiance-atlas', 'packRadianceAtlas', () => fieldProbeCount);
      if (!packed.ok) return packed;
      if (far !== undefined) {
        const packedFar = stagePass(
          'pack-far-radiance-atlas',
          'packRadianceAtlas',
          () => fieldProbeCount,
          {},
          undefined,
          true,
        );
        if (!packedFar.ok) return packedFar;
      }
    }
    const steps: (() => ReturnType<typeof stagePass>)[] = [
      () =>
        stagePass(
          'place-uniform',
          'placeUniformProbes',
          (value) => value.extent().layout.uniformCount,
          {},
          (value) =>
            value.writeFrame(pixelMoving !== undefined && previousScreenDepth !== undefined),
        ),
      () =>
        stagePass(
          'place-adaptive',
          'placeAdaptiveProbes',
          (value) => value.extent().layout.uniformCount * value.extent().layout.adaptiveSlots,
        ),
      () =>
        stagePass(
          'compact-adaptive',
          'compactAdaptiveProbes',
          (value) => value.extent().layout.uniformCount * value.extent().layout.adaptiveSlots,
        ),
      () =>
        trace === undefined
          ? stagePass('generate-rays', 'generateProbeRays', probeCount)
          : stagePass(
              'generate-rays',
              atlas === undefined || far === undefined
                ? 'generateHistoryProbeRays'
                : 'generateHardwareCacheProbeRays',
              probeCount,
              {
                // Temporal starts at B; each spatial filter swaps. Preintegration
                // writes its projection to the opposite buffer, keeping this radiance.
                radianceIn: prepared.profile.probes.filterPasses % 2 === 0 ? radianceB : radianceA,
              },
            ),
    ];
    for (const step of steps) {
      const added = step();
      if (!added.ok) return added;
    }
    return ok(undefined);
  }
  const probePlacement = addProbePlacement();
  if (!probePlacement.ok) return probePlacement;
  function addScreenTrace() {
    if (trace !== undefined) {
      // Placement owns the live probe count. Each screen workgroup traces the
      // same 64-slot probe consumed by the existing compact and scatter passes.
      const args = stagePass('trace-resolve-args', 'beginTraceResolve', () => 1);
      if (!args.ok) return args;
    }
    if (receiverMotion !== undefined) {
      const motion = stagePass('receiver-motion', 'prepareScreenProbeReceiverMotion', probeCount);
      if (!motion.ok) return motion;
    }
    const screenStage =
      previousScreenDepth === undefined
        ? 'traceScreenProbes'
        : target.motionWithDepth === undefined
          ? 'traceHardwareScreenProbes'
          : receiverMotion === undefined
            ? 'traceHardwareScreenProbesWithVelocity'
            : 'traceHardwareScreenProbesWithMotion';
    const screen = stagePass(
      'trace-screen',
      screenStage,
      trace === undefined
        ? (value) => probeCount(value) * SCREEN_PROBE_TEXELS
        : { args: trace.dispatch, offset: 0 },
    );
    if (!screen.ok) return screen;
    return ok(undefined);
  }
  const screenTrace = addScreenTrace();
  if (!screenTrace.ok) return screenTrace;
  const compactedWork = trace === undefined ? undefined : { args: trace.dispatch, offset: 12 };
  function addWorldTraceCompaction() {
    if (trace !== undefined) {
      const compact = stagePass('compact-world-traces', 'compactWorldTraces', {
        args: trace.dispatch,
        offset: 0,
      });
      if (!compact.ok) return compact;
      const args = stagePass('world-trace-args', 'prepareTraceFallbackDispatch', () => 1);
      if (!args.ok) return args;
    }
    return ok(undefined);
  }
  const worldTraceCompaction = addWorldTraceCompaction();
  if (!worldTraceCompaction.ok) return worldTraceCompaction;
  const worldHandles: Record<string, KernelGraphHandle | undefined> = {
    receiverMotion,
    ...field,
    rays,
    probesIn: probes,
    probeFrame: frame,
    traceListIn: trace?.fallback,
    rootRequests,
    ...receiver.value,
    receiverView: view,
  };
  const worldHandle = (name: string) => {
    const handle = worldHandles[name];
    if (handle === undefined) throw new Error(`screen-probe world trace has no ${name}`);
    return handle;
  };
  const worldPass = (
    label: string,
    select: (value: PreparedScreenProbe) => ScreenProbeKernel,
    work: ProbeWork = (value) => probeCount(value) * SCREEN_PROBE_TEXELS,
  ) => {
    const kernel = select(prepared);
    const worldKinds = new Map(kernel.bindings.map(([, kind, name]) => [name, kind]));
    // The world trace merges its hits into the screen-traced rays in place.
    return graph.addComputePass(`screen-probe.${label}`, {
      accesses: [
        ...kernel.bindings.map(([, kind, name]) =>
          kernelGraphAccess(kind, worldHandle(name), 'storage-read-write'),
        ),
        ...(typeof work === 'function'
          ? []
          : [{ resource: work.args, usage: 'indirect-read' as const }]),
      ],
      encodeDirect: (pass, _graphframe, resources) => {
        const value = current();
        select(value)
          .record(
            pass,
            (name) => {
              const kind = worldKinds.get(name);
              if (kind === undefined) throw new Error(`screen-probe world trace has no ${name}`);
              const bound = resolveKernelBinding(resources, kind, worldHandle(name));
              // The shared camera backing contains many View slots. Bind the
              // same main-view window as the existing Screen stages, never
              // the entire allocation to a single uniform binding.
              return name === 'receiverView' && 'buffer' in bound
                ? { buffer: bound.buffer, size: VIEW_UNIFORM_BYTES }
                : bound;
            },
            undefined,
            typeof work === 'function'
              ? work(value)
              : { buffer: resources.buffer(work.args).unwrap(), offset: work.offset },
          )
          .unwrap();
      },
    });
  };
  const roots = addWorldPreparationPasses(prepared, worldPass);
  if (!roots.ok) return roots;
  const world = worldPass('trace-world', (value) => hardwareWorld ?? value.world, compactedWork);
  if (!world.ok) return world;
  function addProbeResolve() {
    if (trace === undefined) {
      const resolved = stagePass('resolve', 'resolveProbeRays', probeCount, {
        radianceOut: radianceA,
      });
      if (!resolved.ok) return resolved;
    } else {
      const reset = stagePass('reset-trace-list', 'resetTraceList', () => 1);
      if (!reset.ok) return reset;
      for (const [label, stage, offset] of [
        ['compact-trace-fallbacks', 'compactTraceFallbacks', 0],
        ['trace-fallback-args', 'prepareTraceFallbackDispatch', undefined],
        [
          'light-trace-fallbacks',
          atlas === undefined ? 'lightTraceFallbacks' : 'lightTraceFallbacksAtlas',
          12,
        ],
        [
          'resolve',
          probeMoving === undefined ? 'scatterProbeTraces' : 'scatterProbeTracesWithMotion',
          0,
        ],
      ] as const) {
        const added = stagePass(
          label,
          stage,
          offset === undefined ? () => 1 : { args: trace.dispatch, offset },
        );
        if (!added.ok) return added;
      }
    }
    const accumulated = stagePass(
      'probe-temporal',
      trace === undefined ? 'temporalProbeRadiance' : 'temporalTraceRadiance',
      probeCount,
      { radianceIn: radianceA, radianceOut: radianceB },
    );
    if (!accumulated.ok) return accumulated;
    return ok(undefined);
  }
  const probeResolve = addProbeResolve();
  if (!probeResolve.ok) return probeResolve;
  let radiance = radianceB;
  for (let i = 0; i < prepared.profile.probes.filterPasses; i++) {
    const out = radiance === radianceA ? radianceB : radianceA;
    const filtered = stagePass(`filter-${i}`, 'filterProbeRadiance', probeCount, {
      radianceIn: radiance,
      radianceOut: out,
    });
    if (!filtered.ok) return filtered;
    radiance = out;
  }
  const preintegration = trace === undefined ? 'preintegrate' : 'preintegrateScattered';
  if (prepared.kernels[preintegration] !== undefined) {
    const scratch = radiance === radianceA ? radianceB : radianceA;
    const projected = stagePass(
      'preintegrate',
      preintegration,
      (value) =>
        probeCount(value) *
        (value.profile.probes.irradiance === 'probe-sh3' ? 9 : SCREEN_PROBE_IRRADIANCE_TEXELS),
      { probeRadiance: radiance, radianceOut: scratch },
    );
    if (!projected.ok) return projected;
    radiance = scratch;
  }
  const accumulateAo =
    shortRangeAo !== undefined && prepared.profile.probes.history?.pixel !== false;
  const temporalStage =
    pixelMoving !== undefined
      ? accumulateAo
        ? 'temporalScreenProbesWithAoAndMotion'
        : 'temporalScreenProbesWithMotion'
      : target.motionWithDepth === undefined
        ? accumulateAo
          ? 'temporalScreenProbesWithAo'
          : 'temporalScreenProbes'
        : accumulateAo
          ? 'temporalScreenProbesWithAoAndVelocity'
          : 'temporalScreenProbesWithVelocity';
  const later: (() => ReturnType<typeof stagePass>)[] = [
    () =>
      stagePass(
        prepared.profile.probes.integration === 'screen-space'
          ? 'integrate-screen-space'
          : 'integrate',
        pixelMoving === undefined
          ? 'integrateScreenProbes'
          : 'integrateScreenSpaceScreenProbesWithMotion',
        pixels,
        { probeRadiance: radiance },
      ),
    () => stagePass('temporal', temporalStage, pixels),
  ];
  function addShortRangeAoPasses() {
    if (shortRangeAo === undefined) return ok(undefined);
    let aoDepthPyramid = depthPyramid;
    if (aoMode === 'half-scalar') {
      const texture = graph.createTexture('screen-probe.ao-furthest-depth', {
        format: 'r32float',
        size: { width: aoWidth, height: aoHeight },
      });
      if (!texture.ok) return texture;
      const view = graph.view(texture.value);
      if (!view.ok) return view;
      const seed = stagePass(
        'short-range-ao-depth',
        'seedScreenProbeFurthestDepth',
        () => aoPixels,
        {
          shortRangeAoFurthestDepthOut: view.value,
        },
      );
      if (!seed.ok) return seed;
      aoDepthPyramid = view.value;
    }
    return stagePass('short-range-ao', 'computeScreenProbeShortRangeAo', () => aoPixels, {
      depthPyramid: aoDepthPyramid,
    });
  }
  const ao = addShortRangeAoPasses();
  if (!ao.ok) return ao;
  for (const step of later) {
    const added = step();
    if (!added.ok) return added;
  }
  function addProbeOutput() {
    if (shortRangeAo !== undefined) {
      const stage = target.compactGbuffer
        ? accumulateAo
          ? 'applyScreenProbeAoHistoryCompact'
          : 'applyScreenProbeShortRangeAoCompact'
        : accumulateAo
          ? 'applyScreenProbeAoHistory'
          : 'applyScreenProbeShortRangeAo';
      const occluded = stagePass('apply-short-range-ao', stage, pixels, {
        integrated: historyOut,
        integratedOut: integrated,
        ...(accumulateAo ? { metaIn: metaOut } : {}),
      });
      if (!occluded.ok) return occluded;
    }
    // All reads of the previous scene are complete. One-bounce transport must
    // retain this frame's direct scene, before diffuse GI is added to it.
    const historyStage =
      target.reflection === undefined ? 'copySceneHistory' : 'copyDiffuseSceneHistory';
    if (!prepared.profile.field.radiosity) {
      const copied = stagePass('scene-history', historyStage, pixels);
      if (!copied.ok) return copied;
    }
    const composited = addRayDiffuseCompositePass(
      graph,
      'screen-probe.composite',
      () => current().field.composite,
      target,
      shortRangeAo === undefined ? historyOut : integrated,
      pixelCount,
    );
    if (!composited.ok) return composited;
    // Multiple-bounce transport retains the lit HDR scene, including diffuse GI,
    // matching the previous-frame scene color feedback used by Lumen.
    if (prepared.profile.field.radiosity) {
      const copied = stagePass('scene-history', historyStage, pixels);
      if (!copied.ok) return copied;
    }
    if (previousScreenDepth !== undefined) {
      const copied = stagePass('screen-depth-history', 'copyScreenTraceDepth', pixels);
      if (!copied.ok) return copied;
    }
    return ok(undefined);
  }
  return addProbeOutput();
}
