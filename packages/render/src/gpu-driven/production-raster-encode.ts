import type { GraphBuffer, GraphResourceResolver } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  Buffer,
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RenderPipeline,
  RhiDevice,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { bindMeshVertexStreams, meshVertexStreamsForPipeline } from '../device/mesh-vertex-streams';
import { viewForPipeline } from '../environment/bindings';
import { materialLayoutSlotKey, standardPipelineMaterialLayoutIndex } from '../pbr-pipeline';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import {
  bindRasterOffset,
  EMPTY_GEOMETRY_OFFSETS,
  rasterMaterialOffset,
} from '../record/geometry-bind-offsets';
import {
  type PrimitiveReflection,
  samePrimitiveReflection,
} from '../reflection/primitive-bindings';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineGpuDrivenFilter,
} from '../render-pipeline';
import { batchLevelStride, batchLodLevelCount } from './batch-layout';
import type { LiveRasterBatch, LiveRasterCache } from './live-raster';
import {
  type PreparedRasterBindings,
  type PreparedRasterBundleCache,
  type PreparedRasterCounters,
  type PreparedRasterPass,
  prepareRasterWindows,
} from './prepared-raster-bundle';
import {
  isSingleLayerMediumArtifact,
  type ProjectedRasterClass,
} from './production-raster-classes';
import type { ProjectedRasterGraph } from './production-raster-frame';
import type { RasterMeshBinding } from './raster-mesh-bindings';
import { pipelineRasterWindow } from './raster-window-layout';
import type {
  FixedRasterInputs,
  RasterRunRecording,
  RetainedPassEncode,
  RetainedRasterBlock,
  runFacts,
} from './retained-raster-encode';
import type { GpuDrivenView, ViewStorageTarget } from './view-gpu';

function requireViewSkinTask(view: GpuDrivenView) {
  const task = view.skinTaskBinding();
  if (task === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'actual GPU view Skin task output',
      hint: 'prepare the fixed Skin frame before recording this selected view',
    });
  return task;
}

/**
 * The bindings one indirect encode has already set on its pass. Without a
 * bundle descriptor every change is set directly on the pass; with one, the
 * same physical closure is recorded into stable-ID bundle blocks instead.
 * `setPipeline` preserves logical bindings; their actual handles and dynamic
 * offsets still select any required replacement.
 */
export class IndirectPassBindings {
  private boundPipeline: RenderPipeline | undefined;
  private material: BindGroup | undefined;
  private materialOffset: number | undefined;
  private offsetWords?: Uint32Array;
  private mesh: BindGroup | undefined;
  private deformation: 'rigid' | 'skin' | undefined;
  private boundSkinOffset: number | undefined;
  private skinOffsets: number[] | undefined;
  private visible: BindGroup | undefined;
  private vertexKey: GraphBuffer | Buffer | undefined;
  private indexKey: GraphBuffer | Buffer | undefined;
  private indexFormat: MeshGpuHandles['indexFormat'] | undefined;
  private physicalVertex: Buffer | undefined;
  private physicalVertexStreams: MeshGpuHandles['vertexStreams'];
  private physicalIndex: Buffer | undefined;
  /** The current batch's index binding; undefined for a non-indexed mesh. */
  private drawIndex: Buffer | undefined;
  private drawIndexFormat: MeshGpuHandles['indexFormat'] = 'uint32';
  /** Stock recording resolves the rigid cluster group once per encode. */
  private indirectBuffer: Buffer | undefined;
  private readonly bundles: RenderBundle[] = [];
  private bundleBlock = -1;
  private bundleGroup: number | undefined;
  private bundleOwner: LiveRasterBatch | undefined;
  private recording: ReturnType<PreparedRasterBundleCache['begin']> | undefined;
  /** The retained run being recorded; its bundle is attached when flushed. */
  private run: RasterRunRecording | undefined;
  /** Filled completely before each observation; only changed commands take a snapshot. */
  private readonly observed = {} as {
    -readonly [K in keyof PreparedRasterBindings]: PreparedRasterBindings[K];
  };

