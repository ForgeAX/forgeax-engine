/** Private runtime storage captures logical views, never their unrelated backing bytes. */
export function copyAssetData<T>(input: T): T {
  const active = new Set<object>();
  const copy = (value: unknown): unknown => {
    if (value === null || value === undefined || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol')
        throw new TypeError('asset content must be data');
      return value;
    }
    if (active.has(value)) throw new TypeError('asset content contains a cycle');
    if (value instanceof ArrayBuffer) {
      const result = value.slice(0);
      return result;
    }
    if (ArrayBuffer.isView(value)) {
      if (!(value.buffer instanceof ArrayBuffer))
        throw new TypeError('asset content requires private binary storage');
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      const Constructor = ARRAY_TYPES.find(
        (candidate) => Object.getPrototypeOf(value) === candidate.prototype,
      );
      if (Constructor === undefined) throw new TypeError('unsupported asset binary view');
      const result = new (Constructor as new (buffer: ArrayBuffer) => ArrayBufferView)(
        bytes.buffer,
      );
      return result;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== null && prototype !== Object.prototype)
      throw new TypeError('asset content requires plain data objects');
    active.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('asset content contains a symbol property');
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new TypeError('asset content requires enumerable data properties');
      Object.defineProperty(result, key, {
        value: copy(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return result;
  };
  return copy(input) as T;
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
