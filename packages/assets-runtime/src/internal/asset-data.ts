/** Private runtime storage captures logical views, never their unrelated backing bytes. */
export function copyAssetData<T>(input: T): T {
  return captureAssetData(input, undefined) as T;
}

/** A bounded copy charges logical key, scalar and binary storage as it takes ownership. */
export class AssetCopyBudget {
  bytes = 0;
  constructor(
    private readonly limit: number,
    /** Root fields already read by the owner selecting a patch route. */
    readonly rootFields?: PropertyDescriptorMap,
  ) {}

  copy<T>(input: T): T {
    return captureAssetData(input, undefined, undefined, this) as T;
  }

  get exceeded(): boolean {
    return this.bytes > this.limit || !Number.isSafeInteger(this.bytes);
  }

  charge(bytes: number): void {
    this.bytes += bytes;
    if (this.exceeded) throw new RangeError('asset copy exceeds available candidate bytes');
  }
}

/**
 * Capture content whose binary storage the caller gives up. Containers are
 * still copied; a view that spans its whole fixed private buffer keeps that
 * buffer instead of duplicating it. A partial view, a resizable buffer or a
 * buffer met a second time is copied as usual, so stored fields never alias
 * one another and never retain unrelated backing bytes.
 */
export function takeAssetData<T>(input: T): T {
  return captureAssetData(input, new Set()) as T;
}

/** Same owned capture, with only storage actually allocated by this known clone charged as scratch. */
export function captureAssetDataAllocated<T>(
  input: T,
  storage: 'copy' | 'take',
): { value: T; bytes: number; reusedBy(value: unknown): number } {
  const allocation: CaptureAllocation = { bytes: 0, nodes: new Map() };
  const value = captureAssetData(
    input,
    storage === 'take' ? new Set() : undefined,
    allocation,
  ) as T;
  return {
    value,
    bytes: allocation.bytes,
    reusedBy: (value) => reusedCaptureBytes(value, allocation.nodes),
  };
}

interface CaptureAllocation {
  bytes: number;
  readonly nodes: Map<object, number>;
}

/** Credit only nodes/buffers this exact clone allocated and the prepared result actually keeps. */
function reusedCaptureBytes(value: unknown, allocations: ReadonlyMap<object, number>): number {
  const seen = new Set<object>(),
    pending = [value];
  let bytes = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    bytes += allocations.get(node) ?? 0;
    if (ArrayBuffer.isView(node)) pending.push(node.buffer);
    else if (!(node instanceof ArrayBuffer))
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(node)))
        if (Object.hasOwn(descriptor, 'value')) pending.push(descriptor.value);
  }
  return bytes;
}

/**
 * The decoder boundary. The decoder gives up its output: plain nodes are
 * validated and frozen in place, bottom-up, and binary views keep their
 * storage, which owners treat as read-only by contract. A frozen node was
 * adopted already and is not walked again.
 */
function requireAdoptableView(value: ArrayBufferView): void {
  if (!ARRAY_TYPES.some((candidate) => Object.getPrototypeOf(value) === candidate.prototype))
    throw new TypeError('unsupported asset binary view');
  if (!(value.buffer instanceof ArrayBuffer))
    throw new TypeError('asset content requires private binary storage');
}

export function adoptAssetData<T>(input: T): T {
  const active = new Set<object>();
  const adopt = (value: unknown): void => {
    if (value === null || value === undefined || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol')
        throw new TypeError('asset content must be data');
      return;
    }
    if (value instanceof ArrayBuffer) return;
    if (ArrayBuffer.isView(value)) {
      requireAdoptableView(value);
      return;
    }
    if (Object.isFrozen(value)) return;
    if (active.has(value)) throw new TypeError('asset content contains a cycle');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== null && prototype !== Object.prototype)
      throw new TypeError('asset content requires plain data objects');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('asset content contains a symbol property');
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new TypeError('asset content requires enumerable data properties');
      adopt(descriptor.value);
    }
    active.delete(value);
    Object.freeze(value);
  };
  adopt(input);
  return input;
}

