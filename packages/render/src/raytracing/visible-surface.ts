import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { worldEntityKey } from '../record/frame-snapshot';
import type { FrameList } from '../scene/frame-list';
import { MaterialFrame } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { type ProjectedRows, RowProjection } from '../scene/row-projection';
import { SceneSlotFrame } from '../scene/scene-slots';
import { StableRangeAllocator } from '../stable-range-allocator';

/** One submitted raster address resolves through that frame's scene projection. */
export const VISIBLE_SURFACE_RECORD_WORDS = 16;

export interface VisibleSurfaceProjection {
  /**
   * 64-byte rows; zero is reserved for uncovered pixels, addresses start at one.
   * The live owner array: valid for the frame that requested it. A consumer that
   * outlives that frame (a capture or receipt) keeps its own copy.
   */
  readonly records: Uint32Array;
  /** Entity base + drawItemIndex * instanceCount + instanceOrdinal. */
  readonly slotBases: ReadonlyMap<number, number>;
  readonly entityBases: ReadonlyMap<number, number>;
  /** Changes exactly when some row address (base or row count) changes. */
  readonly layout: number;
}

export interface VisibleSurfaceIdentity {
  readonly slot: number;
  readonly generation: number;
  readonly worldId: number;
  readonly entityKey: number;
  readonly instanceOrdinal: number;
  /** Zero means a non-instanced entity; actual instances require owner generations. */
  readonly instanceGeneration: number;
  readonly drawItemIndex: number;
  readonly materialHandle: number;
  readonly assetHandle: number;
  readonly indexed: boolean;
  /** Element offset in the actual source draw, not a mesh-global primitive ID. */
  readonly firstElement: number;
  readonly baseVertex: number;
}

function invalid(expected: string, hint: string): Result<never, RhiError> {
  return err(new RhiError({ code: 'rhi-descriptor-invalid', expected, hint }));
}

type SurfaceRow = number | Result<never, RhiError>;

/** Project one scene row to its surface count; `undefined` publishes no rows (hidden, deformed or LOD). */
function surfaceRow(slot: RenderSceneSlot): SurfaceRow | undefined {
  const source = slot.snapshot;
  if (source.assetHandle === undefined) return undefined;
  const draws = source.gpuDrivenDraws ?? [];
  if (source.authorVisible === false || draws.length === 0) return undefined;
  // Deformed and LOD draws publish no rows until their producers publish matching
  // raster addresses: their pixels read as uncovered (row 0) instead of failing
  // every frame of a scene that also holds a skinned character.
  if (
    source.skinBinding !== undefined ||
    source.morph !== undefined ||
    (source.lods?.length ?? 0) > 0
  )
    return undefined;
  const instances = source.instances;
  const instanceCount = instances?.instanceCount ?? 1;
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 1) {
    return invalid(
      'a positive admitted instance count',
      'repair the Instances producer before preparing visible surfaces',
    );
  }
  if (instances !== undefined) {
    const generations = instances.generations;
    if (
      generations?.length !== instanceCount ||
      new Set(generations).size !== instanceCount ||
      generations.some((generation) => generation === 0)
    ) {
      return invalid(
        'unique nonzero owner generations for every instance',
        'publish stable Instances generations; ordinals alone cannot prove history after reordering or reuse',
      );
    }
  }
  let drawCount = 0;
  for (let index = 0; index < draws.length; index++) {
    const draw = draws[index] as (typeof draws)[number];
    const drawItem = gpuDrivenSourceDrawItemIndex(draw, index);
    let repeated = false;
    for (let other = 0; other < index && !repeated; other++)
      repeated = gpuDrivenSourceDrawItemIndex(draws[other] as typeof draw, other) === drawItem;
    if (
      !Number.isSafeInteger(drawItem) ||
      drawItem < 0 ||
      repeated ||
      draw.topology !== 'triangle-list' ||
      !Number.isInteger(draw.first) ||
      draw.first < 0 ||
      !Number.isInteger(draw.count) ||
      draw.count < 0 ||
      draw.count % 3 !== 0 ||
      draw.first + draw.count > 0xffff_ffff ||
      !Number.isInteger(draw.baseVertex) ||
      draw.baseVertex < -0x8000_0000 ||
      draw.baseVertex > 0x7fff_ffff
    ) {
      return invalid(
        'unique triangle-list source draw ranges',
        'repair source submesh identities and triangle ranges before raster admission',
      );
    }
    drawCount = Math.max(drawCount, drawItem + 1);
    if (source.materials[draw.materialSlot]?.snapshot === undefined)
      return invalid(
        'each visible draw resolves its own material slot',
        'repair the mesh/material binding before preparing the raster frame',
      );
  }
  const count = drawCount * instanceCount;
  if (!Number.isSafeInteger(count) || count > 0xffff_fffe)
    return invalid(
      'the complete visible-surface projection fits its row budget',
      'increase the explicit renderer budget or reduce admitted content; do not truncate contributors',
    );
  return count;
}

