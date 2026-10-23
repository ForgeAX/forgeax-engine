import type { EntityHandle } from '@forgeax/engine-ecs';
import type { MaterialResource } from '../material-resource';
import { getOpaqueResourceIdentity, worldEntityKey } from '../record/frame-snapshot';
import { isMediumMaterial, matchesRecordMode } from '../record/material-pass-selection';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import { type FrameList, FrameListBase } from './frame-list';
import { at, changes, type Node, nodes, put, range, remove } from './frame-tree';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import {
  captureMaterialOverrides,
  defaultMeshMaterial,
  effectiveMeshMaterials,
  type MeshMaterialBindingWrite,
  type MeshMaterialGeometry,
  type MeshMaterialResolver,
  meshMaterialGeometry,
  prepareMeshMaterialBindings,
  retainMeshMaterialBindings,
} from './mesh-materials';
import type { SceneSlotFrame } from './scene-slots';

/** Ordered frame work; arrays and shared execution groups have the same consumption surface. */
export type DispatchList = FrameList<DispatchEntry>;

export type MaterialDispatchPass = Omit<
  DispatchEntry,
  'entityIndex' | 'renderableIndex' | 'layer' | 'materialShaderId'
> & { readonly materialShaderId: string };
type Pass = MaterialDispatchPass;
const passes = new WeakMap<MaterialSnapshot, readonly Pass[]>();

export function materialPasses(snapshot: MaterialSnapshot): readonly MaterialDispatchPass[] {
  const cached = passes.get(snapshot);
  if (cached !== undefined) return cached;
  const entries: DispatchEntry[] = [];
  appendMaterialDispatchEntries(
    entries,
    snapshot.passes,
    0 as EntityHandle,
    snapshot.materialHandle ?? 0,
    0,
    0,
    0,
    snapshot.materialProgramKeys,
  );
  const prepared = entries.map(
    ({ entityIndex: _entity, renderableIndex: _index, layer: _layer, ...pass }) => {
      if (pass.materialShaderId === undefined)
        throw new Error('Accepted material Pass has no program identity');
      return { ...pass, materialShaderId: pass.materialShaderId };
    },
  );
  passes.set(snapshot, prepared);
  return prepared;
}

interface Binding {
  readonly slot: number;
  readonly worldId: number;
  readonly entity: number;
  readonly layer: number;
  readonly shadowCaster: boolean;
  readonly visible: boolean;
  readonly prepared: boolean;
  /** Strong: a binding sees only its own few Pass versions and dies with its slot. */
  readonly entries: Map<Pass, DispatchEntry>;
}
/** The binding group key; equal keys select the same held materials and members. */
function materialBindingKey(
  snapshot: RenderableSnapshot,
  overrides = snapshot.materialOverrides === undefined
    ? undefined
    : captureMaterialOverrides(snapshot.materialOverrides),
  direct = [...new Set(snapshot.materials.length === 0 ? [snapshot.material] : snapshot.materials)],
  geometry = meshMaterialGeometry(snapshot),
): string {
  return overrides === undefined
    ? `direct:${direct.map(getOpaqueResourceIdentity).join(',')}`
    : `mesh:${snapshot.worldId}:${snapshot.assetHandle}:${geometry}:${getOpaqueResourceIdentity(overrides)}`;
}

/** An unreadable source takes the ordinary replacement path, which retires the old binding. */
function tryMaterialBindingKey(snapshot: RenderableSnapshot): string | undefined {
  try {
    return materialBindingKey(snapshot);
  } catch {
    return undefined;
  }
}

interface Work {
  readonly pass: Pass;
  readonly groups: Node<Node<Binding>>;
}
interface QueryWork {
  members: Node<Node<Binding>> | undefined;
  casters: Node<Node<Binding>> | undefined;
  /** Pipeline-preparation demand: accepted materials without Pass work. */
  prepared: Node<Node<Binding>> | undefined;
  passes: readonly Pass[];
}

export interface AcceptedMaterial {
  readonly resource: MaterialResource;
  readonly snapshot: MaterialSnapshot;
  readonly passes: readonly MaterialDispatchPass[];
  readonly bindings: number;
}

interface MaterialDemandCounts {
  readonly transmission: number;
  readonly rough: number;
  readonly backs: number;
  readonly medium: number;
}
const EMPTY_DEMAND: MaterialDemandCounts = { transmission: 0, rough: 0, backs: 0, medium: 0 };

