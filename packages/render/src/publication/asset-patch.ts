import type { AssetChange, AssetRange } from '@forgeax/engine-assets-runtime/internal';
import {
  type Asset,
  type MaterialValue,
  type TerrainAsset,
  validateMaterialValues,
} from '@forgeax/engine-types';
import { RenderPublicationError } from './contract';

export interface PublishedAssetPatch {
  readonly handle: number;
  readonly base: number;
  readonly revision: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly removed: readonly string[];
  readonly ranges: readonly (AssetRange & { readonly bytes: Uint8Array })[];
}

const derivedGeometry = new Set(['collision', 'cardLayout', 'distanceField']);

function binary(value: unknown, path: readonly string[]): Uint8Array {
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new RenderPublicationError({ reason: 'shape', subject: 'asset binary path' });
    value = (value as Record<string, unknown>)[key];
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new RenderPublicationError({ reason: 'shape', subject: 'owned asset binary field' });
}

/** Copy only the changed bytes, including packed columns from strided mesh/texture ranges. */
export function publishAssetPatch(
  value: Asset,
  change: AssetChange,
  base: number,
): PublishedAssetPatch | undefined {
  const materialValues =
    value.kind === 'material' &&
    change.ranges.length === 0 &&
    change.fields.length === 1 &&
    change.fields[0] === 'values';
  const terrainHeights =
    value.kind === 'terrain' &&
    change.ranges.length > 0 &&
    change.ranges.every((range) => range.path.length === 1 && range.path[0] === 'heights') &&
    change.fields.every((field) => field === 'heightRange' || field === 'sections');
  if (
    !materialValues &&
    !terrainHeights &&
    ((value.kind !== 'mesh' && value.kind !== 'texture') ||
      change.ranges.length === 0 ||
      change.fields.some(
        (key) =>
          value.kind !== 'mesh' ||
          (key !== 'aabb' && !(derivedGeometry.has(key) && !Object.hasOwn(value, key))),
      ))
  )
    return undefined;
  return {
    handle: change.handle,
    base,
    revision: change.revision,
    fields: terrainHeights
      ? {}
      : structuredClone(
          Object.fromEntries(
            change.fields
              .filter((key) => Object.hasOwn(value, key))
              .map((key) => [key, (value as unknown as Record<string, unknown>)[key]]),
          ),
        ),
    removed: change.fields.filter((key) => !Object.hasOwn(value, key)),
    ranges: change.ranges.map((range) => {
      const rowBytes = range.rowBytes ?? range.byteLength;
      const stride = range.byteStride ?? rowBytes;
      const rows = (range.byteLength - rowBytes) / stride + 1;
      const source = binary(value, range.path);
      const bytes = new Uint8Array(rows * rowBytes);
      for (let row = 0; row < rows; row++) {
        const offset = range.byteOffset + row * stride;
        bytes.set(source.subarray(offset, offset + rowBytes), row * rowBytes);
      }
      return { ...range, path: [...range.path], bytes };
    }),
  };
}

