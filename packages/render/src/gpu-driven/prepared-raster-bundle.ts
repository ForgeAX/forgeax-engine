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
  readonly index?: Buffer | undefined;
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

const ownedWindows = new WeakSet<readonly BindGroup[]>();

/** Materialize window values once at their publication owner, including accessor inputs. */
export function prepareRasterWindows(windows: readonly BindGroup[]): readonly BindGroup[] {
  if (ownedWindows.has(windows)) return windows;
  const snapshot = Object.freeze([...windows]);
  ownedWindows.add(snapshot);
  return snapshot;
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
    a.indexed !== b.indexed
  )
    return false;
  if (a.windows === b.windows) return true;
  if (a.windows.length !== b.windows.length) return false;
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

type RasterFormats = readonly (GPUTextureFormat | null | undefined)[];
type RasterDescriptor = Omit<RenderBundleEncoderDescriptor, 'colorFormats'> & {
  readonly colorFormats: (GPUTextureFormat | null)[];
};
function formatsFor(descriptor: RenderBundleEncoderDescriptor): RasterFormats {
  if (descriptor.colorFormats === undefined)
    throw new Error('missing prepared raster color formats');
  return Array.isArray(descriptor.colorFormats)
    ? descriptor.colorFormats
    : Array.from(descriptor.colorFormats);
}

function compatible(
  retained: RasterDescriptor,
  observed: RenderBundleEncoderDescriptor,
  formats: RasterFormats,
): boolean {
  if (
    retained.sampleCount !== (observed.sampleCount ?? 1) ||
    retained.depthStencilFormat !== observed.depthStencilFormat ||
    retained.depthReadOnly !== (observed.depthReadOnly ?? false) ||
    retained.stencilReadOnly !== (observed.stencilReadOnly ?? false) ||
    retained.colorFormats.length !== formats.length
  )
    return false;
  for (let i = 0; i < formats.length; i++)
    if (retained.colorFormats[i] !== (formats[i] ?? null)) return false;
  return true;
}

/** A pass-owned compatibility snapshot, shared by every batch recorded for that pass. */
export class PreparedRasterPass {
  readonly #descriptor: RasterDescriptor;

  constructor(descriptor: RenderBundleEncoderDescriptor, formats = formatsFor(descriptor)) {
    const colorFormats = Array.from(formats, (format) => format ?? null);
    // RHI requires a mutable array type; the privately owned snapshot stays frozen at runtime.
    Object.freeze(colorFormats);
    this.#descriptor = Object.freeze({
      ...descriptor,
      colorFormats,
      sampleCount: descriptor.sampleCount ?? 1,
      depthReadOnly: descriptor.depthReadOnly ?? false,
      stencilReadOnly: descriptor.stencilReadOnly ?? false,
    });
  }

  get descriptor(): RasterDescriptor {
    return this.#descriptor;
  }
}

/** Selection and attachment observations happen once per pass, outside the batch loop. */
export class PreparedRasterPassCache {
  readonly #entries: { readonly key: string; readonly pass: PreparedRasterPass }[] = [];

