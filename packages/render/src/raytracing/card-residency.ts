import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import type { CardCaptureScheduler } from './card-capture-schedule';
import {
  type FieldEdit,
  type FieldEditBounds,
  type FieldEditState,
  worldBounds,
} from './field-edit';
import type { IndexRun } from './index-allocator';
import type { SceneFieldSource } from './scene-field-projection';
import type { SdfMeshInstance } from './sdf-query';
import {
  packCardProjection,
  type SurfaceCapture,
  type SurfaceCaptureSource,
} from './surface-cards';

const CARD_PROJECTION_BYTES = 80;
/** A resident instance keeps its Cards until a candidate outranks it by this factor. */
export const CARD_RESIDENCY_HYSTERESIS = 1.5;
/** Residents streaming may evict per frame. */
const EVICTIONS_PER_FRAME = 8;

export type CardResidencyFocus = readonly [number, number, number];

/**
 * Residency priority of one instance's world bounds: its angular size from the
 * nearest view focus, `radius / max(distance, radius)` in (0, 1]. With no active
 * view the radius alone ranks it.
 */
export function cardResidencyScore(
  bounds: FieldEditBounds,
  focuses: readonly CardResidencyFocus[],
): number {
  const center = [0, 1, 2].map((a) => 0.5 * ((bounds.min[a] ?? 0) + (bounds.max[a] ?? 0)));
  const radius =
    0.5 *
    Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
  if (focuses.length === 0) return radius;
  let best = 0;
  for (const focus of focuses) {
    const distance = Math.hypot(
      (center[0] ?? 0) - focus[0],
      (center[1] ?? 0) - focus[1],
      (center[2] ?? 0) - focus[2],
    );
    best = Math.max(best, radius / Math.max(distance, radius, 1e-6));
  }
  return best;
}

/** Rows by descending score, ties by ascending row: the deterministic install order. */
export function rankCardResidency(
  rows: readonly { readonly row: number; readonly score: number }[],
): number[] {
  return [...rows].sort((a, b) => b.score - a.score || a.row - b.row).map((r) => r.row);
}

/** Card residency counters: `resident + pending` is every field instance with Cards. */
export interface CardResidencyInspection {
  /** Instances whose Cards are installed and captured. */
  readonly resident: number;
  /** Instances without captured Cards: not resident, or installed and still capturing. */
  readonly pending: number;
  /** Cumulative evictions since the field was prepared. */
  readonly evicted: number;
}

type CardLower = (
  source: SceneFieldSource,
  instance: SdfMeshInstance,
  row: number,
) => SurfaceCaptureSource;

interface Candidate {
  readonly source: SceneFieldSource;
  readonly instance: SdfMeshInstance;
}

/**
 * Streams Card capture data of one editable field under its atlas and byte ceilings.
 * Every field instance is a candidate; the capture holds the highest-priority set
 * (see {@link cardResidencyScore}) and a resident leaves only for a candidate that
 * outranks it by {@link CARD_RESIDENCY_HYSTERESIS}. An install writes its lookup
 * rows as pending (`ids.y = 2`): lookups treat them as unlit until the scheduler
 * covers their tiles with a submitted capture, then they validate (`ids.y = 1`).
 * Eviction invalidates rows immediately; retired buffers die after the next
 * tracked submission. While any instance is pending, `settings.z = 1` turns hits
 * on instances without captured Cards into unlit rays that keep probe history.
 * The owner is traversal-agnostic: it writes only lookup rows and that flag, which
 * `worldCardRadiance` reads after either `traceWorld` (Global SDF or Ray Query).
 */
export class CardResidency {
  readonly #device: RhiDevice;
  readonly #capture: SurfaceCapture;
  readonly #projections: { readonly buffer: Buffer };
  readonly #settings: { readonly buffer: Buffer };
  readonly #lower: CardLower;
  readonly #state: FieldEditState;
  readonly #candidates = new Map<number, Candidate>();
  readonly #lowered = new Map<number, SurfaceCaptureSource>();
  readonly #unfit = new Set<number>();
  #capturing: { row: number; run: IndexRun }[] = [];
  #admitting = false;
  /** The last install hit a ceiling: only an outranked resident's eviction frees room. */
  #full = false;
  #evicted = 0;
  #pendingFlag = -1;