function captureAssetData(
  input: unknown,
  taken: Set<ArrayBuffer> | undefined,
  allocation?: CaptureAllocation,
  budget?: AssetCopyBudget,
): unknown {
  const active = new Set<object>();
  const takes = (buffer: ArrayBuffer): boolean => {
    if (
      taken === undefined ||
      (buffer as { readonly resizable?: boolean }).resizable === true ||
      taken.has(buffer)
    )
      return false;
    taken.add(buffer);
    return true;
  };
  const copy = (value: unknown): unknown => {
    if (value === null || value === undefined || typeof value !== 'object') {
      if (budget !== undefined) budget.charge(scalarDataBytes(value));
      else if (typeof value === 'function' || typeof value === 'symbol')
        throw new TypeError('asset content must be data');
      return value;
    }
    if (active.has(value)) throw new TypeError('asset content contains a cycle');
    if (value instanceof ArrayBuffer) {
      if (budget !== undefined) {
        const bytes = new Uint8Array(value);
        budget.charge(bytes.byteLength);
        return bytes.slice().buffer;
      }
      if (takes(value)) return value;
      const result = value.slice(0);
      if (allocation !== undefined) {
        allocation.bytes += value.byteLength;
        allocation.nodes.set(result, value.byteLength);
      }
      return result;
    }
    if (ArrayBuffer.isView(value)) return copyBinaryView(value, takes, allocation, budget);
    active.add(value);
    const result = copyPlainNode(
      value,
      copy,
      allocation,
      budget,
      value === input ? budget?.rootFields : undefined,
    );
    active.delete(value);
    return result;
  };
  return copy(input);
}

function copyBinaryView(
  value: ArrayBufferView,
  takes: (buffer: ArrayBuffer) => boolean,
  allocation?: CaptureAllocation,
  budget?: AssetCopyBudget,
): ArrayBufferView {
  const buffer = value.buffer;
  if (!(buffer instanceof ArrayBuffer))
    throw new TypeError('asset content requires private binary storage');
  const Constructor = ARRAY_TYPES.find(
    (candidate) => Object.getPrototypeOf(value) === candidate.prototype,
  ) as (new (buffer: ArrayBuffer) => ArrayBufferView) | undefined;
  if (Constructor === undefined) throw new TypeError('unsupported asset binary view');
  const { byteLength, byteOffset } = value;
  const bytesToCopy = new Uint8Array(buffer, byteOffset, byteLength);
  budget?.charge(bytesToCopy.byteLength);
  if (byteOffset === 0 && bytesToCopy.byteLength === buffer.byteLength && takes(buffer))
    return new Constructor(buffer);
  const bytes = bytesToCopy.slice();
  if (allocation !== undefined) {
    allocation.bytes += bytes.byteLength;
    allocation.nodes.set(bytes.buffer, bytes.byteLength);
  }
  return new Constructor(bytes.buffer);
}

function copyPlainNode(
  value: object,
  copy: (value: unknown) => unknown,
  allocation: CaptureAllocation | undefined,
  budget?: AssetCopyBudget,
  rootFields?: PropertyDescriptorMap,
): object {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== null && prototype !== Object.prototype)
    throw new TypeError('asset content requires plain data objects');
  budget?.charge(16);
  // Snapshot descriptors before descending. A child proxy can mutate later
  // siblings, and copying must never call an accessor on the input or target.
  const descriptors = rootFields ?? Object.getOwnPropertyDescriptors(value);
  const result = array ? [] : {};
  let bytes = 16;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('asset content contains a symbol property');
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('asset content requires enumerable data properties');
    budget?.charge(assetFieldBytes(key, 0));
    const field = copy(descriptor.value);
    descriptor.value = field;
    descriptor.configurable = true;
    descriptor.writable = true;
    Object.defineProperty(result, key, descriptor);
    if (allocation !== undefined) {
      // Strings and nested objects carry their own storage.
      const scalar =
        typeof field === 'number' || typeof field === 'bigint'
          ? 8
          : typeof field === 'boolean'
            ? 1
            : 0;
      bytes += assetFieldBytes(key, scalar);
    }
  }
  if (allocation !== undefined) {
    allocation.bytes += bytes;
    allocation.nodes.set(result, bytes);
  }
  return result;
}

const ARRAY_TYPES = [
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
  DataView,
] as const;

