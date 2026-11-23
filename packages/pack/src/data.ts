import { encodeBase64 } from '@forgeax/engine-types';
import { decodePackBlob } from './blob.js';

const arrays = { Uint8Array, Uint16Array, Uint32Array, Float32Array };
type ArrayKind = keyof typeof arrays;
const packViewAlignment = Math.max(...Object.values(arrays).map((type) => type.BYTES_PER_ELEMENT));

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
  const buffers = new Map<ArrayBuffer, ArrayBuffer>();
  return copyPackTree(value, (value) => {
    const view = readPackView(value);
    return view === undefined ? undefined : copyPackView(view, buffers);
  });
}

type PackView = ReturnType<typeof packArrayStorage> & { readonly kind: ArrayKind };
interface PackBackingRange {
  readonly start: number;
  readonly end: number;
}

function readPackView(value: object): PackView | undefined {
  if (!ArrayBuffer.isView(value)) return undefined;
  const kind = packArrayKind(value);
  return kind === undefined ? undefined : { kind, ...packArrayStorage(value) };
}

function copyPackView(
  view: PackView,
  buffers: Map<ArrayBuffer, ArrayBuffer>,
  range?: PackBackingRange | null,
): ArrayBufferView {
  let buffer = buffers.get(view.buffer);
  if (buffer === undefined) {
    const length = range == null ? packBufferLength(view.buffer) : range.end - range.start;
    buffer = new ArrayBuffer(length);
    buffers.set(view.buffer, buffer);
  }
  const offset = view.byteOffset - (range?.start ?? 0);
  new Uint8Array(buffer, offset, view.byteLength).set(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  );
  const Constructor = arrays[view.kind];
  return new Constructor(buffer, offset, view.byteLength / Constructor.BYTES_PER_ELEMENT);
}

/**
 * Isolate a producer's complete output before encoding. The policy sees a checked
 * output shape with inert placeholders for typed views. Only backings used solely
 * by outputs that normalize their binary layout may be rebased.
 */
export function copyPackOutputData<T extends Readonly<Record<string, unknown>>>(
  output: T,
  compactOutput: (shape: unknown) => boolean,
): T {
  const views = new Map<object, PackView>();
  const shape = copyPackTree(output, (value) => {
    const view = readPackView(value);
    if (view === undefined) return undefined;
    const marker = {};
    views.set(marker, view);
    return marker;
  }) as Readonly<Record<string, unknown>>;
  // null means at least one use requires the original backing extent.
  const ranges = new Map<ArrayBuffer, PackBackingRange | null>();
  const visited = new Map<object, boolean>();
  const measure = (value: unknown, compact: boolean): void => {
    if (value === null || typeof value !== 'object') return;
    const previous = visited.get(value);
    if (previous === false || previous === compact) return;
    visited.set(value, compact);
    const view = views.get(value);
    if (view === undefined) {
      for (const child of Object.values(value)) measure(child, compact);
      return;
    }
    if (!compact) {
      ranges.set(view.buffer, null);
      return;
    }
    const range = ranges.get(view.buffer);
    if (range === null) return;
    // Align the rebased origin for every supported typed view, including aliases.
    const start = view.byteOffset - (view.byteOffset % packViewAlignment);
    const end = view.byteOffset + view.byteLength;
    ranges.set(view.buffer, {
      start: Math.min(range?.start ?? start, start),
      end: Math.max(range?.end ?? end, end),
    });
  };
  for (const asset of Object.values(shape)) measure(asset, compactOutput(asset));
  const buffers = new Map<ArrayBuffer, ArrayBuffer>();
  return copyPackTree(shape, (value) => {
    const view = views.get(value);
    return view === undefined ? undefined : copyPackView(view, buffers, ranges.get(view.buffer));
  }) as T;
}

function copyPackTree(value: unknown, copyBinary: (value: object) => object | undefined): unknown {
  const visiting = new Set<object>();
  const copied = new Map<object, unknown>();
  const copy = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== 'object' || value === null)
      throw new TypeError(`${path}: expected lossless JSON data`);
    if (visiting.has(value)) throw new TypeError(`${path}: cyclic content`);
    if (copied.has(value)) return copied.get(value);
    const binary = copyBinary(value);
    if (binary !== undefined) {
      copied.set(value, binary);
      return binary;
    }
    visiting.add(value);
    try {
      const result = copyPackProperties(value, path, copy);
      copied.set(value, result);
      return result;
    } finally {
      visiting.delete(value);
    }
  };
  return copy(value, '$');
}

function copyPackProperties(
  value: object,
  path: string,
  copy: (value: unknown, path: string) => unknown,
): object {
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError(`${path}: expected a plain data object`);
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
  return result;
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
  const { data, buffers, views } = capturePackData(input);
  return views.length
    ? { ...data, binary: { byteOrder: 'little-endian', buffers: buffers.map(encodeBase64), views } }
    : data;
}