  constructor(
    device: RhiDevice,
    cards: {
      readonly capture: SurfaceCapture;
      readonly projections: { readonly buffer: Buffer };
      readonly settings: { readonly buffer: Buffer };
      readonly lower: CardLower;
    },
    state: FieldEditState,
    sources: readonly SceneFieldSource[],
    instances: readonly SdfMeshInstance[],
  ) {
    this.#device = device;
    this.#capture = cards.capture;
    this.#projections = cards.projections;
    this.#settings = cards.settings;
    this.#lower = cards.lower;
    this.#state = state;
    for (const source of sources)
      for (let ordinal = 0; ordinal < (source.instances?.instanceCount ?? 1); ordinal++) {
        const instance = instances[source.firstInstance + ordinal];
        if (instance !== undefined && source.mesh.cardLayout !== undefined)
          this.#candidates.set(instance.instanceId, { source, instance });
      }
  }

  /** Follows an applied in-place edit; `added` holds each add's Global row. */
  applyEdit(edit: FieldEdit, added: readonly number[]): void {
    for (const move of edit.moved) this.#lowered.delete(move.index);
    for (const removal of edit.removed) this.#forget(removal.index);
    for (const change of edit.rematerialized) {
      this.#forget(change.index);
      this.#candidates.set(change.index, { source: change.source, instance: change.instance });
    }
    edit.added.forEach((add, i) => {
      const row = added[i];
      if (row !== undefined)
        this.#candidates.set(row, { source: add.source, instance: add.instance });
    });
    this.#full = false;
  }

