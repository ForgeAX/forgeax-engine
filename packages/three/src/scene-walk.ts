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

/** Ordered membership for one synchronous source walk. Mounted nodes already have an
 * engine-owned row. An address is valid only while its slot contains that exact source. */
export class SceneWalkRows<T extends Object3D = Object3D> {
  protected readonly rows: (T | undefined)[] = [];
  private provisional: Map<Object3D, number> | undefined;
  protected end = 0;
  size = 0;

  constructor(
    protected readonly records: ReadonlyMap<Object3D, NodeRecord>,
    private readonly slot: WalkSlot,
  ) {}

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
    const address = this.end++;
    this.rows[address] = object;
    this.size++;
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

  [Symbol.iterator](): Iterator<T> {
    let address = 0;
    let result: IteratorYieldResult<T> | undefined;
    return {
      next: (): IteratorResult<T> => {
        while (address < this.end) {
          const object = this.rows[address++];
          if (object !== undefined) {
            if (result === undefined) result = { done: false, value: object };
            else result.value = object;
            return result;
          }
        }
        return walkDone;
      },
    };
  }

  protected clearRows<V>(values: (V | undefined)[]): void {
    values.fill(undefined, 0, this.end);
    if (values.length > Math.max(128, this.end * 2)) values.length = this.end;
  }

  release(): void {
    this.clearRows(this.rows);
    this.end = 0;
    this.size = 0;
    this.provisional = undefined;
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
