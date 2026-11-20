/** Private runtime storage captures logical views, never their unrelated backing bytes. */
export function copyAssetData<T>(input: T): T {
  return captureAssetData(input, undefined) as T;
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
      if (typeof value === 'function' || typeof value === 'symbol')
        throw new TypeError('asset content must be data');
      return value;
    }
    if (active.has(value)) throw new TypeError('asset content contains a cycle');
    if (value instanceof ArrayBuffer) {
      if (takes(value)) return value;
      const result = value.slice(0);
      if (allocation !== undefined) {
        allocation.bytes += value.byteLength;
        allocation.nodes.set(result, value.byteLength);
      }
      return result;
    }
    if (ArrayBuffer.isView(value)) return copyBinaryView(value, takes, allocation);
    active.add(value);
    const result = copyPlainNode(value, copy);
    if (allocation !== undefined && result !== value) {
      let bytes = 16;
      for (const [key, field] of Object.entries(result as object)) {
        // Strings are returned unchanged by copy(), not allocated again by this clone.
        const scalar =
          typeof field === 'number' || typeof field === 'bigint'
            ? 8
            : typeof field === 'boolean'
              ? 1
              : 0;
        bytes += assetFieldBytes(key, scalar);
      }
      allocation.bytes += bytes;
      allocation.nodes.set(result as object, bytes);
    }
    active.delete(value);
    return result;
  };
  return copy(input);
}

function copyBinaryView(
  value: ArrayBufferView,
  takes: (buffer: ArrayBuffer) => boolean,
  allocation?: CaptureAllocation,
): ArrayBufferView {
  if (!(value.buffer instanceof ArrayBuffer))
    throw new TypeError('asset content requires private binary storage');
  const Constructor = ARRAY_TYPES.find(
    (candidate) => Object.getPrototypeOf(value) === candidate.prototype,
  ) as (new (buffer: ArrayBuffer) => ArrayBufferView) | undefined;
  if (Constructor === undefined) throw new TypeError('unsupported asset binary view');
  const whole = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength;
  if (whole && takes(value.buffer)) return new Constructor(value.buffer);
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (allocation !== undefined) {
    allocation.bytes += value.byteLength;
    allocation.nodes.set(bytes.buffer, value.byteLength);
  }
  return new Constructor(bytes.buffer);
}

function copyPlainNode(value: object, copy: (value: unknown) => unknown): unknown {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== null && prototype !== Object.prototype)
    throw new TypeError('asset content requires plain data objects');
  const { keys, fields } = copyPlainFields(value, array, copy);
  const result: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const [index, key] of keys.entries())
    Object.defineProperty(result, key, {
      value: fields[index],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return result;
}

/** Validated enumerable data fields, copied. */
function copyPlainFields(
  value: object,
  array: boolean,
  copy: (value: unknown) => unknown,
): { keys: string[]; fields: unknown[] } {
  const keys: string[] = [];
  const fields: unknown[] = [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('asset content contains a symbol property');
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('asset content requires enumerable data properties');
    keys.push(key);
    fields.push(copy(descriptor.value));
  }
  return { keys, fields };
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
 * Repeated references are independent value occurrences, just as in copyAssetData.
 * A record owner may also collect a plain object's root field sizes in the same traversal.
 */
export function assetDataBytes(value: unknown, rootFields?: Map<string, number>): number {
  const active = new Set<object>();
  const measure = (entry: unknown, fields?: Map<string, number>): number => {
    if (typeof entry === 'string') return entry.length * 2;
    if (typeof entry === 'number' || typeof entry === 'bigint') return 8;
    if (typeof entry === 'boolean') return 1;
    if (typeof entry === 'function' || typeof entry === 'symbol')
      throw new TypeError('asset content must be data');
    if (entry === null || entry === undefined) return 0;
    if (typeof entry !== 'object') throw new TypeError('asset content must be data');
    if (active.has(entry)) throw new TypeError('asset content contains a cycle');
    if (ArrayBuffer.isView(entry)) {
      if (!ARRAY_TYPES.some((candidate) => Object.getPrototypeOf(entry) === candidate.prototype))
        throw new TypeError('unsupported asset binary view');
      if (!(entry.buffer instanceof ArrayBuffer))
        throw new TypeError('asset content requires private binary storage');
      return entry.byteLength;
    }
    if (entry instanceof ArrayBuffer) return entry.byteLength;
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

export function assetFieldBytes(key: string, valueBytes: number): number {
  return key.length * 2 + 8 + valueBytes;
}