/** Logical owned bytes, including scalar storage and keys; VM overhead is measured separately.
 * Validate descriptors before capture, without invoking getters or copying any binary data.
 * Copied views charge each slice. An owned transfer charges each whole backing once.
 * Repeated plain references are independent value occurrences, just as in copyAssetData.
 * A record owner may collect a plain object's root field sizes in the same traversal.
 */
export function assetDataBytes(
  value: unknown,
  rootFields?: Map<string, number>,
  binaryStorage?: 'copy' | 'receive',
): number {
  if (value === null || typeof value !== 'object') return scalarDataBytes(value);
  const active = new Set<object>();
  const received = binaryStorage === 'receive' ? new Set<ArrayBuffer>() : undefined;
  const binaryBytes = (buffer: ArrayBufferLike, viewBytes = buffer.byteLength): number => {
    if (!(buffer instanceof ArrayBuffer)) {
      if (binaryStorage === 'copy') return viewBytes;
      throw new TypeError('asset content requires private binary storage');
    }
    if (received === undefined) return viewBytes;
    if (received.has(buffer)) return 0;
    received.add(buffer);
    return buffer.byteLength;
  };
  const measure = (entry: unknown, fields?: Map<string, number>): number => {
    if (entry === null || typeof entry !== 'object') return scalarDataBytes(entry);
    if (active.has(entry)) throw new TypeError('asset content contains a cycle');
    if (ArrayBuffer.isView(entry)) {
      if (!ARRAY_TYPES.some((candidate) => Object.getPrototypeOf(entry) === candidate.prototype))
        throw new TypeError('unsupported asset binary view');
      return binaryBytes(entry.buffer, entry.byteLength);
    }
    if (entry instanceof ArrayBuffer) return binaryBytes(entry);
    const array = Array.isArray(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new TypeError('asset content requires plain data objects');
    active.add(entry);
    let size = 16;
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('asset content contains a symbol property');
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new TypeError('asset content requires enumerable data properties');
      const bytes = assetFieldBytes(key, measure(descriptor.value));
      size += bytes;
      fields?.set(key, bytes);
    }
    active.delete(entry);
    if (!Number.isSafeInteger(size))
      throw new RangeError('asset content exceeds addressable storage');
    return size;
  };
  return measure(value, Array.isArray(value) ? undefined : rootFields);
}

function scalarDataBytes(value: unknown): number {
  switch (typeof value) {
    case 'string':
      return value.length * 2;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 1;
    case 'function':
    case 'symbol':
      throw new TypeError('asset content must be data');
    default:
      return 0;
  }
}

export function assetFieldBytes(key: string, valueBytes: number): number {
  return key.length * 2 + 8 + valueBytes;
}

/** Copy validated byte rows between packed or strided views. Their first bytes are the origins. */
export function copyAssetRows(
  source: Uint8Array,
  sourceStride: number,
  target: Uint8Array,
  targetStride: number,
  rowBytes: number,
  rows: number,
): void {
  if (rows === 1 || (rowBytes === sourceStride && rowBytes === targetStride)) {
    const size = rows * rowBytes;
    target.set(size === source.length ? source : source.subarray(0, size));
    return;
  }
  const aligned =
    ((source.byteOffset | target.byteOffset | rowBytes | sourceStride | targetStride) & 3) === 0;
  if (rowBytes > (aligned ? 128 : 32) || source.buffer === target.buffer) {
    for (let row = 0, from = 0, to = 0; row < rows; row++, from += sourceStride, to += targetStride)
      target.set(source.subarray(from, from + rowBytes), to);
    return;
  }
  const input = aligned
    ? new Uint32Array(source.buffer, source.byteOffset, Math.floor(source.length / 4))
    : source;
  const output = aligned
    ? new Uint32Array(target.buffer, target.byteOffset, Math.floor(target.length / 4))
    : target;
  const width = rowBytes / input.BYTES_PER_ELEMENT;
  const readStride = sourceStride / input.BYTES_PER_ELEMENT;
  const writeStride = targetStride / input.BYTES_PER_ELEMENT;
  for (let row = 0, from = 0, to = 0; row < rows; row++, from += readStride, to += writeStride)
    for (let lane = 0; lane < width; lane++) output[to + lane] = input[from + lane] as number;
}
