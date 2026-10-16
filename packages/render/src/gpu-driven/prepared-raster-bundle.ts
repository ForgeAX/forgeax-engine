import type {
  BindGroup,
  Buffer,
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RenderPipeline,
  RhiDevice,
  RhiRenderCommands,
} from '@forgeax/engine-rhi';

/** Complete physical closure of a batch's immutable indirect commands. */
export interface PreparedRasterBindings {
  readonly pipeline: RenderPipeline;
  readonly view: BindGroup;
  readonly material: BindGroup;
  readonly materialOffset: number;
  readonly mesh: BindGroup;
  readonly skin: boolean;
  readonly vertex: Buffer;
  readonly index?: Buffer;
  readonly indexFormat: GPUIndexFormat;
  readonly indirect: Buffer;
  readonly indirectOffset: number;
  readonly indexed: boolean;
  readonly windows: readonly BindGroup[];
}

export interface PreparedRasterCounters {
  hits: number;
  builds: number;
  commands: number;
  evictions: number;
}

function equal(a: PreparedRasterBindings, b: PreparedRasterBindings): boolean {
  if (
    a.pipeline !== b.pipeline ||
    a.view !== b.view ||
    a.material !== b.material ||
    a.materialOffset !== b.materialOffset ||
    a.mesh !== b.mesh ||
    a.skin !== b.skin ||
    a.vertex !== b.vertex ||
    a.index !== b.index ||
    a.indexFormat !== b.indexFormat ||
    a.indirect !== b.indirect ||
    a.indirectOffset !== b.indirectOffset ||
    a.indexed !== b.indexed ||
    a.windows.length !== b.windows.length
  )
    return false;
  for (let index = 0; index < a.windows.length; index++)
    if (a.windows[index] !== b.windows[index]) return false;
  return true;
}

/** Pure draw recording, sharing compatible physical state inside one native bundle. */
export function recordPreparedRasters(
  commands: RhiRenderCommands,
  batches: readonly PreparedRasterBindings[],
): number {
  let previous: PreparedRasterBindings | undefined;
  let count = 0;
  for (const b of batches) {
    const pipelineChanged = previous?.pipeline !== b.pipeline;
    if (pipelineChanged) {
      commands.setPipeline(b.pipeline);
      count++;
    }
    if (pipelineChanged || previous?.view !== b.view) {
      commands.setBindGroup(0, b.view, [0, 0]);
      count++;
    }
    if (
      pipelineChanged ||
      previous?.material !== b.material ||
      previous.materialOffset !== b.materialOffset
    ) {
      commands.setBindGroup(1, b.material, [b.materialOffset]);
      count++;
    }
    if (pipelineChanged || previous?.mesh !== b.mesh || previous.skin !== b.skin) {
      commands.setBindGroup(2, b.mesh, b.skin ? [0, 0, 0] : [0]);
      count++;
    }
    if (previous?.vertex !== b.vertex) {
      commands.setVertexBuffer(0, b.vertex);
      count++;
    }
    if (
      b.index !== undefined &&
      (previous?.index !== b.index || previous.indexFormat !== b.indexFormat)
    ) {
      commands.setIndexBuffer(b.index, b.indexFormat);
      count++;
    }
    for (let level = 0; level < b.windows.length; level++) {
      const window = b.windows[level];
      if (window === undefined) throw new Error('missing prepared raster LOD window');
      commands.setBindGroup(3, window);
      const offset = b.indirectOffset + level * 20;
      if (b.indexed) commands.drawIndexedIndirect(b.indirect, offset);
      else commands.drawIndirect(b.indirect, offset);
      count += 2;
    }
    previous = b;
  }
  return count;
}

export function recordPreparedRaster(
  commands: RhiRenderCommands,
  bindings: PreparedRasterBindings,
): void {
  recordPreparedRasters(commands, [bindings]);
}

/** Owned by one live batch; retirement drops all resource references with it. */
export class PreparedRasterBundleCache {
  private readonly entries = new Map<
    string,
    {
      readonly device: RhiDevice;
      readonly bindings: readonly PreparedRasterBindings[];
      readonly bundle: RenderBundle;
    }
  >();

  /** A batch-owned closure can validate one observation without allocating an input list. */
  resolveOne(
    key: string,
    device: RhiDevice,
    descriptor: RenderBundleEncoderDescriptor,
    observed: PreparedRasterBindings,
    counters: PreparedRasterCounters,
  ): RenderBundle {
    const previous = this.entries.get(key);
    const binding = previous?.bindings[0];
    if (
      previous?.device === device &&
      previous.bindings.length === 1 &&
      binding !== undefined &&
      equal(binding, observed)
    ) {
      counters.hits++;
      return previous.bundle;
    }
    return this.build(key, device, descriptor, [observed], counters);
  }

  retire(key: string, counters: PreparedRasterCounters): void {
    if (this.entries.delete(key)) counters.evictions++;
  }

  resolve(
    key: string,
    device: RhiDevice,
    descriptor: RenderBundleEncoderDescriptor,
    bindings: readonly PreparedRasterBindings[],
    counters: PreparedRasterCounters,
  ): RenderBundle {
    const previous = this.entries.get(key);
    if (
      previous?.device === device &&
      previous.bindings.length === bindings.length &&
      bindings.every((batch, index) => {
        const before = previous.bindings[index];
        return before !== undefined && (before === batch || equal(before, batch));
      })
    ) {
      counters.hits++;
      return previous.bundle;
    }
    return this.build(key, device, descriptor, bindings, counters);
  }

  private build(
    key: string,
    device: RhiDevice,
    descriptor: RenderBundleEncoderDescriptor,
    bindings: readonly PreparedRasterBindings[],
    counters: PreparedRasterCounters,
  ): RenderBundle {
    const encoder = device.createRenderBundleEncoder(descriptor);
    if (!encoder.ok) throw encoder.error;
    const recordedCommands = recordPreparedRasters(encoder.value, bindings);
    const finished = encoder.value.finish();
    if (!finished.ok) throw finished.error;
    counters.builds++;
    counters.commands += recordedCommands;
    // Bound attachment variants; changed physical resources replace their entry.
    if (!this.entries.has(key) && this.entries.size >= 8) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
      counters.evictions++;
    }
    this.entries.set(key, {
      device,
      bindings: bindings.map((batch) =>
        Object.freeze({ ...batch, windows: Object.freeze([...batch.windows]) }),
      ),
      bundle: finished.value,
    });
    return finished.value;
  }
}