function capturePackData<T extends object>(input: T, maxBytes = Infinity) {
  assertSnapshotRoot(input);
  if (Object.hasOwn(input, 'binary'))
    throw new TypeError('snapshot root reserves the binary field');
  if (!littleEndian) throw new TypeError('runtime binary snapshots require a little-endian host');
  const ids = new Map<ArrayBuffer, number>();
  const buffers: Uint8Array<ArrayBuffer>[] = [];
  const views: BinaryView[] = [];
  let capturedBytes = 0;
  const visit = (value: unknown, path: string[]): unknown => {
    if (ArrayBuffer.isView(value)) {
      const kind = packArrayKind(value);
      if (!kind) throw new TypeError('unsupported or shared snapshot array');
      const storage = packArrayStorage(value);
      let buffer = ids.get(storage.buffer);
      if (buffer === undefined) {
        const length = packBufferLength(storage.buffer);
        capturedBytes += length;
        if (capturedBytes > maxBytes) throw new RangeError('Pack binary data exceeds its budget');
        buffer = buffers.length;
        ids.set(storage.buffer, buffer);
        buffers.push(new Uint8Array(length));
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
  return { data: visit(input, []) as T, buffers, views };
}

const recordHeaderBytes = 12;
const recordMagic = 0x46585044; // FXPD
const recordVersion = 1;

/** Store a privately owned Pack data graph with raw binary blocks. */
export function encodePackDataRecord(input: object, maxBytes: number): Uint8Array<ArrayBuffer> {
  const { data, buffers, views } = capturePackData(input, maxBytes);
  const lengths = buffers.map((buffer) => buffer.byteLength);
  const metadata = new TextEncoder().encode(JSON.stringify({ data, lengths, views }));
  const size =
    recordHeaderBytes + metadata.byteLength + lengths.reduce((sum, length) => sum + length, 0);
  if (size > maxBytes) throw new RangeError('Pack data record exceeds its budget');
  const record = new Uint8Array(size);
  const header = new DataView(record.buffer);
  header.setUint32(0, recordMagic);
  header.setUint32(4, recordVersion, true);
  header.setUint32(8, metadata.byteLength, true);
  record.set(metadata, recordHeaderBytes);
  let offset = recordHeaderBytes + metadata.byteLength;
  for (const buffer of buffers) {
    record.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return record;
}

export function decodePackDataRecord(record: Uint8Array, maxBytes: number): object {
  if (!littleEndian || record.byteLength < recordHeaderBytes || record.byteLength > maxBytes)
    throw new TypeError('invalid Pack data record size or byte order');
  const header = new DataView(record.buffer, record.byteOffset, recordHeaderBytes);
  if (header.getUint32(0) !== recordMagic || header.getUint32(4, true) !== recordVersion)
    throw new TypeError('unsupported Pack data record');
  const start = recordHeaderBytes + header.getUint32(8, true);
  if (start > record.byteLength) throw new TypeError('invalid Pack data metadata range');
  const metadata: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(recordHeaderBytes, start)),
  );
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('data' in metadata) ||
    !('lengths' in metadata) ||
    !Array.isArray(metadata.lengths) ||
    !('views' in metadata) ||
    !Array.isArray(metadata.views)
  )
    throw new TypeError('invalid Pack data record metadata');
  const data = metadata.data as object;
  assertSnapshotRoot(data);
  let offset = start;
  const buffers = (metadata.lengths as unknown[]).map((length) => {
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > record.byteLength - offset
    )
      throw new TypeError('invalid Pack data block range');
    const block = new Uint8Array(record.subarray(offset, offset + length)).buffer;
    offset += length;
    return block;
  });
  if (offset !== record.byteLength) throw new TypeError('unreferenced Pack data record bytes');
  return restorePackViews(data, buffers, metadata.views);
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
  return restorePackViews(data, buffers, binary.views);
}

function restorePackViews(
  data: object,
  buffers: readonly ArrayBuffer[],
  views: readonly unknown[],
) {
  const paths = new Set<string>();
  const used = new Set<number>();
  for (const raw of views) {
    const view = checkedPackView(raw);
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
    installPackView(data, view.path, new Constructor(storage, view.offset, view.length));
  }
  if (used.size !== buffers.length) throw new TypeError('unreferenced snapshot binary buffer');
  return data;
}

function checkedPackView(raw: unknown): BinaryView {
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
  return view;
}

function installPackView(data: object, path: readonly string[], value: ArrayBufferView): void {
  let parent: unknown = data;
  for (const part of path.slice(0, -1)) {
    if (
      parent === null ||
      typeof parent !== 'object' ||
      ArrayBuffer.isView(parent) ||
      !Object.hasOwn(parent, part)
    )
      throw new TypeError('missing snapshot binary path');
    parent = (parent as Record<string, unknown>)[part];
  }
  const last = path.at(-1);
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
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