  constructor(
    private readonly encoder: RhiRenderPassEncoder | undefined,
    private readonly viewBindGroup: BindGroup,
    private readonly descriptor: RenderBundleEncoderDescriptor | undefined,
    private readonly bundlePass: PreparedRasterPass | undefined,
    private readonly viewOffset: number,
    private readonly preparation?: {
      readonly current: () => boolean;
      readonly receipts: (() => boolean)[];
    },
  ) {}

  private get pass(): RhiRenderPassEncoder {
    if (this.encoder === undefined) throw new Error('Native bundle preparation has no render pass');
    return this.encoder;
  }

  /** No descriptor: commands go straight to the pass. */
  get direct(): boolean {
    return this.descriptor === undefined;
  }

  /** The pipeline of the batch being recorded. */
  get pipeline(): RenderPipeline {
    if (this.boundPipeline === undefined) throw new Error('Missing prepared pipeline');
    return this.boundPipeline;
  }

  get hasIndirect(): boolean {
    return this.indirectBuffer !== undefined;
  }

  /** The graph's indirect argument buffer, resolved once per encode. */
  get indirect(): Buffer {
    if (this.indirectBuffer === undefined) throw new Error('Missing prepared indirect buffer');
    return this.indirectBuffer;
  }

  set indirect(buffer: Buffer) {
    this.indirectBuffer = buffer;
  }

  private projectedView?: BindGroup;

  /** Raw encodes publish the caller's base binding before selecting any draws. */
  bindInitialView(): void {
    this.pass.setBindGroup(0, this.viewBindGroup, [this.viewOffset]);
    this.projectedView = this.viewBindGroup;
  }

  bindPipeline(pipeline: RenderPipeline, device: RhiDevice): void {
    if (this.boundPipeline === pipeline) return;
    const previous = this.projectedView;
    this.projectedView = viewForPipeline(device, pipeline, this.viewBindGroup);
    if (this.direct) {
      this.pass.setPipeline(pipeline);
      if (previous !== this.projectedView)
        bindRasterOffset(
          this.pass,
          0,
          this.projectedView,
          this.viewOffset,
          this.wordsFor(this.viewOffset),
        );
    }
    this.boundPipeline = pipeline;
  }

  private wordsFor(offset: number | undefined): Uint32Array | undefined {
    if (offset !== undefined && offset !== 0) this.offsetWords ??= new Uint32Array(1);
    return this.offsetWords;
  }

  bindMaterial(group: BindGroup, offset: number | undefined): void {
    if (this.material === group && this.materialOffset === offset) return;
    if (this.direct) bindRasterOffset(this.pass, 1, group, offset, this.wordsFor(offset));
    this.material = group;
    this.materialOffset = offset;
  }

  /**
   * A retained run is the contiguous stable-ID block one bundle covers: close
   * the open bundle so the run starts its own.
   */
  startRun(): void {
    this.flush();
    this.bundleBlock = -1;
    this.run = undefined;
  }

  /**
   * Replay a retained run's bundle without visiting its batches; the reused
   * prepared bundle counts as a hit without rebuilding it.
   */
  replayRun(block: RetainedRasterBlock, counters: PreparedRasterCounters): void {
    if (block.bundle === undefined) return;
    this.bundles.push(block.bundle);
    counters.hits++;
  }

  recordRun(block: RasterRunRecording): void {
    this.run = block;
  }

  /** The material slot owner the recorded run resolved. */
  observeRunMaterial(
    slot: number,
    group: BindGroup,
    offset: number | undefined,
    program: string,
    reflection: PrimitiveReflection | undefined,
    uniformRequired?: boolean,
  ): void {
    const run = this.run;
    if (run === undefined) return;
    const prior = run.materials.get(slot);
    if (
      prior !== undefined &&
      (prior.program !== program ||
        prior.uniformRequired !== uniformRequired ||
        prior.group !== group ||
        prior.offset !== offset ||
        !samePrimitiveReflection(prior.reflection, reflection))
    )
      run.materialConflict = true;
    run.materials.set(slot, { group, offset, program, reflection, uniformRequired });
  }

