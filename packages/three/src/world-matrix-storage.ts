// The target owns the public Array shape. While a stock pose is attached its sixteen
// values live in one binary64 row. Structural edits transfer the values back first.
function matrixLane(key: PropertyKey): number {
  if (typeof key !== 'string') return -1;
  if (key.length === 1) {
    const digit = key.charCodeAt(0) - 48;
    return digit >= 0 && digit <= 9 ? digit : -1;
  }
  if (key.length === 2 && key.charCodeAt(0) === 49) {
    const digit = key.charCodeAt(1) - 48;
    if (digit >= 0 && digit <= 5) return 10 + digit;
  }
  return -1;
}

const rows = new WeakMap<object, WorldMatrixRow>();

export class WorldMatrixRow implements ProxyHandler<number[]> {
  readonly view: number[];
  elements: number[];
  lanes: Float64Array | undefined;
  private owners = 0;
  private ordinary = true;

  constructor(private readonly target: number[]) {
    this.view = new Proxy(target, this);
    this.elements = this.view;
    rows.set(this.view, this);
  }

  get dense(): number[] | Float64Array | undefined {
    return this.ordinary ? (this.lanes ?? this.target) : undefined;
  }

  readLane(index: number, receiver: object): unknown {
    if (this.ordinary) return (this.lanes ?? this.target)[index];
    return Reflect.get(this.target, index, receiver);
  }

  writeLane(index: number, value: number): void {
    if (this.ordinary && typeof value === 'number') (this.lanes ?? this.target)[index] = value;
    else if (this.ordinary) this.view[index] = value;
    else {
      // Internal bulk stores publish once. An authored accessor still receives
      // the public Array as its receiver, including inherited setters.
      const key = String(index);
      for (let owner: object | null = this.target; owner; owner = Object.getPrototypeOf(owner)) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor) continue;
        if ('value' in descriptor) break;
        if (!descriptor.set) throw new TypeError('Cannot write a read-only matrix element');
        descriptor.set.call(this.elements, value);
        return;
      }
      this.view[index] = value;
    }
  }

  attach(): void {
    if (++this.owners !== 1) return;
    const target = this.target;
    if (target.length !== 16 || Object.getPrototypeOf(target) !== Array.prototype) return;
    for (let i = 0; i < 16; i++) {
      const d = Object.getOwnPropertyDescriptor(target, i);
      if (!d?.writable || !d.configurable || !d.enumerable || typeof d.value !== 'number') return;
    }
    this.ordinary = true;
    const lanes = new Float64Array(16);
    for (let i = 0; i < 16; i++) {
      lanes[i] = target[i] as number;
      target[i] = 0;
    }
    this.lanes = lanes;
  }

  release(): void {
    if (--this.owners === 0) this.materialize();
  }

  private materialize(): void {
    const lanes = this.lanes;
    if (lanes === undefined) return;
    for (let i = 0; i < 16; i++) this.target[i] = lanes[i] as number;
    this.lanes = undefined;
  }

  get(target: number[], key: PropertyKey, receiver: object): unknown {
    if (this.lanes !== undefined) {
      const lane = matrixLane(key);
      if (lane >= 0) return this.lanes[lane];
    }
    return Reflect.get(target, key, receiver);
  }

  getOwnPropertyDescriptor(target: number[], key: PropertyKey): PropertyDescriptor | undefined {
    const d = Object.getOwnPropertyDescriptor(target, key);
    if (this.lanes !== undefined && d !== undefined) {
      const lane = matrixLane(key);
      if (lane >= 0) d.value = this.lanes[lane];
    }
    return d;
  }

  set(target: number[], key: PropertyKey, value: unknown, receiver: object): boolean {
    if (receiver === this.view && this.ordinary && typeof value === 'number') {
      const lane = matrixLane(key);
      if (lane >= 0) {
        if (this.lanes) this.lanes[lane] = value;
        else target[lane] = value;
        return true;
      }
    }
    return Reflect.set(target, key, value, receiver);
  }

  defineProperty(target: number[], key: PropertyKey, desc: PropertyDescriptor): boolean {
    if (this.lanes !== undefined) {
      const lane = matrixLane(key);
      if (
        lane >= 0 &&
        typeof desc.value === 'number' &&
        desc.configurable !== false &&
        desc.writable !== false &&
        desc.enumerable !== false
      ) {
        this.lanes[lane] = desc.value;
        return true;
      }
      this.materialize();
    }
    if (
      desc.get ||
      desc.set ||
      !('value' in desc) ||
      key === 'length' ||
      desc.writable === false ||
      desc.configurable === false ||
      desc.enumerable === false
    )
      this.ordinary = false;
    return Reflect.defineProperty(target, key, desc);
  }

  deleteProperty(target: number[], key: PropertyKey): boolean {
    this.materialize();
    this.ordinary = false;
    return Reflect.deleteProperty(target, key);
  }

  setPrototypeOf(target: number[], prototype: object | null): boolean {
    this.materialize();
    this.ordinary = false;
    return Reflect.setPrototypeOf(target, prototype);
  }

  preventExtensions(target: number[]): boolean {
    this.materialize();
    this.ordinary = false;
    return Reflect.preventExtensions(target);
  }
}

export function worldMatrixRow(storage: object): WorldMatrixRow | undefined {
  return rows.get(storage);
}

/** Copy in r187 lane order. A getter or setter may change either array during the call. */
export function copyWorldMatrixElements(
  out: number[],
  input: number[],
  receiver: number[],
): boolean {
  const source = worldMatrixRow(input);
  const target = worldMatrixRow(out);
  if (source === undefined && target === undefined) return false;
  for (let i = 0; i < 16; i++) {
    const value =
      source === undefined ? (input[i] as number) : (source.readLane(i, receiver) as number);
    if (target === undefined) out[i] = value;
    else target.writeLane(i, value);
  }
  return true;
}

/** Stock r187 multiplication for dense numeric inputs. Only the two world rows may alias. */
export function multiplyWorldMatrix(
  parent: Float64Array,
  local: number[],
  out: Float64Array,
): void {
  for (let row = 0; row < 4; row++) {
    // All writes touch this one row, including when parent and out are the same matrix.
    const a = parent[row] as number;
    const b = parent[row + 4] as number;
    const c = parent[row + 8] as number;
    const d = parent[row + 12] as number;
    for (let col = 0; col < 16; col += 4) {
      out[col + row] =
        a * (local[col] as number) +
        b * (local[col + 1] as number) +
        c * (local[col + 2] as number) +
        d * (local[col + 3] as number);
    }
  }
}
