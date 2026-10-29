import { deriveVertexCount } from '@forgeax/engine-geometry';
import type {
  BindGroup,
  BindGroupLayout,
  CommandBuffer,
  ComputePipeline,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { MeshAsset } from '@forgeax/engine-types';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { worldEntityKey } from '../record/frame-snapshot';
import type { MorphSnapshot } from '../render-system-extract';
import type { DeviceScope } from './device-scope';
import type { MeshGpuHandles } from './gpu-residency';

const COMPUTE_STAGE = 0x4;
const WORKGROUP = 64;
const HEADER_WORDS = 4;
/** Entries absent from this many consecutive submissions release their buffers. */
const RETIRE_AFTER_SUBMISSIONS = 8;

/**
 * vertices[v].position = source[v] + sum_t weight[t] * source[(t + 1) * count + v].
 * Only the position lane is written; every other attribute keeps the bytes the
 * output received from the Mesh once at creation.
 */
export const MORPH_GEOMETRY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> params : array<u32>;
@group(0) @binding(1) var<storage, read> source : array<f32>;
@group(0) @binding(2) var<storage, read_write> vertices : array<f32>;

@compute @workgroup_size(${WORKGROUP})
fn morphPositions(@builtin(global_invocation_id) id : vec3<u32>) {
  let count = params[0];
  let vertex = id.x;
  if (vertex >= count) { return; }
  let stride = params[1];
  let targets = params[2];
  var position = vec3<f32>(source[vertex * 3u], source[vertex * 3u + 1u], source[vertex * 3u + 2u]);
  for (var t = 0u; t < targets; t++) {
    let weight = bitcast<f32>(params[${HEADER_WORDS}u + t]);
    let at = ((t + 1u) * count + vertex) * 3u;
    position += weight * vec3<f32>(source[at], source[at + 1u], source[at + 2u]);
  }
  let out = vertex * stride;
  vertices[out] = position.x;
  vertices[out + 1u] = position.y;
  vertices[out + 2u] = position.z;
}
`;

/** Base positions followed by every target delta, uploaded once per Mesh version. */
interface MorphSource {
  buffer: GpuBuffer | undefined;
  readonly vertexCount: number;
  holders: number;
}

interface MorphEntry {
  readonly base: MeshGpuHandles;
  readonly mesh: MeshAsset;
  readonly source: MorphSource;
  readonly output: GpuBuffer;
  /** GPU executor inputs, created once a compute pipeline is available. */
  params: GpuBuffer | undefined;
  bindGroup: BindGroup | undefined;
  readonly handles: MeshGpuHandles;
  readonly strideWords: number;
  morph: MorphSnapshot;
  seen: number;
}

interface MorphPipeline {
  readonly layout: BindGroupLayout;
  readonly pipeline: ComputePipeline;
}

export interface MorphGeometryInput {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly factory: PipelineBuilderShaderModuleFactory | undefined;
  readonly reportError: (error: RhiError) => void;
}

export interface MorphGeometryWork {
  readonly buffer: CommandBuffer;
  complete(submitted: boolean): void;
}

export interface MorphGeometryStats {
  /** Weight rows written to the GPU; one per actual weight change. */
  weightUploads: number;
  /** Per-Mesh base/delta sources written; one per Mesh version. */
  sourceUploads: number;
  /** Per-entity outputs created and seeded from the Mesh vertex stream. */
  outputsCreated: number;
  /** Entity deformations dispatched by compute. */
  dispatches: number;
  /** Entity deformations evaluated on the CPU (no compute pipeline). */
  cpuDeformations: number;
}

/**
 * Renderer-owned morph deformation. Each morphed entity owns one vertex buffer
 * whose position lane is derived from per-Mesh target deltas and the entity's
 * weights; draws bind it in place of the shared Mesh stream, so every material
 * program and lane consumes it as ordinary rigid geometry. Work is proportional
 * to weight changes: unchanged rows return their retained handles.
 */
export class MorphGeometry {
  private device: RhiDevice | undefined;
  private readonly entries = new Map<number, MorphEntry>();
  private readonly sources = new Map<MeshGpuHandles, MorphSource>();
  private readonly pending = new Set<MorphEntry>();
  private pipeline: MorphPipeline | null | undefined;
  private epoch = 0;
  private touched = 0;
  readonly stats: MorphGeometryStats = {
    weightUploads: 0,
    sourceUploads: 0,
    outputsCreated: 0,
    dispatches: 0,
    cpuDeformations: 0,
  };

  get size(): number {
    return this.entries.size;
  }

  /**
   * Stable handles for one morphed entity, or undefined when the Mesh cannot be
   * morphed (the caller then draws the shared stream, as for zero weights).
   */
  resolve(
    input: MorphGeometryInput,
    key: number,
    base: MeshGpuHandles,
    morph: MorphSnapshot,
    mesh: () => MeshAsset | undefined,
  ): MeshGpuHandles | undefined {
    if (this.device !== input.device) this.reset(input.device);
    let entry = this.entries.get(key);
    if (entry !== undefined && entry.base !== base) {
      this.release(key, entry, input.reportError);
      entry = undefined;
    }
    if (entry === undefined) {
      const asset = mesh();
      if (asset === undefined) return undefined;
      entry = this.create(input, base, asset, morph);
      if (entry === undefined) return undefined;
      this.entries.set(key, entry);
      this.stage(input, entry);
    } else if (entry.morph !== morph) {
      const previous = entry.morph;
      entry.morph = morph;
      if (!sameWeights(previous.weights, morph.weights)) this.stage(input, entry);
    }
    if (entry.seen !== this.epoch) {
      entry.seen = this.epoch;
      this.touched++;
    }
    return entry.handles;
  }

  /** Encode staged deformations; the caller submits them before the frame's commands. */
  prepare(
    device: RhiDevice,
    reportError: (error: RhiError) => void,
  ): MorphGeometryWork | undefined {
    if (this.device !== device) {
      this.pending.clear();
      return undefined;
    }
    this.retire(reportError);
    this.epoch++;
    this.touched = 0;
    const pipeline = this.pipeline;
    if (this.pending.size === 0 || pipeline === undefined || pipeline === null) return undefined;
    const created = device.createCommandEncoder({ label: 'morph-geometry' });
    if (!created.ok) {
      reportError(created.error);
      return undefined;
    }
    const work = [...this.pending];
    const pass = created.value.beginComputePass({ label: 'morph-geometry' });
    pass.setPipeline(pipeline.pipeline);
    for (const entry of work) {
      if (entry.bindGroup === undefined) continue;
      pass.setBindGroup(0, entry.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(entry.source.vertexCount / WORKGROUP));
    }
    pass.end();
    const finished = created.value.finish();
    if (!finished.ok) {
      reportError(finished.error);
      return undefined;
    }
    return {
      buffer: finished.value,
      complete: (submitted) => {
        if (!submitted) return;
        for (const entry of work) {
          if (this.pending.delete(entry)) this.stats.dispatches++;
        }
      },
    };
  }

  /** Device loss: every buffer belongs to the retired scope. */
  reset(device?: RhiDevice): void {
    this.entries.clear();
    this.sources.clear();
    this.pending.clear();
    this.pipeline = undefined;
    this.device = device;
    this.touched = 0;
  }

  dispose(reportError: (error: RhiError) => void): void {
    for (const [key, entry] of this.entries) this.release(key, entry, reportError);
    this.reset();
  }

  private create(
    input: MorphGeometryInput,
    base: MeshGpuHandles,
    mesh: MeshAsset,
    morph: MorphSnapshot,
  ): MorphEntry | undefined {
    const targets = mesh.morphTargets;
    if (targets === undefined || targets.length !== morph.targetCount) return undefined;
    const position = base.layoutProjection.attributes.find(
      (attribute) => attribute.key === 'position',
    );
    if (
      position === undefined ||
      position.offset !== 0 ||
      position.shaderLocation !== 0 ||
      position.format !== 'float32x3' ||
      position.byteLength !== 12
    )
      return undefined;
    const vertexCount = deriveVertexCount(mesh.vertices, base.layoutProjection);
    if (vertexCount === undefined || vertexCount !== base.vertexCount || vertexCount <= 0)
      return undefined;
    for (const target of targets) if (target.position?.length !== vertexCount * 3) return undefined;
    const strideWords = base.layoutProjection.arrayStride / Float32Array.BYTES_PER_ELEMENT;
    const source = this.acquireSource(base, vertexCount);
    const vertexBytes = mesh.vertices.byteLength;
    const output = this.buffer(
      input,
      'morph-geometry-vbo',
      vertexBytes,
      GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (output === undefined) {
      this.releaseSource(base, source, input.reportError);
      return undefined;
    }
    const seeded = input.device.queue.writeBuffer(output.handle, 0, mesh.vertices);
    if (!seeded.ok) input.reportError(seeded.error);
    this.stats.outputsCreated++;
    return {
      base,
      mesh,
      source,
      output,
      params: undefined,
      bindGroup: undefined,
      strideWords,
      // Morphed rows draw LOD0 only; lower levels keep the shared stream's ranges.
      handles: withoutLods({ ...base, vertexBuffer: output, vboBytes: vertexBytes }),
      morph,
      seen: -1,
    };
  }

  /** Write the entity's weights, then deform on the GPU or, without compute, on the CPU. */
  private stage(input: MorphGeometryInput, entry: MorphEntry): void {
    const weights = entry.morph.weights;
    if (this.gpuBinding(input, entry) !== undefined && entry.params !== undefined) {
      const words = new Uint32Array(HEADER_WORDS + weights.length);
      words[0] = entry.source.vertexCount;
      words[1] = entry.strideWords;
      words[2] = weights.length;
      new Float32Array(words.buffer, HEADER_WORDS * 4).set(weights);
      const written = input.device.queue.writeBuffer(entry.params.handle, 0, words);
      if (written.ok) {
        this.stats.weightUploads++;
        this.pending.add(entry);
        return;
      }
      input.reportError(written.error);
    }
    this.pending.delete(entry);
    const { vertices: source, morphTargets: targets = [] } = entry.mesh;
    const vertices = new Float32Array(source);
    const { vertexCount } = entry.source;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const out = vertex * entry.strideWords;
      for (let lane = 0; lane < 3; lane++) {
        let value = source[out + lane] as number;
        for (let target = 0; target < weights.length; target++)
          value +=
            (weights[target] as number) *
            ((targets[target]?.position?.[vertex * 3 + lane] ?? 0) as number);
        vertices[out + lane] = value;
      }
    }
    const written = input.device.queue.writeBuffer(entry.output.handle, 0, vertices);
    if (written.ok) this.stats.cpuDeformations++;
    else input.reportError(written.error);
  }

  private acquireSource(base: MeshGpuHandles, vertexCount: number): MorphSource {
    const existing = this.sources.get(base);
    if (existing !== undefined) {
      existing.holders++;
      return existing;
    }
    const source: MorphSource = { buffer: undefined, vertexCount, holders: 1 };
    this.sources.set(base, source);
    return source;
  }

  /** Lazily upload the Mesh's targets and the entity's weight row for compute. */
  private gpuBinding(input: MorphGeometryInput, entry: MorphEntry): BindGroup | undefined {
    if (entry.bindGroup !== undefined) return entry.bindGroup;
    const pipeline = this.computePipeline(input);
    if (pipeline === undefined) return undefined;
    const { source, mesh, strideWords } = entry;
    const targets = mesh.morphTargets ?? [];
    if (source.buffer === undefined) {
      const { vertexCount } = source;
      const positions = new Float32Array((targets.length + 1) * vertexCount * 3);
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const at = vertex * strideWords;
        positions[vertex * 3] = mesh.vertices[at] as number;
        positions[vertex * 3 + 1] = mesh.vertices[at + 1] as number;
        positions[vertex * 3 + 2] = mesh.vertices[at + 2] as number;
      }
      for (let target = 0; target < targets.length; target++)
        positions.set(targets[target]?.position as Float32Array, (target + 1) * vertexCount * 3);
      const buffer = this.buffer(
        input,
        'morph-geometry-targets',
        positions.byteLength,
        GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      );
      if (buffer === undefined) return undefined;
      const written = input.device.queue.writeBuffer(buffer.handle, 0, positions);
      if (!written.ok) {
        input.reportError(written.error);
        destroy(buffer, input.reportError);
        return undefined;
      }
      source.buffer = buffer;
      this.stats.sourceUploads++;
    }
    entry.params ??= this.buffer(
      input,
      'morph-geometry-weights',
      (HEADER_WORDS + targets.length) * 4,
      GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    );
    if (entry.params === undefined) return undefined;
    const group = input.device.createBindGroup({
      label: 'morph-geometry',
      layout: pipeline.layout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: entry.params.handle } } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: source.buffer.handle } } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: entry.output.handle } } },
      ],
    });
    if (!group.ok) {
      input.reportError(group.error);
      return undefined;
    }
    entry.bindGroup = group.value;
    return entry.bindGroup;
  }

  private computePipeline(input: MorphGeometryInput): MorphPipeline | undefined {
    if (this.pipeline !== undefined) return this.pipeline ?? undefined;
    const { device, factory } = input;
    if (!device.caps.compute || !device.caps.storageBuffer || factory === undefined) {
      this.pipeline = null;
      return undefined;
    }
    const module = factory.createShaderModule({
      code: MORPH_GEOMETRY_WGSL,
      label: 'morph-geometry',
    });
    // A module still compiling is retried later; the CPU executor covers the gap.
    if (!module.ok) {
      if (module.error.code !== 'rhi-not-available') this.pipeline = null;
      return undefined;
    }
    const layout = device.createBindGroupLayout({
      label: 'morph-geometry',
      entries: [
        { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
      ],
    });
    if (!layout.ok) return this.unavailable(input, layout.error);
    const pipelineLayout = device.createPipelineLayout({
      label: 'morph-geometry',
      bindGroupLayouts: [layout.value],
    });
    if (!pipelineLayout.ok) return this.unavailable(input, pipelineLayout.error);
    const pipeline = device.createComputePipeline({
      label: 'morph-geometry',
      layout: pipelineLayout.value,
      compute: { module: module.value, entryPoint: 'morphPositions' },
    });
    if (!pipeline.ok) return this.unavailable(input, pipeline.error);
    this.pipeline = { layout: layout.value, pipeline: pipeline.value };
    return this.pipeline;
  }

  private unavailable(input: MorphGeometryInput, error: RhiError): undefined {
    input.reportError(error);
    this.pipeline = null;
    return undefined;
  }

  private buffer(
    input: MorphGeometryInput,
    label: string,
    size: number,
    usage: number,
  ): GpuBuffer | undefined {
    const created = input.device.createBuffer({
      label,
      size: Math.max(4, Math.ceil(size / 4) * 4),
      usage,
      mappedAtCreation: false,
    });
    if (!created.ok) {
      input.reportError(created.error);
      return undefined;
    }
    return new GpuBuffer(input.device, created.value, input.scope);
  }

  /** Entries no draw resolved recently; the scan runs only when some row went unseen. */
  private retire(reportError: (error: RhiError) => void): void {
    if (this.touched === this.entries.size) return;
    const horizon = this.epoch - RETIRE_AFTER_SUBMISSIONS;
    for (const [key, entry] of this.entries)
      if (entry.seen < horizon) this.release(key, entry, reportError);
  }

  private release(key: number, entry: MorphEntry, reportError: (error: RhiError) => void): void {
    this.entries.delete(key);
    this.pending.delete(entry);
    destroy(entry.output, reportError);
    if (entry.params !== undefined) destroy(entry.params, reportError);
    this.releaseSource(entry.base, entry.source, reportError);
  }

  private releaseSource(
    base: MeshGpuHandles,
    source: MorphSource,
    reportError: (error: RhiError) => void,
  ): void {
    if (--source.holders !== 0) return;
    this.sources.delete(base);
    if (source.buffer !== undefined) destroy(source.buffer, reportError);
  }
}

function withoutLods(handles: MeshGpuHandles): MeshGpuHandles {
  const { lodRanges: _lodRanges, ...rest } = handles;
  return rest;
}

function sameWeights(left: Float32Array, right: Float32Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function destroy(buffer: GpuBuffer, reportError: (error: RhiError) => void): void {
  if (buffer.isDestroyed) return;
  const result = buffer.destroy();
  if (!result.ok) reportError(result.error);
}

type MorphGeometryOwner = Pick<
  import('../record/render-context').RenderSystemInternals,
  | 'device'
  | 'deviceScope'
  | 'errorRegistry'
  | 'gpuStore'
  | 'immediateShaderModuleFactory'
  | 'shaderModuleFactory'
>;

/** Resolve one morphed entity against the renderer's current device. */
export function resolveMorphGeometry(
  internals: MorphGeometryOwner,
  key: number,
  base: MeshGpuHandles,
  morph: MorphSnapshot,
  mesh: () => MeshAsset | undefined,
): MeshGpuHandles | undefined {
  let input = morphInputs.get(internals);
  if (
    input === undefined ||
    input.device !== internals.device ||
    input.scope !== internals.deviceScope
  ) {
    input = {
      device: internals.device,
      scope: internals.deviceScope,
      factory: internals.immediateShaderModuleFactory ?? internals.shaderModuleFactory,
      reportError: (error) => internals.errorRegistry.fire(error),
    };
    morphInputs.set(internals, input);
  }
  return internals.gpuStore.morphGeometry.resolve(input, key, base, morph, mesh);
}

const morphInputs = new WeakMap<object, MorphGeometryInput>();

/**
 * Direct (CPU-recorded) draw of one morphed source: its own deformed stream,
 * or the shared stream when the Mesh cannot be morphed.
 */
export function directMorphGeometry(
  internals: MorphGeometryOwner,
  worlds: readonly import('../publication/resource-scope').RenderResourceScope[],
  source: Pick<
    import('../render-system-extract').RenderableSnapshot,
    'morph' | 'worldId' | 'entityKey' | 'assetHandle'
  >,
  base: MeshGpuHandles,
): MeshGpuHandles {
  const morph = source.morph;
  const handle = source.assetHandle;
  if (morph === undefined || handle === undefined) return base;
  return (
    resolveMorphGeometry(
      internals,
      worldEntityKey(source.worldId, source.entityKey),
      base,
      morph,
      () => {
        const asset = worlds[source.worldId]?.resolveAsset<MeshAsset>(
          handle as import('@forgeax/engine-types').AssetHandle<'mesh'>,
        );
        return asset?.ok === true ? asset.value : undefined;
      },
    ) ?? base
  );
}
