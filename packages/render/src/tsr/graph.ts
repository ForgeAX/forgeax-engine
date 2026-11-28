import { type Mat4, mat4 } from '@forgeax/engine-math';
import type {
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, Sampler, TextureFormat } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { cameraLensProjection } from '../camera-projection';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import {
  flickerTerms,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuWrite,
  type TemporalGpuState,
  type TsrParamsScratch,
  temporalReadIndex,
  temporalWriteIndex,
} from '../temporal/gpu';
import type { TemporalView } from '../temporal/view';
import type { TypedTemporalResolveTargets } from '../typed-render-graph-primitives';
import { recordContext } from '../world/view-record-context';
import { TSR_ANALYSIS_FORMATS, TSR_PARAMS_BYTES } from './layout';
import {
  createTsrProgram,
  createTsrRasterProgram,
  type TsrStage,
  tsrStageIsInputDomain,
  tsrStageUsesScene,
  tsrStageWorkgroupSize,
} from './program';
import { resurrectionSourceFor, resurrectionStoreDue, resurrectionStoreSlot } from './resurrection';

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

type ResurrectionKind = 'guide' | 'color' | 'stability';

/** The input extent of the frame: the dynamic-resolution input, else the output surface. */
function inputExtent(frame: RenderPipelineFrame) {
  const input = frame.camera.temporal?.input;
  return {
    width: input?.internalWidth ?? frame.targetW,
    height: input?.internalHeight ?? frame.targetH,
  };
}

/** The snapshot slot that serves this frame (UE oldest persistent frame), if any. */
function resurrectionSource(frame: RenderPipelineFrame): 0 | 1 | undefined {
  const tsr = stateOf(frame).tsr;
  return tsr === undefined
    ? undefined
    : resurrectionSourceFor(
        tsr.resurrection,
        inputExtent(frame),
        frame.camera.temporal?.historyValid !== true,
      );
}

/**
 * A persistent snapshot slot: the one the next store overwrites (an empty one, otherwise the
 * oldest), or the one this frame resurrects from. Without a source the store slot stands in; the
 * resurrection passes do not run then.
 */
function resurrectionTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  kind: ResurrectionKind,
  role: 'source' | 'store',
  format: RenderPipelineTarget['format'],
  size: 'surface' | { readonly width: number; readonly height: number },
): Result<RenderPipelineTarget, RenderGraphError> {
  const label = `tsr-resurrection-${role}-${kind}`;
  const surface = (frame: RenderPipelineFrame) => {
    const tsr = stateOf(frame).tsr;
    if (tsr === undefined) throw new Error('TSR resurrection is not admitted');
    const slot =
      (role === 'source' ? resurrectionSource(frame) : undefined) ??
      resurrectionStoreSlot(tsr.resurrection);
    return tsr.resurrection.slots[slot][kind];
  };
  const texture = graph.importTexture(
    label,
    {
      format,
      size,
      usage:
        role === 'store'
          ? GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
          : GPU_TEXTURE_USAGE_TEXTURE_BINDING,
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
  return ok({ texture: texture.value, view: view.value, format, sampleCount: 1 });
}

/** Whether this frame publishes a snapshot, and the unjittered view-projection that goes with it. */
function resurrectionStore(frame: RenderPipelineFrame) {
  const view = frame.camera.temporal;
  const tsr = stateOf(frame).tsr;
  const viewProjection = view?.currentUnjitteredViewProjection;
  if (tsr === undefined || viewProjection === undefined) return undefined;
  const reset = view?.historyValid !== true;
  if (!resurrectionStoreDue(tsr.resurrection, reset)) return undefined;
  return { tsr, viewProjection, reset, view };
}

/**
 * Publish this frame's guide, color and stability into the oldest snapshot slot every
 * TSR_RESURRECTION_INTERVAL frames (UE PersistentFrameInterval, TemporalSuperResolution.cpp:1908-1914).
 */
function addResurrectionStore(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTemporalResolveTargets,
  guideWrite: RenderPipelineTarget,
  capacity: { readonly width: number; readonly height: number },
): Result<void, RenderGraphError> {
  const guide = resurrectionTarget(graph, 'guide', 'store', TSR_ANALYSIS_FORMATS.guide, capacity);
  if (!guide.ok) return guide;
  const color = resurrectionTarget(graph, 'color', 'store', targets.writeColor.format, 'surface');
  if (!color.ok) return color;
  const stability = resurrectionTarget(
    graph,
    'stability',
    'store',
    targets.writeStability.format,
    'surface',
  );
  if (!stability.ok) return stability;
  // The guide lives on the input lattice; color and stability on the output surface.
  const pairs = [
    [guideWrite, guide.value, 'input'],
    [targets.writeColor, color.value, 'output'],
    [targets.writeStability, stability.value, 'output'],
  ] as const;
  const added = graph.addCopyPass('tsr-resurrection-store', {
    accesses: pairs.flatMap(([source, destination]) => [
      { resource: source.view, usage: 'copy-src' as const },
      { resource: destination.view, usage: 'copy-dst' as const },
    ]),
    executeIf: (frame) => resurrectionStore(frame) !== undefined,
    encodeDirect(encoder, frame, resources) {
      const store = resurrectionStore(frame);
      if (store === undefined) return;
      const width = store.view?.input.internalWidth ?? frame.targetW;
      const height = store.view?.input.internalHeight ?? frame.targetH;
      for (const [source, destination, lattice] of pairs)
        encoder.copyTextureToTexture(
          { texture: resources.texture(source.texture).unwrap() },
          { texture: resources.texture(destination.texture).unwrap() },
          lattice === 'input'
            ? { width, height, depthOrArrayLayers: 1 }
            : { width: frame.targetW, height: frame.targetH, depthOrArrayLayers: 1 },
        );
      store.tsr.resurrection.pending = {
        slot: resurrectionStoreSlot(store.tsr.resurrection),
        viewProjection: Float32Array.from(store.viewProjection),
        inputWidth: width,
        inputHeight: height,
        reset: store.reset,
      };
    },
  });
  return added.ok ? ok(undefined) : added;
}

/** The map from the clip of one view-projection to the clip of another, identity when either is unknown. */
function clipToClip(
  out: Mat4,
  inverse: Mat4,
  transMat: Mat4,
  current: ArrayLike<number> | undefined,
  other: ArrayLike<number> | undefined,
  translation?: readonly [number, number, number],
): Mat4 {
  mat4.identity(out);
  if (current === undefined || other === undefined) return out;
  mat4.invert(inverse, current);
  if (translation !== undefined) {
    mat4.fromTranslation(transMat, translation);
    mat4.multiply(inverse, transMat, inverse);
  }
  return mat4.multiply(out, other, inverse);
}

/** UE ClipToResurrectionClip and whether a snapshot can serve this frame (resurrection.ts). */
function writeResurrectionTerms(
  floats: Float32Array,
  words: Uint32Array,
  scratch: TsrParamsScratch,
  view: TemporalView | undefined,
  state: TemporalGpuState,
  input: { readonly width: number; readonly height: number },
): void {
  const resurrection = state.tsr?.resurrection;
  const source =
    resurrection === undefined
      ? undefined
      : resurrectionSourceFor(resurrection, input, view?.historyValid !== true);
  if (resurrection === undefined || source === undefined) return;
  floats.set(
    clipToClip(
      scratch.matB,
      scratch.matC,
      scratch.matD,
      view?.currentUnjitteredViewProjection,
      resurrection.slots[source].viewProjection,
    ),
    60,
  );
  words[76] = 1;
}

/** UE WorldDepthToPixelWorldRadius (SceneView.cpp:2680-2685): pixel radius = x * depth + y. */
function writeDepthModel(
  floats: Float32Array,
  frame: RenderPipelineFrame,
  projection: Mat4,
  width: number,
): void {
  const halfExtent = 1 / (projection[0] || 1);
  const orthographic = frame.camera.projection === 'orthographic';
  floats[16] = orthographic ? 0 : halfExtent / width;
  floats[17] = orthographic ? halfExtent / width : 0;
  floats[18] = orthographic ? frame.camera.far : 0;
}

function writeFlickerTerms(
  floats: Float32Array,
  frame: RenderPipelineFrame,
  previousSampleTime: number | undefined,
  width: number,
): void {
  const sampleTime = frame.camera.temporal?.sampleTimeSeconds ?? 1 / 60;
  const deltaSeconds = Math.max(0.001, Math.min(0.25, sampleTime - (previousSampleTime ?? 0)));
  floats[13] = deltaSeconds;
  const flicker = flickerTerms(deltaSeconds, width);
  floats[20] = flicker.invThreshold;
  floats[21] = flicker.invMaxParallax;
  // The Standard output stage applies the camera exposure after TSR (UE accumulates exposed color).
  floats[22] = frame.camera.exposure;
}

function writeClipTerms(
  floats: Float32Array,
  scratch: TsrParamsScratch,
  view: TemporalView | undefined,
  projection: Mat4,
): void {
  const now = view?.currentCameraPosition ?? [0, 0, 0];
  const then = view?.previousCameraPosition ?? now;
  floats.set(
    clipToClip(
      scratch.matB,
      scratch.matC,
      scratch.matD,
      view?.currentUnjitteredViewProjection,
      view?.previousUnjitteredViewProjection,
    ),
    24,
  );
  floats.set(
    clipToClip(
      scratch.matB,
      scratch.matC,
      scratch.matD,
      view?.currentUnjitteredViewProjection,
      view?.previousUnjitteredViewProjection,
      [then[0] - now[0], then[1] - now[1], then[2] - now[2]],
    ),
    40,
  );
  floats[56] = projection[10] ?? 0;
  floats[57] = projection[14] ?? 0;
  floats[58] = projection[11] ?? 0;
  floats[59] = projection[15] ?? 1;
}

function fallbackScratch(): TsrParamsScratch {
  const bytes = new ArrayBuffer(TSR_PARAMS_BYTES);
  return {
    bytes,
    floats: new Float32Array(bytes),
    words: new Uint32Array(bytes),
    u8: new Uint8Array(bytes),
    matA: mat4.create(),
    matB: mat4.create(),
    matC: mat4.create(),
    matD: mat4.create(),
    uploadedFrame: undefined,
    uploadedWidth: 0,
    uploadedHeight: 0,
  };
}

/** Populate and upload TsrParams once per frame using zero-allocation scratch storage. */
function parameters(
  frame: RenderPipelineFrame,
  state: TemporalGpuState,
  hasSecondary: boolean,
  hasCoverage: boolean,
) {
  const buffer = getTemporalParamsBuffer(state);
  const scratch = state.tsr?.paramsScratch;
  if (scratch !== undefined && scratch.uploadedFrame === frame) {
    return { buffer, width: scratch.uploadedWidth, height: scratch.uploadedHeight };
  }
  const active = scratch ?? fallbackScratch();
  const { floats, words, u8 } = active;
  u8.fill(0);
  const view = frame.camera.temporal;
  const width = view?.input.internalWidth ?? frame.targetW;
  const height = view?.input.internalHeight ?? frame.targetH;
  const internal = frame as _InternalRenderPipelineContext;
  const previous = internal.frameState.temporalView.accepted;
  floats[0] = view?.currentJitterUv?.[0] ?? 0;
  floats[1] = view?.currentJitterUv?.[1] ?? 0;
  floats[2] = previous?.currentJitterUv?.[0] ?? 0;
  floats[3] = previous?.currentJitterUv?.[1] ?? 0;
  floats[4] = width;
  floats[5] = height;
  floats[6] = state.tsr?.inputWidth ?? width;
  floats[7] = state.tsr?.inputHeight ?? height;
  words[8] = Number(state.valid && view?.historyValid === true);
  words[9] = Number(
    words[8] === 1 && state.tsr?.inputWidth === width && state.tsr?.inputHeight === height,
  );
  words[10] = view?.temporalFrameIndex ?? 0;
  words[11] = Number(hasSecondary);
  words[12] = Number(hasCoverage);
  floats[14] = frame.targetW;
  floats[15] = frame.targetH;
  const projection = cameraLensProjection(frame.camera, active.matA);
  writeDepthModel(floats, frame, projection, width);
  writeFlickerTerms(floats, frame, previous?.sampleTimeSeconds, width);
  writeClipTerms(floats, active, view, projection);
  writeResurrectionTerms(floats, words, active, view, state, { width, height });
  const written = frame.runtime.device.queue.writeBuffer(buffer, 0, u8);
  if (!written.ok) throw written.error;
  if (scratch !== undefined) {
    scratch.uploadedFrame = frame;
    scratch.uploadedWidth = width;
    scratch.uploadedHeight = height;
  }
  return { buffer, width, height };
}

interface TransientSpec {
  readonly label: string;
  readonly format: TextureFormat;
}

const CORE_TRANSIENTS = {
  dilated: { label: 'tsr-dilated', format: TSR_ANALYSIS_FORMATS.dilated },
  dilateEdge: { label: 'tsr-dilate-edge', format: TSR_ANALYSIS_FORMATS.dilateEdge },
  decimate: { label: 'tsr-decimate', format: TSR_ANALYSIS_FORMATS.decimate },
  inputGcs: { label: 'tsr-input-gcs', format: 'rgba16float' },
  historyGcs: { label: 'tsr-reprojected-gcs', format: 'rgba16float' },
  resurrected: { label: 'tsr-resurrected', format: 'rgba16float' },
  spatial: { label: 'tsr-spatial', format: TSR_ANALYSIS_FORMATS.spatial },
  reprojectedMoire: { label: 'tsr-reprojected-moire', format: TSR_ANALYSIS_FORMATS.moire },
  moireError: { label: 'tsr-flicker-error', format: 'rgba16float' },
} as const satisfies Record<string, TransientSpec>;

const RASTER_ONLY_TRANSIENTS = {
  clampedInput: { label: 'tsr-clamped-input', format: 'rgba16float' },
  clampedHistory: { label: 'tsr-clamped-history', format: 'rgba16float' },
  clampEnergy: { label: 'tsr-clamp-energy', format: 'rgba16float' },
  clampDelta: { label: 'tsr-clamp-delta', format: 'rgba16float' },
  resurrectedInput: { label: 'tsr-resurrected-clamped-input', format: 'rgba16float' },
  resurrectedHistory: { label: 'tsr-resurrected-clamped-history', format: 'rgba16float' },
  resurrectedEnergy: { label: 'tsr-resurrected-clamp-energy', format: 'rgba16float' },
  resurrectedDelta: { label: 'tsr-resurrected-clamp-delta', format: 'rgba16float' },
  moireField: { label: 'tsr-flicker-field', format: 'rgba16float' },
  moireRaw: { label: 'tsr-flicker-raw', format: 'rgba16float' },
  moireUpdate: { label: 'tsr-flicker-update', format: 'rgba16float' },
} as const satisfies Record<string, TransientSpec>;

type CoreTransients = Record<keyof typeof CORE_TRANSIENTS, RenderPipelineTarget>;
type RasterTransients = Record<keyof typeof RASTER_ONLY_TRANSIENTS, RenderPipelineTarget>;

function createTransientGroup<T extends Record<string, TransientSpec>>(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  specs: T,
  capacity: { readonly width: number; readonly height: number },
): Result<Record<keyof T, RenderPipelineTarget>, RenderGraphError> {
  const targets: Partial<Record<keyof T, RenderPipelineTarget>> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const target = createRenderPipelineTarget(graph, spec.label, {
      format: spec.format,
      size: { width: capacity.width, height: capacity.height },
    });
    if (!target.ok) return target;
    targets[name as keyof T] = target.value;
  }
  return ok(targets as Record<keyof T, RenderPipelineTarget>);
}

interface TsrStageDeclaration {
  readonly name: string;
  readonly stage: TsrStage;
  readonly reads: readonly RenderPipelineTarget['view'][];
  readonly writes: readonly RenderPipelineTarget[];
  readonly executeIf?: (frame: RenderPipelineFrame) => boolean;
}

/** One staged TSR pass: bind group preparation plus the compute or raster encoder. */
function addTsrStage(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  stage: TsrStageDeclaration,
  targets: TypedTemporalResolveTargets,
  sceneVelocity: TypedTemporalResolveTargets['sceneVelocity'],
  compute: boolean,
): Result<void, RenderGraphError> {
  const inputDomain = tsrStageIsInputDomain(stage.stage);
  const wgSize = tsrStageWorkgroupSize(stage.stage);
  const velocitySource = tsrStageUsesScene(stage.stage) ? sceneVelocity : undefined;
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
    const depth =
      velocitySource === undefined
        ? undefined
        : resources.textureView(velocitySource.depth).unwrap();
    const view =
      velocitySource === undefined ? undefined : resources.buffer(velocitySource.view).unwrap();
    const keys = [state, ...views, depth, view];
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
            ...(depth === undefined || view === undefined
              ? []
              : [
                  { binding: 17, resource: { kind: 'textureView' as const, value: depth } },
                  {
                    binding: 18,
                    resource: {
                      kind: 'buffer' as const,
                      value: { buffer: view, size: VIEW_UNIFORM_BYTES },
                    },
                  },
                ]),
          ],
        })
        .unwrap();
      if (cached.length === 2) cached.shift();
      cached.push({ keys, value: group });
    }
    return { state, params, group };
  };
  const complete = (frame: RenderPipelineFrame, ready: ReturnType<typeof prepare>) => {
    if (stage.stage !== 'reconstruct') return;
    if (ready.state.tsr !== undefined)
      ready.state.tsr.pendingInput = [ready.params.width, ready.params.height];
    stageTemporalGpuWrite((frame as _InternalRenderPipelineContext).frameState, ready.state);
  };
  const accesses = [
    ...stage.reads.map((resource) => ({ resource, usage: 'sampled-read' as const })),
    ...(velocitySource === undefined
      ? []
      : [
          { resource: velocitySource.depth, usage: 'sampled-read' as const },
          { resource: velocitySource.view, usage: 'uniform-read' as const },
        ]),
    ...stage.writes.map((t) => ({
      resource: t.view,
      usage: compute ? ('storage-write' as const) : ('color-attachment' as const),
    })),
  ];
  const added = compute
    ? graph.addComputePass(stage.name, {
        accesses,
        executeIf: stage.executeIf,
        encodeDirect(pass, frame, resources) {
          native ??= createTsrProgram(
            frame,
            stage.stage,
            sceneVelocity !== undefined,
            stage.stage === 'reconstruct' && stage.writes.length > 3,
          );
          const ready = prepare(frame, resources, native);
          pass.setPipeline(native.pipeline);
          pass.setBindGroup(0, ready.group);
          pass.dispatchWorkgroups(
            Math.ceil((inputDomain ? ready.params.width : frame.targetW) / wgSize),
            Math.ceil((inputDomain ? ready.params.height : frame.targetH) / wgSize),
            1,
          );
          complete(frame, ready);
        },
      })
    : graph.addRasterPass(stage.name, {
        accesses,
        executeIf: stage.executeIf,
        colorAttachments: stage.writes.map((t) => ({
          view: t.view,
          loadOp: 'clear',
          storeOp: 'store',
        })),
        encodeDirect(pass, frame, resources) {
          raster ??= createTsrRasterProgram(frame, stage.stage, sceneVelocity !== undefined);
          const ready = prepare(frame, resources, raster);
          pass.setPipeline(raster.pipeline);
          pass.setBindGroup(0, ready.group);
          pass.setViewport(
            0,
            0,
            inputDomain ? ready.params.width : frame.targetW,
            inputDomain ? ready.params.height : frame.targetH,
            0,
            1,
          );
          pass.draw(3);
          complete(frame, ready);
        },
      });
  return added;
}