function demandCounts(material: AcceptedMaterial | undefined): MaterialDemandCounts {
  if (material === undefined) return EMPTY_DEMAND;
  const snapshot = material.snapshot;
  const transmission = matchesRecordMode(snapshot, 'transmission');
  const roughness = snapshot.paramSnapshot?.roughness ?? snapshot.roughness;
  return {
    transmission: transmission ? material.bindings : 0,
    rough: transmission && typeof roughness === 'number' && roughness > 0 ? material.bindings : 0,
    backs:
      transmission && material.passes.some((pass) => pass.tags.LightMode === 'TransmissionBack')
        ? material.bindings
        : 0,
    medium: isMediumMaterial(snapshot) ? material.bindings : 0,
  };
}

function replaceDemand(
  counts: MaterialDemandCounts,
  previous: AcceptedMaterial | undefined,
  next: AcceptedMaterial | undefined,
): MaterialDemandCounts {
  const old = demandCounts(previous);
  const current = demandCounts(next);
  return {
    transmission: counts.transmission - old.transmission + current.transmission,
    rough: counts.rough - old.rough + current.rough,
    medium: counts.medium - old.medium + current.medium,
    backs: counts.backs - old.backs + current.backs,
  };
}

const passDefinitions = new WeakMap<MaterialSnapshot['passes'], string>();
function passDefinition(passes: MaterialSnapshot['passes']): string {
  let definition = passDefinitions.get(passes);
  if (definition === undefined) {
    definition = JSON.stringify(passes);
    passDefinitions.set(passes, definition);
  }
  return definition;
}

function sameMaterialPasses(previous: MaterialSnapshot, next: MaterialSnapshot): boolean {
  // Worker transport changes object identity without changing the accepted program contract.
  if (
    previous.passes !== next.passes &&
    passDefinition(previous.passes) !== passDefinition(next.passes)
  )
    return false;
  const before = previous.materialProgramKeys;
  const after = next.materialProgramKeys;
  return (
    before === after ||
    (before !== undefined &&
      after !== undefined &&
      Object.keys(before).length === Object.keys(after).length &&
      Object.keys(before).every((key) => before[key] === after[key]))
  );
}

/** Fixed shared material roots; capturing or adopting a version never copies bindings. */
export class MaterialFrame {
  readonly transmissionDemand: import('../transmission/projection').TransmissionDemand;
  constructor(
    private readonly root: Node<AcceptedMaterial> | undefined,
    private readonly counts: MaterialDemandCounts = EMPTY_DEMAND,
  ) {
    this.transmissionDemand = Object.freeze({
      activeCount: counts.transmission,
      needsRoughMips: counts.rough > 0,
      ...(counts.backs > 0 ? { needsBackPass: true } : {}),
    });
  }
  get hasMedium(): boolean {
    return this.counts.medium > 0;
  }
  /** Capture a newly generated view material at its producer, preserving this frame's root. */
  with(material: MaterialResource, bindings?: number, snapshot = material.snapshot): MaterialFrame {
    const previous = this.get(material);
    const count = bindings ?? previous?.bindings ?? 1;
    if (previous?.snapshot === snapshot && previous.bindings === count) return this;
    // Each resource owns its execution order, even if two resources started
    // with the same payload. Parameter-only adoption retains the same Passes.
    const passes =
      previous !== undefined && sameMaterialPasses(previous.snapshot, snapshot)
        ? previous.passes
        : materialPasses(snapshot).map((pass) => {
            const owned = { ...pass };
            getOpaqueResourceIdentity(owned);
            return owned;
          });
    const next = { resource: material, snapshot, passes, bindings: count };
    return new MaterialFrame(
      put(this.root, next, 0, getOpaqueResourceIdentity(material), 1),
      replaceDemand(this.counts, previous, next),
    );
  }
  /** Adopt already fixed input during actual Pass assembly, without a live read. */
  withAccepted(accepted: AcceptedMaterial, bindings = accepted.bindings): MaterialFrame {
    const previous = this.get(accepted.resource);
    if (
      previous?.snapshot === accepted.snapshot &&
      previous.passes === accepted.passes &&
      previous.bindings === bindings
    )
      return this;
    const next = accepted.bindings === bindings ? accepted : { ...accepted, bindings };
    return new MaterialFrame(
      put(this.root, next, 0, getOpaqueResourceIdentity(accepted.resource), 1),
      replaceDemand(this.counts, previous, next),
    );
  }
  without(material: MaterialResource): MaterialFrame {
    const previous = this.get(material);
    if (previous === undefined) return this;
    return new MaterialFrame(
      remove(this.root, 0, getOpaqueResourceIdentity(material)),
      replaceDemand(this.counts, previous, undefined),
    );
  }
  /** Project actual draw work from this fixed frame, independent of current Scene bindings. */
  project(
    draws: readonly {
      readonly source: RenderableSnapshot;
      readonly renderableIndex: number;
      readonly materials?: readonly MaterialResource[];
    }[],
  ): readonly DispatchEntry[] {
    const entries: {
      readonly pass: number;
      readonly identity: number;
      readonly entry: DispatchEntry;
    }[] = [];
    for (const draw of draws) {
      for (const resource of new Set(
        draw.materials ??
          (draw.source.materials.length === 0 ? [draw.source.material] : draw.source.materials),
      )) {
        const accepted = this.get(resource);
        if (accepted === undefined) throw new Error('Direct draw has no accepted material version');
        for (const pass of accepted.passes) {
          if (pass.tags.LightMode === 'ShadowCaster' && draw.source.shadowCaster === false)
            continue;
          entries.push({
            pass: getOpaqueResourceIdentity(pass),
            identity: worldEntityKey(draw.source.worldId, draw.source.entityKey),
            entry: {
              ...pass,
              entityIndex: draw.source.entityKey as EntityHandle,
              renderableIndex: draw.renderableIndex,
              layer: draw.source.layer ?? 0,
            },
          });
        }
      }
    }
    entries.sort(
      (a, b) =>
        a.entry.queue - b.entry.queue ||
        a.pass - b.pass ||
        a.identity - b.identity ||
        a.entry.renderableIndex - b.entry.renderableIndex,
    );
    return entries.map(({ entry }) => entry);
  }
  get(material: MaterialResource): AcceptedMaterial | undefined {
    const key = getOpaqueResourceIdentity(material);
    let current = this.root;
    while (current !== undefined && key !== undefined) {
      if (current.key === key) return current.value;
      current = key < current.key ? current.left : current.right;
    }
    return undefined;
  }

