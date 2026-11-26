import type { Object3D } from 'three/src/Three.Core.js';
import type { MeshPlan, Renderable } from './scene-mesh-planning';
import type { NodeRecord } from './scene-state';

export type WalkSlot =
  | 'sourceWalkSlot'
  | 'visibleWalkSlot'
  | 'poseWalkSlot'
  | 'meshPlanSlot'
  | 'reusedDrawSlot';
const walkDone = { done: true, value: undefined } as const;

export interface WalkMembers extends Iterable<Object3D> {
  readonly size: number;
  has(object: Object3D): boolean;
}
export interface MutableWalkMembers extends WalkMembers {
  add(object: Object3D): unknown;
  delete(object: Object3D): boolean;
}

/** Reusable source references in insertion order. Releasing a traversal clears
 * its strong references and trims storage after its working set contracts. */
class OrderedSourceRows<T extends Object3D> {
  protected readonly rows: (T | undefined)[] = [];
  protected end = 0;
  protected readers = 0;
  size = 0;

  // Cursor methods are shared. Each traversal owns its address and one reusable result.
  private static readonly Cursor = class<T extends Object3D> implements Iterator<T> {
    private address = 0;
    private yielded: IteratorYieldResult<T> | undefined;
    constructor(private owner: OrderedSourceRows<T> | undefined) {}
    next(): IteratorResult<T> {
      const owner = this.owner;
      if (owner === undefined) return walkDone;
      while (this.address < owner.end) {
        const node = owner.rows[this.address++];
        if (node === undefined) continue;
        if (this.yielded === undefined) this.yielded = { done: false, value: node };
        else this.yielded.value = node;
        return this.yielded;
      }
      return this.return();
    }
    return(): typeof walkDone {
      if (this.owner !== undefined) this.owner.readers--;
      this.owner = undefined;
      this.yielded = undefined;
      return walkDone;
    }
  };

  protected append(object: T): number {
    const address = this.end++;
    this.rows[address] = object;
    this.size++;
    return address;
  }

  [Symbol.iterator](): Iterator<T> {
    this.readers++;
    return new OrderedSourceRows.Cursor(this);
  }

  protected clearRows<V>(values: (V | undefined)[]): void {
    values.fill(undefined, 0, this.end);
    if (values.length > Math.max(128, this.end * 2)) values.length = this.end;
  }

  release(): void {
    this.clearRows(this.rows);
    this.end = 0;
    this.size = 0;
  }
}

/** Mounted scene rows issue membership addresses for one synchronous walk. */
export class SceneWalkRows<T extends Object3D = Object3D> extends OrderedSourceRows<T> {
  private provisional: Map<Object3D, number> | undefined;

  constructor(
    protected readonly records: ReadonlyMap<Object3D, NodeRecord>,
    private readonly slot: WalkSlot,
  ) {
    super();
  }

  has(object: T): boolean {
    return this.addressOf(object, this.records.get(object)) !== undefined;
  }

  protected addressOf(object: T, record: NodeRecord | undefined): number | undefined {
    const address = record?.[this.slot];
    if (address !== undefined && this.rows[address] === object) return address;
    return this.provisional?.get(object);
  }

  protected include(object: T): number {
    const record = this.records.get(object);
    const prior = this.addressOf(object, record);
    if (prior !== undefined) return prior;
    const address = this.append(object);
    if (record) record[this.slot] = address;
    else {
      this.provisional ??= new Map();
      this.provisional.set(object, address);
    }
    return address;
  }

  add(object: T): this {
    this.include(object);
    return this;
  }

  delete(object: T): boolean {
    const address = this.addressOf(object, this.records.get(object));
    if (address === undefined) return false;
    this.rows[address] = undefined;
    this.provisional?.delete(object);
    this.size--;
    return true;
  }

  override release(): void {
    super.release();
    this.provisional = undefined;
  }
}

/** The observer writes to one list while the publisher reads the preceding list.
 * Each weak address is only a hint. Identity in the receiving list decides membership. */
export class SourcePoseEdits extends OrderedSourceRows<Object3D> {
  private readonly addresses = new WeakMap<Object3D, number>();

  /** A local repair also restores the derived world matrix. A world-only edit
   * does not stage the author's local TRS. Both belong to the captured batch. */
  readonly matrixRepairs = new Map<Object3D, 'local' | 'world'>();

  override release(): void {
    this.matrixRepairs.clear();
    super.release();
  }

  has(node: Object3D): boolean {
    const address = this.addresses.get(node);
    return address !== undefined && this.rows[address] === node;
  }

  add(node: Object3D, observedAddress?: number): number {
    if (observedAddress !== undefined && this.rows[observedAddress] === node)
      return observedAddress;
    const previous = this.addresses.get(node);
    if (previous !== undefined && this.rows[previous] === node) return previous;
    const address = this.append(node);
    if (address !== previous) this.addresses.set(node, address);
    return address;
  }

  delete(node: Object3D): boolean {
    this.matrixRepairs.delete(node);
    const address = this.addresses.get(node);
    if (address === undefined || this.rows[address] !== node) return false;
    this.addresses.delete(node);
    this.rows[address] = undefined;
    this.size--;
    // A live cursor must observe delete-and-reinsert at the end in submission order.
    if (this.readers !== 0) return true;
    while (this.end > 0 && this.rows[this.end - 1] === undefined) this.end--;
    // Structural churn can leave holes between surviving nodes before the next capture.
    if (this.end > Math.max(128, this.size * 2)) this.compact();
    return true;
  }

  private compact(): void {
    let kept = 0;
    for (let index = 0; index < this.end; index++) {
      const node = this.rows[index];
      if (node === undefined) continue;
      if (kept !== index) {
        this.rows[kept] = node;
        this.addresses.set(node, kept);
      }
      kept++;
    }
    this.rows.length = this.end = kept;
  }
}

/** Current draw plans use the same source addresses from projection through publication.
 * Nested source callbacks receive independent working storage. */
export class SceneMeshPlans extends SceneWalkRows<Renderable> {
  private readonly plans: (MeshPlan | undefined)[] = [];

  constructor(records: ReadonlyMap<Object3D, NodeRecord>) {
    super(records, 'meshPlanSlot');
  }

  set(object: Renderable, plan: MeshPlan): void {
    this.plans[this.include(object)] = plan;
  }

  get(object: Renderable): MeshPlan | undefined {
    const address = this.addressOf(object, this.records.get(object));
    return address === undefined ? undefined : this.plans[address];
  }

  forEach(visit: (plan: MeshPlan, object: Renderable) => void): void {
    for (let address = 0; address < this.end; address++) {
      const object = this.rows[address];
      const plan = this.plans[address];
      if (object !== undefined && plan !== undefined) visit(plan, object);
    }
  }

  override release(): void {
    this.clearRows(this.plans);
    super.release();
  }
}
