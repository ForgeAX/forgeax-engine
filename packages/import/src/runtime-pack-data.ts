import {
  decodePackBlob,
  encodePackBlob,
  packArrayKind,
  packArrayStorage,
  packBufferLength,
} from '@forgeax/engine-pack/runtime';

const arrays = { Uint8Array, Uint16Array, Uint32Array, Float32Array };
type ArrayKind = keyof typeof arrays;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
interface BinaryView {
  readonly path: readonly string[];
  readonly kind: ArrayKind;
  readonly buffer: number;
  readonly offset: number;
  readonly length: number;
}
export interface RuntimePackBinary {
  readonly byteOrder: 'little-endian';
  readonly buffers: readonly string[];
  readonly views: readonly BinaryView[];
}

/** Snapshot-only encoding. Paths address null slots; author objects need no reserved tags. */
export function encodeRuntimePackData<T extends object>(
  input: T,
): T & { binary?: RuntimePackBinary } {
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
        binary: { byteOrder: 'little-endian', buffers: buffers.map(encodePackBlob), views },
      }
    : result;
}

/** The caller has already copied plain data without invoking accessors. */
export function decodeRuntimePackData(input: object): object {
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
