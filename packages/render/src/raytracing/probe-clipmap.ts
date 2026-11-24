import type { FieldEditBounds } from './field-edit';
import type { IrradianceFieldPlan } from './irradiance-field-plan';
import { splitProbeBudget } from './probe-budget';
import { PROBE_ENTRY_FAST, PROBE_ENTRY_FRESH } from './probe-entry';

export { PROBE_ENTRY_FAST, PROBE_ENTRY_FRESH, PROBE_ENTRY_INDEX } from './probe-entry';

/** Integer lattice cell of one clipmap level, relative to the plan origin. */
export type ProbeCell = readonly [number, number, number];

/** Half-open cell box `[min, max)` of one level. */
interface ProbeBox {
  readonly level: number;
  readonly min: ProbeCell;
  readonly max: ProbeCell;
}

/** Edited probes sweep this many times at fast hysteresis once Cards relit. */
export const PROBE_EDIT_SWEEPS = 3;

/** Reserve one ordinary probe every four committed frames during repeated edits. */
const REPEATED_EDIT_ROTATION_PERIOD = 4;

export type ProbeClipmapPlan = Pick<
  IrradianceFieldPlan,
  | 'origin'
  | 'spacing'
  | 'dimensions'
  | 'levels'
  | 'levelBudgets'
  | 'probeBudget'
  | 'probeCount'
  | 'follow'
>;

const boxCount = (box: Pick<ProbeBox, 'min' | 'max'>) =>
  Math.max(0, box.max[0] - box.min[0]) *
  Math.max(0, box.max[1] - box.min[1]) *
  Math.max(0, box.max[2] - box.min[2]);

const mod = (value: number, n: number) => ((value % n) + n) % n;
const cell3 = (f: (axis: 0 | 1 | 2) => number): ProbeCell => [f(0), f(1), f(2)];

const levelSpacing = (plan: Pick<ProbeClipmapPlan, 'spacing'>, level: number) =>
  plan.spacing * 2 ** level;

/** Window min cell of `level` centred on `focus`, snapped to that level's spacing. */
export function clipmapWindow(plan: ProbeClipmapPlan, level: number, focus: ProbeCell): ProbeCell {
  const spacing = levelSpacing(plan, level);
  return cell3(
    (a) =>
      Math.floor(((focus[a] ?? 0) - plan.origin[a]) / spacing) - Math.floor(plan.dimensions[a] / 2),
  );
}

/** Toroidal storage index of a level cell: the physical slot is the cell modulo the lattice. */
export function probeIndex(plan: ProbeClipmapPlan, level: number, cell: ProbeCell): number {
  const [dx, dy, dz] = plan.dimensions;
  const x = mod(cell[0], dx),
    y = mod(cell[1], dy),
    z = mod(cell[2], dz);
  return level * dx * dy * dz + (z * dy + y) * dx + x;
}

/** World cell held by a storage index under `window`: the inverse of {@link probeIndex}. */
export function probeCell(
  plan: ProbeClipmapPlan,
  window: ProbeCell,
  index: number,
): { readonly level: number; readonly cell: ProbeCell } {
  const [dx, dy, dz] = plan.dimensions;
  const per = dx * dy * dz;
  const level = Math.floor(index / per);
  const local = index - level * per;
  const p = [local % dx, Math.floor(local / dx) % dy, Math.floor(local / (dx * dy))];
  return {
    level,
    cell: cell3((a) => (window[a] ?? 0) + mod((p[a] ?? 0) - (window[a] ?? 0), plan.dimensions[a])),
  };
}

const intersect = (a: Pick<ProbeBox, 'min' | 'max'>, b: Pick<ProbeBox, 'min' | 'max'>) => {
  const min = cell3((i) => Math.max(a.min[i], b.min[i]));
  const max = cell3((i) => Math.min(a.max[i], b.max[i]));
  return boxCount({ min, max }) > 0 ? { min, max } : { min, max: min };
};

/** Count the retained tasks before an old x-fastest traversal cursor. Clipping
 * changes task ordinals, not which world cells already received this sweep. */
