import { encodeBase64 } from '@forgeax/engine-types';
import { decodePackBlob } from './blob.js';

const arrays = { Uint8Array, Uint16Array, Uint32Array, Float32Array };
type ArrayKind = keyof typeof arrays;

function packArrayKind(value: object): ArrayKind | undefined {
  const prototype = Object.getPrototypeOf(value);
  return (Object.keys(arrays) as ArrayKind[]).find((kind) => prototype === arrays[kind].prototype);
}

function intrinsicGetter(prototype: object, key: string): (this: unknown) => unknown {
  const get = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (!get) throw new TypeError(`missing binary intrinsic ${key}`);
  return get;
}
const bufferLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength');
function packBufferLength(buffer: ArrayBuffer): number {
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
      const Constructor = arrays[kind];
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

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
interface BinaryView {
  readonly path: readonly string[];
  readonly kind: ArrayKind;
  readonly buffer: number;
  readonly offset: number;
  readonly length: number;
}
export interface PackBinary {
  readonly byteOrder: 'little-endian';
  readonly buffers: readonly string[];
  readonly views: readonly BinaryView[];
}

function assertSnapshotRoot(input: object): void {
  if (
    input === null ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    throw new TypeError('expected a plain snapshot object');
}

/**
 * Encode a captured plain-object snapshot. The root reserves `binary`; nested
 * author objects need no reserved tags. Use copyPackData before encoding caller data.
 */
export function encodePackData<T extends object>(input: T): T & { binary?: PackBinary } {
  assertSnapshotRoot(input);
  if (Object.hasOwn(input, 'binary'))
    throw new TypeError('snapshot root reserves the binary field');
  if (!littleEndian) throw new TypeError('runtime binary snapshots require a little-endian host');
  const ids = new Map<ArrayBuffer, number>();
  const buffers: Uint8Array<ArrayBuffer>[] = [];
  const views: BinaryView[] = [];
  const visit = (value: unknown, path: string[]): unknown => {
    if (ArrayBuffer.isView(value)) {
      const kind = packArrayKind(value);
      if (!kind) throw new TypeError('unsupported or shared snapshot array');
      const storage = packArrayStorage(value);
      let buffer = ids.get(storage.buffer);
      if (buffer === undefined) {
        buffer = buffers.length;
        ids.set(storage.buffer, buffer);
        buffers.push(new Uint8Array(packBufferLength(storage.buffer)));
      }
      // Preserve aliasing and offsets without exporting unrelated backing bytes.
      const target = buffers[buffer];
      if (!target) throw new TypeError('missing captured binary storage');
      target.set(
        new Uint8Array(storage.buffer, storage.byteOffset, storage.byteLength),
        storage.byteOffset,
      );
      views.push({
        path,
        kind,
        buffer,
        offset: storage.byteOffset,
        length: storage.byteLength / arrays[kind].BYTES_PER_ELEMENT,
      });
      return null;
    }
    if (Array.isArray(value))
      return value.map((child, index) => visit(child, [...path, String(index)]));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, visit(child, [...path, key])]),
      );
    return value;
  };
  const result = visit(input, []) as T;
  return views.length
    ? {
        ...result,
        binary: { byteOrder: 'little-endian', buffers: buffers.map(encodeBase64), views },
      }
    : result;
}

/** Decode a plain-object snapshot already captured without invoking accessors. */
export function decodePackData(input: object): object {
  assertSnapshotRoot(input);
  if (!('binary' in input)) return input;
  const { binary, ...data } = input;
  if (
    !littleEndian ||
    !binary ||
    typeof binary !== 'object' ||
    !('byteOrder' in binary) ||
    binary.byteOrder !== 'little-endian' ||
    !('buffers' in binary) ||
    !Array.isArray(binary.buffers) ||
    !('views' in binary) ||
    !Array.isArray(binary.views) ||
    Object.keys(binary).some((key) => !['byteOrder', 'buffers', 'views'].includes(key))
  )
    throw new TypeError('invalid snapshot binary table');
  const buffers = binary.buffers.map((value: unknown) => {
    if (typeof value !== 'string') throw new TypeError('expected encoded snapshot bytes');
    return decodePackBlob(value).buffer;
  });
  const paths = new Set<string>();
  const used = new Set<number>();
  for (const raw of binary.views as unknown[]) {
    if (!raw || typeof raw !== 'object') throw new TypeError('invalid snapshot binary view');
    const view = raw as BinaryView;
    if (
      !Array.isArray(view.path) ||
      view.path.length === 0 ||
      view.path.some((key: unknown) => typeof key !== 'string') ||
      !Object.hasOwn(arrays, view.kind) ||
      Object.keys(view).some(
        (key) => !['path', 'kind', 'buffer', 'offset', 'length'].includes(key),
      ) ||
      !Number.isSafeInteger(view.buffer) ||
      !Number.isSafeInteger(view.offset) ||
      !Number.isSafeInteger(view.length) ||
      view.buffer < 0 ||
      view.offset < 0 ||
      view.length < 0
    )
      throw new TypeError('invalid snapshot binary view');
    const key = JSON.stringify(view.path);
    if (paths.has(key)) throw new TypeError('duplicate snapshot binary view');
    paths.add(key);
    const storage = buffers[view.buffer];
    const Constructor = arrays[view.kind];
    const end = view.offset + view.length * Constructor.BYTES_PER_ELEMENT;
    if (
      !storage ||
      !Number.isSafeInteger(end) ||
      view.offset % Constructor.BYTES_PER_ELEMENT ||
      end > storage.byteLength
    )
      throw new TypeError('snapshot binary view exceeds its buffer');
    used.add(view.buffer);
    let parent: unknown = data;
    for (const part of view.path.slice(0, -1)) {
      if (
        parent === null ||
        typeof parent !== 'object' ||
        ArrayBuffer.isView(parent) ||
        !Object.hasOwn(parent, part)
      )
        throw new TypeError('missing snapshot binary path');
      parent = (parent as Record<string, unknown>)[part];
    }
    const last = view.path.at(-1);
    if (last === undefined) throw new TypeError('missing snapshot binary slot');
    if (
      parent === null ||
      typeof parent !== 'object' ||
      ArrayBuffer.isView(parent) ||
      !Object.hasOwn(parent, last) ||
      (parent as Record<string, unknown>)[last] !== null
    )
      throw new TypeError('snapshot binary view must replace its own null slot');
    Object.defineProperty(parent, last, {
      value: new Constructor(storage, view.offset, view.length),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (used.size !== buffers.length) throw new TypeError('unreferenced snapshot binary buffer');
  return data;
}