  /** Current pass identities already witness Skin buffers, ranges and offsets. */
  observeRunClass(
    rasterClass: ProjectedRasterClass,
    pipeline: RenderPipeline,
    mesh: BindGroup,
  ): void {
    const run = this.run;
    if (run === undefined) return;
    run.classes.set(rasterClass, { pipeline, mesh });
  }

  countRunDraw(): void {
    if (this.run !== undefined) this.run.draws += 1;
  }

  bindMesh(group: BindGroup, deformation: 'rigid' | 'skin', view: GpuDrivenView): void {
    const offset = deformation === 'skin' ? requireViewSkinTask(view).auxiliaryOffset : undefined;
    if (this.mesh === group && this.deformation === deformation && this.boundSkinOffset === offset)
      return;
    if (this.direct) this.pass.setBindGroup(2, group, this.meshOffsets(offset));
    this.mesh = group;
    this.deformation = deformation;
    this.boundSkinOffset = offset;
  }

  // A direct command reads synchronously; retained recordings take their own offset snapshot.
  private meshOffsets(skinOffset: number | undefined): readonly number[] {
    if (skinOffset === undefined) return EMPTY_GEOMETRY_OFFSETS;
    this.skinOffsets ??= [0];
    const words = this.skinOffsets;
    words[0] = skinOffset;
    return words;
  }

  /** Stock recording binds live residency-owned meshes like direct draws. */
  bindRecordedGeometry(
    binding: RasterMeshBinding,
    indexFormat: MeshGpuHandles['indexFormat'],
  ): void {
    const vertex = binding.vertex;
    const streams = meshVertexStreamsForPipeline(this.pipeline, binding.mesh.vertexStreams);
    if (
      vertex !== undefined &&
      (this.vertexKey !== vertex || this.physicalVertexStreams !== streams)
    )
      this.setVertex(vertex, vertex, streams);
    const index = binding.index;
    if (index !== undefined && (this.indexKey !== index || this.indexFormat !== indexFormat))
      this.setIndex(index, index, indexFormat);
    this.drawIndex = index === undefined ? undefined : this.physicalIndex;
    this.drawIndexFormat = indexFormat;
  }

  /** Raw projections resolve the graph imports of their compiled class. */
  bindGraphGeometry(
    vertex: GraphBuffer | undefined,
    index: GraphBuffer | undefined,
    indexFormat: MeshGpuHandles['indexFormat'],
    resources: GraphResourceResolver,
    meshStreams: MeshGpuHandles['vertexStreams'],
  ): void {
    const streams = meshVertexStreamsForPipeline(this.pipeline, meshStreams);
    if (
      vertex !== undefined &&
      (this.vertexKey !== vertex || this.physicalVertexStreams !== streams)
    )
      this.setVertex(vertex, resources.buffer(vertex).unwrap(), streams);
    if (index !== undefined && this.indexKey !== index)
      this.setIndex(index, resources.buffer(index).unwrap(), indexFormat);
    this.drawIndex = index === undefined ? undefined : this.physicalIndex;
    this.drawIndexFormat = indexFormat;
  }

  private setVertex(
    key: GraphBuffer | Buffer,
    vertex: Buffer,
    streams: MeshGpuHandles['vertexStreams'],
  ): void {
    this.physicalVertex = vertex;
    this.physicalVertexStreams = streams;
    if (this.direct) bindMeshVertexStreams(this.pass, vertex, streams);
    this.vertexKey = key;
  }

  private setIndex(
    key: GraphBuffer | Buffer,
    index: Buffer,
    indexFormat: MeshGpuHandles['indexFormat'],
  ): void {
    this.physicalIndex = index;
    if (this.direct) this.pass.setIndexBuffer(index, indexFormat);
    this.indexKey = key;
    this.indexFormat = indexFormat;
  }