  /** Shared subtrees are identical evidence; only changed asset paths are visited. */
  changesSince(
    previous: MaterialFrame,
    visit: (before: AcceptedMaterial | undefined, after: AcceptedMaterial | undefined) => void,
  ): void {
    changes(previous.root, this.root, visit);
  }
}

// Only a completed real traversal can populate this cache. Fixed Work is
// retained across parameter adoption, so later draws and slices reuse its order.
const consumedBindings = new WeakMap<Work, readonly Binding[]>();

function* workBindings(work: Work, start = 0, end = Infinity): Generator<Binding> {
  const cached = consumedBindings.get(work);
  if (cached !== undefined) {
    for (let index = Math.max(0, start); index < Math.min(end, cached.length); index++) {
      const binding = cached[index];
      if (binding !== undefined) yield binding;
    }
    return;
  }
  if (start > 0 || end < work.groups.count) {
    yield* mergeWorkBindings(work, start, end);
    return;
  }
  const consumed: Binding[] = [];
  for (const binding of mergeWorkBindings(work, start, end)) {
    consumed.push(binding);
    yield binding;
  }
  consumedBindings.set(work, consumed);
}

/** Merge shared member trees only while their actual draw work is consumed. */
function* mergeWorkBindings(work: Work, start = 0, end = Infinity): Generator<Binding> {
  if (work.groups.left === undefined && work.groups.right === undefined) {
    for (const member of range(work.groups.value, start, end)) yield member.value;
    return;
  }
  type Cursor = { binding: Binding; iterator: Generator<Node<Binding>>; key: number };
  const heap: Cursor[] = [];
  const push = (cursor: Cursor) => {
    let index = heap.length;
    heap.push(cursor);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const before = heap[parent];
      if (before === undefined || before.key <= cursor.key) break;
      heap[index] = before;
      index = parent;
    }
    heap[index] = cursor;
  };
  for (const { value: root } of nodes(work.groups)) {
    const iterator = nodes(root);
    const first = iterator.next();
    if (!first.done) push({ binding: first.value.value, iterator, key: first.value.key });
  }
  let index = 0;
  while (heap.length > 0 && index < end) {
    const first = heap[0];
    const last = heap.pop();
    if (first === undefined || last === undefined) break;
    if (heap.length > 0) {
      let current = 0;
      while (current * 2 + 1 < heap.length) {
        let child = current * 2 + 1;
        if (
          child + 1 < heap.length &&
          (heap[child + 1]?.key ?? Infinity) < (heap[child]?.key ?? Infinity)
        )
          child++;
        const next = heap[child];
        if (next === undefined || next.key >= last.key) break;
        heap[current] = next;
        current = child;
      }
      heap[current] = last;
    }
    if (index++ >= start) yield first.binding;
    const next = first.iterator.next();
    if (!next.done)
      push({ binding: next.value.value, iterator: first.iterator, key: next.value.key });
  }
}

