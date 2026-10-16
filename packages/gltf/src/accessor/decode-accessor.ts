import { err, type GltfError, gltfErr, ok, type Result } from '../errors.js';

export const COMPONENT_TYPE = {
  I8: 5120,
  U8: 5121,
  I16: 5122,
  U16: 5123,
  U32: 5125,
  F32: 5126,
} as const;
export type ComponentTypeId = (typeof COMPONENT_TYPE)[keyof typeof COMPONENT_TYPE];
const WIDTH: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const SHAPE: Readonly<Record<string, readonly [number, number]>> = {
  SCALAR: [1, 1],
  VEC2: [2, 1],
  VEC3: [3, 1],
  VEC4: [4, 1],
  MAT2: [2, 2],
  MAT3: [3, 3],
  MAT4: [4, 4],
};
export interface AccessorJson {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly normalized?: boolean;
  readonly type: string;
  readonly sparse?: {
    readonly count: number;
    readonly indices: {
      readonly bufferView: number;
      readonly byteOffset?: number;
      readonly componentType: number;
    };
    readonly values: { readonly bufferView: number; readonly byteOffset?: number };
  };
}
export interface BufferViewJson {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}
export type AccessorRole = 'attribute' | 'indices' | 'joints';
export interface DecodeAccessorInput {
  readonly accessorIndex: number;
  readonly accessor: AccessorJson;
  readonly bufferViews: readonly BufferViewJson[];
  readonly buffers: readonly Uint8Array[];
  readonly role: AccessorRole;
}
export type DecodedAccessor =
  | { readonly kind: 'f32'; readonly data: Float32Array }
  | { readonly kind: 'u16'; readonly data: Uint16Array }
  | { readonly kind: 'u32'; readonly data: Uint32Array };
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** A single decoder for attributes, indices, skin, morph and animation. Matrix columns are 4-byte aligned. */
export function decodeAccessor(input: DecodeAccessorInput): Result<DecodedAccessor, GltfError> {
  const { accessorIndex, accessor, bufferViews, buffers, role } = input;
  const fail = (reason: 'unknownComponentType' | 'layout' | 'sparse') =>
    err(gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason }));
  if (accessor == null || typeof accessor !== 'object') return fail('layout');
  const componentWidth = WIDTH[accessor.componentType],
    shape = SHAPE[accessor.type];
  if (componentWidth === undefined || shape === undefined) return fail('unknownComponentType');
  const width: number = componentWidth;
  const [rows, columns] = shape;
  const components = rows * columns;
  const columnBytes = columns === 1 ? rows * width : Math.ceil((rows * width) / 4) * 4;
  const elementBytes = columnBytes * columns;
  const finalElementBytes = columnBytes * (columns - 1) + rows * width;
  const length = accessor.count * components;
  if (!integer(accessor.count) || !integer(length) || length > 67_108_864) return fail('layout');
  if (
    accessor.normalized === true &&
    (accessor.componentType === 5126 || accessor.componentType === 5125 || role !== 'attribute')
  )
    return fail('layout');
  if (
    role === 'indices' &&
    (accessor.type !== 'SCALAR' || ![5121, 5123, 5125].includes(accessor.componentType))
  )
    return fail('layout');
  if (
    role === 'joints' &&
    (accessor.type !== 'VEC4' || ![5121, 5123].includes(accessor.componentType))
  )
    return fail('layout');
  const kind = role === 'attribute' ? 'f32' : accessor.componentType === 5125 ? 'u32' : 'u16';
  function range(
    viewIndex: number,
    offset: number,
    count: number,
    size: number,
    stride: number,
    alignment: number,
  ): Result<{ view: DataView; start: number }, GltfError> {
    const bv = bufferViews[viewIndex] ?? undefined;
    const buffer = bv === undefined ? undefined : buffers[bv.buffer];
    const start = (bv?.byteOffset ?? 0) + offset;
    const bytes = count === 0 ? 0 : (count - 1) * stride + size;
    if (
      !integer(viewIndex) ||
      bv === undefined ||
      !integer(bv.buffer) ||
      buffer === undefined ||
      !integer(offset) ||
      !integer(bv.byteOffset ?? 0) ||
      !integer(bv.byteLength) ||
      !integer(start) ||
      start % alignment !== 0 ||
      !integer(bytes) ||
      offset + bytes > bv.byteLength ||
      (bv.byteOffset ?? 0) + bv.byteLength > buffer.byteLength
    ) {
      return err(
        gltfErr('gltf-buffer-out-of-bounds', {
          accessor: accessorIndex,
          byteOffset: start,
          byteLength: bytes,
          bufferIndex: bv?.buffer ?? -1,
        }),
      );
    }
    return ok({ view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), start });
  }
  let dense: { view: DataView; start: number; stride: number } | undefined;
  let sparseData:
    | {
        indices: { view: DataView; start: number };
        values: { view: DataView; start: number };
        indexWidth: number;
      }
    | undefined;
  if (accessor.bufferView !== undefined) {
    const stride = bufferViews[accessor.bufferView]?.byteStride ?? elementBytes;
    if (
      !integer(stride) ||
      stride < elementBytes ||
      stride % width !== 0 ||
      (bufferViews[accessor.bufferView]?.byteStride !== undefined &&
        (stride < 4 || stride > 252 || stride % 4 !== 0 || role === 'indices'))
    )
      return fail('layout');
    const base = range(
      accessor.bufferView,
      accessor.byteOffset ?? 0,
      accessor.count,
      finalElementBytes,
      stride,
      columns > 1 ? 4 : width,
    );
    if (!base.ok) return base;
    dense = { ...base.value, stride };
  } else if ((accessor.byteOffset ?? 0) !== 0) return fail('layout');
  if (accessor.sparse !== undefined) {
    const sparse = accessor.sparse;
    if (
      sparse === null ||
      !integer(sparse.count) ||
      sparse.count < 1 ||
      sparse.count > accessor.count ||
      sparse.indices == null ||
      sparse.values == null ||
      ![5121, 5123, 5125].includes(sparse.indices.componentType)
    )
      return fail('sparse');
    const indexWidth = WIDTH[sparse.indices.componentType];
    if (indexWidth === undefined) return fail('sparse');
    if (
      bufferViews[sparse.indices.bufferView]?.byteStride !== undefined ||
      bufferViews[sparse.values.bufferView]?.byteStride !== undefined
    )
      return fail('sparse');
    const indices = range(
      sparse.indices.bufferView,
      sparse.indices.byteOffset ?? 0,
      sparse.count,
      indexWidth,
      indexWidth,
      indexWidth,
    );
    if (!indices.ok) return indices;
    const values = range(
      sparse.values.bufferView,
      sparse.values.byteOffset ?? 0,
      sparse.count,
      finalElementBytes,
      elementBytes,
      columns > 1 ? 4 : width,
    );
    if (!values.ok) return values;
    sparseData = { indices: indices.value, values: values.value, indexWidth };
  }
  const out =
    kind === 'f32'
      ? new Float32Array(length)
      : kind === 'u32'
        ? new Uint32Array(length)
        : new Uint16Array(length);
  function read(view: DataView, offset: number, type: number): number {
    switch (type) {
      case 5120:
        return view.getInt8(offset);
      case 5121:
        return view.getUint8(offset);
      case 5122:
        return view.getInt16(offset, true);
      case 5123:
        return view.getUint16(offset, true);
      case 5125:
        return view.getUint32(offset, true);
      case 5126:
        return view.getFloat32(offset, true);
    }
    return NaN;
  }
  function copy(view: DataView, source: number, target: number): boolean {
    for (let c = 0; c < components; c++) {
      let value = read(
        view,
        source + Math.floor(c / rows) * columnBytes + (c % rows) * width,
        accessor.componentType,
      );
      if (!Number.isFinite(value)) return false;
      if (accessor.normalized === true) {
        value =
          accessor.componentType === 5120
            ? Math.max(-1, value / 127)
            : accessor.componentType === 5122
              ? Math.max(-1, value / 32767)
              : value / (accessor.componentType === 5121 ? 255 : 65535);
      }
      out[target * components + c] = value;
    }
    return true;
  }
  if (dense !== undefined) {
    const absolute = dense.view.byteOffset + dense.start;
    if (
      kind === 'f32' &&
      accessor.componentType === 5126 &&
      dense.stride === elementBytes &&
      absolute % 4 === 0 &&
      LITTLE_ENDIAN
    ) {
      out.set(new Float32Array(dense.view.buffer, absolute, length));
      for (let i = 0; i < length; i++) if (!Number.isFinite(out[i])) return fail('layout');
    } else
      for (let i = 0; i < accessor.count; i++)
        if (!copy(dense.view, dense.start + i * dense.stride, i)) return fail('layout');
  }
  if (sparseData !== undefined && accessor.sparse !== undefined) {
    const { indices, values, indexWidth } = sparseData;
    const sparse = accessor.sparse;
    let previous = -1;
    for (let i = 0; i < sparse.count; i++) {
      const target = read(
        indices.view,
        indices.start + i * indexWidth,
        sparse.indices.componentType,
      );
      if (target <= previous || target >= accessor.count) return fail('sparse');
      previous = target;
      if (!copy(values.view, values.start + i * elementBytes, target)) return fail('layout');
    }
  }
  if (out instanceof Float32Array) return ok({ kind: 'f32', data: out });
  if (out instanceof Uint32Array) return ok({ kind: 'u32', data: out });
  return ok({ kind: 'u16', data: out });
}
export function decodeF32Accessor(
  accessorIndex: number,
  accessor: AccessorJson,
  allowedTypes: readonly string[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<Float32Array, GltfError> {
  if (accessor.componentType !== COMPONENT_TYPE.F32 || !allowedTypes.includes(accessor.type))
    return err(
      gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason: 'unknownComponentType' }),
    );
  const result = decodeAccessor({
    accessorIndex,
    accessor,
    bufferViews,
    buffers,
    role: 'attribute',
  });
  if (!result.ok) return result;
  if (result.value.kind === 'f32') return ok(result.value.data);
  return err(
    gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason: 'unknownComponentType' }),
  );
}
