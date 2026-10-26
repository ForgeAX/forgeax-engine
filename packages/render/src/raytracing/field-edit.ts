import type { RenderSceneRecord } from '../scene/render-scene-types';
import type { GlobalSdfGrid } from './global-sdf';
import type { SceneFieldSource } from './scene-field-projection';
import type { SdfMeshInstance } from './sdf-query';

/** Axis-aligned world box. */
export interface FieldEditBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

interface FieldEditEntry {
  /** Global instance id: the row this identity owns in the prepared field. */
  readonly index: number;
  /** Mesh/field facts: a change replaces the instance (removal + add). */
  readonly geometry: readonly unknown[];
  /** Material facts: a change recaptures the instance's Cards only. */
  material: readonly unknown[];
  readonly transform: Float32Array;
  /** Membership in the currently bound immutable SDF sample box. */
  outside?: boolean;
  readonly local: FieldEditBounds;
}

/** Identity -> owned row of one prepared field; edits mutate it in place. */
export class FieldEditState extends Map<string, FieldEditEntry> {
  readonly #rows = new Map<string, Set<string>>();
  #grid: GlobalSdfGrid | undefined;
  #outside = 0;

  // biome-ignore lint/complexity/noUselessConstructor: Map(iterable) would call set before private indices initialize.
  constructor() {
    super();
  }

  outsideEmpty(grid: GlobalSdfGrid): boolean {
    if (this.#grid !== grid) {
      this.#grid = grid;
      this.#outside = 0;
      for (const value of this.values()) {
        value.outside = outsideGrid(value, grid);
        if (value.outside) this.#outside++;
      }
    }
    return this.#outside === 0;
  }