function clippedPrefixCount(box: ProbeBox, clipped: ProbeBox, prefix: number): number {
  if (prefix >= boxCount(box)) return boxCount(clipped);
  const dx = box.max[0] - box.min[0];
  const dy = box.max[1] - box.min[1];
  const z = box.min[2] + Math.floor(prefix / (dx * dy));
  const y = box.min[1] + Math.floor((prefix % (dx * dy)) / dx);
  const x = box.min[0] + (prefix % dx);
  const before = (axis: 0 | 1 | 2, coordinate: number) =>
    Math.max(0, Math.min(clipped.max[axis], coordinate) - clipped.min[axis]);
  const width = clipped.max[0] - clipped.min[0];
  const height = clipped.max[1] - clipped.min[1];
  let count = before(2, z) * width * height;
  if (z >= clipped.min[2] && z < clipped.max[2]) {
    count += before(1, y) * width;
    if (y >= clipped.min[1] && y < clipped.max[1]) count += before(0, x);
  }
  return count;
}

/**
 * Newly exposed cells of `window` outside the still-valid box `valid` (inside
 * `window`), as at most two slabs per axis in x, y, z order. Each slab spans the
 * box grown so far on the other axes, so completing the slabs in order keeps the
 * valid region a box; an empty `valid` exposes the whole window as one slab.
 */
export function exposedSlabs(
  level: number,
  valid: Pick<ProbeBox, 'min' | 'max'>,
  window: Pick<ProbeBox, 'min' | 'max'>,
): ProbeBox[] {
  if (boxCount(valid) === 0) return [{ level, min: window.min, max: window.max }];
  const out: ProbeBox[] = [];
  const lo = [...valid.min];
  const hi = [...valid.max];
  const cell = (v: number[]): ProbeCell => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  for (let axis = 0; axis < 3; axis++) {
    const wMin = window.min[axis] ?? 0;
    const wMax = window.max[axis] ?? 0;
    if (wMin < (lo[axis] ?? 0)) {
      const max = [...hi];
      max[axis] = lo[axis] ?? 0;
      const min = [...lo];
      min[axis] = wMin;
      out.push({ level, min: cell(min), max: cell(max) });
    }
    if (wMax > (hi[axis] ?? 0)) {
      const min = [...lo];
      min[axis] = hi[axis] ?? 0;
      const max = [...hi];
      max[axis] = wMax;
      out.push({ level, min: cell(min), max: cell(max) });
    }
    lo[axis] = wMin;
    hi[axis] = wMax;
  }
  return out;
}

/** Append only cells the existing same-level edit boxes do not own. */
function appendEditBox(boxes: ProbeBox[], box: ProbeBox): void {
  let uncovered = [box];
  for (const covered of boxes) {
    if (covered.level !== box.level) continue;
    const remaining: ProbeBox[] = [];
    for (const piece of uncovered) {
      const overlap = intersect(covered, piece);
      if (boxCount(overlap) === 0) remaining.push(piece);
      else remaining.push(...exposedSlabs(piece.level, overlap, piece));
    }
    if (remaining.length === 0) return;
    uncovered = remaining;
  }
  boxes.push(...uncovered);
}

interface EditSweep {
  boxes: ProbeBox[];
  cursor: number;
  end: number;
  count: number;
  rotationPhase: number | undefined;
}

interface Level {
  window: ProbeCell;
  valid: { min: ProbeCell; max: ProbeCell };
  /** Pending exposed slabs; the head is traced first. */
  slabs: ProbeBox[];
  slabCursor: number;
  rotation: number;
}

/** One frame's probe work: storage indices with flags, and how to advance on commit. */
export interface ProbeFrameSchedule {
  readonly list: Uint32Array;
  readonly count: number;
  readonly fresh: number;
  readonly priority: number;
  readonly rotation: readonly number[];
  readonly slabs: readonly number[];
}

export interface ProbeClipmapInspection {
  readonly levels: number;
  readonly levelBudgets: readonly number[];
  readonly windows: readonly ProbeCell[];
  readonly valid: readonly { readonly min: ProbeCell; readonly max: ProbeCell }[];
  /** Window moves applied, per level. */
  readonly scrolls: readonly number[];
  /** Probes queued for a fresh trace because a scroll exposed them. */
  readonly exposedProbes: number;
  readonly pendingExposedProbes: number;
}

/**
 * The single probe scheduler of a field: exposed clipmap slabs first (fresh
 * history), then edited probes (fast hysteresis sweeps), then per-level
 * budgeted round-robin. It only advances on {@link commit} of a physically
 * submitted frame's schedule, so failed submits replay the same work.
 */