class FrameDispatch extends FrameListBase<DispatchEntry> {
  readonly length: number;
  constructor(
    private readonly root: Node<Work> | undefined,
    readonly slots: SceneSlotFrame,
  ) {
    super();
    this.length = root?.count ?? 0;
  }
  private entry(pass: Pass, binding: Binding): DispatchEntry {
    const renderableIndex = this.slots.indexOfSlot(binding.slot);
    if (renderableIndex === undefined) throw new Error('Missing material binding frame address');
    let entry = binding.entries.get(pass);
    if (entry === undefined || entry.renderableIndex !== renderableIndex) {
      entry = { ...pass, entityIndex: binding.entity, renderableIndex, layer: binding.layer };
      binding.entries.set(pass, entry);
    }
    return entry;
  }
  /** Complete traversals are fixed for this root and slot roster; later readers reuse them. */
  private traversed: readonly DispatchEntry[] | undefined;
  *[Symbol.iterator](): Generator<DispatchEntry> {
    if (this.traversed !== undefined) {
      yield* this.traversed;
      return;
    }
    const traversed: DispatchEntry[] = [];
    for (const { value: work } of nodes(this.root))
      for (const binding of workBindings(work)) {
        const entry = this.entry(work.pass, binding);
        traversed.push(entry);
        yield entry;
      }
    this.traversed = traversed;
  }
  at(index: number): DispatchEntry | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const work = at(this.root, index);
    if (work === undefined) return undefined;
    const member = workBindings(work.node.value, work.offset, work.offset + 1).next().value;
    return member === undefined ? undefined : this.entry(work.node.value.pass, member);
  }
  override slice(start = 0, end = this.length): DispatchEntry[] {
    start = Math.trunc(start) || 0;
    end = Math.trunc(end) || 0;
    start = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
    end = end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length);
    const result: DispatchEntry[] = [];
    for (const work of range(this.root, start, end))
      for (const member of workBindings(work.value, work.start, work.end))
        result.push(this.entry(work.value.pass, member));
    return result;
  }
}

type MaterialBinding = Pick<
  RenderableSnapshot,
  'material' | 'materials' | 'materialBindingSources' | 'materialOverrides'
>;
interface BindingGroup {
  readonly source: MaterialBinding;
  readonly identity: number;
  readonly mesh: MeshExpression | undefined;
  readonly held: readonly MaterialResource[];
  readonly key: string;
  readonly geometry: MeshMaterialGeometry;
  holders: number;
  members: Node<Binding> | undefined;
  casters: Node<Binding> | undefined;
  // Hidden preparation rows draw nothing but validate against the accepted
  // frame, so their effective (Mesh-default) materials must be resolved too.
  prepared: Node<Binding> | undefined;
}
interface MeshExpression {
  readonly worldId: number;
  readonly handle: number;
  holders: number;
}
function joinGroup(group: BindingGroup, binding: Binding, identity: number): void {
  if (binding.visible) {
    group.members = put(group.members, binding, 0, identity, 1);
    if (binding.shadowCaster) group.casters = put(group.casters, binding, 0, identity, 1);
  }
  if (binding.prepared) group.prepared = put(group.prepared, binding, 0, identity, 1);
}
function leaveGroup(group: BindingGroup, binding: Binding, identity: number): void {
  group.members = remove(group.members, 0, identity);
  if (binding.shadowCaster) group.casters = remove(group.casters, 0, identity);
  if (binding.prepared) group.prepared = remove(group.prepared, 0, identity);
}
/** Draw members or pipeline preparation both need the group's effective materials. */
function groupHasDemand(group: BindingGroup): boolean {
  return group.members !== undefined || group.prepared !== undefined;
}
function addRoot(
  roots: Node<Node<Binding>> | undefined,
  members: Node<Binding> | undefined,
  identity: number,
): Node<Node<Binding>> | undefined {
  return members === undefined ? roots : put(roots, members, 0, identity, members.count);
}
function addGroupWork(value: QueryWork, group: BindingGroup): QueryWork {
  return {
    ...value,
    members: addRoot(value.members, group.members, group.identity),
    casters: addRoot(value.casters, group.casters, group.identity),
    prepared: addRoot(value.prepared, group.prepared, group.identity),
  };
}
function removeGroupWork(value: QueryWork, identity: number): QueryWork {
  return {
    ...value,
    members: remove(value.members, 0, identity),
    casters: remove(value.casters, 0, identity),
    prepared: remove(value.prepared, 0, identity),
  };
}
function workIsEmpty(value: QueryWork): boolean {
  return value.members === undefined && value.casters === undefined && value.prepared === undefined;
}
const EMPTY_WORK: QueryWork = Object.freeze({
  members: undefined,
  casters: undefined,
  prepared: undefined,
  passes: [],
});
/** Source bindings and asset roots; Pass work is produced only by an actual query. */
export class MaterialDispatch {
  private querying = false;

