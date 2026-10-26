import type { RenderBundle } from '@forgeax/engine-rhi';

type MaterialOwner = { readonly group: object; readonly offset: number };
type ClassOwner = { readonly pipeline: object; readonly mesh: object };

/** Recorded inputs and output of one contiguous bundled run of live batches. */
export interface RetainedRasterBlock {
  /** The live batch owners of the run, in encode order. */
  readonly lives: readonly object[];
  /** Two physical buffer handles (vertex, index) per live batch. */
  readonly physical: readonly unknown[];
  readonly materials: Map<number, MaterialOwner>;
  readonly classes: Map<object, ClassOwner>;
  bundle: RenderBundle | undefined;
  /** NaN marks a run with per-frame inputs (Skin task offsets); it is never replayed. */
  draws: number;
}

function sameList(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++)
    if (!Object.is(left[index], right[index])) return false;
  return true;
}

/**
 * One pass encode's view of its retained runs. A run whose live owners,
 * physical buffers and re-resolved material, pipeline and mesh groups all
 * match replays its bundle without visiting its batches. Owners are resolved
 * at most once per encode.
 */
export class RetainedPassEncode {
  readonly #next = new Map<object, RetainedRasterBlock>();
  readonly #materials = new Map<number, MaterialOwner | undefined>();
  readonly #classes = new Map<object, ClassOwner | undefined>();
  readonly #physical: unknown[] = [];
  constructor(
    private readonly previous: ReadonlyMap<object, RetainedRasterBlock> | undefined,
    private readonly resolveMaterial: (slot: number) => MaterialOwner | undefined,
    private readonly resolveClass: (rasterClass: object) => ClassOwner | undefined,
  ) {}

  /** Retained output of the run `lives[start..end)`, if every input still matches. */
  reuse(
    lives: readonly object[],
    start: number,
    end: number,
    physicalOf: (live: object, out: unknown[]) => void,
  ): RetainedRasterBlock | undefined {
    const first = lives[start];
    const block = first === undefined ? undefined : this.previous?.get(first);
    if (block === undefined || Number.isNaN(block.draws) || block.lives.length !== end - start)
      return undefined;
    for (let index = start; index < end; index++)
      if (block.lives[index - start] !== lives[index]) return undefined;
    // One scratch list per encode: a replayed run allocates nothing.
    const physical = this.#physical;
    physical.length = 0;
    for (let index = start; index < end; index++) physicalOf(lives[index] as object, physical);
    const same = sameList(block.physical, physical);
    physical.length = 0;
    if (!same) return undefined;
    for (const [slot, expected] of block.materials) {
      let actual = this.#materials.get(slot);
      if (!this.#materials.has(slot)) {
        actual = this.resolveMaterial(slot);
        this.#materials.set(slot, actual);
      }
      if (actual?.group !== expected.group || actual.offset !== expected.offset) return undefined;
    }
    for (const [rasterClass, expected] of block.classes) {
      let actual = this.#classes.get(rasterClass);
      if (!this.#classes.has(rasterClass)) {
        actual = this.resolveClass(rasterClass);
        this.#classes.set(rasterClass, actual);
      }
      if (actual?.pipeline !== expected.pipeline || actual.mesh !== expected.mesh) return undefined;
    }
    this.#next.set(first as object, block);
    return block;
  }

  /** Start recording the run `lives[start..end)`; its bundle is attached when flushed. */
  record(
    lives: readonly object[],
    start: number,
    end: number,
    physicalOf: (live: object, out: unknown[]) => void,
  ): RetainedRasterBlock {
    const physical: unknown[] = [];
    for (let index = start; index < end; index++) physicalOf(lives[index] as object, physical);
    const block: RetainedRasterBlock = {
      lives: lives.slice(start, end),
      physical,
      materials: new Map(),
      classes: new Map(),
      bundle: undefined,
      draws: 0,
    };
    this.#next.set(lives[start] as object, block);
    return block;
  }