function buildRasterShadingStages(
  core: CoreTransients,
  raster: RasterTransients,
  opaqueGuide: RenderPipelineTarget,
  scene: RenderPipelineTarget,
  moireWrite: RenderPipelineTarget,
  guideWrite: RenderPipelineTarget,
  decision: RenderPipelineTarget,
  resurrects: (frame: RenderPipelineFrame) => boolean,
): TsrStageDeclaration[] {
  return [
    {
      name: 'tsr-moire-clamp',
      stage: 'moireClamp',
      reads: [opaqueGuide.view, core.reprojectedMoire.view, scene.view],
      writes: [raster.moireField],
    },
    {
      name: 'tsr-moire-measure',
      stage: 'moireMeasure',
      reads: [raster.moireField.view],
      writes: [raster.moireRaw],
    },
    {
      name: 'tsr-moire-update',
      stage: 'moireUpdate',
      reads: [raster.moireRaw.view, raster.moireField.view, core.reprojectedMoire.view],
      writes: [raster.moireUpdate],
    },
    {
      name: 'tsr-moire-history',
      stage: 'moireHistory',
      reads: [
        raster.moireUpdate.view,
        raster.moireField.view,
        core.reprojectedMoire.view,
        core.historyGcs.view,
        core.dilateEdge.view,
      ],
      writes: [moireWrite, core.moireError],
    },
    {
      name: 'tsr-clamp',
      stage: 'clamp',
      reads: [core.inputGcs.view, core.historyGcs.view],
      writes: [raster.clampedInput, raster.clampedHistory],
    },
    {
      name: 'tsr-measure',
      stage: 'measure',
      reads: [
        core.inputGcs.view,
        raster.clampedInput.view,
        raster.clampedHistory.view,
        core.moireError.view,
      ],
      writes: [raster.clampEnergy, raster.clampDelta],
    },
    {
      name: 'tsr-resurrect-clamp',
      stage: 'resurrectClamp',
      reads: [core.inputGcs.view, core.resurrected.view],
      writes: [raster.resurrectedInput, raster.resurrectedHistory],
      executeIf: resurrects,
    },
    {
      name: 'tsr-resurrect-measure',
      stage: 'resurrectMeasure',
      reads: [core.inputGcs.view, raster.resurrectedInput.view, raster.resurrectedHistory.view],
      writes: [raster.resurrectedEnergy, raster.resurrectedDelta],
      executeIf: resurrects,
    },
    {
      name: 'tsr-reject',
      stage: 'reject',
      reads: [
        core.inputGcs.view,
        core.historyGcs.view,
        raster.clampEnergy.view,
        raster.clampDelta.view,
        core.decimate.view,
        core.resurrected.view,
        raster.resurrectedEnergy.view,
        raster.resurrectedDelta.view,
      ],
      writes: [guideWrite, decision],
    },
  ];
}