const NO_RANGE = -1;

/** The owner's slot-indexed columns the published base views read. */
interface SurfaceColumns {
  readonly starts: Float64Array;
  readonly entities: Float64Array;
  readonly ranges: number;
  readonly slots: FrameList<RenderSceneSlot> | undefined;
}

/** Base views read straight from the owner's columns; no Map entry per row. */
abstract class ColumnBases implements ReadonlyMap<number, number> {
  constructor(protected readonly view: SurfaceColumns) {}
  abstract get(key: number): number | undefined;
  protected abstract keyOf(slot: number, columns: SurfaceColumns): number;
  get size(): number {
    return this.view.ranges;
  }
  has(key: number): boolean {
    return this.get(key) !== undefined;
  }
  *entries(): MapIterator<[number, number]> {
    const columns = this.view;
    const starts = columns.starts;
    for (let slot = 0; slot < starts.length; slot++) {
      const start = starts[slot] as number;
      if (start !== NO_RANGE) yield [this.keyOf(slot, columns), start + 1];
    }
  }
  *keys(): MapIterator<number> {
    for (const [key] of this.entries()) yield key;
  }
  *values(): MapIterator<number> {
    for (const [, base] of this.entries()) yield base;
  }
  [Symbol.iterator](): MapIterator<[number, number]> {
    return this.entries();
  }
  forEach(visit: (base: number, key: number, map: ReadonlyMap<number, number>) => void): void {
    for (const [key, base] of this.entries()) visit(base, key, this);
  }
  protected base(slot: number | undefined, columns: SurfaceColumns): number | undefined {
    const start = slot === undefined ? undefined : columns.starts[slot];
    return start === undefined || start === NO_RANGE ? undefined : start + 1;
  }
}

/** Slot address -> base. */
class SlotBases extends ColumnBases {
  get(slot: number): number | undefined {
    return Number.isInteger(slot) && slot >= 0 ? this.base(slot, this.view) : undefined;
  }
  protected keyOf(slot: number): number {
    return slot;
  }
}

/** World entity key -> base, resolved through the projected frame's own identity map. */
class EntityBases extends ColumnBases {
  get(key: number): number | undefined {
    const columns = this.view;
    const slots = columns.slots;
    if (slots === undefined || !Number.isSafeInteger(key) || key < 0) return undefined;
    let slot: number | undefined;
    if (slots instanceof SceneSlotFrame)
      slot = slots.identitySlot(Math.floor(key / 0x1_0000_0000), key % 0x1_0000_0000);
    // Detached row lists (tests, captures) carry no identity map.
    else
      for (const record of slots)
        if (worldEntityKey(record.worldId, record.entityKey) === key) slot = record.slot;
    return slot !== undefined && columns.entities[slot] === key
      ? this.base(slot, columns)
      : undefined;
  }
  protected keyOf(slot: number, columns: SurfaceColumns): number {
    return columns.entities[slot] as number;
  }
}