export class ProbeClipmapScheduler {
  readonly #plan: ProbeClipmapPlan;
  readonly #levels: Level[];
  readonly #per: number;
  #pendingEdit: FieldEditBounds[] = [];
  #edit: EditSweep | undefined;
  #cached: ProbeFrameSchedule | undefined;
  #limit: number;
  #tinyLevel = 0;
  #exposed = 0;
  readonly #scrolls: number[];

  constructor(plan: ProbeClipmapPlan, focus?: ProbeCell) {
    this.#plan = plan;
    this.#limit = plan.probeBudget;
    const [dx, dy, dz] = plan.dimensions;
    this.#per = dx * dy * dz;
    this.#scrolls = Array.from({ length: plan.levels }, () => 0);
    this.#levels = Array.from({ length: plan.levels }, (_, level) => {
      const window =
        plan.follow && focus !== undefined
          ? clipmapWindow(plan, level, focus)
          : ([0, 0, 0] as ProbeCell);
      return {
        window,
        // Untraced probes are invalid by meta, so the whole first window counts as valid.
        valid: { min: window, max: this.#max(window) },
        slabs: [],
        slabCursor: 0,
        rotation: 0,
      };
    });
  }

  #max(window: ProbeCell): ProbeCell {
    return cell3((a) => (window[a] ?? 0) + this.#plan.dimensions[a]);
  }

  /** Re-centre every level on `focus`; returns the probes newly exposed. */
  focus(focus: ProbeCell): number {
    if (!this.#plan.follow) return 0;
    let exposed = 0;
    this.#levels.forEach((level, index) => {
      const window = clipmapWindow(this.#plan, index, focus);
      if (window.every((v, a) => v === level.window[a])) return;
      const box = { min: window, max: this.#max(window) };
      level.window = window;
      level.valid = intersect(level.valid, box);
      level.slabs = exposedSlabs(index, level.valid, box);
      level.slabCursor = 0;
      this.#scrolls[index] = (this.#scrolls[index] ?? 0) + 1;
      const count = level.slabs.reduce((n, slab) => n + boxCount(slab), 0);
      exposed += count;
    });
    // Edited cells outside the new windows are fresh slab probes now.
    if (exposed > 0 && this.#edit !== undefined) this.#edit = this.#clipEdit(this.#edit);
    this.#exposed += exposed;
    if (exposed > 0) this.#cached = undefined;
    return exposed;
  }

  #clipEdit(edit: EditSweep): EditSweep | undefined {
    const boxes: ProbeBox[] = [];
    let startPrefix = edit.cursor % edit.count;
    let endPrefix = edit.end % edit.count;
    let retainedStart = 0;
    let retainedEnd = 0;
    for (const box of edit.boxes) {
      const level = this.#levels[box.level];
      if (level !== undefined) {
        const clipped = {
          level: box.level,
          ...intersect(box, { min: level.window, max: this.#max(level.window) }),
        };
        if (boxCount(clipped) > 0) {
          boxes.push(clipped);
          retainedStart += clippedPrefixCount(box, clipped, startPrefix);
          retainedEnd += clippedPrefixCount(box, clipped, endPrefix);
        }
      }
      const size = boxCount(box);
      startPrefix = Math.max(0, startPrefix - size);
      endPrefix = Math.max(0, endPrefix - size);
    }
    const count = boxes.reduce((n, box) => n + boxCount(box), 0);
    const cursor = Math.floor(edit.cursor / edit.count) * count + retainedStart;
    const end = Math.floor(edit.end / edit.count) * count + retainedEnd;
    return cursor < end
      ? { boxes, cursor, end, count, rotationPhase: edit.rotationPhase }
      : undefined;
  }

  /** World boxes whose probes must re-integrate once their Cards relit. */
  queueEdit(bounds: readonly FieldEditBounds[]): void {
    this.#pendingEdit.push(...bounds);
  }

  /** Cards are current: the queued edits sweep {@link PROBE_EDIT_SWEEPS} times. */
  activateEdits(): void {
    if (this.#pendingEdit.length === 0) return;
    const boxes = this.editBoxes(this.#pendingEdit);
    this.#pendingEdit = [];
    if (boxes.length === 0) return;
    const previous = this.#edit;
    const merged = previous === undefined ? boxes : [...previous.boxes];
    if (previous !== undefined) {
      for (const box of boxes) appendEditBox(merged, box);
    }
    const count = merged.reduce((n, box) => n + boxCount(box), 0);
    // New boxes append after the existing disjoint boxes. An accepted edit
    // starts a full set of sweeps without moving the next cell to the front.
    const cursor = previous === undefined ? 0 : previous.cursor % previous.count;
    this.#edit = {
      boxes: merged,
      cursor,
      end: cursor + count * PROBE_EDIT_SWEEPS,
      count,
      rotationPhase: previous === undefined ? undefined : (previous.rotationPhase ?? 0),
    };
    this.#cached = undefined;
  }

  /** Per-level cell boxes within two level spacings of the world boxes, inside each window. */
  editBoxes(bounds: readonly FieldEditBounds[]): ProbeBox[] {
    const out: ProbeBox[] = [];
    for (const [index, level] of this.#levels.entries()) {
      const spacing = levelSpacing(this.#plan, index);
      const margin = 2 * spacing;
      const window = { min: level.window, max: this.#max(level.window) };
      for (const box of bounds) {
        const cell = (v: number, a: 0 | 1 | 2, round: (x: number) => number) =>
          round((v - this.#plan.origin[a]) / spacing);
        const clipped = intersect(
          {
            min: cell3((a) => cell((box.min[a] ?? 0) - margin, a, Math.floor)),
            max: cell3((a) => cell((box.max[a] ?? 0) + margin, a, Math.ceil) + 1),
          },
          window,
        );
        if (boxCount(clipped) > 0) appendEditBox(out, { level: index, ...clipped });
      }
    }
    return out;
  }

  /** Probes queued by the last activated edit (one sweep). */
  priorityProbes(): number {
    return (
      this.#edit?.count ?? this.editBoxes(this.#pendingEdit).reduce((n, b) => n + boxCount(b), 0)
    );
  }

  pendingPriorityUpdates(): number {
    const pending =
      PROBE_EDIT_SWEEPS * this.editBoxes(this.#pendingEdit).reduce((n, b) => n + boxCount(b), 0);
    const active = this.#edit === undefined ? 0 : this.#edit.end - this.#edit.cursor;
    return pending + active;
  }

  #cellAt(boxes: readonly ProbeBox[], ordinal: number): { level: number; cell: ProbeCell } {
    let rest = ordinal;
    for (const box of boxes) {
      const n = boxCount(box);
      if (rest < n) {
        const ex = box.max[0] - box.min[0],
          ey = box.max[1] - box.min[1];
        return {
          level: box.level,
          cell: [
            box.min[0] + (rest % ex),
            box.min[1] + (Math.floor(rest / ex) % ey),
            box.min[2] + Math.floor(rest / (ex * ey)),
          ],
        };
      }
      rest -= n;
    }
    throw new Error('probe box ordinal out of range');
  }

  /** Probes per frame, within `[1, probeBudget]`: a share of the budget when views share it.
   * Level rotation budgets scale with it; a change re-plans an unsubmitted schedule. */
  get limit(): number {
    return this.#limit;
  }

  set limit(value: number) {
    const limit = Math.max(1, Math.min(this.#plan.probeBudget, Math.floor(value)));
    if (limit === this.#limit) return;
    this.#limit = limit;
    this.#cached = undefined;
  }

  /** This attempt's work; stable until {@link commit} or a scroll/edit changes it.
   * Every storage index appears at most once, so no two workgroups race on a probe. */
  schedule(): ProbeFrameSchedule {
    if (this.#cached !== undefined) return this.#cached;
    const plan = this.#plan;
    const budget = this.#limit;
    const list = new Uint32Array(plan.probeBudget);
    const used = new Uint8Array(plan.probeCount);
    let count = 0;
    const push = (index: number, flags: number) => {
      if (used[index] === 1) return;
      used[index] = 1;
      list[count++] = (index | flags) >>> 0;
    };
    const slabs = this.#levels.map(() => 0);
    for (const [index, level] of this.#levels.entries()) {
      const head = level.slabs[0];
      if (head === undefined) continue;
      const take = Math.min(budget - count, boxCount(head) - level.slabCursor);
      for (let i = 0; i < take; i++)
        push(
          probeIndex(plan, index, this.#cellAt([head], level.slabCursor + i).cell),
          PROBE_ENTRY_FRESH,
        );
      slabs[index] = take;
    }
    const fresh = count;
    let priority = 0;
    const edit = this.#edit;
    if (edit !== undefined) {
      // One sweep at most per frame keeps the entries distinct.
      const reserved = edit.rotationPhase === REPEATED_EDIT_ROTATION_PERIOD - 1 ? 1 : 0;
      priority = Math.min(
        Math.max(0, budget - count - reserved),
        edit.end - edit.cursor,
        edit.count,
      );
      for (let i = 0; i < priority; i++) {
        const { level, cell } = this.#cellAt(edit.boxes, (edit.cursor + i) % edit.count);
        push(probeIndex(plan, level, cell), PROBE_ENTRY_FAST);
      }
    }
    const rotation = this.#levels.map(() => 0);
    const tinyBudget = budget < plan.levels;
    const shares = tinyBudget
      ? undefined
      : budget === plan.probeBudget
        ? plan.levelBudgets
        : splitProbeBudget(budget, plan.levels, this.#per);
    for (let offset = 0; offset < this.#levels.length && count < budget; offset++) {
      // With fewer free slots than levels, using array order can always award
      // a lone remaining slot to a lower level, even when shares rotate.
      const index = tinyBudget ? (this.#tinyLevel + offset) % plan.levels : offset;
      const level = this.#levels[index];
      if (level === undefined) break;
      const share = shares === undefined ? 1 : (shares[index] ?? 0);
      const first = count;
      let visited = 0;
      // Fresh/edit entries already satisfy their work. Skip those slots while
      // filling the remaining unique quota, visiting at most one level cycle.
      for (; visited < this.#per && count < budget && count - first < share; visited++)
        push(index * this.#per + ((level.rotation + visited) % this.#per), 0);
      rotation[index] = visited;
    }
    this.#cached = { list, count, fresh, priority, rotation, slabs };
    return this.#cached;
  }

  /** Advance past a physically submitted schedule. */
  commit(done: ProbeFrameSchedule): void {
    if (done !== this.#cached) return;
    this.#cached = undefined;
    if (this.#limit < this.#plan.levels) {
      const visitedLevels = done.rotation.reduce(
        (count, visited) => count + Number(visited > 0),
        0,
      );
      this.#tinyLevel = (this.#tinyLevel + visitedLevels) % this.#plan.levels;
    }
    for (const [index, level] of this.#levels.entries()) {
      level.rotation = (level.rotation + (done.rotation[index] ?? 0)) % this.#per;
      const head = level.slabs[0];
      if (head === undefined) continue;
      level.slabCursor += done.slabs[index] ?? 0;
      if (level.slabCursor < boxCount(head)) continue;
      // The exposed slab is traced: it joins the sampled (valid) box.
      level.valid =
        boxCount(level.valid) === 0
          ? { min: head.min, max: head.max }
          : {
              min: cell3((a) => Math.min(level.valid.min[a] ?? 0, head.min[a] ?? 0)),
              max: cell3((a) => Math.max(level.valid.max[a] ?? 0, head.max[a] ?? 0)),
            };
      level.slabs = level.slabs.slice(1);
      level.slabCursor = 0;
    }
    const edit = this.#edit;
    if (edit !== undefined) {
      edit.cursor += done.priority;
      if (edit.rotationPhase !== undefined) {
        edit.rotationPhase = (edit.rotationPhase + 1) % REPEATED_EDIT_ROTATION_PERIOD;
      }
      if (edit.cursor >= edit.end) this.#edit = undefined;
    }
  }

  inspect(): ProbeClipmapInspection {
    return {
      levels: this.#plan.levels,
      levelBudgets: this.#plan.levelBudgets,
      windows: this.#levels.map((level) => level.window),
      valid: this.#levels.map((level) => level.valid),
      scrolls: [...this.#scrolls],
      exposedProbes: this.#exposed,
      pendingExposedProbes: this.#levels.reduce(
        (n, level) => n + level.slabs.reduce((m, slab) => m + boxCount(slab), 0) - level.slabCursor,
        0,
      ),
    };
  }

  /** Uniform rows: per level window min cell, valid min and valid max (exclusive). */
  windows(): readonly {
    readonly window: ProbeCell;
    readonly min: ProbeCell;
    readonly max: ProbeCell;
  }[] {
    return this.#levels.map((level) => ({ window: level.window, ...level.valid }));
  }
}
