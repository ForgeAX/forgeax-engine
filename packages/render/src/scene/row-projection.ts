import type { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { FrameList } from './frame-list';
import { MaterialFrame } from './material-dispatch';
import { MeshFrame } from './mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './mesh-materials';
import type { PersistentGpuDrivenState } from './render-scene';
import type { RenderSceneSlot } from './render-scene-types';
import { SceneSlotFrame } from './scene-slots';

/** The complete retained composition a secondary consumer projects. */
export interface ProjectedRows {
  readonly identity: object;
  /** Monotonic content + asset revision; equal revisions of one identity prove equal rows. */
  readonly revision?: number;
  readonly slots: FrameList<RenderSceneSlot>;
  readonly materials: MaterialFrame;
  readonly meshes: MeshFrame;
}

const NO_MATERIALS = new MaterialFrame(undefined);
const NO_MESHES = new MeshFrame();

/** A scene state's complete retained composition; a filtered view stands for its own rows. */
export function projectedRows(
  scene: Pick<PersistentGpuDrivenState, 'retained' | 'slots' | 'meshes'>,
): ProjectedRows {
  return (
    scene.retained ?? {
      identity: scene,
      slots: scene.slots,
      materials: NO_MATERIALS,
      meshes: scene.meshes ?? NO_MESHES,
    }
  );
}

/** Declares that a row's projection read one asset payload by handle. */
export type ReadAsset = (scope: RenderResourceScope, handle: number) => void;

/** What the last {@link RowProjection.sync} changed; `changed` lists slots in no order. */
export interface RowProjectionSync {
  /** Every slot whose entry entered, left or was re-projected. */
  readonly changed: readonly number[];
  /** The current row of each `changed` slot (`undefined` once it left), parallel to `changed`. */
  readonly records: readonly (RenderSceneSlot | undefined)[];
  /** No retained evidence linked the rows to the previous sync: every slot was visited. */
  readonly cold: boolean;
}

/** The rows that read one key, as link ids of {@link RowLinks}. A fired list is dead. */
interface Readers {
  readonly links: number[];
  dead: boolean;
  /** Asset revision the readers projected against; unused for Mesh and Material keys. */
  revision: number | undefined;
}

const readersOf = (revision?: number): Readers => ({ links: [], dead: false, revision });

/**
 * Row -> key links in one slot-indexed pool of typed columns: each link
 * records its list and its position there, and each row chains its own links.
 * Unlinking a row removes exactly its links (swap-remove, O(keys read)), so the
 * reverse indices stay exact without one dependency object per row.
 */
class RowLinks {
  #lists: (Readers | undefined)[] = [];
  #slots = new Int32Array(0);
  #positions = new Int32Array(0);
  #next = new Int32Array(0);
  #heads = new Int32Array(0);
  #free = -1;
  #end = 0;

  slotOf(link: number): number {
    return this.#slots[link] as number;
  }

  /** Join `list` once; a row's repeated reads of one key share its link. */
  link(slot: number, list: Readers): void {
    this.#reserveSlot(slot);
    for (let link = this.#heads[slot] as number; link !== -1; link = this.#next[link] as number)
      if (this.#lists[link] === list) return;
    let link = this.#free;
    if (link !== -1) this.#free = this.#next[link] as number;
    else {
      link = this.#end++;
      this.#reserveLink(link);
    }
    this.#lists[link] = list;
    this.#slots[link] = slot;
    this.#positions[link] = list.links.length;
    list.links.push(link);
    this.#next[link] = this.#heads[slot] as number;
    this.#heads[slot] = link;
  }

  /** Leave every list the row joined. */
  unlink(slot: number): void {
    if (slot >= this.#heads.length) return;
    let link = this.#heads[slot] as number;
    this.#heads[slot] = -1;
    while (link !== -1) {
      const next = this.#next[link] as number;
      const list = this.#lists[link];
      if (list !== undefined && !list.dead) {
        const at = this.#positions[link] as number;
        const last = list.links.pop() as number;
        if (last !== link) {
          list.links[at] = last;
          this.#positions[last] = at;
        }
      }
      this.#lists[link] = undefined;
      this.#next[link] = this.#free;
      this.#free = link;
      link = next;
    }
  }

  #reserveSlot(slot: number): void {
    if (slot < this.#heads.length) return;
    const heads = new Int32Array(Math.max(slot + 1, this.#heads.length * 2, 64)).fill(-1);
    heads.set(this.#heads);
    this.#heads = heads;
  }

  #reserveLink(link: number): void {
    if (link < this.#slots.length) return;
    const size = Math.max(link + 1, this.#slots.length * 2, 64);
    const grow = (column: Int32Array) => {
      const grown = new Int32Array(size);
      grown.set(column);
      return grown;
    };
    this.#slots = grow(this.#slots);
    this.#positions = grow(this.#positions);
    this.#next = grow(this.#next);
  }
}

const NOTHING: RowProjectionSync = Object.freeze({
  changed: Object.freeze([]),
  records: Object.freeze([]),
  cold: false,
});

const meshKey = (worldId: number, handle: number) => worldId * 0x1_0000_0000 + handle;

/**
 * A secondary consumer's per-row projection of the retained scene, kept
 * current from the scene's own change evidence: differing slot pages, Mesh
 * frame paths, Material frame paths and the revisions of asset payloads the
 * projection declared it read. A row is re-projected only when one of those
 * changed; an unrelated row edit costs nothing, and an unchanged composition
 * revision costs nothing at all. A cold source (first sync, a replaced
 * composition, or {@link reset} after device loss) visits every row once
 * through the same projection, so recovery is "clear derived, mark every
 * source dirty".
 *
 * Per-row state lives in slot-indexed columns (row version, cold-pass stamp,
 * admitted entries) and one link pool for the exact reverse indices; there is
 * no dependency object per row.
 *
 * `project` returns `undefined` for rows the consumer does not admit.
 */
export class RowProjection<T> {
  #rows: ProjectedRows | undefined;
  /** Slot-indexed admitted entries; `undefined` = not admitted. */
  #values: (T | undefined)[] = [];
  #size = 0;
  /** Slot-indexed row version of the last projection; 0 = never projected. */
  #versions = new Float64Array(0);
  /** Slot-indexed cold-pass stamp: retiring rows that left needs no Set of seen slots. */
  #seen = new Uint32Array(0);
  #epoch = 0;
  #links = new RowLinks();
  readonly #meshReaders = new Map<number, Readers>();
  readonly #materialReaders = new Map<MaterialResource, Readers>();
  /** An adopted payload may arrive under a new resource: handles name every resource that carried them. */
  readonly #handleResources = new Map<number, Set<MaterialResource>>();
  readonly #assetReaders = new Map<RenderResourceScope, Map<number, Readers>>();
  #visits = 0;
  #revision = 0;
  /** The slot being projected, for declared asset reads. */
  #slot = 0;

  constructor(
    private readonly project: (
      slot: RenderSceneSlot,
      rows: ProjectedRows,
      read: ReadAsset,
    ) => T | undefined,
    /** Equal re-projections keep the prior entry and are not reported as changed. */
    private readonly same: (before: T, after: T) => boolean = () => false,
  ) {}

  /** Rows re-projected since construction; regression evidence for O(changes) work. */
  get visits(): number {
    return this.#visits;
  }

  /** Increments whenever any admitted entry changes. */
  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#size;
  }

  get(slot: number): T | undefined {
    return this.#values[slot];
  }

  /** Admitted entries keyed by slot address, in ascending slot order. */
  *entries(): IterableIterator<[number, T]> {
    const values = this.#values;
    for (let slot = 0; slot < values.length; slot++) {
      const value = values[slot];
      if (value !== undefined) yield [slot, value];
    }
  }

  /** Drop every derived entry; the next sync re-projects every row. */
  reset(): void {
    this.#rows = undefined;
    this.#values = [];
    this.#size = 0;
    this.#versions = new Float64Array(0);
    this.#seen = new Uint32Array(0);
    this.#links = new RowLinks();
    this.#meshReaders.clear();
    this.#materialReaders.clear();
    this.#handleResources.clear();
    this.#assetReaders.clear();
    this.#revision++;
  }

  sync(rows: ProjectedRows): RowProjectionSync {
    const previous = this.#rows;
    this.#rows = rows;
    if (
      previous === rows ||
      (previous?.identity === rows.identity &&
        rows.revision !== undefined &&
        previous.revision === rows.revision)
    )
      return NOTHING;
    const dirty = new Set<number>();
    const linked =
      previous !== undefined &&
      previous.identity === rows.identity &&
      (previous.slots === rows.slots ||
        (previous.slots instanceof SceneSlotFrame && rows.slots instanceof SceneSlotFrame)) &&
      this.#collectChanges(previous, rows, dirty);
    const changed: number[] = [];
    const records: (RenderSceneSlot | undefined)[] = [];
    if (!linked) {
      // Cold: one ordered pass over every current row, then retire rows that left.
      const epoch = ++this.#epoch;
      for (const record of rows.slots) {
        const slot = record.slot;
        this.#reserve(slot);
        this.#seen[slot] = epoch;
        this.#visit(slot, record, rows, changed, records);
      }
      const values = this.#values;
      for (let slot = 0; slot < values.length; slot++)
        if (values[slot] !== undefined && this.#seen[slot] !== epoch)
          this.#visit(slot, undefined, rows, changed, records);
    } else {
      const slots = rows.slots;
      const slotAt =
        slots instanceof SceneSlotFrame
          ? slots.slotAt
          : (slot: number) => slots.find((record) => record.slot === slot);
      for (const slot of dirty) this.#visit(slot, slotAt(slot), rows, changed, records);
    }
    if (changed.length > 0) this.#revision++;
    return { changed, records, cold: !linked };
  }

  #visit(
    slot: number,
    record: RenderSceneSlot | undefined,
    rows: ProjectedRows,
    changed: number[],
    records: (RenderSceneSlot | undefined)[],
  ): void {
    this.#visits++;
    const before = this.#values[slot];
    this.#links.unlink(slot);
    let value: T | undefined;
    if (record === undefined) {
      if (slot < this.#versions.length) this.#versions[slot] = 0;
    } else {
      this.#reserve(slot);
      this.#slot = slot;
      value = this.project(record, rows, this.#read);
      this.#link(record, rows);
    }
    if (value === undefined) {
      if (before === undefined) return;
      this.#values[slot] = undefined;
      this.#size--;
    } else if (before !== undefined && this.same(before, value)) return;
    else {
      if (before === undefined) this.#size++;
      this.#values[slot] = value;
    }
    changed.push(slot);
    records.push(record);
  }

  #reserve(slot: number): void {
    if (slot < this.#versions.length) return;
    const size = Math.max(slot + 1, this.#versions.length * 2, 64);
    const versions = new Float64Array(size);
    versions.set(this.#versions);
    this.#versions = versions;
    const seen = new Uint32Array(size);
    seen.set(this.#seen);
    this.#seen = seen;
  }

  /**
   * `false` when the row-change log cannot answer, so only a cold pass can;
   * nothing is fired before that answer, so the cold pass relinks every row.
   */
  #collectChanges(previous: ProjectedRows, rows: ProjectedRows, dirty: Set<number>): boolean {
    const slots = rows.slots;
    const versions = this.#versions;
    if (
      previous.slots !== slots &&
      slots instanceof SceneSlotFrame &&
      !slots.changesSince(previous.slots as SceneSlotFrame, (slot) => {
        if (slots.versionAt(slot) !== (versions[slot] ?? 0)) dirty.add(slot);
      })
    )
      return false;
    // A fired list dies: its readers are re-projected and join what they read now.
    const fire = (readers: Readers | undefined) => {
      if (readers === undefined) return;
      readers.dead = true;
      for (const link of readers.links) dirty.add(this.#links.slotOf(link));
    };
    const fireKey = <K>(index: Map<K, Readers>, key: K) => {
      fire(index.get(key));
      index.delete(key);
    };
    if (previous.meshes !== rows.meshes)
      rows.meshes.changesSince(previous.meshes, (before, after) => {
        const geometry = after ?? before;
        if (geometry !== undefined)
          fireKey(this.#meshReaders, meshKey(geometry.worldId, geometry.handle));
      });
    if (previous.materials !== rows.materials)
      rows.materials.changesSince(previous.materials, (before, after) => {
        for (const accepted of [before, after]) {
          if (accepted === undefined) continue;
          fireKey(this.#materialReaders, accepted.resource);
          const handle = accepted.snapshot.materialHandle;
          const carriers = handle === undefined ? undefined : this.#handleResources.get(handle);
          if (handle === undefined || carriers === undefined) continue;
          this.#handleResources.delete(handle);
          for (const resource of carriers) fireKey(this.#materialReaders, resource);
        }
      });
    // O(distinct assets read), independent of the rows that share them.
    for (const [scope, handles] of this.#assetReaders) {
      for (const [handle, readers] of handles)
        if (scope.assetRevision(handle) !== readers.revision) {
          handles.delete(handle);
          fire(readers);
        }
      if (handles.size === 0) this.#assetReaders.delete(scope);
    }
    return true;
  }

  readonly #read: ReadAsset = (scope, handle) => {
    let handles = this.#assetReaders.get(scope);
    if (handles === undefined) {
      handles = new Map();
      this.#assetReaders.set(scope, handles);
    }
    const revision = scope.assetRevision(handle);
    let readers = handles.get(handle);
    if (readers === undefined) {
      readers = readersOf(revision);
      handles.set(handle, readers);
    } else readers.revision = revision;
    this.#links.link(this.#slot, readers);
  };

  #link(record: RenderSceneSlot, rows: ProjectedRows): void {
    const slot = record.slot;
    this.#versions[slot] = record.version;
    const source = record.snapshot;
    if (source.assetHandle !== undefined) {
      const key = meshKey(record.worldId, source.assetHandle);
      let readers = this.#meshReaders.get(key);
      if (readers === undefined) {
        readers = readersOf();
        this.#meshReaders.set(key, readers);
      }
      this.#links.link(slot, readers);
    }
    const materials = source.materials;
    for (let index = 0; index < materials.length; index++)
      this.#linkMaterial(materials[index], slot);
    this.#linkMaterial(source.material, slot);
    const geometry = rows.meshes.get(record.worldId, source.assetHandle);
    if (geometry === undefined) return;
    for (const resource of geometry.materials) this.#linkMaterial(resource, slot);
    // Mesh defaults with per-row overrides resolve to their own effective bindings.
    if (source.materialOverrides !== undefined)
      for (const resource of effectiveMeshMaterials(source, geometry, meshMaterialGeometry(source))
        .materials)
        this.#linkMaterial(resource, slot);
  }

  #linkMaterial(resource: MaterialResource | undefined, slot: number): void {
    if (resource === undefined) return;
    let readers = this.#materialReaders.get(resource);
    if (readers === undefined) {
      readers = readersOf();
      this.#materialReaders.set(resource, readers);
      const handle = resource.snapshot.materialHandle;
      if (handle !== undefined) {
        let carriers = this.#handleResources.get(handle);
        if (carriers === undefined) {
          carriers = new Set();
          this.#handleResources.set(handle, carriers);
        }
        carriers.add(resource);
      }
    }
    this.#links.link(slot, readers);
  }
}