  constructor(private readonly resolveMaterial?: MeshMaterialResolver) {}

  private assertSourceWritable(): void {
    if (this.querying) throw new Error('Pass sources changed during material query');
  }
  private readonly groups = new Map<string, BindingGroup>();
  private readonly meshes = new Map<string, MeshExpression>();
  private readonly bindings = new Map<number, { group: BindingGroup; binding: Binding }>();
  private readonly holds = new Map<MaterialResource, number>();
  private readonly unpublished = new Set<MaterialResource>();
  private meshFrame: MeshFrame | undefined;
  private queryRoot: Node<Work> | undefined;
  private queryDirty = true;
  /**
   * Retained query projection for change-driven Pass queries: per-resource
   * member/caster roots, the Passes they were published under, and each
   * group's effective resources. Only groups whose membership changed are
   * re-projected; untouched Work objects (and their consumed draw order) stay.
   */
  private queryWork = new Map<MaterialResource, QueryWork>();
  private groupResources = new Map<BindingGroup, readonly MaterialResource[]>();
  private readonly dirtyGroups = new Set<BindingGroup>();
  private fullQuery = true;
  private previous: FrameDispatch | undefined;
  private revision = 0;
  private sourceMaterials = new MaterialFrame(undefined);
  private materialFrame = this.sourceMaterials;

  private invalidateQuery(): void {
    this.queryDirty = true;
    this.queryRoot = undefined;
    this.previous = undefined;
    this.fullQuery = true;
    this.dirtyGroups.clear();
  }

  /** Membership edit of one group; the next query re-projects only that group. */
  private invalidateGroup(group: BindingGroup): void {
    this.queryDirty = true;
    this.previous = undefined;
    if (!this.fullQuery) this.dirtyGroups.add(group);
  }

  materials(): MaterialFrame {
    return this.materialFrame;
  }

  /** Adopt named Mesh changes without visiting their binding groups or members. */
  prepare(meshes: MeshFrame): void {
    this.assertSourceWritable();
    const changed = (
      before: import('./mesh-frame').MeshGeometry | undefined,
      after: import('./mesh-frame').MeshGeometry | undefined,
    ) => {
      const source = after ?? before;
      if (source === undefined) return;
      const expression = this.meshes.get(`${source.worldId}:${source.handle}`);
      if (expression === undefined) return;
      if (after === undefined) throw new Error('Bound Mesh has no accepted geometry version');
      if (
        before?.materials === after.materials &&
        before.materialSlots === after.materialSlots &&
        before.layout.digest === after.layout.digest
      ) {
        retainMeshMaterialBindings(before, after);
        return;
      }
      this.invalidateQuery();
      this.revision++;
    };
    if (this.meshFrame === undefined) {
      // First adoption reads the actual bound Mesh sources, never their groups.
      for (const expression of this.meshes.values())
        changed(undefined, meshes.get(expression.worldId, expression.handle));
    } else if (this.meshFrame !== meshes) meshes.changesSince(this.meshFrame, changed);
    this.meshFrame = meshes;
    for (const resource of this.unpublished)
      if (!this.holds.has(resource)) {
        this.sourceMaterials = this.sourceMaterials.without(resource);
        if (this.materialFrame.get(resource)?.bindings === 0)
          this.materialFrame = this.materialFrame.without(resource);
      }
    this.unpublished.clear();
  }

  adopt(material: MaterialResource): void {
    this.assertSourceWritable();
    const previous = this.materialFrame.get(material);
    this.materialFrame = this.materialFrame.with(material, previous?.bindings ?? 0);
    const current = this.materialFrame.get(material);
    if (current === undefined) throw new Error('Material adoption has no accepted version');
    this.sourceMaterials = this.sourceMaterials.withAccepted(current, 0);
    this.unpublished.add(material);
    if (previous !== undefined && current.passes !== previous.passes) {
      this.invalidateQuery();
      this.revision++;
    }
  }

