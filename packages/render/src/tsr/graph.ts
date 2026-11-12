import type {
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, Sampler } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import {
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuWrite,
  type TemporalGpuState,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import type { TypedTemporalResolveTargets } from '../typed-render-graph-primitives';
import { recordContext } from '../world/view-record-context';
import { TSR_ANALYSIS_FORMATS } from './layout';
import { createTsrProgram, createTsrRasterProgram } from './program';

function stateOf(frame: RenderPipelineFrame): TemporalGpuState {
  const internal = frame as _InternalRenderPipelineContext;
  return getTemporalGpuState(
    internal.frameState,
    frame.runtime.device,
    recordContext(internal.runtime).deviceScope,
    frame.targetW,
    frame.targetH,
    false,
    frame.camera,
  );
}

function analysisTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  kind: 'guide' | 'moire',
  role: 'read' | 'write',
  width: number,
  height: number,
  compute: boolean,
): Result<RenderPipelineTarget, RenderGraphError> {
  const label = `tsr-${kind}-${role}`;
  const surface = (frame: RenderPipelineFrame) => {
    const state = stateOf(frame);
    if (state.tsr === undefined) throw new Error('TSR analysis history is not admitted');
    return state.tsr[kind][role === 'read' ? temporalReadIndex(state) : temporalWriteIndex(state)];
  };
  const texture = graph.importTexture(
    label,
    {
      format: TSR_ANALYSIS_FORMATS[kind],
      size: { width, height },
      usage:
        GPU_TEXTURE_USAGE_COPY_SRC |
        (compute ? GPU_TEXTURE_USAGE_STORAGE_BINDING : GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    },
    (frame) => surface(frame).texture,
  );
  if (!texture.ok) return texture;
  const view = graph.importView(
    texture.value,
    { dimension: '2d', label: `${label}.view` },
    (frame) => surface(frame).view,
  );
  if (!view.ok) return view;
  return ok({
    texture: texture.value,
    view: view.value,
    format: TSR_ANALYSIS_FORMATS[kind],
    sampleCount: 1,
  });
}

function parameters(
  frame: RenderPipelineFrame,
  state: TemporalGpuState,
  hasSecondary: boolean,
  hasCoverage: boolean,
) {
  const view = frame.camera.temporal;
  const width = view?.input.internalWidth ?? frame.targetW;
  const height = view?.input.internalHeight ?? frame.targetH;
  const internal = frame as _InternalRenderPipelineContext;
  const previous = internal.frameState.temporalView.accepted;
  const bytes = new ArrayBuffer(64);
  const floats = new Float32Array(bytes);
  const words = new Uint32Array(bytes);
  floats.set([
    ...(view?.currentJitterUv ?? [0, 0]),
    ...(previous?.currentJitterUv ?? [0, 0]),
    width,
    height,
    state.tsr?.inputWidth ?? width,
    state.tsr?.inputHeight ?? height,
  ]);
  words[8] = Number(state.valid && view?.historyValid === true);
  words[9] = Number(
    words[8] === 1 && state.tsr?.inputWidth === width && state.tsr?.inputHeight === height,
  );
  words[10] = view?.temporalFrameIndex ?? 0;
  words[11] = Number(hasSecondary);
  words[12] = Number(hasCoverage);
  floats[13] = Math.max(
    0.001,
    Math.min(0.25, (view?.sampleTimeSeconds ?? 1 / 60) - (previous?.sampleTimeSeconds ?? 0)),
  );
  const buffer = getTemporalParamsBuffer(state);
  const written = frame.runtime.device.queue.writeBuffer(buffer, 0, new Uint8Array(bytes));
  if (!written.ok) throw written.error;
  return { buffer, width, height };
}

/** Declare independent input-domain analysis and output-domain reconstruction in one graph. */
export function addTsrPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTemporalResolveTargets,
  opaqueGuide: RenderPipelineTarget,
  capacity: { readonly width: number; readonly height: number },
  compute = true,
): Result<void, RenderGraphError> {
  const guideRead = analysisTarget(
    graph,
    'guide',
    'read',
    capacity.width,
    capacity.height,
    compute,
  );
  if (!guideRead.ok) return guideRead;
  const guideWrite = analysisTarget(
    graph,
    'guide',
    'write',
    capacity.width,
    capacity.height,
    compute,
  );
  if (!guideWrite.ok) return guideWrite;
  const moireRead = analysisTarget(
    graph,
    'moire',
    'read',
    capacity.width,
    capacity.height,
    compute,
  );
  if (!moireRead.ok) return moireRead;
  const moireWrite = analysisTarget(
    graph,
    'moire',
    'write',
    capacity.width,
    capacity.height,
    compute,
  );
  if (!moireWrite.ok) return moireWrite;
  const decision = createRenderPipelineTarget(graph, 'tsr-rejection', {
    format: TSR_ANALYSIS_FORMATS.decision,
    size: { width: capacity.width, height: capacity.height },
  });
  if (!decision.ok) return decision;
  const analysisReads = [
    targets.scene,
    targets.currentTemporal,
    guideRead.value,
    moireRead.value,
    targets.historyTemporal,
    opaqueGuide,
    targets.coverage ?? targets.currentTemporal,
  ];
  const secondary = targets.secondaryReactivity?.view ?? targets.currentTemporal.view;
  const reconstructionReads = [
    targets.scene.view,
    targets.currentTemporal.view,
    targets.historyColor.view,
    targets.historyTemporal.view,
    targets.historyStability.view,
    decision.value.view,
    secondary,
    targets.coverage?.view ?? targets.currentTemporal.view,
  ];
  const stages = [
    {
      name: 'tsr-analyze',
      analyze: true,
      reads: analysisReads.map((t) => t.view),
      writes: [guideWrite.value, moireWrite.value, decision.value],
    },
    {
      name: 'tsr-reconstruct',
      analyze: false,
      reads: reconstructionReads,
      writes: [targets.writeColor, targets.writeTemporal, targets.writeStability],
    },
  ];
  for (const stage of stages) {
    let native: ReturnType<typeof createTsrProgram> | undefined;
    let raster: ReturnType<typeof createTsrRasterProgram> | undefined;
    const cached: { readonly keys: readonly unknown[]; readonly value: BindGroup }[] = [];
    const prepare = (
      frame: RenderPipelineFrame,
      resources: GraphResourceResolver,
      built: { readonly layout: BindGroupLayout; readonly sampler: Sampler },
    ) => {
      const state = stateOf(frame);
      const params = parameters(
        frame,
        state,
        targets.secondaryReactivity !== undefined,
        targets.coverage !== undefined,
      );
      const views = [...stage.reads, ...(compute ? stage.writes.map((t) => t.view) : [])].map(
        (view) => resources.textureView(view).unwrap(),
      );
      const keys = [state, ...views];
      let group = cached.find((c) => c.keys.every((v, i) => v === keys[i]))?.value;
      if (group === undefined) {
        const count = stage.reads.length;
        group = frame.runtime.device
          .createBindGroup({
            label: stage.name,
            layout: built.layout,
            entries: [
              ...views.slice(0, count).map((value, binding) => ({
                binding,
                resource: { kind: 'textureView' as const, value },
              })),
              { binding: count, resource: { kind: 'sampler', value: built.sampler } },
              {
                binding: count + 1,
                resource: { kind: 'buffer', value: { buffer: params.buffer } },
              },
              ...views.slice(count).map((value, i) => ({
                binding: count + 2 + i,
                resource: { kind: 'textureView' as const, value },
              })),
            ],
          })
          .unwrap();
        if (cached.length === 2) cached.shift();
        cached.push({ keys, value: group });
      }
      return { state, params, group };
    };
    const complete = (frame: RenderPipelineFrame, ready: ReturnType<typeof prepare>) => {
      if (stage.analyze) return;
      if (ready.state.tsr !== undefined)
        ready.state.tsr.pendingInput = [ready.params.width, ready.params.height];
      stageTemporalGpuWrite((frame as _InternalRenderPipelineContext).frameState, ready.state);
    };
    const accesses = [
      ...stage.reads.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      ...stage.writes.map((t) => ({
        resource: t.view,
        usage: compute ? ('storage-write' as const) : ('color-attachment' as const),
      })),
    ];
    const added = compute
      ? graph.addComputePass(stage.name, {
          accesses,
          encodeDirect(pass, frame, resources) {
            native ??= createTsrProgram(frame, stage.analyze);
            const ready = prepare(frame, resources, native);
            pass.setPipeline(native.pipeline);
            pass.setBindGroup(0, ready.group);
            pass.dispatchWorkgroups(
              Math.ceil((stage.analyze ? ready.params.width : frame.targetW) / 8),
              Math.ceil((stage.analyze ? ready.params.height : frame.targetH) / 8),
              1,
            );
            complete(frame, ready);
          },
        })
      : graph.addRasterPass(stage.name, {
          accesses,
          colorAttachments: stage.writes.map((t) => ({
            view: t.view,
            loadOp: 'clear',
            storeOp: 'store',
          })),
          encodeDirect(pass, frame, resources) {
            raster ??= createTsrRasterProgram(frame, stage.analyze);
            const ready = prepare(frame, resources, raster);
            pass.setPipeline(raster.pipeline);
            pass.setBindGroup(0, ready.group);
            // Analysis histories reserve max DRS capacity; only current input is evaluated.
            pass.setViewport(
              0,
              0,
              stage.analyze ? ready.params.width : frame.targetW,
              stage.analyze ? ready.params.height : frame.targetH,
              0,
              1,
            );
            pass.draw(3);
            complete(frame, ready);
          },
        });
    if (!added.ok) return added;
  }
  return ok(undefined);
}