function buildComputeShadingStages(
  core: CoreTransients,
  opaqueGuide: RenderPipelineTarget,
  scene: RenderPipelineTarget,
  moireWrite: RenderPipelineTarget,
  guideWrite: RenderPipelineTarget,
  decision: RenderPipelineTarget,
): TsrStageDeclaration[] {
  return [
    {
      name: 'tsr-moire',
      stage: 'moire',
      reads: [
        opaqueGuide.view,
        core.reprojectedMoire.view,
        scene.view,
        core.historyGcs.view,
        core.dilateEdge.view,
      ],
      writes: [moireWrite, core.moireError],
    },
    {
      name: 'tsr-reject',
      stage: 'rejectFused',
      reads: [
        core.inputGcs.view,
        core.historyGcs.view,
        core.moireError.view,
        core.decimate.view,
        core.resurrected.view,
      ],
      writes: [guideWrite, decision],
    },
  ];
}

function declareAnalysisAndResurrection(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTemporalResolveTargets,
  capacity: { readonly width: number; readonly height: number },
  compute: boolean,
) {
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
    size: capacity,
  });
  if (!decision.ok) return decision;
  const resurrectionGuide = resurrectionTarget(
    graph,
    'guide',
    'source',
    TSR_ANALYSIS_FORMATS.guide,
    capacity,
  );
  if (!resurrectionGuide.ok) return resurrectionGuide;
  const resurrectedColor = resurrectionTarget(
    graph,
    'color',
    'source',
    targets.writeColor.format,
    'surface',
  );
  if (!resurrectedColor.ok) return resurrectedColor;
  const resurrectedStability = resurrectionTarget(
    graph,
    'stability',
    'source',
    targets.writeStability.format,
    'surface',
  );
  if (!resurrectedStability.ok) return resurrectedStability;
  return ok({
    guideRead: guideRead.value,
    guideWrite: guideWrite.value,
    moireRead: moireRead.value,
    moireWrite: moireWrite.value,
    decision: decision.value,
    resurrectionGuide: resurrectionGuide.value,
    resurrectedColor: resurrectedColor.value,
    resurrectedStability: resurrectedStability.value,
  });
}