  bind(slot: number, snapshot: RenderableSnapshot): void {
    this.assertSourceWritable();
    const current = this.bindings.get(slot);
    if (current !== undefined) {
      const { group, binding } = current;
      // Pose-only republication keeps every material and membership fact; the
      // retained query root, ranks and dispatch entries stay valid.
      if (
        binding.worldId === snapshot.worldId &&
        binding.entity === snapshot.entityKey &&
        binding.layer === (snapshot.layer ?? 0) &&
        binding.shadowCaster === (snapshot.shadowCaster !== false) &&
        binding.visible === (snapshot.authorVisible !== false) &&
        binding.prepared === (snapshot.pipelinePreparation !== undefined) &&
        group.key === tryMaterialBindingKey(snapshot)
      ) {
        for (const resource of group.held) {
          this.adopt(resource);
          this.unpublished.delete(resource);
        }
        return;
      }
    }
    const accepted = this.materialFrame;
    this.remove(slot);
    // Replacement is one source operation: preserve accepted Pass identities,
    // while leaving retired holds and member roots retired.
    this.materialFrame = accepted;
    try {
      const overrides =
        snapshot.materialOverrides === undefined
          ? undefined
          : captureMaterialOverrides(snapshot.materialOverrides);
      const direct = [
        ...new Set(snapshot.materials.length === 0 ? [snapshot.material] : snapshot.materials),
      ];
      const geometry = meshMaterialGeometry(snapshot);
      const key = materialBindingKey(snapshot, overrides, direct, geometry);
      let group = this.groups.get(key);
      if (group === undefined) {
        let mesh: MeshExpression | undefined;
        if (overrides !== undefined && snapshot.assetHandle !== undefined) {
          const meshKey = `${snapshot.worldId}:${snapshot.assetHandle}`;
          mesh = this.meshes.get(meshKey);
          if (mesh === undefined) {
            mesh = {
              worldId: snapshot.worldId,
              handle: snapshot.assetHandle,
              holders: 0,
            };
            this.meshes.set(meshKey, mesh);
          }
        }
        const source: MaterialBinding = {
          material: snapshot.material,
          materials: direct,
          materialBindingSources: snapshot.materialBindingSources,
          ...(overrides === undefined ? {} : { materialOverrides: overrides }),
        };
        const held =
          overrides === undefined
            ? direct
            : [
                ...new Set(
                  [defaultMeshMaterial, ...overrides].filter(
                    (value): value is MaterialResource => value !== undefined,
                  ),
                ),
              ];
        for (const resource of held) {
          this.adopt(resource);
          this.hold(resource);
        }
        group = {
          source,
          identity: getOpaqueResourceIdentity(source),
          mesh,
          held,
          key,
          geometry,
          holders: 0,
          members: undefined,
          casters: undefined,
          prepared: undefined,
        };
        this.groups.set(key, group);
        if (mesh !== undefined) mesh.holders++;
      }
      // Rebinding is explicit author work and admits current author overrides.
      for (const resource of group.held) {
        this.adopt(resource);
        this.unpublished.delete(resource);
      }
      const binding: Binding = {
        slot,
        worldId: snapshot.worldId,
        entity: snapshot.entityKey,
        layer: snapshot.layer ?? 0,
        shadowCaster: snapshot.shadowCaster !== false,
        visible: snapshot.authorVisible !== false,
        prepared: snapshot.pipelinePreparation !== undefined,
        entries: new Map(),
      };
      group.holders++;
      joinGroup(group, binding, worldEntityKey(binding.worldId, binding.entity));
      this.bindings.set(slot, { group, binding });
      this.revision++;
      this.invalidateGroup(group);
    } catch (error) {
      this.clearEmptyMaterialRoots();
      throw error;
    }
  }

  remove(slot: number): void {
    this.assertSourceWritable();
    const previous = this.bindings.get(slot);
    if (previous === undefined) return;
    const { group, binding } = previous;
    leaveGroup(group, binding, worldEntityKey(binding.worldId, binding.entity));
    if (--group.holders === 0) {
      this.groups.delete(group.key);
      const mesh = group.mesh;
      if (mesh !== undefined) {
        if (--mesh.holders === 0) {
          this.meshes.delete(`${mesh.worldId}:${mesh.handle}`);
        }
      }
      for (const resource of group.held) this.release(resource);
    }
    this.bindings.delete(slot);
    this.invalidateGroup(group);
    this.revision++;
    this.clearEmptyMaterialRoots();
  }