  drawIndirect(window: BindGroup, indirect: Buffer, commandOffset: number, indexed: boolean): void {
    if (!this.direct) return;
    if (this.visible !== window) {
      this.pass.setBindGroup(3, window);
      this.visible = window;
    }
    if (indexed) this.pass.drawIndexedIndirect(indirect, commandOffset);
    else this.pass.drawIndirect(indirect, commandOffset);
  }

  /**
   * Record the batch's complete command closure. Contiguous stable-ID blocks
   * bound rebuilding to at most 32 batches while sharing state and reducing
   * native execute overhead.
   */
  recordBundle(
    live: LiveRasterBatch,
    windows: readonly BindGroup[],
    indirectOffset: number,
    view: GpuDrivenView,
    device: RhiDevice,
    counters: PreparedRasterCounters,
  ): void {
    const bundlePass = this.bundlePass;
    if (this.descriptor === undefined || bundlePass === undefined) return;
    const vertex = this.physicalVertex;
    if (vertex === undefined) throw new Error('Missing prepared vertex buffer');
    const block = Math.floor(live.batch.batchId / 32);
    const group = live.batch.key.residencyGroup;
    if (this.bundleBlock !== block || this.bundleGroup !== group) this.flush();
    this.bundleBlock = block;
    this.bundleGroup = group;
    this.bundleOwner ??= live;
    if (this.bundleOwner !== live) live.bundles.retire(bundlePass, counters);
    this.recording ??= this.bundleOwner.bundles.begin(
      bundlePass,
      device,
      counters,
      this.preparation?.current,
    );
    this.observeBindings(live, vertex, windows, indirectOffset, view);
    this.recording.push(this.observed);
  }

  private observeBindings(
    live: LiveRasterBatch,
    vertex: Buffer,
    windows: readonly BindGroup[],
    indirectOffset: number,
    view: GpuDrivenView,
  ): void {
    const observed = this.observed;
    const { material, mesh, deformation } = this;
    if (material === undefined || mesh === undefined || deformation === undefined)
      throw new Error('Missing prepared material or mesh binding');
    observed.pipeline = this.pipeline;
    observed.view = this.projectedView ?? this.viewBindGroup;
    observed.viewOffset = this.viewOffset;
    observed.material = material;
    observed.materialOffset = this.materialOffset;
    observed.mesh = mesh;
    observed.meshOffsets = this.meshOffsets(
      deformation === 'skin' ? requireViewSkinTask(view).auxiliaryOffset : undefined,
    );
    observed.vertex = vertex;
    observed.vertexStreams = this.physicalVertexStreams;
    observed.index = this.drawIndex;
    observed.indexFormat = this.drawIndexFormat;
    observed.indirect = this.indirect;
    observed.indirectOffset = indirectOffset;
    observed.indexed = live.batch.key.drawKind === 'indexed';
    observed.windows = windows;
  }

  private flush(): void {
    if (
      this.descriptor !== undefined &&
      this.bundlePass !== undefined &&
      this.bundleOwner !== undefined &&
      this.recording !== undefined
    ) {
      const finished = this.recording.finish();
      const receipt = this.bundleOwner.bundles.captureCurrent(this.bundlePass);
      if (receipt !== undefined) this.preparation?.receipts.push(receipt);
      this.bundles.push(finished);
      if (this.run !== undefined) this.run.bundle = finished;
    }
    this.recording = undefined;
    this.bundleOwner = undefined;
  }

  /** Close the last bundle block and execute every recorded bundle. */
  finish(): void {
    this.flush();
    if (this.bundles.length === 0 || this.encoder === undefined) return;
    const executed = this.encoder.executeBundles(this.bundles);
    if (!executed.ok) throw executed.error;
  }
}

/** The arguments of one projection `encode` call and their derived attachment facts. */
export interface RasterEncodeCall {
  readonly resources: GraphResourceResolver;
  readonly frameResources: GpuDrivenStandardPbrFrameResources;
  readonly filter: RenderPipelineGpuDrivenFilter | undefined;
  readonly fragmentEntryPoint: string | undefined;
  readonly coverageOnly: boolean;
  readonly seededDepth: boolean;
  readonly phase: GpuDrivenDrawPhase;
  readonly colorFormats: readonly TextureFormat[];
  /** Actual graph-pass samples; raw projections may retain their declared target count. */
  readonly sampleCount?: 1 | 4;
  readonly formatKey: string | undefined;
  readonly regionOffset: number;
  readonly visibleRegionBase: number;
}