  prepare(key: string, descriptor: RenderBundleEncoderDescriptor): PreparedRasterPass {
    const formats = formatsFor(descriptor);
    for (const entry of this.#entries)
      if (entry.key === key && compatible(entry.pass.descriptor, descriptor, formats))
        return entry.pass;
    const pass = new PreparedRasterPass(descriptor, formats);
    if (this.#entries.length === 32) this.#entries.shift();
    this.#entries.push({ key, pass });
    return pass;
  }
}

interface PreparedRasterEntry {
  readonly pass: PreparedRasterPass;
  readonly device: RhiDevice;
  readonly bindings: readonly PreparedRasterBindings[];
  readonly bundle: RenderBundle;
}
type RasterRecordingEntry = Pick<PreparedRasterEntry, 'pass' | 'device'> &
  Partial<Pick<PreparedRasterEntry, 'bindings' | 'bundle'>>;

function snapshotBindings(observed: PreparedRasterBindings): PreparedRasterBindings {
  return { ...observed, windows: prepareRasterWindows(observed.windows) };
}

function buildEntry(
  entries: Map<PreparedRasterPass, PreparedRasterEntry>,
  pass: PreparedRasterPass,
  device: RhiDevice,
  bindings: readonly PreparedRasterBindings[],
  counters: PreparedRasterCounters,
): RenderBundle {
  const encoder = device.createRenderBundleEncoder(pass.descriptor);
  if (!encoder.ok) throw encoder.error;
  const commands = recordPreparedRasters(encoder.value, bindings);
  const finished = encoder.value.finish();
  if (!finished.ok) throw finished.error;
  if (!entries.has(pass) && entries.size === 8) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
    counters.evictions++;
  }
  entries.set(pass, { pass, device, bindings, bundle: finished.value });
  counters.builds++;
  counters.commands += commands;
  return finished.value;
}

/** A one-shot transaction; private snapshots are published only after recording succeeds. */
class PreparedRasterRecording {
  readonly #entries: Map<PreparedRasterPass, PreparedRasterEntry>;
  readonly #entry: RasterRecordingEntry;
  readonly #previous: readonly PreparedRasterBindings[];
  #count = 0;
  #changed: PreparedRasterBindings[] | undefined;

  constructor(
    entries: Map<PreparedRasterPass, PreparedRasterEntry>,
    entry: RasterRecordingEntry,
    private readonly counters: PreparedRasterCounters,
  ) {
    this.#entries = entries;
    this.#entry = entry;
    this.#previous = entry.bindings ?? [];
  }

  push(observed: PreparedRasterBindings): void {
    const previous = this.#previous[this.#count];
    if (previous !== undefined && equal(previous, observed)) {
      this.#changed?.push(previous);
      this.#count++;
      return;
    } else {
      if (this.#count < 0) throw new Error('prepared raster recording already finished');
      this.#changed ??= this.#previous.slice(0, this.#count);
      this.#changed.push(snapshotBindings(observed));
    }
    this.#count++;
  }

  finish(): RenderBundle {
    const count = this.#count;
    if (count < 0) throw new Error('prepared raster recording already finished');
    this.#count = -1;
    const entry = this.#entry;
    if (
      this.#changed === undefined &&
      entry.bundle !== undefined &&
      count === entry.bindings?.length &&
      this.#entries.get(entry.pass) === entry
    ) {
      this.counters.hits++;
      return entry.bundle;
    }
    try {
      const bindings =
        this.#changed ??
        (count === entry.bindings?.length
          ? entry.bindings
          : (entry.bindings?.slice(0, count) ?? []));
      return buildEntry(this.#entries, entry.pass, entry.device, bindings, this.counters);
    } catch (error) {
      this.#count = count;
      throw error;
    }
  }
}

/** One live batch owns bounded pass variants; callers never receive cached binding snapshots. */
export class PreparedRasterBundleCache {
  readonly #entries = new Map<PreparedRasterPass, PreparedRasterEntry>();

  begin(
    pass: PreparedRasterPass,
    device: RhiDevice,
    counters: PreparedRasterCounters,
  ): PreparedRasterRecording {
    const previous = this.#entries.get(pass);
    return new PreparedRasterRecording(
      this.#entries,
      previous?.device === device ? previous : { pass, device },
      counters,
    );
  }

  resolveOne(
    pass: PreparedRasterPass,
    device: RhiDevice,
    observed: PreparedRasterBindings,
    counters: PreparedRasterCounters,
  ): RenderBundle {
    const previous = this.#entries.get(pass);
    const before = previous?.bindings[0];
    if (
      previous?.device === device &&
      previous.bindings.length === 1 &&
      before !== undefined &&
      equal(before, observed)
    ) {
      counters.hits++;
      return previous.bundle;
    }
    return buildEntry(this.#entries, pass, device, [snapshotBindings(observed)], counters);
  }

  retire(pass: PreparedRasterPass, counters: PreparedRasterCounters): void {
    if (this.#entries.delete(pass)) counters.evictions++;
  }
}