  private clearEmptyMaterialRoots(): void {
    if (this.bindings.size === 0) {
      this.invalidateQuery();
      this.sourceMaterials = new MaterialFrame(undefined);
      this.materialFrame = this.sourceMaterials;
      this.unpublished.clear();
    }
  }

  /**
   * Actual Pass demand, before resource capture. Resolving a variant uses the
   * current factory once; the returned work and MaterialFrame then retain its
   * accepted bytes independently of subsequent source adoption.
   */
  query(slots: SceneSlotFrame, meshes = this.meshFrame, validate?: () => void): DispatchList {
    if (this.querying) throw new Error('Recursive material Pass query');
    this.querying = true;
    try {
      validate?.();
      if (meshes !== this.meshFrame)
        throw new Error('Pass query requires the current adopted MeshFrame');
      if (this.queryDirty && !this.fullQuery && this.queryIncrementally(meshes, validate))
        this.queryDirty = false;
      if (this.queryDirty) {
        const revision = this.revision;
        const sources = this.sourceMaterials;
        const resolve = this.resolveMaterial;
        const pendingBindings: MeshMaterialBindingWrite[] = [];
        const work = new Map<MaterialResource, QueryWork>();
        const groupResources = new Map<BindingGroup, readonly MaterialResource[]>();
        let materials = this.sourceMaterials;
        for (const group of this.groups.values()) {
          if (!groupHasDemand(group)) continue;
          const { mesh, resources } = this.effectiveResources(
            group,
            meshes,
            resolve,
            pendingBindings,
          );
          groupResources.set(group, resources);
          for (const resource of resources) {
            const value = work.get(resource);
            if (value === undefined) materials = this.admit(materials, resource, mesh, resolve);
            work.set(resource, addGroupWork(value ?? EMPTY_WORK, group));
          }
        }
        let root: Node<Work> | undefined;
        for (const [resource, value] of work) {
          const accepted = materials.get(resource);
          if (accepted === undefined) throw new Error('Pass query has no accepted material');
          materials = materials.withAccepted(accepted, value.members?.count ?? 0);
          value.passes = accepted.passes;
          for (const pass of accepted.passes) {
            const members = pass.tags.LightMode === 'ShadowCaster' ? value.casters : value.members;
            if (members !== undefined)
              root = put(
                root,
                { pass, groups: members },
                pass.queue,
                getOpaqueResourceIdentity(pass),
                members.count,
              );
          }
        }
        if (
          this.revision !== revision ||
          this.sourceMaterials !== sources ||
          this.meshFrame !== meshes ||
          this.resolveMaterial !== resolve
        )
          throw new Error('Pass sources changed during material query');
        validate?.();
        for (const { contexts, geometry, value } of pendingBindings) contexts.set(geometry, value);
        this.queryRoot = root;
        this.materialFrame = materials;
        this.queryWork = work;
        this.groupResources = groupResources;
        this.dirtyGroups.clear();
        this.fullQuery = false;
        this.queryDirty = false;
        this.previous = undefined;
      }
      // Entry addresses are slot ranks. Pose-only frames replace slot records but
      // keep the identity roster, so ranks and the projected work are unchanged.
      if (
        this.previous === undefined ||
        (this.previous.slots !== slots && this.previous.slots.identities !== slots.identities)
      )
        this.previous = new FrameDispatch(this.queryRoot, slots);
      return this.previous;
    } finally {
      this.querying = false;
    }
  }

