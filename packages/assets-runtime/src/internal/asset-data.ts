import { isSharedImmutableAssetData } from './shared-immutable.js';

/** Private runtime storage captures logical views, never their unrelated backing bytes.
 * Realm-shared immutable facts (deep-frozen JSON and verified content-addressed
 * bytes) keep their identity: copying them would only duplicate equal content.
 */
export function copyAssetData<T>(input: T): T {
  return captureAssetData(input, false, undefined) as T;
}

/**
 * Capture content whose binary storage the caller gives up. Containers are
 * still copied; a view that spans its whole fixed private buffer keeps that
 * buffer instead of duplicating it. A partial view, a resizable buffer or a
 * buffer met a second time is copied as usual, so stored fields never alias
 * one another and never retain unrelated backing bytes.
 */
export function takeAssetData<T>(input: T): T {
  return captureAssetData(input, false, new Set()) as T;
}

/**
 * Frozen plain nodes proven immutable by a frozen capture: every own field is
 * a primitive, a realm-shared immutable fact, or another such node. A frozen
 * node's fields cannot change and shared admission is permanent, so the proof
 * holds for the node's lifetime.
 */
const immutableNodes = new WeakSet<object>();

/**
 * The decoder boundary: equivalent to `freezeRuntimePayload(copyAssetData(input))`,
 * with the same validation, except that a node no holder can change keeps its
 * identity. A frozen plain node whose fields all keep their identity is such a
 * node (deep-frozen JSON, such as a verified Pack document, optionally holding
 * shared facts). Every other node is copied, so mutable values and every
 * private binary view still become storage only the payload holds.
 */
export function freezeAssetData<T>(input: T): T {
  return captureAssetData(input, true, undefined) as T;
}

function captureAssetData(
  input: unknown,
  frozen: boolean,
  taken: Set<ArrayBuffer> | undefined,
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
    if (isSharedImmutableAssetData(value)) return value;
    if (frozen && immutableNodes.has(value)) return value;
    if (value instanceof ArrayBuffer) return takes(value) ? value : value.slice(0);
    if (ArrayBuffer.isView(value)) return copyBinaryView(value, takes);
    active.add(value);
    const result = copyPlainNode(value, frozen, copy);
    active.delete(value);
    return result;
  };
  return copy(input);
}

function copyBinaryView(
  value: ArrayBufferView,
  takes: (buffer: ArrayBuffer) => boolean,
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
  return new Constructor(bytes.buffer);
}

function copyPlainNode(value: object, frozen: boolean, copy: (value: unknown) => unknown): unknown {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== null && prototype !== Object.prototype)
    throw new TypeError('asset content requires plain data objects');
  // A copy is a dense, ordinary-prototype tree; only such a frozen node may stand in for it.
  const candidate =
    frozen && Object.isFrozen(value) && prototype === (array ? Array.prototype : Object.prototype);
  const { keys, fields, same } = copyPlainFields(value, array, copy);
  if (candidate && same && (!array || keys.length === (value as unknown[]).length)) {
    immutableNodes.add(value);
    return value;
  }
  const result: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const [index, key] of keys.entries())
    Object.defineProperty(result, key, {
      value: fields[index],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return frozen ? Object.freeze(result) : result;
}

/** Validated enumerable data fields, copied; `same` when every field kept its identity at its dense index. */
function copyPlainFields(
  value: object,
  array: boolean,
  copy: (value: unknown) => unknown,
): { keys: string[]; fields: unknown[]; same: boolean } {
  const keys: string[] = [];
  const fields: unknown[] = [];
  let same = true;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('asset content contains a symbol property');
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('asset content requires enumerable data properties');
    const field = copy(descriptor.value);
    if (field !== descriptor.value || (array && key !== String(keys.length))) same = false;
    keys.push(key);
    fields.push(field);
  }
  return { keys, fields, same };
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
 */
export function assetDataBytes(value: unknown): number {
  const active = new Set<object>();
  const measure = (entry: unknown): number => {
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
      size += assetFieldBytes(key, measure(descriptor.value));
    }
    active.delete(entry);
    if (!Number.isSafeInteger(size))
      throw new RangeError('asset content exceeds addressable storage');
    return size;
  };
  return measure(value);
}

export function assetFieldBytes(key: string, valueBytes: number): number {
  return key.length * 2 + 8 + valueBytes;
}
