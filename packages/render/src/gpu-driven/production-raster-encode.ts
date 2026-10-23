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
import { pbrSkinMeshDynamicOffsets } from '../pbr-pipeline';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineGpuDrivenFilter,
} from '../render-pipeline';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { batchLevelStride, batchLodLevelCount } from './batch-layout';
import type { LiveRasterBatch } from './live-raster';
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
import type { RasterMeshBinding } from './raster-mesh-bindings';
import type { RetainedRasterBlock } from './retained-raster-encode';
import type { GpuDrivenView } from './view-gpu';

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

function meshDynamicOffsets(deformation: 'rigid' | 'skin', view: GpuDrivenView): readonly number[] {
  return deformation === 'skin'
    ? pbrSkinMeshDynamicOffsets(0, requireViewSkinTask(view), true)
    : [0];
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
  private materialOffset = -1;
  private mesh: BindGroup | undefined;
  private deformation: 'rigid' | 'skin' | undefined;
  private visible: BindGroup | undefined;
  private vertexKey: GraphBuffer | Buffer | undefined;
  private indexKey: GraphBuffer | Buffer | undefined;
  private indexFormat: MeshGpuHandles['indexFormat'] | undefined;
  private physicalVertex: Buffer | undefined;
  private physicalIndex: Buffer | undefined;
  /** The current batch's index binding; undefined for a non-indexed mesh. */
  private drawIndex: Buffer | undefined;
  private drawIndexFormat: MeshGpuHandles['indexFormat'] = 'uint32';
  /** Stock recording resolves the rigid cluster group once per encode. */
  rigidClusterGroup: BindGroup | undefined;
  private indirectBuffer: Buffer | undefined;
  private readonly bundles: RenderBundle[] = [];
  private bundleBlock = -1;
  private bundleOwner: LiveRasterBatch | undefined;
  private recording: ReturnType<PreparedRasterBundleCache['begin']> | undefined;
  /** The retained run being recorded; its bundle is attached when flushed. */
  private run: RetainedRasterBlock | undefined;
  /** Filled completely before each observation; only changed commands take a snapshot. */
  private readonly observed = {} as {
    -readonly [K in keyof PreparedRasterBindings]: PreparedRasterBindings[K];
  };

  constructor(
    private readonly pass: RhiRenderPassEncoder,
    private readonly viewBindGroup: BindGroup,
    private readonly descriptor: RenderBundleEncoderDescriptor | undefined,
    private readonly bundlePass: PreparedRasterPass | undefined,
  ) {}

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

  bindPipeline(pipeline: RenderPipeline): void {
    if (this.boundPipeline === pipeline) return;
    if (this.direct) this.pass.setPipeline(pipeline);
    this.boundPipeline = pipeline;
  }

  bindMaterial(group: BindGroup, offset: number): void {
    if (this.material === group && this.materialOffset === offset) return;
    if (this.direct) this.pass.setBindGroup(1, group, [offset]);
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

  recordRun(block: RetainedRasterBlock): void {
    this.run = block;
  }

  /** The material slot owner the recorded run resolved. */
  observeRunMaterial(slot: number, group: BindGroup, offset: number): void {
    this.run?.materials.set(slot, { group, offset });
  }

  /** Skin task offsets are per-frame facts; such runs are never replayed. */
  observeRunClass(
    rasterClass: ProjectedRasterClass,
    pipeline: RenderPipeline,
    mesh: BindGroup,
  ): void {
    const run = this.run;
    if (run === undefined) return;
    if (rasterClass.deformation === 'skin') run.draws = Number.NaN;
    run.classes.set(rasterClass, { pipeline, mesh });
  }

  countRunDraw(): void {
    if (this.run !== undefined) this.run.draws += 1;
  }

  bindMesh(group: BindGroup, deformation: 'rigid' | 'skin', view: GpuDrivenView): void {
    if (this.mesh === group && this.deformation === deformation) return;
    if (this.direct) this.pass.setBindGroup(2, group, meshDynamicOffsets(deformation, view));
    this.mesh = group;
    this.deformation = deformation;
  }

  /** Stock recording binds live residency-owned meshes like direct draws. */
  bindRecordedGeometry(
    binding: RasterMeshBinding,
    indexFormat: MeshGpuHandles['indexFormat'],
  ): void {
    const vertex = binding.vertex;
    if (vertex !== undefined && this.vertexKey !== vertex) this.setVertex(vertex, vertex);
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
  ): void {
    if (vertex !== undefined && this.vertexKey !== vertex)
      this.setVertex(vertex, resources.buffer(vertex).unwrap());
    if (index !== undefined && this.indexKey !== index)
      this.setIndex(index, resources.buffer(index).unwrap(), indexFormat);
    this.drawIndex = index === undefined ? undefined : this.physicalIndex;
    this.drawIndexFormat = indexFormat;
  }

  private setVertex(key: GraphBuffer | Buffer, vertex: Buffer): void {
    this.physicalVertex = vertex;
    if (this.direct) this.pass.setVertexBuffer(0, vertex);
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
    if (this.bundleBlock !== block) this.flush();
    this.bundleBlock = block;
    this.bundleOwner ??= live;
    if (this.bundleOwner !== live) live.bundles.retire(bundlePass, counters);
    this.recording ??= this.bundleOwner.bundles.begin(bundlePass, device, counters);
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
    observed.view = this.viewBindGroup;
    observed.material = material;
    observed.materialOffset = this.materialOffset;
    observed.mesh = mesh;
    observed.meshOffsets = meshDynamicOffsets(deformation, view);
    observed.vertex = vertex;
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
      this.bundles.push(finished);
      if (this.run !== undefined) this.run.bundle = finished;
    }
    this.recording = undefined;
    this.bundleOwner = undefined;
  }

  /** Close the last bundle block and execute every recorded bundle. */
  finish(): void {
    this.flush();
    if (this.bundles.length === 0) return;
    const executed = this.pass.executeBundles(this.bundles);
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
  readonly phase: GpuDrivenDrawPhase;
  readonly colorFormats: readonly TextureFormat[];
  readonly formatKey: string | undefined;
  readonly regionOffset: number;
  readonly visibleRegionBase: number;
}

/**
 * One candidate is already classified by the Scene camera owner. Larger
 * batches stay GPU-culled without enumerating members here.
 */
export function cameraRejectsSingleton(
  live: LiveRasterBatch,
  frameResources: GpuDrivenStandardPbrFrameResources,
  scene: PersistentGpuDrivenState,
): boolean {
  if (live.batch.visibleCapacity !== 1 || frameResources.cameraVisible === undefined) return false;
  const member = live.batch.members?.at(0);
  if (member === undefined) return false;
  const source = scene.slotAt(member.primitiveIndex);
  return (
    source !== undefined &&
    source.generation === member.generation &&
    frameResources.cameraVisible(source.snapshot) === false
  );
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
): readonly BindGroup[] {
  const windowPhase = call.phase === 'late' ? 'late' : 'early';
  const retained = live.visibleBindGroups?.[windowPhase];
  if (retained !== undefined) return retained;
  const levelStride = batchLevelStride(live.batch);
  const levelCount = batchLodLevelCount(live.batch);
  const resolvedWindows: BindGroup[] = [];
  for (let level = 0; level < levelCount; level += 1) {
    const resolved = batch.raster.visibleWindowBindGroup(
      call.visibleRegionBase + live.batch.visibleBase + level * levelStride,
      live.batch.visibleAllocationCapacity ?? live.batch.visibleCapacity,
    );
    if (!resolved.ok) throw resolved.error;
    resolvedWindows.push(resolved.value);
  }
  live.visibleBindGroups ??= {};
  const windows = prepareRasterWindows(resolvedWindows);
  live.visibleBindGroups[windowPhase] = windows;
  return windows;
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