/** The frame-global material slot this pass draws the batch with, or none. */
export function selectedMaterialSlot(
  live: LiveRasterBatch,
  frameResources: GpuDrivenStandardPbrFrameResources,
): number | undefined {
  const slotsByBinding = frameResources.materialSlotIndicesByBinding;
  const material = live.batch.binding?.material;
  let slot: number | undefined;
  if (slotsByBinding.size === 0) slot = live.batch.key.materialSlot;
  else if (material !== undefined)
    slot = slotsByBinding.get(material)?.get(live.materialBindingClass);
  if (slot === undefined) return undefined;
  const selected = frameResources.selectedMaterialSlots;
  return selected === undefined || selected.has(slot) ? slot : undefined;
}

/**
 * Complete LOD windows per visible region. Failed construction publishes
 * nothing; accepted arrays are never edited, and physical/range changes
 * replace their owner.
 */
export function visibleWindowsFor(
  live: LiveRasterBatch,
  batch: ProjectedRasterClass,
  call: RasterEncodeCall,
  pipeline: RenderPipeline,
): readonly BindGroup[] {
  return preparedVisibleWindows(
    live,
    batch,
    call.phase === 'late' ? 'late' : 'early',
    call.visibleRegionBase,
    pipeline,
  );
}

export function preparedVisibleWindows(
  live: LiveRasterBatch,
  batch: ProjectedRasterClass,
  windowPhase: 'early' | 'late',
  visibleBase: number,
  pipeline: RenderPipeline,
): readonly BindGroup[] {
  const layout = pipelineRasterWindow(pipeline);
  const variants = live.visibleBindGroups;
  const phaseWindows = variants?.get(layout);
  const retained = phaseWindows?.[windowPhase];
  if (retained !== undefined) return retained;
  const levelStride = batchLevelStride(live.batch);
  const levelCount = batchLodLevelCount(live.batch);
  const resolvedWindows: BindGroup[] = [];
  for (let level = 0; level < levelCount; level += 1) {
    const resolved = batch.raster.visibleWindowBindGroup(
      visibleBase + live.batch.visibleBase + level * levelStride,
      live.batch.visibleAllocationCapacity ?? live.batch.visibleCapacity,
      undefined,
      layout,
    );
    if (!resolved.ok) throw resolved.error;
    resolvedWindows.push(resolved.value);
  }
  const windows = prepareRasterWindows(resolvedWindows);
  const next = new Map(variants);
  next.set(layout, { ...phaseWindows, [windowPhase]: windows });
  live.visibleBindGroups = next;
  return windows;
}

/**
 * Only the Surface nearest-layer and color passes feed the frame-local
 * observation; every other pass may defer and replay its draws.
 */
export function observesSurfaceDraws(
  frameResources: GpuDrivenStandardPbrFrameResources,
  fragmentEntryPoint: string | undefined,
): boolean {
  return (
    frameResources.surfaceSubmissionObservation !== undefined &&
    (fragmentEntryPoint === 'fs_nearest_layer' || fragmentEntryPoint === 'fs_color')
  );
}

