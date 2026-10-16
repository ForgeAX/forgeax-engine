const arrays = { Uint8Array, Uint16Array, Uint32Array, Float32Array };
type ArrayKind = keyof typeof arrays;

export function packArrayKind(value: object): ArrayKind | undefined {
  const prototype = Object.getPrototypeOf(value);
  return (Object.keys(arrays) as ArrayKind[]).find((kind) => prototype === arrays[kind].prototype);
}

function intrinsicGetter(prototype: object, key: string): (this: unknown) => unknown {
  const get = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (!get) throw new TypeError(`missing binary intrinsic ${key}`);
  return get;
}
const bufferLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength');
export function packBufferLength(buffer: ArrayBuffer): number {
  return bufferLength.call(buffer) as number;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = intrinsicGetter(typedArrayPrototype, 'buffer');
const offsetGetter = intrinsicGetter(typedArrayPrototype, 'byteOffset');
const lengthGetter = intrinsicGetter(typedArrayPrototype, 'byteLength');
export function packArrayStorage(value: ArrayBufferView): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
} {
  const buffer: unknown = bufferGetter.call(value);
  if (!(buffer instanceof ArrayBuffer))
    throw new TypeError('shared binary storage is not immutable');
  return {
    buffer,
    byteOffset: offsetGetter.call(value) as number,
    byteLength: lengthGetter.call(value) as number,
  };
}

/** Copy lossless data and owned binary views. Never invoke getters or toJSON on submitted content. */
export function copyPackData(value: unknown): unknown {
  const visiting = new Set<object>();
  const copied = new Map<object, unknown>();
  const buffers = new Map<ArrayBuffer, ArrayBuffer>();
  const copy = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== 'object' || value === null)
      throw new TypeError(`${path}: expected lossless JSON data`);
    if (visiting.has(value)) throw new TypeError(`${path}: cyclic content`);
    if (copied.has(value)) return copied.get(value);
    const kind = packArrayKind(value);
    if (kind && ArrayBuffer.isView(value)) {
      const storage = packArrayStorage(value);
      let buffer = buffers.get(storage.buffer);
      if (!buffer) {
        buffer = new ArrayBuffer(packBufferLength(storage.buffer));
        buffers.set(storage.buffer, buffer);
      }
      new Uint8Array(buffer, storage.byteOffset, storage.byteLength).set(
        new Uint8Array(storage.buffer, storage.byteOffset, storage.byteLength),
      );
      const Constructor = { Uint8Array, Uint16Array, Uint32Array, Float32Array }[kind];
      const result = new Constructor(
        buffer,
        storage.byteOffset,
        storage.byteLength / Constructor.BYTES_PER_ELEMENT,
      );
      copied.set(value, result);
      return result;
    }
    const array = Array.isArray(value);
    if (
      !array &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new TypeError(`${path}: expected a plain data object`);
    if (visiting.has(value)) throw new TypeError(`${path}: cyclic content`);
    visiting.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (array && keys.length !== value.length + 1)
        throw new TypeError(`${path}: sparse or extended array`);
      const result: Record<string, unknown> | unknown[] = array ? [] : {};
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw new TypeError(`${path}: symbol property`);
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new TypeError(`${path}.${key}: expected an enumerable data property`);
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
          throw new TypeError(`${path}: extended array`);
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, `${path}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      copied.set(value, result);
      return result;
    } finally {
      visiting.delete(value);
    }
  };
  return copy(value, '$');
}
