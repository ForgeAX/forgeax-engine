import type { MeshVertexStreamRange } from '@forgeax/engine-geometry';
import type {
  BindGroup,
  Buffer,
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RenderPipeline,
  RhiDevice,
  RhiRenderCommands,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { bindMeshVertexStreams } from '../device/mesh-vertex-streams';

export interface PreparedRasterWindowPreparation {
  isCurrent(): boolean;
  replacement(bundle: RenderBundle): RenderBundle | undefined;
  publish(): Result<void, RhiError>;
  release(): void;
}

function assertCurrent(current: (() => boolean) | undefined): void {
  if (current !== undefined && !current()) throw staleWindows();
}

function staleWindows(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'unchanged prepared raster entries and their window preparation',
    hint: 'release this private recording and prepare against the current owners',
  });
}

/** Complete physical closure of a batch's immutable indirect commands. */
export interface PreparedRasterBindings {
  readonly pipeline: RenderPipeline;
  readonly view: BindGroup;
  readonly viewOffset: number;
  readonly material: BindGroup;
  readonly materialOffset: number;
  readonly mesh: BindGroup;
  readonly meshOffsets: readonly number[];
  readonly vertex: Buffer;
  readonly vertexStreams?: readonly MeshVertexStreamRange[] | undefined;
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

function sameVertexBinding(
  previous: PreparedRasterBindings | undefined,
  next: PreparedRasterBindings,
): boolean {
  return previous?.vertex === next.vertex && previous.vertexStreams === next.vertexStreams;
}

function equal(a: PreparedRasterBindings, b: PreparedRasterBindings): boolean {
  if (
    a.pipeline !== b.pipeline ||
    a.view !== b.view ||
    a.viewOffset !== b.viewOffset ||
    a.material !== b.material ||
    a.materialOffset !== b.materialOffset ||
    a.mesh !== b.mesh ||
    !sameVertexBinding(a, b) ||
    a.index !== b.index ||
    a.indexFormat !== b.indexFormat ||
    a.indirect !== b.indirect ||
    a.indirectOffset !== b.indirectOffset ||
    a.indexed !== b.indexed
  )
    return false;
  if (
    a.meshOffsets !== b.meshOffsets &&
    (a.meshOffsets.length !== b.meshOffsets.length ||
      a.meshOffsets.some((value, index) => value !== b.meshOffsets[index]))
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
  current?: () => boolean,
): number {
  assertCurrent(current);
  let previous: PreparedRasterBindings | undefined;
  let count = 0;
  for (const b of batches) {
    count += recordPreparedRasterAfter(commands, b, previous, current);
    previous = b;
  }
  return count;
}

const ZERO_VIEW_OFFSETS = Object.freeze([0, 0]);
const ZERO_MATERIAL_OFFSET = Object.freeze([0]);

/** Encode a single row while preserving physical state across consecutive draws. */
export function recordPreparedRasterAfter(
  commands: RhiRenderCommands,
  b: PreparedRasterBindings,
  previous?: PreparedRasterBindings,
  current?: () => boolean,
): number {
  let count = 0;
  const pipelineChanged = previous?.pipeline !== b.pipeline;
  if (pipelineChanged) {
    commands.setPipeline(b.pipeline);
    assertCurrent(current);
    count++;
  }
  if (pipelineChanged || previous?.view !== b.view || previous.viewOffset !== b.viewOffset) {
    commands.setBindGroup(0, b.view, b.viewOffset === 0 ? ZERO_VIEW_OFFSETS : [b.viewOffset, 0]);
    assertCurrent(current);
    count++;
  }
  if (
    pipelineChanged ||
    previous?.material !== b.material ||
    previous.materialOffset !== b.materialOffset
  ) {
    commands.setBindGroup(
      1,
      b.material,
      b.materialOffset === 0 ? ZERO_MATERIAL_OFFSET : [b.materialOffset],
    );
    assertCurrent(current);
    count++;
  }
  if (
    pipelineChanged ||
    previous?.mesh !== b.mesh ||
    previous.meshOffsets.length !== b.meshOffsets.length ||
    previous.meshOffsets.some((value, index) => value !== b.meshOffsets[index])
  ) {
    commands.setBindGroup(2, b.mesh, b.meshOffsets);
    assertCurrent(current);
    count++;
  }
  if (!sameVertexBinding(previous, b)) {
    count += bindMeshVertexStreams(commands, b.vertex, b.vertexStreams);
    assertCurrent(current);
  }
  if (
    b.index !== undefined &&
    (previous?.index !== b.index || previous.indexFormat !== b.indexFormat)
  ) {
    commands.setIndexBuffer(b.index, b.indexFormat);
    assertCurrent(current);
    count++;
  }
  for (let level = 0; level < b.windows.length; level++) {
    const window = b.windows[level];
    if (window === undefined) throw new Error('missing prepared raster LOD window');
    commands.setBindGroup(3, window);
    assertCurrent(current);
    const offset = b.indirectOffset + level * 20;
    if (b.indexed) commands.drawIndexedIndirect(b.indirect, offset);
    else commands.drawIndirect(b.indirect, offset);
    assertCurrent(current);
    count += 2;
  }
  return count;
}

export function recordPreparedRaster(
  commands: RhiRenderCommands,
  bindings: PreparedRasterBindings,
): void {
  recordPreparedRasterAfter(commands, bindings);
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
  return {
    ...observed,
    meshOffsets: Object.freeze([...observed.meshOffsets]),
    windows: prepareRasterWindows(observed.windows),
  };
}

function buildEntry(
  entries: Map<PreparedRasterPass, PreparedRasterEntry>,
  pass: PreparedRasterPass,
  device: RhiDevice,
  bindings: readonly PreparedRasterBindings[],
  counters: PreparedRasterCounters,
  current?: () => boolean,
): RenderBundle {
  assertCurrent(current);
  const encoder = device.createRenderBundleEncoder(pass.descriptor);
  if (!encoder.ok) throw encoder.error;
  assertCurrent(current);
  const commands = recordPreparedRasters(encoder.value, bindings, current);
  const finished = encoder.value.finish();
  if (!finished.ok) throw finished.error;
  assertCurrent(current);
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
    private readonly current?: () => boolean,
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
    assertCurrent(this.current);
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
      return buildEntry(
        this.#entries,
        entry.pass,
        entry.device,
        bindings,
        this.counters,
        this.current,
      );
    } catch (error) {
      this.#count = count;
      throw error;
    }
  }
}

