import { RhiError } from '@forgeax/engine-rhi';
import { type MaterialResource, materialUsesSpriteGeometry } from '../material-resource';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { FrameListBase, FrameProjection } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import { changes, type Node, nodes, put, remove } from '../scene/frame-tree';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { MaterialBinding, MaterialTable } from './fold-buckets';
import type { ValidatedRenderable } from './frame-snapshot';
import { getOpaqueResourceIdentity } from './frame-snapshot';

/** Ownership and intrinsic empty classes are decided before maintaining any rows. */
export function canRetainMaterialBindings(
  classes: ReadonlyMap<string, string> | undefined,
): boolean {
  return (
    classes === undefined ||
    (Object.getPrototypeOf(classes) === Map.prototype &&
      !Object.hasOwn(classes, 'size') &&
      !Object.hasOwn(classes, 'get') &&
      classes.size === 0)
  );
}

/** All draw-table paths consume the same accepted material version and failure. */
export function acceptedMaterialSnapshot(
  material: MaterialResource,
  frame: MaterialFrame | undefined,
  source?: import('../render-system-extract').RenderableSnapshot,
): MaterialSnapshot {
  if (frame === undefined) return material.snapshot;
  const accepted = frame.get(material);
  if (accepted === undefined)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'a fixed material version for every prepared binding',
      hint: 'prepare materials and geometry from the same accepted Scene publication',
      detail: {
        error: {
          code: 'material-binding-not-accepted',
          message: 'Prepared binding has no accepted material version',
          detail: {
            materialIdentity: getOpaqueResourceIdentity(material),
            materialHandle: material.snapshot.materialHandle,
            materialFrameIdentity: getOpaqueResourceIdentity(frame),
            ...(source === undefined
              ? {}
              : {
                  worldId: source.worldId,
                  entityKey: source.entityKey,
                  meshHandle: source.assetHandle,
                  primaryMaterial: source.material === material,
                  materialIdentities: source.materials.map(getOpaqueResourceIdentity),
                  authorVisible: source.authorVisible !== false,
                  pipelinePreparation: source.pipelinePreparation !== undefined,
                }),
          },
        },
      },
    });
  return accepted.snapshot;
}

const PAGE_SIZE = 64;
const IDS = 2;
type Tuple = readonly MaterialResource[];

/** Fixed numeric identities and shared material tuples; no object or scope per row. */
interface Page {
  readonly materials: readonly (Tuple | undefined)[];
  readonly identities: Float64Array;
}
interface WritablePage {
  materials: (Tuple | undefined)[];
  identities: Float64Array;
}

function pageAt(root: Node<Page> | undefined, key: number): Page | undefined {
  while (root !== undefined) {
    if (root.key === key) return root.value;
    root = key < root.key ? root.left : root.right;
  }
  return undefined;
}

function sameTuple(left: Tuple, right: Tuple): boolean {
  if (left.length !== right.length) return false;
  for (let lane = 0; lane < left.length; lane++)
    if (lane in left !== lane in right || left[lane] !== right[lane]) return false;
  return true;
}

/** One phase's fixed entity-to-material relations, addressed in emitted row order. */
export class MaterialRelationFrame extends FrameListBase<Tuple> {
  private readPage = -1;
  private readValue: Page | undefined;
  constructor(
    readonly owner: object,
    readonly root: Node<Page> | undefined,
    readonly length: number,
  ) {
    super();
  }