/** Medium Surface draws feed the frame-local observation in recording order. */
export function observeSurfaceDraw(
  call: RasterEncodeCall,
  bindings: IndirectPassBindings,
  live: LiveRasterBatch,
  batch: ProjectedRasterClass,
  commandOffset: number,
): void {
  const observation = call.frameResources.surfaceSubmissionObservation;
  if (observation === undefined || !isSingleLayerMediumArtifact(batch.artifact)) return;
  let surfacePass: 'nearest-layer' | 'color';
  if (call.fragmentEntryPoint === 'fs_nearest_layer') surfacePass = 'nearest-layer';
  else if (call.fragmentEntryPoint === 'fs_color') surfacePass = 'color';
  else return;
  const receipt = batch.artifact.receipt;
  observation.record(surfacePass, {
    kind: live.batch.key.drawKind === 'indexed' ? 'draw-indexed-indirect' : 'draw-indirect',
    indirectBufferIdentity: getOpaqueResourceIdentity(bindings.indirect as object),
    indirectOffset: commandOffset,
    pipelineIdentity: getOpaqueResourceIdentity(bindings.pipeline as object),
    ...(receipt === undefined
      ? {}
      : { receiptIdentity: receipt.receiptIdentity, receiptGeneration: receipt.generation }),
  });
}

/** One stock encode's retained-run state and the pass identities gating it. */
export interface RetainedEncode {
  readonly key: PreparedRasterPass;
  readonly identities: readonly unknown[];
  readonly runs: RetainedPassEncode;
  readonly facts: ReturnType<typeof runFacts>;
  readonly fixed: FixedRasterInputs | undefined;
  readonly lateClassesFailed: number;
}

export function captureFixedRasterInputs(
  live: LiveRasterCache | undefined,
  projected: ProjectedRasterGraph,
  call: RasterEncodeCall,
): FixedRasterInputs | undefined {
  if (live === undefined) return undefined;
  const { frameResources } = call;
  const slotsByBinding = frameResources.materialSlotIndicesByBinding;
  // The retained live owner proves every command and physical geometry input.
  // The per-pass slot tables can be rewritten in place, so capture distinct
  // bindings and classes as values. Material/group identities are still
  // re-resolved immediately before each retained run executes.
  const bindingFacts: unknown[] = [
    live,
    call.filter,
    call.phase,
    call.fragmentEntryPoint,
    call.coverageOnly,
    call.seededDepth,
    call.sampleCount,
    frameResources.opaqueDepthPrimed,
    projected.rasterClasses.size,
  ];
  for (const [name, cls] of projected.rasterClasses) bindingFacts.push(name, cls);
  bindingFacts.push(slotsByBinding.size);
  for (const [material, classes] of slotsByBinding) {
    bindingFacts.push(material, classes.size);
    for (const [resourceClass, slot] of classes) bindingFacts.push(resourceClass, slot);
  }
  const selected = frameResources.selectedMaterialSlots;
  bindingFacts.push(selected?.size);
  if (selected !== undefined) for (const slot of selected) bindingFacts.push(slot);
  return { lives: live.value, bindings: bindingFacts };
}

/** End of the contiguous stable-ID block starting at `start`. */
export function retainedRunEnd(lives: readonly LiveRasterBatch[], start: number): number {
  const block = Math.floor((lives[start] as LiveRasterBatch).batch.batchId / 32);
  const group = (lives[start] as LiveRasterBatch).batch.key.residencyGroup;
  let end = start + 1;
  while (
    end < lives.length &&
    Math.floor((lives[end] as LiveRasterBatch).batch.batchId / 32) === block &&
    (lives[end] as LiveRasterBatch).batch.key.residencyGroup === group
  )
    end++;
  return end;
}

export function requireLateRegion(
  projected: ProjectedRasterGraph,
): NonNullable<ProjectedRasterGraph['lateRegion']> {
  if (projected.lateRegion === undefined) {
    throw new RhiError({
      code: 'internal-error',
      expected: 'addLateOcclusion(...) before a late-phase GPU-driven encode',
      hint: 'add the late HZB cull between the early and late geometry passes',
    });
  }
  return projected.lateRegion;
}

/**
 * Scene-index templates read numeric values from GPU Scene. Their retained
 * uniform declaration only satisfies the shared layout; a frame-local material
 * slot must not invalidate those commands. Full-custom programs that
 * reference the uniform retain its offset.
 */
