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
  type IrradianceFieldGraphHandles,
  irradianceFieldGraphShape,
} from './irradiance-field-graph';
import {
  type KernelGraphHandle,
  kernelGraphAccess,
  resolveKernelBinding,
} from './kernel-graph-access';
import { addRayDiffuseCompositePass } from './ray-graph-shared';
import type { PreparedScreenProbe, ScreenProbeExtent } from './renderer-screen-probe';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  type ScreenProbeSlot,
  type ScreenProbeStage,
} from './screen-probe-kernels';
import { SCREEN_PROBE_TEXELS } from './screen-probe-plan';

/** Graph identity: field topology, view extent and the filter pass count. */
export function screenProbeGraphShape(prepared: PreparedScreenProbe) {
  const layout = prepared.extent().layout;
  return [
    prepared.generation,
    irradianceFieldGraphShape(prepared.field),
    layout.width,
    layout.height,
    prepared.profile.probes.filterPasses,
  ];
}

type Handle = KernelGraphHandle;

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
  return addIrradianceFieldPasses(graph, prepared.field, target, (fieldHandles) =>
    addProbePasses(graph, prepared, target, pyramid.value, fieldHandles),
  );
}

function addProbePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedScreenProbe,
  target: RayDiffuseTargets,
  depthPyramid: GraphTextureView,
  field: IrradianceFieldGraphHandles,
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
  const fixed = (slot: keyof ScreenProbeExtent['buffers']) =>
    imported(slot, b[slot].size, (value) => value.buffers[slot].buffer);
  const probes = fixed('probes');
  const adaptiveCount = fixed('adaptiveCount');
  const tileAdaptive = fixed('tileAdaptive');
  const rays = fixed('rays');
  const radianceA = fixed('radianceA');
  const radianceB = fixed('radianceB');
  const integrated = fixed('integrated');
  const previousScene = fixed('previousScene');
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
  const base: Partial<Record<ScreenProbeSlot, Handle>> = {
    frame,
    view,
    depth: target.depth,
    normal: target.normal.view,
    depthPyramid,
    scene: target.scene.view,
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
    integratedOut: integrated,
    integrated,
    probeHistoryIn,
    probeHistoryOut,
    historyIn,
    historyOut,
    metaIn,
    metaOut,
  };
  const fieldReads: GraphAccess[] = [
    { resource: field.field as GraphBuffer, usage: 'uniform-read' },
    { resource: field.grid as GraphBuffer, usage: 'uniform-read' },
    { resource: field.visibility, usage: 'sampled-read' },
    ...(['irradiance', 'moments', 'meta'] as const).map(
      (name): GraphAccess => ({ resource: field[name] as GraphBuffer, usage: 'storage-read' }),
    ),
  ];
  const stagePass = (
    label: string,
    stage: ScreenProbeStage,
    work: (value: PreparedScreenProbe) => number,
    overrides: Partial<Record<ScreenProbeSlot, Handle>> = {},
    before?: (value: PreparedScreenProbe) => void,
  ) => {
    const handles = { ...base, ...overrides };
    const handle = (slot: ScreenProbeSlot): Handle => {
      const value = handles[slot];
      if (value === undefined) throw new Error(`screen-probe ${stage} has no ${slot} resource`);
      return value;
    };
    const slots = SCREEN_PROBE_STAGES[stage].slots as readonly ScreenProbeSlot[];
    return graph.addComputePass(`screen-probe.${label}`, {
      accesses: [
        ...slots.map((slot) =>
          kernelGraphAccess(SCREEN_PROBE_BINDINGS[slot][1], handle(slot), 'storage-read-write'),
        ),
        ...fieldReads,
      ],
      encode: ({ pass, resources }) => {
        const value = current();
        before?.(value);
        value.kernels[stage]
          .record(
            pass,
            (slot) => {
              const kind = SCREEN_PROBE_BINDINGS[slot as ScreenProbeSlot][1];
              const bound = resolveKernelBinding(resources, kind, handle(slot as ScreenProbeSlot));
              return slot === 'view' && 'buffer' in bound
                ? { buffer: bound.buffer, size: VIEW_UNIFORM_BYTES }
                : bound;
            },
            value.field.sample,
            work(value),
          )
          .unwrap();
      },
    });
  };
  const probeCount = (value: PreparedScreenProbe) => value.extent().layout.probeCount;
  const pixels = (value: PreparedScreenProbe) =>
    value.extent().layout.width * value.extent().layout.height;
  const steps: (() => ReturnType<typeof stagePass>)[] = [
    () =>
      stagePass(
        'place-uniform',
        'placeUniformProbes',
        (value) => value.extent().layout.uniformCount,
        {},
        (value) => value.writeFrame(),
      ),
    () =>
      stagePass(
        'place-adaptive',
        'placeAdaptiveProbes',
        (value) => value.extent().layout.uniformCount * 4,
      ),
    () =>
      stagePass(
        'compact-adaptive',
        'compactAdaptiveProbes',
        (value) => value.extent().layout.uniformCount * 4,
      ),
    () => stagePass('generate-rays', 'generateProbeRays', probeCount),
    () =>
      stagePass(
        'trace-screen',
        'traceScreenProbes',
        (value) => probeCount(value) * SCREEN_PROBE_TEXELS,
      ),
  ];
  for (const step of steps) {
    const added = step();
    if (!added.ok) return added;
  }
  const worldHandles: Record<string, KernelGraphHandle | undefined> = {
    ...field,
    rays,
    probesIn: probes,
    probeFrame: frame,
  };
  const worldHandle = (name: string) => {
    const handle = worldHandles[name];
    if (handle === undefined) throw new Error(`screen-probe world trace has no ${name}`);
    return handle;
  };
  const worldKinds = new Map(prepared.world.bindings.map(([, kind, name]) => [name, kind]));
  // The world trace merges its hits into the screen-traced rays in place.
  const world = graph.addComputePass('screen-probe.trace-world', {
    accesses: prepared.world.bindings.map(([, kind, name]) =>
      kernelGraphAccess(kind, worldHandle(name), 'storage-read-write'),
    ),
    encode: ({ pass, resources }) => {
      const value = current();
      value.world
        .record(
          pass,
          (name) => {
            const kind = worldKinds.get(name);
            if (kind === undefined) throw new Error(`screen-probe world trace has no ${name}`);
            return resolveKernelBinding(resources, kind, worldHandle(name));
          },
          undefined,
          probeCount(value) * SCREEN_PROBE_TEXELS,
        )
        .unwrap();
    },
  });
  if (!world.ok) return world;
  const resolved = stagePass('resolve', 'resolveProbeRays', probeCount, { radianceOut: radianceA });
  if (!resolved.ok) return resolved;
  const accumulated = stagePass('probe-temporal', 'temporalProbeRadiance', probeCount, {
    radianceIn: radianceA,
    radianceOut: radianceB,
  });
  if (!accumulated.ok) return accumulated;
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
  const later: (() => ReturnType<typeof stagePass>)[] = [
    () => stagePass('integrate', 'integrateScreenProbes', pixels, { probeRadiance: radiance }),
    () => stagePass('temporal', 'temporalScreenProbes', pixels),
  ];
  for (const step of later) {
    const added = step();
    if (!added.ok) return added;
  }
  const reflectionResponse =
    prepared.profile.reflections === undefined ? undefined : target.reflection?.response.view;
  const composited = addRayDiffuseCompositePass(
    graph,
    'screen-probe.composite',
    () => current().field.composite,
    target,
    historyOut,
    view,
    pixelCount,
    reflectionResponse,
  );
  if (!composited.ok) return composited;
  // The lit HDR scene (direct + this frame's GI) is the next frame's screen
  // trace radiance, matching UE's previous-frame scene color feedback.
  const copied = stagePass('scene-history', 'copySceneHistory', pixels);
  if (!copied.ok) return copied;
  return ok(undefined);
}