  at(index: number): Tuple | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const key = Math.floor(index / PAGE_SIZE);
    if (this.readPage !== key) {
      this.readPage = key;
      this.readValue = pageAt(this.root, key);
    }
    return this.readValue?.materials[index % PAGE_SIZE];
  }

  *[Symbol.iterator](): IterableIterator<Tuple> {
    for (const node of nodes(this.root))
      for (const tuple of node.value.materials) if (tuple !== undefined) yield tuple;
  }

  changesSince(
    before: MaterialRelationFrame,
    visit: (index: number, previous: Tuple | undefined, next: Tuple | undefined) => void,
  ): boolean {
    if (before.owner !== this.owner) return false;
    changes(before.root, this.root, (left, right, key) => {
      for (let lane = 0; lane < PAGE_SIZE; lane++) {
        const previous = left?.materials[lane];
        const next = right?.materials[lane];
        if (
          previous !== next ||
          (previous !== undefined &&
            (left?.identities[lane * IDS] !== right?.identities[lane * IDS] ||
              left?.identities[lane * IDS + 1] !== right?.identities[lane * IDS + 1]))
        )
          visit(key * PAGE_SIZE + lane, previous, next);
      }
    });
    return true;
  }
}

/** Writes join the phase's existing emit walk; only changed pages allocate storage. */
export class MaterialRelations {
  private frame = new MaterialRelationFrame(this, undefined, 0);
  private pending: Map<number, WritablePage> | undefined;
  private materials: MaterialFrame | undefined;
  private sprites = new Map<MaterialResource, boolean>();
  private readonly singletons = new WeakMap<MaterialResource, Tuple>();
  private readonly tuples = new WeakMap<Tuple, Tuple>();
  private pageKey = -1;
  private page: Page | undefined;
  /** Counterpart to V8 heap allocation: explicitly account for numeric backing bytes. */
  readonly work = { pagesWritten: 0, identityBytes: 0 };

  begin(materials: MaterialFrame): void {
    this.pending = undefined;
    this.pageKey = -1;
    this.page = undefined;
    if (this.materials !== materials) {
      this.materials = materials;
      this.sprites.clear();
    }
  }

  private capture(tuple: Tuple): Tuple {
    if (Object.isFrozen(tuple)) return tuple;
    const previous = this.tuples.get(tuple);
    if (previous !== undefined && sameTuple(previous, tuple)) return previous;
    const captured = Object.freeze(tuple.slice());
    this.tuples.set(tuple, captured);
    return captured;
  }

  private editPage(key: number, before: Page | undefined): WritablePage {
    this.pending ??= new Map();
    let page = this.pending.get(key);
    if (page !== undefined) return page;
    const identities = new Float64Array(PAGE_SIZE * IDS);
    if (before !== undefined) identities.set(before.identities);
    page = { materials: before?.materials.slice() ?? [], identities };
    this.pending.set(key, page);
    this.work.pagesWritten++;
    this.work.identityBytes += identities.byteLength;
    return page;
  }

  write(index: number, row: ValidatedRenderable): void {
    const source = row.source;
    const primary = source.material;
    let sprite = this.sprites.get(primary);
    if (sprite === undefined) {
      sprite = materialUsesSpriteGeometry(acceptedMaterialSnapshot(primary, this.materials));
      this.sprites.set(primary, sprite);
    }
    let tuple = source.materials;
    if (sprite || tuple.length === 0) {
      const existing = this.singletons.get(primary);
      if (existing !== undefined) tuple = existing;
      else {
        tuple = Object.freeze([primary]);
        this.singletons.set(primary, tuple);
      }
    }
    tuple = this.capture(tuple);
    const key = Math.floor(index / PAGE_SIZE);
    if (this.pageKey !== key) {
      this.pageKey = key;
      this.page = this.pending?.get(key) ?? pageAt(this.frame.root, key);
    }
    const lane = index % PAGE_SIZE;
    if (
      this.page?.materials[lane] === tuple &&
      this.page.identities[lane * IDS] === source.worldId &&
      this.page.identities[lane * IDS + 1] === source.entityKey
    )
      return;
    const page = this.editPage(key, this.page);
    page.materials[lane] = tuple;
    page.identities[lane * IDS] = source.worldId;
    page.identities[lane * IDS + 1] = source.entityKey;
    this.page = page;
  }

