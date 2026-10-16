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
  transform: Float32Array;
  readonly local: FieldEditBounds;
}

/** Identity -> owned row of one prepared field; edits mutate it in place. */
export type FieldEditState = Map<string, FieldEditEntry>;

/** One projected identity entering a prepared field or changing its materials. */
export interface FieldEditSource {
  readonly id: string;
  readonly source: SceneFieldSource;
  /** Projected instance; its `instanceId` is a projection position, not a field row. */
  readonly instance: SdfMeshInstance;
  readonly local: FieldEditBounds;
}

/** One scene delta a prepared field can apply without a rebuild. */
export interface FieldEdit {
  readonly moved: readonly {
    readonly index: number;
    readonly from: Float32Array;
    readonly to: Float32Array;
    readonly local: FieldEditBounds;
  }[];
  readonly removed: readonly {
    readonly index: number;
    readonly from: Float32Array;
    readonly local: FieldEditBounds;
  }[];
  /** New identities, including replacements whose mesh or field changed. */
  readonly added: readonly FieldEditSource[];
  /** Owned rows whose materials changed; geometry and SDF rows stay. */
  readonly rematerialized: readonly (FieldEditSource & { readonly index: number })[];
}

function stableFacts(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Map) return ['Map', [...v.entries()].sort(([a], [b]) => (a < b ? -1 : 1))];
    if (v instanceof Set) return ['Set', [...v].sort()];
    if (ArrayBuffer.isView(v)) return ['View', Array.from(v as unknown as ArrayLike<number>)];
    if (typeof v === 'bigint') return ['BigInt', String(v)];
    return v;
  });
}

function geometryFacts(source: SceneFieldSource): unknown[] {
  return [source.scope, source.mesh, source.field];
}

function materialFacts(source: SceneFieldSource): unknown[] {
  return source.materials.flatMap((m) => [
    m.materialSlot,
    m.handle,
    m.payload,
    m.effectivePayload,
    m.projection,
    stableFacts(m.facts),
  ]);
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
  const state: FieldEditState = new Map();
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
  sources: readonly SceneFieldSource[],
  instances: readonly SdfMeshInstance[],
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
      moved.push({ index: owned.index, from: owned.transform, to, local: owned.local });
    if (!same(materialFacts(source), owned.material))
      rematerialized.push({ index: owned.index, id, source, instance, local });
  }
  const removed: FieldEdit['removed'][number][] = [];
  for (const [id, owned] of state)
    if (!kept.has(id))
      removed.push({ index: owned.index, from: owned.transform, local: owned.local });
  return { moved, removed, added, rematerialized };
}

/** Adopt an applied edit so the next diff starts from it; `rows` are the adds' owned rows. */
export function adoptFieldEdit(
  state: FieldEditState,
  edit: FieldEdit,
  rows: readonly number[] = [],
): void {
  const byIndex = new Map([...state].map(([id, entry]) => [entry.index, id]));
  for (const move of edit.moved) {
    const id = byIndex.get(move.index);
    const owned = id === undefined ? undefined : state.get(id);
    if (owned !== undefined) owned.transform = move.to;
  }
  for (const change of edit.rematerialized) {
    const owned = state.get(change.id);
    if (owned !== undefined) owned.material = materialFacts(change.source);
  }
  for (const removal of edit.removed) {
    const id = byIndex.get(removal.index);
    if (id !== undefined) state.delete(id);
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

/** The current scene contains no trace geometry outside the stored SDF sample box.
 * Derive from the adopted edit authority, including geometry without field data. */
export function fieldOutsideEmpty(state: FieldEditState, grid: GlobalSdfGrid): boolean {
  for (const entry of state.values()) {
    const bounds = worldBounds(entry.local, entry.transform);
    for (const axis of [0, 1, 2] as const) {
      const lo = grid.origin[axis];
      const hi = lo + (grid.dimensions[axis] - 1) * grid.spacing;
      if (!(bounds.min[axis] >= lo && bounds.max[axis] <= hi)) return false;
    }
  }
  return true;
}

/** World boxes whose SDF an edit changes: old and new placements; material-only changes add none. */
export function fieldEditBounds(edit: FieldEdit): FieldEditBounds[] {
  return [
    ...edit.moved.flatMap((m) => [worldBounds(m.local, m.from), worldBounds(m.local, m.to)]),
    ...edit.removed.map((r) => worldBounds(r.local, r.from)),
    ...edit.added.map((a) => worldBounds(a.local, a.instance.transform)),
  ];
}

/** Scene slot -> generation of every projected field source. */
export type FieldSourceSlots = ReadonlyMap<number, number>;

export const fieldSourceSlots = (
  sources: readonly Pick<SceneFieldSource, 'slot' | 'generation'>[],
): FieldSourceSlots => new Map(sources.map((source) => [source.slot, source.generation]));

/**
 * True when scene content changes touch no field input, so the full scene
 * projection can be skipped: the change set is proven (`changed` defined),
 * every source slot is live at its generation (removed slots are absent from
 * change logs), no changed slot is a source, and the changed slots alone
 * project no field source (`projectsSource`; deforming meshes never do).
 */
export function fieldInputsUnchanged<R extends { readonly generation: number }>(
  sources: FieldSourceSlots,
  changed: readonly number[] | undefined,
  slotAt: (slot: number) => R | undefined,
  projectsSource: (records: readonly R[]) => boolean,
): boolean {
  if (changed === undefined) return false;
  for (const [slot, generation] of sources)
    if (slotAt(slot)?.generation !== generation) return false;
  const records: R[] = [];
  for (const slot of changed) {
    if (sources.has(slot)) return false;
    const record = slotAt(slot);
    if (record !== undefined) records.push(record);
  }
  return records.length === 0 || !projectsSource(records);
}