/** One live batch owns bounded pass variants; callers never receive cached binding snapshots. */
export class PreparedRasterBundleCache {
  readonly #entries = new Map<PreparedRasterPass, PreparedRasterEntry>();
  #preparingWindows: PreparedRasterWindowPreparation | undefined;

  /** Share immutable commands without sharing the mutable pass slots. */
  fork(): PreparedRasterBundleCache {
    const fork = new PreparedRasterBundleCache();
    for (const [pass, entry] of this.#entries) fork.#entries.set(pass, entry);
    return fork;
  }

  captureCurrent(pass: PreparedRasterPass): (() => boolean) | undefined {
    const entry = this.#entries.get(pass);
    return entry === undefined ? undefined : () => this.#entries.get(pass) === entry;
  }

  /** Pre-record existing pass variants without replacing any accepted native bundle. */
  prepareBindings(
    replace: (binding: PreparedRasterBindings) => PreparedRasterBindings,
    current: () => boolean,
  ): Result<PreparedRasterWindowPreparation, RhiError> {
    if (this.#preparingWindows !== undefined) return err(staleWindows());
    const before = new Map(this.#entries);
    const next = new Map(before);
    const replacements = new Map<RenderBundle, RenderBundle>();
    const counters: PreparedRasterCounters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
    let closed = false;
    let ready = false;
    let observing = false;
    const live = () => {
      if (closed || this.#preparingWindows !== api || !current()) return false;
      // The supplied owner observation may itself reenter the cache.
      if (closed || this.#preparingWindows !== api || this.#entries.size !== before.size)
        return false;
      for (const [pass, entry] of before) if (this.#entries.get(pass) !== entry) return false;
      return true;
    };
    const release = () => {
      closed = true;
      ready = false;
      before.clear();
      next.clear();
      replacements.clear();
      if (this.#preparingWindows === api) this.#preparingWindows = undefined;
    };
    const isCurrent = () => {
      if (observing) return false;
      observing = true;
      try {
        return ready && live();
      } finally {
        observing = false;
      }
    };
    const api: PreparedRasterWindowPreparation = Object.freeze({
      isCurrent,
      replacement: (bundle: RenderBundle) => {
        // The caller can probe several cache owners. A miss has no validity to prove.
        if (!replacements.has(bundle) || !isCurrent()) return undefined;
        return replacements.get(bundle);
      },
      publish: () => {
        if (observing) return err(staleWindows());
        observing = true;
        try {
          if (!ready || !live()) return err(staleWindows());
          for (const [pass, entry] of next) this.#entries.set(pass, entry);
          release();
          return ok(undefined);
        } finally {
          observing = false;
        }
      },
      release,
    });
    this.#preparingWindows = api;
    let accepted = false;
    try {
      assertCurrent(live);
      for (const [pass, entry] of before) {
        let changed = false;
        const bindings = entry.bindings.map((binding) => {
          assertCurrent(live);
          const replacement = snapshotBindings(replace(binding));
          assertCurrent(live);
          changed ||= !equal(binding, replacement);
          return replacement;
        });
        assertCurrent(live);
        const bundle = changed
          ? buildEntry(next, pass, entry.device, bindings, counters, live)
          : entry.bundle;
        replacements.set(entry.bundle, bundle);
      }
      assertCurrent(live);
      ready = true;
      accepted = true;
      return ok(api);
    } catch (cause) {
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    } finally {
      if (!accepted) release();
    }
  }

  begin(
    pass: PreparedRasterPass,
    device: RhiDevice,
    counters: PreparedRasterCounters,
    current?: () => boolean,
  ): PreparedRasterRecording {
    const previous = this.#entries.get(pass);
    return new PreparedRasterRecording(
      this.#entries,
      previous?.device === device ? previous : { pass, device },
      counters,
      current,
    );
  }

  resolveOne(
    pass: PreparedRasterPass,
    device: RhiDevice,
    observed: PreparedRasterBindings,
    counters: PreparedRasterCounters,
    current?: () => boolean,
  ): RenderBundle {
    assertCurrent(current);
    const previous = this.#entries.get(pass);
    const before = previous?.bindings[0];
    if (
      previous?.device === device &&
      previous.bindings.length === 1 &&
      before !== undefined &&
      equal(before, observed)
    ) {
      assertCurrent(current);
      counters.hits++;
      return previous.bundle;
    }
    return buildEntry(this.#entries, pass, device, [snapshotBindings(observed)], counters, current);
  }

  retire(pass: PreparedRasterPass, counters: PreparedRasterCounters): void {
    if (this.#entries.delete(pass)) counters.evictions++;
  }
}