  /**
   * Re-project only groups whose membership changed since the last query.
   * Equivalent to a complete query: same effective resources (including Mesh
   * expression bindings), member roots, Pass roots and binding counts.
   */
  private queryIncrementally(meshes: MeshFrame | undefined, validate?: () => void): boolean {
    const dirty = [...this.dirtyGroups];
    const revision = this.revision;
    const sources = this.sourceMaterials;
    const resolve = this.resolveMaterial;
    const pendingBindings: MeshMaterialBindingWrite[] = [];
    const work = new Map(this.queryWork);
    const groupResources = new Map(this.groupResources);
    const affected = new Map<MaterialResource, readonly Pass[]>();
    let materials = this.materialFrame;
    for (const group of dirty) {
      for (const resource of groupResources.get(group) ?? []) {
        const value = work.get(resource);
        if (value === undefined) continue;
        if (!affected.has(resource)) affected.set(resource, value.passes);
        work.set(resource, removeGroupWork(value, group.identity));
      }
      groupResources.delete(group);
      if (this.groups.get(group.key) !== group || !groupHasDemand(group)) continue;
      const { mesh, resources } = this.effectiveResources(group, meshes, resolve, pendingBindings);
      groupResources.set(group, resources);
      for (const resource of resources) {
        const value = work.get(resource);
        if (value === undefined) materials = this.admit(materials, resource, mesh, resolve);
        if (!affected.has(resource)) affected.set(resource, value?.passes ?? []);
        work.set(resource, addGroupWork(value ?? EMPTY_WORK, group));
      }
    }
    let root = this.queryRoot;
    for (const [resource, previousPasses] of affected) {
      for (const pass of previousPasses)
        root = remove(root, pass.queue, getOpaqueResourceIdentity(pass));
      const value = work.get(resource);
      if (value === undefined) continue;
      if (workIsEmpty(value)) {
        work.delete(resource);
        const source = sources.get(resource);
        materials =
          source === undefined ? materials.without(resource) : materials.withAccepted(source, 0);
        continue;
      }
      const accepted = materials.get(resource);
      if (accepted === undefined) throw new Error('Pass query has no accepted material');
      materials = materials.withAccepted(accepted, value.members?.count ?? 0);
      work.set(resource, { ...value, passes: accepted.passes });
      for (const pass of accepted.passes) {
        const members = pass.tags.LightMode === 'ShadowCaster' ? value.casters : value.members;
        if (members !== undefined)
          root = put(
            root,
            { pass, groups: members },
            pass.queue,
            getOpaqueResourceIdentity(pass),
            members.count,
          );
      }
    }
    if (
      this.revision !== revision ||
      this.sourceMaterials !== sources ||
      this.meshFrame !== meshes ||
      this.resolveMaterial !== resolve
    )
      throw new Error('Pass sources changed during material query');
    validate?.();
    for (const { contexts, geometry, value } of pendingBindings) contexts.set(geometry, value);
    this.queryRoot = root;
    this.materialFrame = materials;
    this.queryWork = work;
    this.groupResources = groupResources;
    this.dirtyGroups.clear();
    this.previous = undefined;
    return true;
  }

  /** One binding group's effective resources against one fixed Mesh version. */
  private effectiveResources(
    group: BindingGroup,
    meshes: MeshFrame | undefined,
    resolve: MeshMaterialResolver | undefined,
    pending: MeshMaterialBindingWrite[],
  ): { mesh: MeshGeometry | undefined; resources: MaterialResource[] } {
    const mesh =
      group.mesh === undefined ? undefined : meshes?.get(group.mesh.worldId, group.mesh.handle);
    if (group.mesh !== undefined && mesh === undefined)
      throw new Error('Mesh Pass query requires accepted geometry');
    const effective =
      mesh === undefined
        ? group.source
        : resolve === undefined
          ? effectiveMeshMaterials(group.source, mesh, group.geometry)
          : prepareMeshMaterialBindings(group.source, mesh, group.geometry, resolve, pending);
    // One binding can repeat a material in several authored slots.
    const resources = [
      ...new Set(effective.materials.length === 0 ? [effective.material] : effective.materials),
    ];
    return { mesh, resources };
  }

  /** Admit a resource's accepted version; a resolved Mesh variant adopts its current bytes. */
  private admit(
    materials: MaterialFrame,
    resource: MaterialResource,
    mesh: MeshGeometry | undefined,
    resolve: MeshMaterialResolver | undefined,
  ): MaterialFrame {
    const accepted = this.materialFrame.get(resource) ?? materials.get(resource);
    return accepted === undefined ||
      (mesh !== undefined && resolve !== undefined && accepted.snapshot !== resource.snapshot)
      ? materials.with(resource, 0)
      : materials.withAccepted(accepted, 0);
  }

  revisionValue(): number {
    return this.revision;
  }

  private hold(resource: MaterialResource): void {
    this.holds.set(resource, (this.holds.get(resource) ?? 0) + 1);
    this.unpublished.delete(resource);
  }
  private release(resource: MaterialResource): void {
    const count = (this.holds.get(resource) ?? 0) - 1;
    if (count > 0) {
      this.holds.set(resource, count);
      return;
    }
    this.holds.delete(resource);
    this.sourceMaterials = this.sourceMaterials.without(resource);
    if (this.materialFrame.get(resource)?.bindings === 0)
      this.materialFrame = this.materialFrame.without(resource);
  }
}