/** Validate and capture every operation before the receiver commits any bytes. */
export function prepareAssetPatch(
  current: Asset,
  patch: PublishedAssetPatch,
  retained: boolean,
): {
  readonly value: Asset;
  readonly change: AssetChange;
  commit(): void;
} {
  const fail = () => {
    throw new RenderPublicationError({ reason: 'shape', subject: 'asset binary patch' });
  };
  if (current.kind === 'material') {
    if (
      patch.fields === null ||
      typeof patch.fields !== 'object' ||
      Array.isArray(patch.fields) ||
      !Array.isArray(patch.ranges) ||
      patch.ranges.length !== 0 ||
      !Array.isArray(patch.removed) ||
      patch.removed.length !== 0 ||
      Object.keys(patch.fields).length !== 1 ||
      !Object.hasOwn(patch.fields, 'values')
    )
      return fail();
    const values = structuredClone(patch.fields.values);
    if (
      values === null ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      !validateMaterialValues(
        '<publication>',
        values as Record<string, MaterialValue | null>,
        current.parameters === undefined
          ? undefined
          : new Map(current.parameters.map((parameter) => [parameter.name, parameter])),
      ).ok
    )
      return fail();
    return {
      value: { ...current, values: values as Record<string, MaterialValue | null> },
      change: {
        handle: patch.handle as AssetChange['handle'],
        revision: patch.revision,
        removed: false,
        fields: ['values'],
        ranges: [],
      },
      commit() {},
    };
  }
  if (current.kind === 'terrain') return prepareTerrainPatch(current, patch);
  const keyValid = (key: unknown): key is string =>
    typeof key === 'string' &&
    key !== 'kind' &&
    key !== '__proto__' &&
    key !== 'constructor' &&
    key !== 'prototype';
  if (
    (current.kind !== 'mesh' && current.kind !== 'texture') ||
    patch.fields === null ||
    typeof patch.fields !== 'object' ||
    Array.isArray(patch.fields) ||
    !Array.isArray(patch.removed) ||
    !Array.isArray(patch.ranges) ||
    patch.ranges.length === 0 ||
    patch.ranges.length > 64
  )
    return fail();
  const fields = structuredClone(patch.fields);
  const removed = [...patch.removed];
  const keys = Object.keys(fields);
  if (
    keys.some((key) => key !== 'aabb') ||
    removed.some((key) => !derivedGeometry.has(key)) ||
    (current.kind === 'texture' && (keys.length > 0 || removed.length > 0))
  )
    return fail();
  if (
    fields.aabb !== undefined &&
    (!(fields.aabb instanceof Float32Array) ||
      fields.aabb.length !== 6 ||
      !fields.aabb.every(Number.isFinite) ||
      [0, 1, 2].some(
        (axis) =>
          ((fields.aabb as Float32Array)[axis] as number) >
          ((fields.aabb as Float32Array)[axis + 3] as number),
      ))
  )
    return fail();
  const touched = new Set([...keys, ...removed]);
  const next = { ...current, ...fields } as unknown as Record<string, unknown>;
  for (const key of removed) delete next[key];
  const ranges: AssetRange[] = [];
  const copied = new WeakMap<object, unknown>();
  const copyBranch = (value: unknown, path: readonly string[], index = 0): unknown => {
    if (value === null || typeof value !== 'object') return fail();
    const cached = copied.get(value);
    if (index === path.length) {
      if (cached !== undefined) return cached;
      const owned = structuredClone(value);
      copied.set(value, owned);
      return owned;
    }
    const branch = (cached ?? { ...value }) as Record<string, unknown>;
    copied.set(value, branch);
    const key = path[index] as string;
    branch[key] = copyBranch((value as Record<string, unknown>)[key], path, index + 1);
    return branch;
  };
  const writes: {
    target: Uint8Array;
    bytes: Uint8Array;
    offset: number;
    rowBytes: number;
    stride: number;
  }[] = [];
  for (const range of patch.ranges) {
    if (
      !Array.isArray(range.path) ||
      range.path.length < 1 ||
      range.path.length > 2 ||
      !range.path.every(keyValid) ||
      touched.has(range.path[0] as string) ||
      !(range.bytes instanceof Uint8Array)
    )
      return fail();
    if (
      current.kind === 'texture'
        ? range.path.length !== 1 || range.path[0] !== 'data'
        : !(
            (range.path.length === 1 &&
              (range.path[0] === 'vertices' || range.path[0] === 'indices')) ||
            (range.path.length === 2 && range.path[0] === 'attributes')
          )
    )
      return fail();
    const rowBytes = range.rowBytes ?? range.byteLength;
    const stride = range.byteStride ?? rowBytes;
    const rows = (range.byteLength - rowBytes) / stride + 1;
    if (
      !Number.isSafeInteger(range.byteOffset) ||
      range.byteOffset < 0 ||
      !Number.isSafeInteger(rowBytes) ||
      rowBytes <= 0 ||
      !Number.isSafeInteger(stride) ||
      stride < rowBytes ||
      !Number.isSafeInteger(rows) ||
      rows < 1 ||
      !Number.isSafeInteger(range.byteLength) ||
      rows * rowBytes !== range.bytes.byteLength
    )
      return fail();
    // A fixed preparation owns the old buffers; ordinary receiver reads borrow until adoption.
    if (retained) {
      const key = range.path[0] as string;
      next[key] = copyBranch(
        (current as unknown as Record<string, unknown>)[key],
        range.path.slice(1),
      );
    }
    const target = binary(next, range.path);
    if (range.byteOffset + range.byteLength > target.byteLength) return fail();
    writes.push({ target, bytes: range.bytes.slice(), offset: range.byteOffset, rowBytes, stride });
    ranges.push({
      path: [...range.path],
      byteOffset: range.byteOffset,
      byteLength: range.byteLength,
      ...(range.rowBytes === undefined ? {} : { rowBytes }),
      ...(range.byteStride === undefined ? {} : { byteStride: stride }),
    });
  }
  return {
    value: next as unknown as Asset,
    change: {
      handle: patch.handle as AssetChange['handle'],
      revision: patch.revision,
      removed: false,
      fields: [...keys, ...removed],
      ranges,
    },
    commit: () => {
      for (const { target, bytes, offset, rowBytes, stride } of writes)
        for (
          let source = 0, destination = offset;
          source < bytes.byteLength;
          source += rowBytes, destination += stride
        )
          target.set(bytes.subarray(source, source + rowBytes), destination);
    },
  };
}