  finish(length: number): MaterialRelationFrame {
    let root = this.frame.root;
    if (length < this.frame.length) {
      const last = Math.floor(length / PAGE_SIZE);
      for (const node of nodes(root))
        if (node.key > last || (node.key === last && length % PAGE_SIZE === 0))
          root = remove(root, 0, node.key);
      if (length % PAGE_SIZE !== 0) {
        const page = this.pending?.get(last) ?? pageAt(root, last);
        if (page !== undefined) this.editPage(last, page).materials.length = length % PAGE_SIZE;
      }
    }
    this.pending?.forEach((page, key) => {
      if (key * PAGE_SIZE < length) root = put(root, page, 0, key, 1);
    });
    this.pending = undefined;
    if (root !== this.frame.root || length !== this.frame.length)
      this.frame = new MaterialRelationFrame(this, root, length);
    return this.frame;
  }

  clear(): void {
    if (this.frame.length === 0 && this.materials === undefined) return;
    this.frame = new MaterialRelationFrame(this, undefined, 0);
    this.pending = undefined;
    this.materials = undefined;
    this.sprites.clear();
    this.page = undefined;
  }
}

interface Segment {
  readonly frame: MaterialRelationFrame;
  readonly offset: number;
}

/** A fixed concatenation has only one descriptor per entered Scene Pass. */
class Relations extends FrameListBase<Tuple> {
  readonly length: number;
  constructor(readonly segments: readonly Segment[]) {
    super();
    const last = segments.at(-1);
    this.length = last === undefined ? 0 : last.offset + last.frame.length;
  }
  at(index: number): Tuple | undefined {
    if (index < 0) index += this.length;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const segment = this.segments[i] as Segment;
      if (index >= segment.offset) return segment.frame.at(index - segment.offset);
    }
    return undefined;
  }
  *[Symbol.iterator](): IterableIterator<Tuple> {
    for (const { frame } of this.segments) yield* frame;
  }
}

/**
 * The view owns actual material-reader membership, not a per-frame result cache.
 * Bitmaps retire absent resources; old projections hold their own fixed pages.
 */
export class MaterialBindingIndex {
  private relations = new Relations([]);
  private readonly readers = new Map<MaterialResource, FrameSet>();
  private readonly shadows = new MaterialRelations();
  private slots: FrameList<readonly number[]> = [];
  private resources: readonly MaterialResource[] = [];
  private firstReaders: readonly number[] = [];
  readonly work = { changedRows: 0, indexedRows: 0, rebuilt: 0 };

  clear(): void {
    this.shadows.clear();
    if (this.relations.segments.length === 0) return;
    this.relations = new Relations([]);
    this.readers.clear();
    this.slots = [];
    this.resources = [];
    this.firstReaders = [];
  }

  build(
    frames: readonly MaterialRelationFrame[],
    shadows: readonly ValidatedRenderable[],
    materials: MaterialFrame,
    rows: readonly ValidatedRenderable[],
  ): MaterialTable {
    this.shadows.begin(materials);
    for (let index = 0; index < shadows.length; index++)
      this.shadows.write(index, shadows[index] as ValidatedRenderable);
    const shadow = this.shadows.finish(shadows.length);
    const segments: Segment[] = [];
    let offset = 0;
    for (const frame of frames) {
      segments.push({ frame, offset });
      offset += frame.length;
    }
    segments.push({ frame: shadow, offset });
    if (
      segments.length !== this.relations.segments.length ||
      segments.some((segment, index) => {
        const before = this.relations.segments[index];
        return before?.frame !== segment.frame || before.offset !== segment.offset;
      })
    )
      this.adopt(new Relations(segments));
    const snapshots = this.resources.map((resource) =>
      acceptedMaterialSnapshot(resource, materials),
    );
    // This descriptor belongs to this submission: capacity clipping and shared
    // GPU bindings may replace/append its small resource tables independently.
    return {
      slotIndices: this.slots,
      slots: snapshots,
      bindings: this.resources.map((resource, slot): MaterialBinding => {
        const first = this.firstReaders[slot] as number;
        const row = first < rows.length ? rows[first] : shadows[first - rows.length];
        if (row === undefined) throw new Error('Material reader has no submitted row');
        return {
          material: resource,
          resourceClass: '',
          ...(row.world === undefined ? {} : { world: row.world }),
          entityKey: row.source.entityKey,
        };
      }),
      bindingSlots: new Map(
        this.resources.map((resource, slot) => [resource, new Map([['', slot]])]),
      ),
      slotCount: snapshots.length,
    };
  }