  override set(id: string, value: FieldEditEntry): this {
    const parts = id.split(':');
    const key = `${parts[0]}:${parts[2]}`;
    let rows = this.#rows.get(key);
    if (rows === undefined) {
      rows = new Set();
      this.#rows.set(key, rows);
    }
    rows.add(id);
    if (super.get(id)?.outside) this.#outside--;
    if (this.#grid !== undefined) {
      value.outside = outsideGrid(value, this.#grid);
      if (value.outside) this.#outside++;
    }
    return super.set(id, value);
  }

  override delete(id: string): boolean {
    const parts = id.split(':');
    const key = `${parts[0]}:${parts[2]}`;
    const rows = this.#rows.get(key);
    rows?.delete(id);
    if (rows?.size === 0) this.#rows.delete(key);
    if (super.get(id)?.outside) this.#outside--;
    return super.delete(id);
  }

  override clear(): void {
    this.#rows.clear();
    this.#outside = 0;
    super.clear();
  }

  *identities(
    sources: readonly Pick<RenderSceneRecord, 'worldId' | 'slot'>[],
  ): IterableIterator<string> {
    for (const source of sources) yield* this.#rows.get(`${source.worldId}:${source.slot}`) ?? [];
  }
}

/** Complete cold input, or the current rows named by retained change evidence. */
export interface FieldEditInput {
  readonly sources: readonly SceneFieldSource[];
  readonly instances: readonly SdfMeshInstance[];
  /** Omitted only for a complete cold snapshot. Missing rows of these sources leave. */
  readonly changedSources?: readonly Pick<RenderSceneRecord, 'worldId' | 'slot'>[];
}

/** One projected identity entering a prepared field or changing its materials. */
interface FieldEditSource {
  readonly id: string;
  readonly source: SceneFieldSource;
  /** Projected instance; its `instanceId` is a projection position, not a field row. */
  readonly instance: SdfMeshInstance;
  readonly local: FieldEditBounds;
}

/** One scene delta a prepared field can apply without a rebuild. */
export interface FieldEdit {
  readonly moved: readonly {
    readonly id: string;
    readonly index: number;
    readonly from: Float32Array;
    readonly to: Float32Array;
    readonly local: FieldEditBounds;
  }[];
  readonly removed: readonly {
    readonly id: string;
    readonly index: number;
    readonly from: Float32Array;
    readonly local: FieldEditBounds;
  }[];
  /** New identities, including replacements whose mesh or field changed. */
  readonly added: readonly FieldEditSource[];
  /** Owned rows whose materials changed; geometry and SDF rows stay. */
  readonly rematerialized: readonly (FieldEditSource & { readonly index: number })[];
}

function geometryFacts(source: SceneFieldSource): unknown[] {
  return [source.scope, source.assetHandle, source.assetRevision];
}

function materialFacts(source: SceneFieldSource): unknown[] {
  // Values belong to shared material roots. This state tracks only instance
  // bindings; root adoption must never fan values out into instance baselines.
  return source.materials.flatMap((m) => [m.materialSlot, m.resource, m.handle]);
}

const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

function identities(sources: readonly SceneFieldSource[], instances: readonly SdfMeshInstance[]) {
  const out: { id: string; source: SceneFieldSource; instance: SdfMeshInstance }[] = [];
  for (const source of sources)
    for (let ordinal = 0; ordinal < (source.instances?.instanceCount ?? 1); ordinal++) {
      const instance = instances[source.firstInstance + ordinal];
      if (instance === undefined) throw new Error('field edit lost a projected instance');
      out.push({
        id: `${source.worldId}:${source.entityKey}:${source.slot}:${source.generation}:${source.instances?.generations?.[ordinal] ?? 0}`,
        source,
        instance,
      });
    }
  return out;
}

/** Local trace bounds of one projected instance. */
export function fieldLocalBounds(instance: SdfMeshInstance): FieldEditBounds {
  const field = instance.field;
  const b =
    !('missing' in field) && field.policy.kind === 'sampled-visibility'
      ? field.policy.traceBounds
      : field.bounds;
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}

function entry(index: number, source: SceneFieldSource, instance: SdfMeshInstance) {
  return {
    index,
    geometry: geometryFacts(source),
    material: materialFacts(source),
    transform: Float32Array.from(instance.transform),
    local: fieldLocalBounds(instance),
  };
}

export function fieldEditState(
  sources: readonly SceneFieldSource[],
  instances: readonly SdfMeshInstance[],
): FieldEditState {
  const state = new FieldEditState();
  for (const { id, source, instance } of identities(sources, instances))
    state.set(id, entry(instance.instanceId, source, instance));
  return state;
}

/**
 * Diff a current projection against a prepared field's owned rows. Moves and
 * removals address owned rows; new identities are adds; a mesh or field change
 * is a removal plus an add; a material-only change recaptures in place.
 */
export function diffFieldEdit(
  state: FieldEditState,
  { sources, instances, changedSources }: FieldEditInput,
): FieldEdit {
  const moved: FieldEdit['moved'][number][] = [];
  const added: FieldEditSource[] = [];
  const rematerialized: FieldEdit['rematerialized'][number][] = [];
  const kept = new Set<string>();
  for (const { id, source, instance } of identities(sources, instances)) {
    const owned = state.get(id);
    const local = fieldLocalBounds(instance);
    if (owned === undefined || !same(geometryFacts(source), owned.geometry)) {
      added.push({ id, source, instance, local });
      continue;
    }
    kept.add(id);
    const to = Float32Array.from(instance.transform);
    if (to.some((v, i) => v !== owned.transform[i]))
      moved.push({ id, index: owned.index, from: owned.transform, to, local: owned.local });
    if (!same(materialFacts(source), owned.material))
      rematerialized.push({ index: owned.index, id, source, instance, local });
  }
  const removed: FieldEdit['removed'][number][] = [];
  for (const id of changedSources === undefined ? state.keys() : state.identities(changedSources)) {
    const owned = state.get(id);
    if (owned !== undefined && !kept.has(id))
      removed.push({ id, index: owned.index, from: owned.transform, local: owned.local });
  }
  return { moved, removed, added, rematerialized };
}

/** Adopt an applied edit so the next diff starts from it; `rows` are the adds' owned rows. */
export function adoptFieldEdit(
  state: FieldEditState,
  edit: FieldEdit,
  rows: readonly number[] = [],
): void {
  for (const move of edit.moved) {
    const owned = state.get(move.id);
    if (owned !== undefined) state.set(move.id, { ...owned, transform: move.to });
  }
  for (const change of edit.rematerialized) {
    const owned = state.get(change.id);
    if (owned !== undefined) owned.material = materialFacts(change.source);
  }
  for (const removal of edit.removed) {
    state.delete(removal.id);
  }
  if (rows.length !== edit.added.length) throw new Error('field edit adds need one row each');
  edit.added.forEach((add, i) => {
    state.set(add.id, entry(rows[i] ?? NaN, add.source, add.instance));
  });
}

/** World AABB of local bounds under an affine column-major transform. */
export function worldBounds(local: FieldEditBounds, t: ArrayLike<number>): FieldEditBounds {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map((a) => ((corner >> a) & 1 ? local.max[a] : local.min[a]) ?? 0);
    for (let a = 0; a < 3; a++) {
      const v =
        (t[a] ?? 0) * (p[0] ?? 0) +
        (t[4 + a] ?? 0) * (p[1] ?? 0) +
        (t[8 + a] ?? 0) * (p[2] ?? 0) +
        (t[12 + a] ?? 0);
      min[a] = Math.min(min[a] ?? 0, v);
      max[a] = Math.max(max[a] ?? 0, v);
    }
  }
  return {
    min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  };
}

function outsideGrid(entry: FieldEditEntry, grid: GlobalSdfGrid): boolean {
  const bounds = worldBounds(entry.local, entry.transform);
  for (const axis of [0, 1, 2] as const) {
    const lo = grid.origin[axis];
    const hi = lo + (grid.dimensions[axis] - 1) * grid.spacing;
    if (!(bounds.min[axis] >= lo && bounds.max[axis] <= hi)) return true;
  }
  return false;
}

/** Adopted trace geometry has no bounds outside the immutable SDF sample box. */
export function fieldOutsideEmpty(state: FieldEditState, grid: GlobalSdfGrid): boolean {
  return state.outsideEmpty(grid);
}

/** World boxes whose SDF an edit changes: old and new placements; material-only changes add none. */
export function fieldEditBounds(edit: FieldEdit): FieldEditBounds[] {
  return [
    ...edit.moved.flatMap((m) => [worldBounds(m.local, m.from), worldBounds(m.local, m.to)]),
    ...edit.removed.map((r) => worldBounds(r.local, r.from)),
    ...edit.added.map((a) => worldBounds(a.local, a.instance.transform)),
  ];
}