/**
 * Visible-surface addresses of the retained scene, never a second identity
 * allocator: rows key RenderScene slots, and each slot's address range is
 * stable while its row count is. A steady frame re-projects only changed
 * scene rows and rewrites only their records. Ranges are slot-indexed
 * columns; no object per row.
 */
export class VisibleSurfaceRows {
  readonly #rows = new RowProjection<SurfaceRow>(surfaceRow);
  readonly #allocator = new StableRangeAllocator();
  /** Slot-indexed range start (`NO_RANGE` when the slot publishes no rows), count and entity key. */
  #starts = new Float64Array(0);
  #counts = new Uint32Array(0);
  #entities = new Float64Array(0);
  #ranges = 0;
  #slots: FrameList<RenderSceneSlot> | undefined;
  readonly #columns: SurfaceColumns = ((owner: VisibleSurfaceRows): SurfaceColumns => ({
    get starts() {
      return owner.#starts;
    },
    get entities() {
      return owner.#entities;
    },
    get ranges() {
      return owner.#ranges;
    },
    get slots() {
      return owner.#slots;
    },
  }))(this);
  readonly #slotBases = new SlotBases(this.#columns);
  readonly #entityBases = new EntityBases(this.#columns);
  readonly #failures = new Set<number>();
  #records = new Uint32Array(0);
  #rowCount = 0;
  #layout = 0;
  #projection: VisibleSurfaceProjection | undefined;

  /** Scene rows re-projected since construction. */
  get visits(): number {
    return this.#rows.visits;
  }

  /** Drop every derived address; the next update re-projects every scene row. */
  reset(): void {
    this.#rows.reset();
    this.#allocator.reset();
    this.#starts = new Float64Array(0);
    this.#counts = new Uint32Array(0);
    this.#entities = new Float64Array(0);
    this.#ranges = 0;
    this.#slots = undefined;
    this.#failures.clear();
    this.#records = new Uint32Array(0);
    this.#rowCount = 0;
    this.#layout++;
    this.#projection = undefined;
  }

  update(rows: ProjectedRows, maxRecords: number): Result<VisibleSurfaceProjection, RhiError> {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > 0xffff_fffe) {
      return invalid(
        'a bounded u32 visible-surface row budget',
        'set the renderer row budget before projection',
      );
    }
    const sync = this.#rows.sync(rows);
    this.#slots = rows.slots;
    const { changed, records } = sync;
    // Ascending slot order makes a layout independent of source order. A cold
    // pass over the slot frame is already ascending; only other orders sort.
    let order: readonly number[] | undefined;
    for (let i = 1; i < changed.length && order === undefined; i++)
      if ((changed[i] as number) < (changed[i - 1] as number))
        order = Array.from(changed.keys()).sort(
          (a, b) => (changed[a] as number) - (changed[b] as number),
        );
    if (changed.length > 0) this.#reserve(changed);
    // A cold pass sizes the record table once instead of doubling per write; from
    // an empty layout it takes one block and places rows densely in slot order.
    let bump = -1;
    if (sync.cold) {
      let total = 0;
      for (let i = 0; i < changed.length; i++) {
        const entry = this.#rows.get(changed[i] as number);
        if (typeof entry === 'number') total += entry;
      }
      if (this.#allocator.requiredCapacity() === 0 && total > 0)
        bump = this.#allocator.allocate(total);
      this.#grow(
        Math.min(this.#allocator.requiredCapacity() + total, maxRecords + 1) *
          VISIBLE_SURFACE_RECORD_WORDS,
      );
    }
    let layoutChanged = false;
    for (let i = 0; i < changed.length; i++) {
      const at = order === undefined ? i : (order[i] as number);
      const slot = changed[at] as number;
      const record = records[at];
      const entry = this.#rows.get(slot);
      if (entry !== undefined && typeof entry !== 'number') this.#failures.add(slot);
      else if (this.#failures.size > 0) this.#failures.delete(slot);
      const count = typeof entry === 'number' && record !== undefined ? entry : 0;
      const entity = record === undefined ? 0 : worldEntityKey(record.worldId, record.entityKey);
      let start = this.#starts[slot] as number;
      if (
        start !== NO_RANGE &&
        (count === 0 || this.#counts[slot] !== count || this.#entities[slot] !== entity)
      ) {
        this.#release(slot);
        start = NO_RANGE;
        layoutChanged = true;
      }
      if (count === 0 || record === undefined) continue;
      if (start === NO_RANGE) {
        if (bump >= 0) {
          start = bump;
          bump += count;
        } else start = this.#allocator.allocate(count);
        this.#starts[slot] = start;
        this.#counts[slot] = count;
        this.#entities[slot] = entity;
        this.#rowCount += count;
        this.#ranges++;
        layoutChanged = true;
      }
      this.#write(start, count, record);
    }
    const failure = this.#firstFailure();
    if (failure !== undefined) return failure;
    if (this.#rowCount > maxRecords)
      return invalid(
        'the complete visible-surface projection fits its row budget',
        'increase the explicit renderer budget or reduce admitted content; do not truncate contributors',
      );
    if (this.#allocator.requiredCapacity() > maxRecords) {
      this.#compact();
      layoutChanged = true;
    }
    if (layoutChanged) this.#layout++;
    if (layoutChanged || changed.length > 0 || this.#projection === undefined)
      this.#projection = {
        records: this.#records.subarray(
          0,
          this.#allocator.allocatedEnd() * VISIBLE_SURFACE_RECORD_WORDS,
        ),
        slotBases: this.#slotBases,
        entityBases: this.#entityBases,
        layout: this.#layout,
      };
    return ok(this.#projection);
  }

  #reserve(changed: readonly number[]): void {
    let max = -1;
    for (let i = 0; i < changed.length; i++) max = Math.max(max, changed[i] as number);
    if (max < this.#starts.length) return;
    const size = Math.max(max + 1, this.#starts.length * 2, 64);
    const starts = new Float64Array(size).fill(NO_RANGE);
    starts.set(this.#starts);
    this.#starts = starts;
    const counts = new Uint32Array(size);
    counts.set(this.#counts);
    this.#counts = counts;
    const entities = new Float64Array(size);
    entities.set(this.#entities);
    this.#entities = entities;
  }

  #grow(words: number): void {
    if (words <= this.#records.length) return;
    const grown = new Uint32Array(Math.max(words, this.#records.length * 2));
    grown.set(this.#records);
    this.#records = grown;
  }

  #release(slot: number): void {
    const start = this.#starts[slot] as number;
    const count = this.#counts[slot] as number;
    this.#records.fill(
      0,
      start * VISIBLE_SURFACE_RECORD_WORDS,
      (start + count) * VISIBLE_SURFACE_RECORD_WORDS,
    );
    this.#allocator.release(start, count);
    this.#starts[slot] = NO_RANGE;
    this.#rowCount -= count;
    this.#ranges--;
  }

  /** Draw holes preserve the original submesh address after transparent filtering. */
  #write(start: number, count: number, slot: RenderSceneSlot): void {
    const end = (start + count) * VISIBLE_SURFACE_RECORD_WORDS;
    this.#grow(end);
    const words = this.#records;
    words.fill(0, start * VISIBLE_SURFACE_RECORD_WORDS, end);
    const source = slot.snapshot;
    const instanceCount = source.instances?.instanceCount ?? 1;
    const generations = source.instances?.generations;
    const draws = source.gpuDrivenDraws ?? [];
    for (let index = 0; index < draws.length; index++) {
      const draw = draws[index] as (typeof draws)[number];
      const drawItemIndex = gpuDrivenSourceDrawItemIndex(draw, index);
      const material = source.materials[draw.materialSlot]?.snapshot;
      for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal++) {
        const at =
          (start + drawItemIndex * instanceCount + instanceOrdinal) * VISIBLE_SURFACE_RECORD_WORDS;
        words[at] = slot.slot;
        words[at + 1] = slot.generation;
        words[at + 2] = slot.worldId;
        words[at + 3] = slot.entityKey;
        words[at + 4] = instanceOrdinal;
        words[at + 5] = generations?.[instanceOrdinal] ?? 0;
        words[at + 6] = drawItemIndex;
        words[at + 7] = material?.materialHandle ?? 0;
        words[at + 8] = source.assetHandle ?? 0;
        words[at + 9] = draw.first;
        words[at + 10] = draw.count;
        words[at + 11] = draw.baseVertex;
        words[at + 12] = draw.kind === 'indexed' ? 1 : 0;
      }
    }
  }

  #firstFailure(): Result<never, RhiError> | undefined {
    let first: number | undefined;
    for (const slot of this.#failures) if (first === undefined || slot < first) first = slot;
    const entry = first === undefined ? undefined : this.#rows.get(first);
    return entry !== undefined && typeof entry !== 'number' ? entry : undefined;
  }

  /** Re-place every range densely in slot order once holes exceed the row budget. */
  #compact(): void {
    const previous = this.#records;
    this.#allocator.reset();
    this.#records = new Uint32Array(this.#rowCount * VISIBLE_SURFACE_RECORD_WORDS);
    const starts = this.#starts;
    for (let slot = 0; slot < starts.length; slot++) {
      const from = starts[slot] as number;
      if (from === NO_RANGE) continue;
      const count = this.#counts[slot] as number;
      const start = this.#allocator.allocate(count);
      this.#records.set(
        previous.subarray(
          from * VISIBLE_SURFACE_RECORD_WORDS,
          (from + count) * VISIBLE_SURFACE_RECORD_WORDS,
        ),
        start * VISIBLE_SURFACE_RECORD_WORDS,
      );
      starts[slot] = start;
    }
  }
}

/** One cold projection of a fixed row list, for consumers that rebuild their own snapshot. */
export function projectVisibleSurfaces(
  slots: FrameList<RenderSceneSlot>,
  maxRecords: number,
  rows: Omit<ProjectedRows, 'slots' | 'identity'> = {
    materials: new MaterialFrame(undefined),
    meshes: new MeshFrame(),
  },
): Result<VisibleSurfaceProjection, RhiError> {
  return new VisibleSurfaceRows().update({ ...rows, identity: {}, slots }, maxRecords);
}

/** Debug/reference decode of the same row the GPU consumes; no triangle search. */
export function resolveVisibleSurface(
  projection: Pick<VisibleSurfaceProjection, 'records'>,
  row: number,
  primitive: number,
): Result<VisibleSurfaceIdentity | undefined, RhiError> {
  if (row === 0) return ok(undefined);
  const offset = (row - 1) * VISIBLE_SURFACE_RECORD_WORDS;
  const words = projection.records;
  if (
    !Number.isInteger(row) ||
    row < 1 ||
    offset + VISIBLE_SURFACE_RECORD_WORDS > words.length ||
    // RenderScene generations start at zero. A hole has no source elements;
    // generation zero must never be used as a missing-record sentinel.
    words[offset + 10] === 0
  ) {
    return invalid(
      'a covered raster row from the same submitted frame',
      'use the projection retained with this capture/receipt, not the latest live scene',
    );
  }
  if (!Number.isInteger(primitive) || primitive < 0 || primitive >= (words[offset + 10] ?? 0) / 3) {
    return invalid(
      'a draw-local primitive inside the captured source range',
      'inspect the selected raster draw and its matching frame projection',
    );
  }
  return ok({
    slot: words[offset] ?? 0,
    generation: words[offset + 1] ?? 0,
    worldId: words[offset + 2] ?? 0,
    entityKey: words[offset + 3] ?? 0,
    instanceOrdinal: words[offset + 4] ?? 0,
    instanceGeneration: words[offset + 5] ?? 0,
    drawItemIndex: words[offset + 6] ?? 0,
    materialHandle: words[offset + 7] ?? 0,
    assetHandle: words[offset + 8] ?? 0,
    firstElement: (words[offset + 9] ?? 0) + primitive * 3,
    baseVertex: (words[offset + 11] ?? 0) | 0,
    indexed: words[offset + 12] === 1,
  });
}