  /** Runs of this encode; every other retained run is released. */
  get blocks(): ReadonlyMap<object, RetainedRasterBlock> {
    return this.#next;
  }
}

/**
 * The retained runs of each pass key. Pass identities (view, tables, indirect
 * buffer, regions, formats, raster classes) gate every run; entries unused in
 * the current or previous frame are released, so no older plan or frame
 * owner stays reachable.
 */
export class RetainedRasterEncodes {
  readonly #passes = new Map<
    object,
    {
      identities: readonly unknown[];
      blocks: ReadonlyMap<object, RetainedRasterBlock>;
      frame: number;
    }
  >();
  #frame = 0;

  beginFrame(): void {
    this.#frame++;
    for (const [key, entry] of this.#passes)
      if (entry.frame < this.#frame - 1) this.#passes.delete(key);
  }

  begin(
    key: object,
    identities: readonly unknown[],
    resolveMaterial: (slot: number) => MaterialOwner | undefined,
    resolveClass: (rasterClass: object) => ClassOwner | undefined,
  ): RetainedPassEncode {
    const entry = this.#passes.get(key);
    const previous =
      entry !== undefined && sameList(entry.identities, identities) ? entry.blocks : undefined;
    // A failed encode leaves no partially recorded runs behind.
    this.#passes.delete(key);
    return new RetainedPassEncode(previous, resolveMaterial, resolveClass);
  }

  finish(key: object, identities: readonly unknown[], encode: RetainedPassEncode): void {
    this.#passes.set(key, { identities, blocks: encode.blocks, frame: this.#frame });
  }

  clear(): void {
    this.#passes.clear();
  }

  get size(): number {
    return this.#passes.size;
  }
}

/** Resolved material owner of a prepared material binding. */
export function materialOwner(
  prepared: { readonly group: object; readonly byteOffset: number } | undefined,
): MaterialOwner | undefined {
  return prepared === undefined
    ? undefined
    : { group: prepared.group, offset: prepared.byteOffset };
}

/** Resolved pipeline and group(2) owner of a raster class. */
export function classOwner(
  pipeline: { readonly ok: boolean; readonly value?: unknown },
  mesh: object | undefined,
): ClassOwner | undefined {
  return pipeline.ok &&
    mesh !== undefined &&
    typeof pipeline.value === 'object' &&
    pipeline.value !== null
    ? { pipeline: pipeline.value, mesh }
    : undefined;
}

/** Physical vertex and index handles of a live raster batch. */
export function livePhysical(live: object, out: unknown[]): void {
  const binding = (
    live as { readonly meshBinding: { readonly vertex: unknown; readonly index: unknown } }
  ).meshBinding;
  out.push(binding.vertex, binding.index);
}

interface RunLive {
  readonly meshBinding: { readonly vertex: unknown; readonly index: unknown };
  readonly materialBindingClass: string;
  readonly batch: {
    readonly key: { readonly materialSlot: number };
    readonly binding?: { readonly material: object };
  };
}

/**
 * Per-live facts a replayed run depends on: physical buffers and the material
 * slot and selection it resolves through this frame's (in-place) slot table.
 */
export function runFacts(
  eligible: (live: object) => boolean,
  slotsByBinding: ReadonlyMap<object, ReadonlyMap<string, number>>,
  selected: ReadonlySet<number> | undefined,
): (owner: object, out: unknown[]) => void {
  return (owner, out) => {
    livePhysical(owner, out);
    const live = owner as RunLive;
    const material = live.batch.binding?.material;
    const slot = !eligible(owner)
      ? undefined
      : slotsByBinding.size === 0
        ? live.batch.key.materialSlot
        : material === undefined
          ? undefined
          : slotsByBinding.get(material)?.get(live.materialBindingClass);
    out.push(slot === undefined ? -1 : selected?.has(slot) === false ? -2 - slot : slot);
  };
}