export function recordRetainedMaterialPipelineBinding(
  block: RetainedRasterBlock,
  batch: ProjectedRasterClass,
  slot: number,
  frameResources: GpuDrivenStandardPbrFrameResources,
): void {
  const selected = block.classes.get(batch);
  if (selected === undefined || frameResources.recordMaterialPipelineBinding === undefined) return;
  const pipeline = selected.pipeline as RenderPipeline;
  const material = block.materials.get(
    materialLayoutSlotKey(slot, standardPipelineMaterialLayoutIndex(pipeline)),
  );
  if (material !== undefined)
    frameResources.recordMaterialPipelineBinding(slot, pipeline, material.group as BindGroup);
}

export function bindMaterialSlot(
  bindings: IndirectPassBindings,
  batch: ProjectedRasterClass,
  frameResources: GpuDrivenStandardPbrFrameResources,
  globalMaterialSlot: number,
  standardMaterialLayoutIndex: number,
): NonNullable<ReturnType<GpuDrivenStandardPbrFrameResources['prepareMaterialBinding']>> {
  const program = batch.artifact.specializationKey ?? batch.artifact.material;
  const prepared = frameResources.prepareMaterialBinding(
    globalMaterialSlot,
    standardMaterialLayoutIndex,
    program,
  );
  if (prepared === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: `material bind group for global slot ${globalMaterialSlot}`,
      hint: 'keep GPU-driven material selection on the main-pass producer contract',
    });
  }
  const uniformRequired = batch.artifact.program.materialUniformRequired;
  const offset = rasterMaterialOffset(
    prepared.byteOffset,
    prepared.dynamicOffsetCount,
    uniformRequired,
  );
  bindings.observeRunMaterial(
    materialLayoutSlotKey(globalMaterialSlot, standardMaterialLayoutIndex),
    prepared.group,
    offset,
    program,
    prepared.reflection,
    uniformRequired,
  );
  bindings.bindMaterial(prepared.group, offset);
  return prepared;
}

/** One stock pass's ordered physical facts; storage migration uses the same layout. */
export function retainedRasterIdentities(
  projected: ProjectedRasterGraph,
  call: RasterEncodeCall,
  viewBindGroup: BindGroup,
  indirect: Buffer | undefined,
): readonly unknown[] {
  const skinTask = projected.frame.view.skinTaskBinding();
  return [
    viewBindGroup,
    call.frameResources.materialSlotIndicesByBinding.size === 0,
    indirect,
    call.regionOffset,
    call.visibleRegionBase,
    call.formatKey,
    projected.rasterClasses,
    projected.frame.scene.scene.tableBindingIdentity,
    projected.frame.materialRaster.visibleBindingIdentity,
    projected.frame.skinRaster?.visibleBindingIdentity,
    // Palette contents change without changing commands. Physical buffers,
    // ranges and dynamic addresses are the actual Skin bundle inputs.
    skinTask?.data,
    skinTask?.auxiliary,
    skinTask?.dataOffset,
    skinTask?.auxiliaryOffset,
    skinTask?.dataSize,
    skinTask?.auxiliarySize,
  ];
}

/** Only the region and Skin fields of the exact replaced View may change numerically. */
export function remapRetainedRasterStorage(
  values: readonly unknown[],
  storage: ViewStorageTarget | undefined,
): readonly unknown[] {
  if (storage === undefined || values[2] !== storage.before.indirect) return values;
  const next = [...values];
  next[2] = storage.after.indirect;
  if (values[3] !== 0 && values[3] !== storage.previousLateIndirectBase)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the original early or late indirect region',
      hint: 'retain the actual graph pass storage recipe',
    });
  if (values[4] !== 0 && values[4] !== storage.previousLateVisibleBase)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the original early or late visible region',
      hint: 'retain the actual graph pass storage recipe',
    });
  if (values[3] !== 0) next[3] = storage.lateIndirectBase;
  if (values[4] !== 0) next[4] = storage.lateVisibleBase;
  const skin = storage.skin;
  next.splice(
    10,
    6,
    skin?.data,
    skin?.auxiliary,
    skin?.dataOffset,
    skin?.auxiliaryOffset,
    skin?.dataSize,
    skin?.auxiliarySize,
  );
  return next;
}