  private adopt(next: Relations): void {
    const edits = new Map<MaterialResource, Map<number, boolean>>();
    const edit = (resource: MaterialResource, index: number, present: boolean) => {
      let keys = edits.get(resource);
      if (keys === undefined) {
        keys = new Map();
        edits.set(resource, keys);
      }
      keys.set(index, present);
    };
    const changed = (index: number, before: Tuple | undefined, after: Tuple | undefined) => {
      this.work.changedRows++;
      const previous = before;
      const next = after;
      for (let lane = 0; lane < (previous?.length ?? 0); lane++) {
        const resource = previous?.[lane];
        if (resource !== undefined && !next?.includes(resource)) edit(resource, index, false);
      }
      for (let lane = 0; lane < (next?.length ?? 0); lane++) {
        const resource = next?.[lane];
        if (resource !== undefined && !previous?.includes(resource)) edit(resource, index, true);
      }
    };
    const count = Math.max(next.segments.length, this.relations.segments.length);
    for (let index = 0; index < count; index++) {
      const before = this.relations.segments[index];
      const after = next.segments[index];
      if (before?.offset === after?.offset && before !== undefined && after !== undefined) {
        if (after.frame === before.frame) continue;
        if (
          after.frame.changesSince(before.frame, (row, left, right) =>
            changed(row + after.offset, left, right),
          )
        )
          continue;
      }
      if (before !== undefined)
        before.frame.forEach((row, index) => {
          changed(before.offset + index, row, undefined);
        });
      if (after !== undefined)
        after.frame.forEach((row, index) => {
          changed(after.offset + index, undefined, row);
        });
    }
    edits.forEach((keys, resource) => {
      // Compact ranges can overlap when an earlier Pass grows or shrinks.
      // Membership belongs to the final fixed relation, independent of edit order.
      keys.forEach((_present, index) => {
        keys.set(index, next.at(index)?.includes(resource) ?? false);
      });
      const members = (this.readers.get(resource) ?? new FrameSet()).edit(keys);
      if (members.size === 0) this.readers.delete(resource);
      else this.readers.set(resource, members);
    });
    const ordered = [...this.readers].map(([resource, readers]) => {
      const first = readers.values().next().value;
      const row = first === undefined ? undefined : next.at(first);
      if (row === undefined) throw new Error('Material reader has no live relation');
      return { resource, first: first as number, lane: row.indexOf(resource) };
    });
    ordered.sort((left, right) => left.first - right.first || left.lane - right.lane);
    const slots = new Map<MaterialResource, number>();
    this.resources = ordered.map(({ resource }, slot) => {
      slots.set(resource, slot);
      return resource;
    });
    this.firstReaders = ordered.map(({ first }) => first);
    const tuples = new WeakMap<Tuple, readonly number[]>();
    this.slots = new FrameProjection(next, (row) => {
      let indices = tuples.get(row);
      if (indices === undefined) {
        indices = Object.freeze(
          row.map((resource) => {
            const slot = slots.get(resource);
            if (slot === undefined) throw new Error('Material tuple has no live slot');
            return slot;
          }),
        );
        tuples.set(row, indices);
      }
      return indices;
    });
    this.relations = next;
    this.work.indexedRows += [...edits.values()].reduce((count, keys) => count + keys.size, 0);
    this.work.rebuilt++;
  }
}