/** Declare independent input-domain analysis and output-domain reconstruction in one graph. */
export function addTsrPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  targets: TypedTemporalResolveTargets,
  opaqueGuide: RenderPipelineTarget,
  capacity: { readonly width: number; readonly height: number },
  compute = true,
  writeHalf?: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  const persistent = declareAnalysisAndResurrection(graph, targets, capacity, compute);
  if (!persistent.ok) return persistent;
  const {
    guideRead,
    guideWrite,
    moireRead,
    moireWrite,
    decision,
    resurrectionGuide,
    resurrectedColor,
    resurrectedStability,
  } = persistent.value;
  const coreResult = createTransientGroup(graph, CORE_TRANSIENTS, capacity);
  if (!coreResult.ok) return coreResult;
  const core = coreResult.value;
  const resurrects = (frame: RenderPipelineFrame) => resurrectionSource(frame) !== undefined;
  let shadingStages: TsrStageDeclaration[];
  if (compute) {
    shadingStages = buildComputeShadingStages(
      core,
      opaqueGuide,
      targets.scene,
      moireWrite,
      guideWrite,
      decision,
    );
  } else {
    const rasterResult = createTransientGroup(graph, RASTER_ONLY_TRANSIENTS, capacity);
    if (!rasterResult.ok) return rasterResult;
    shadingStages = buildRasterShadingStages(
      core,
      rasterResult.value,
      opaqueGuide,
      targets.scene,
      moireWrite,
      guideWrite,
      decision,
      resurrects,
    );
  }
  const { sceneVelocity } = targets;
  const temporalPlaceholder =
    sceneVelocity === undefined ? targets.currentTemporal : targets.historyTemporal;
  const stages: TsrStageDeclaration[] = [
    {
      name: 'tsr-dilate',
      stage: 'dilate',
      reads: [targets.currentTemporal.view],
      writes: [core.dilated, core.dilateEdge],
    },
    {
      name: 'tsr-analyze',
      stage: 'analyze',
      reads: [
        targets.scene.view,
        core.dilated.view,
        guideRead.view,
        moireRead.view,
        targets.historyTemporal.view,
        (targets.coverage ?? temporalPlaceholder).view,
        core.dilateEdge.view,
      ],
      writes: [core.inputGcs, core.historyGcs, core.reprojectedMoire, core.decimate],
    },
    {
      name: 'tsr-resurrect-guide',
      stage: 'resurrectGuide',
      reads: [core.dilated.view, resurrectionGuide.view],
      writes: [core.resurrected],
      executeIf: resurrects,
    },
    ...shadingStages,
    {
      name: 'tsr-spatial',
      stage: 'spatial',
      reads: [targets.scene.view, decision.view],
      writes: [core.spatial],
    },
    {
      name: 'tsr-reconstruct',
      stage: 'reconstruct',
      reads: [
        targets.scene.view,
        core.dilated.view,
        targets.historyColor.view,
        targets.historyTemporal.view,
        targets.historyStability.view,
        decision.view,
        targets.secondaryReactivity?.view ?? temporalPlaceholder.view,
        targets.coverage?.view ?? temporalPlaceholder.view,
        core.spatial.view,
        resurrectedColor.view,
        resurrectedStability.view,
        core.dilateEdge.view,
      ],
      writes: [
        targets.writeColor,
        targets.writeTemporal,
        targets.writeStability,
        ...(compute && writeHalf !== undefined ? [writeHalf] : []),
      ],
    },
  ];
  for (const stage of stages) {
    const added = addTsrStage(graph, stage, targets, sceneVelocity, compute);
    if (!added.ok) return added;
  }
  return addResurrectionStore(graph, targets, guideWrite, capacity);
}
