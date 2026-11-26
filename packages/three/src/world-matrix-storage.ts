// A stock Matrix4 array owns its values throughout its lifetime. The internal view
// bypasses write notifications while preserving user-defined lane setters.
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
  private output: number[];

  constructor(private readonly target: number[]) {
    this.view = new Proxy(target, this);
    this.elements = this.view;
    this.output = target;
    // Normal Object3D construction supplies the sixteen own, writable data lanes of Matrix4.
    // An authored array can already have accessors before tracking begins.
    if (target.length !== 16 || Object.getPrototypeOf(target) !== Array.prototype)
      this.output = this.view;
    else {
      for (let i = 0; i < 16; i++) {
        const lane = Object.getOwnPropertyDescriptor(target, i);
        if (!lane?.writable || !lane.configurable || !lane.enumerable) {
          this.output = this.view;
          break;
        }
      }
    }
    rows.set(this.view, this);
  }

  get dense(): number[] | undefined {
    return this.output === this.view ? undefined : this.target;
  }

  readLane(index: number, receiver: object): unknown {
    if (this.output !== this.view) return this.output[index];
    return Reflect.get(this.target, index, receiver);
  }

  writeLane(index: number, value: number): void {
    this.output[index] = value;
  }

  /** ECS publishes one selected F32 row. A structural edit can release the dense
   * storage during source lookup; authored lanes retain their public receiver and order. */
  writePresentation(values: Float32Array, offset: number): void {
    const dense = this.dense;
    if (dense !== undefined) {
      for (let i = 0; i < 16; i++) dense[i] = values[offset + i] as number;
    } else {
      for (let i = 0; i < 16; i++) this.writeLane(i, values[offset + i] as number);
    }
  }

  set(target: number[], key: PropertyKey, value: unknown, receiver: object): boolean {
    if (receiver === this.view && this.output === this.view && matrixLane(key) >= 0) {
      // Internal products publish once. Authored setters still receive the public array.
      for (let owner: object | null = target; owner; owner = Object.getPrototypeOf(owner)) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor) continue;
        if ('value' in descriptor) break;
        if (!descriptor.set) return false;
        descriptor.set.call(this.elements, value);
        return true;
      }
    }
    return Reflect.set(target, key, value, receiver);
  }

  defineProperty(target: number[], key: PropertyKey, desc: PropertyDescriptor): boolean {
    if (
      desc.get ||
      desc.set ||
      !('value' in desc) ||
      key === 'length' ||
      desc.writable === false ||
      desc.configurable === false ||
      desc.enumerable === false
    )
      this.output = this.view;
    return Reflect.defineProperty(target, key, desc);
  }

  deleteProperty(target: number[], key: PropertyKey): boolean {
    this.output = this.view;
    return Reflect.deleteProperty(target, key);
  }

  setPrototypeOf(target: number[], prototype: object | null): boolean {
    this.output = this.view;
    return Reflect.setPrototypeOf(target, prototype);
  }

  preventExtensions(target: number[]): boolean {
    this.output = this.view;
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