  #forget(row: number): void {
    this.#candidates.delete(row);
    this.#lowered.delete(row);
    this.#unfit.delete(row);
    this.#capturing = this.#capturing.filter((c) => c.row !== row);
  }

  /**
   * One frame of streaming: validate captured installs, then install the best
   * candidates up to `tileLimit` new tiles, evicting outranked residents when a
   * ceiling is hit. Installs queue their tiles on `schedule`.
   */
  stream(
    focuses: readonly CardResidencyFocus[],
    schedule: CardCaptureScheduler,
    tileLimit: number,
  ): void {
    const capture = this.#capture;
    this.#capturing = this.#capturing.filter(({ row, run }) => {
      if (!capture.has(row)) return false;
      if (!schedule.covers(run)) return true;
      for (let tile = run.first; tile < run.end; tile++)
        this.#write(this.#projections, tile * CARD_PROJECTION_BYTES + 68, new Uint32Array([1]));
      return false;
    });
    if (!this.#admitting) this.#install(focuses, schedule, tileLimit);
    const pending = this.inspect().pending > 0;
    if (this.#pendingFlag !== Number(pending)) {
      this.#pendingFlag = Number(pending);
      this.#write(this.#settings, 8, new Uint32Array([this.#pendingFlag]));
    }
  }

  #install(
    focuses: readonly CardResidencyFocus[],
    schedule: CardCaptureScheduler,
    tileLimit: number,
  ): void {
    const capture = this.#capture;
    const scores = new Map<number, number>();
    const transforms = new Map<number, Float32Array>();
    for (const entry of this.#state.values())
      if (this.#candidates.has(entry.index)) {
        transforms.set(entry.index, entry.transform);
        scores.set(
          entry.index,
          cardResidencyScore(worldBounds(entry.local, entry.transform), focuses),
        );
      }
    const score = (row: number) => scores.get(row) ?? 0;
    const waiting = rankCardResidency(
      [...this.#candidates.keys()]
        .filter((row) => !capture.has(row) && !this.#unfit.has(row))
        .map((row) => ({ row, score: score(row) })),
    );
    if (waiting.length === 0) return;
    // Lowest kept score first; ties evict the higher row.
    const residents = [...this.#candidates.keys()]
      .filter((row) => capture.has(row))
      .map((row) => ({ row, kept: score(row) * CARD_RESIDENCY_HYSTERESIS }))
      .sort((a, b) => a.kept - b.kept || b.row - a.row);
    let evictions = 0;
    let tiles = 0;
    const high = capture.allocatedTiles;
    const evictFor = (candidate: number) => {
      const victim = residents[0];
      if (
        victim === undefined ||
        evictions >= EVICTIONS_PER_FRAME ||
        victim.kept >= score(candidate)
      )
        return false;
      residents.shift();
      this.#evict(victim.row);
      evictions++;
      return true;
    };
    for (const row of waiting) {
      if (tiles >= tileLimit) break;
      if (this.#full && !evictFor(row)) break;
      const candidate = this.#candidates.get(row);
      if (candidate === undefined) continue;
      let lowered = this.#lowered.get(row);
      try {
        if (lowered === undefined) {
          const transform = transforms.get(row) ?? candidate.instance.transform;
          lowered = this.#lower(candidate.source, { ...candidate.instance, transform }, row);
          this.#lowered.set(row, lowered);
        }
      } catch {
        this.#unfit.add(row);
        continue;
      }
      if (lowered.layout.cards.length > capture.capacity) {
        this.#unfit.add(row);
        continue;
      }
      if (!capture.admitted(lowered)) {
        this.#admitting = true;
        void capture
          .admit(lowered)
          .then(
            (admitted) => {
              if (!admitted.ok) this.#unfit.add(row);
            },
            () => this.#unfit.add(row),
          )
          .finally(() => {
            this.#admitting = false;
          });
        return;
      }
      let added = capture.add(lowered);
      while (!added.ok && added.error.code === 'ray-reference-limit' && evictFor(row))
        added = capture.add(lowered);
      if (!added.ok) {
        if (added.error.code !== 'ray-reference-limit') {
          this.#unfit.add(row);
          continue;
        }
        this.#full = true;
        break;
      }
      this.#full = false;
      const run = { first: added.value.first, end: added.value.first + added.value.count };
      this.#writeRows(row, run, 2);
      schedule.queue([run]);
      schedule.grow(capture.allocatedTiles);
      this.#capturing.push({ row, run });
      tiles += added.value.count;
    }
    if (capture.allocatedTiles !== high)
      this.#write(this.#settings, 0, new Uint32Array([capture.allocatedTiles]));
  }

  #evict(row: number): void {
    const removed = this.#capture.remove(row);
    if (!removed.ok) return;
    const bytes = new Uint8Array(removed.value.count * CARD_PROJECTION_BYTES);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < removed.value.count; i++)
      view.setUint32(i * CARD_PROJECTION_BYTES + 64, 0xffffffff, true);
    this.#write(this.#projections, removed.value.first * CARD_PROJECTION_BYTES, bytes);
    this.#capturing = this.#capturing.filter((c) => c.row !== row);
    this.#evicted++;
  }

  #writeRows(row: number, run: IndexRun, valid: number): void {
    const entry = this.#capture.entries.find((e) => e.instanceId === row);
    if (entry === undefined) return;
    const bytes = new Uint8Array((run.end - run.first) * CARD_PROJECTION_BYTES);
    const view = new DataView(bytes.buffer);
    entry.projections.forEach((p, i) => {
      bytes.set(packCardProjection(p), i * CARD_PROJECTION_BYTES);
      view.setUint32(i * CARD_PROJECTION_BYTES + 64, row, true);
      view.setUint32(i * CARD_PROJECTION_BYTES + 68, valid, true);
    });
    this.#write(this.#projections, run.first * CARD_PROJECTION_BYTES, bytes);
  }

  #write(target: { readonly buffer: Buffer }, offset: number, data: ArrayBufferView): void {
    this.#device.queue
      .writeBuffer(
        target.buffer,
        offset,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      .unwrap();
  }

  inspect(): CardResidencyInspection {
    const installed = [...this.#candidates.keys()].filter((row) => this.#capture.has(row)).length;
    const resident = installed - this.#capturing.length;
    return { resident, pending: this.#candidates.size - resident, evicted: this.#evicted };
  }
}