/** Bounds are derived from the transferred samples; no full sections array crosses the wire. */
function prepareTerrainPatch(
  current: TerrainAsset,
  patch: PublishedAssetPatch,
): {
  readonly value: Asset;
  readonly change: AssetChange;
  commit(): void;
} {
  const fail = (): never => {
    throw new RenderPublicationError({ reason: 'shape', subject: 'terrain height patch' });
  };
  if (
    patch.fields === null ||
    typeof patch.fields !== 'object' ||
    Array.isArray(patch.fields) ||
    Object.keys(patch.fields).length !== 0 ||
    !Array.isArray(patch.removed) ||
    patch.removed.length !== 0 ||
    !Array.isArray(patch.ranges) ||
    patch.ranges.length === 0 ||
    patch.ranges.length > 64
  )
    fail();
  let min = current.heightRange[0],
    max = current.heightRange[1];
  const step = current.subsectionVertices - 1;
  const nx = (current.columns - 1) / step,
    nz = (current.rows - 1) / step;
  const sections = new Map<number, TerrainAsset['sections'][number]>();
  const ranges: AssetRange[] = [];
  const writes: { offset: number; stride: number; rowBytes: number; bytes: Uint8Array }[] = [];
  for (const range of patch.ranges) {
    const rowBytes = range.rowBytes ?? range.byteLength;
    const stride = range.byteStride ?? rowBytes;
    const rows = (range.byteLength - rowBytes) / stride + 1;
    if (
      !Array.isArray(range.path) ||
      range.path.length !== 1 ||
      range.path[0] !== 'heights' ||
      !(range.bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(range.byteOffset) ||
      range.byteOffset < 0 ||
      !Number.isSafeInteger(rowBytes) ||
      rowBytes < 4 ||
      !Number.isSafeInteger(stride) ||
      stride < rowBytes ||
      !Number.isSafeInteger(rows) ||
      rows < 1 ||
      !Number.isSafeInteger(range.byteLength) ||
      range.byteOffset % 4 !== 0 ||
      rowBytes % 4 !== 0 ||
      stride % 4 !== 0 ||
      rows * rowBytes !== range.bytes.byteLength ||
      range.byteOffset + range.byteLength > current.heights.byteLength
    )
      fail();
    const bytes = range.bytes.slice();
    const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < rowBytes / 4; column++) {
        const value = values.getFloat32(row * rowBytes + column * 4, true);
        if (!Number.isFinite(value)) fail();
        min = Math.min(min, value);
        max = Math.max(max, value);
        const sample = (range.byteOffset + row * stride) / 4 + column;
        const x = sample % current.columns,
          z = Math.floor(sample / current.columns);
        for (
          let sz = Math.max(0, Math.ceil(z / step) - 1);
          sz <= Math.min(nz - 1, Math.floor(z / step));
          sz++
        )
          for (
            let sx = Math.max(0, Math.ceil(x / step) - 1);
            sx <= Math.min(nx - 1, Math.floor(x / step));
            sx++
          ) {
            const index = sz * nx + sx;
            const previous = sections.get(index) ?? current.sections[index] ?? fail();
            if (value < previous.minHeight || value > previous.maxHeight)
              sections.set(index, {
                ...previous,
                minHeight: Math.min(previous.minHeight, value),
                maxHeight: Math.max(previous.maxHeight, value),
              });
          }
      }
    writes.push({ offset: range.byteOffset, stride, rowBytes, bytes });
    ranges.push({
      path: ['heights'],
      byteOffset: range.byteOffset,
      byteLength: range.byteLength,
      ...(range.rowBytes === undefined ? {} : { rowBytes }),
      ...(range.byteStride === undefined ? {} : { byteStride: stride }),
    });
  }
  const value: TerrainAsset = { ...current, heightRange: [min, max] };
  return {
    value,
    change: {
      handle: patch.handle as AssetChange['handle'],
      revision: patch.revision,
      removed: false,
      fields: ['heightRange', ...(sections.size === 0 ? [] : ['sections'])],
      ranges,
    },
    commit() {
      const target = new Uint8Array(
        current.heights.buffer,
        current.heights.byteOffset,
        current.heights.byteLength,
      );
      for (const write of writes)
        for (
          let source = 0, destination = write.offset;
          source < write.bytes.byteLength;
          source += write.rowBytes, destination += write.stride
        )
          target.set(write.bytes.subarray(source, source + write.rowBytes), destination);
      for (const [index, section] of sections)
        (current.sections as TerrainAsset['sections'][number][])[index] = section;
    },
  };
}
