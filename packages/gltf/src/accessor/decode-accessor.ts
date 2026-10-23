import { err, type GltfError, gltfErr, ok, type Result } from '../errors.js';
import { accessorShape, accessorStorage, COMPONENT_TYPE } from './layout.js';

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

type AccessorFailure = 'unknownComponentType' | 'layout' | 'sparse';

/** Byte geometry of one element; matrix columns are padded to 4 bytes. */
interface ElementLayout {
  readonly width: number;
  readonly rows: number;
  readonly components: number;
  readonly columnBytes: number;
  readonly elementBytes: number;
  readonly finalElementBytes: number;
  readonly alignment: number;
  readonly length: number;
}
interface ByteRange {
  readonly view: DataView;
  readonly start: number;
}
interface DenseRange extends ByteRange {
  readonly stride: number;
}
interface SparseRanges {
  readonly indices: ByteRange;
  readonly values: ByteRange;
  readonly indexWidth: number;
}
type AccessorOutput = Float32Array | Uint16Array | Uint32Array;

/** A single decoder for attributes, indices, skin, morph and animation. Matrix columns are 4-byte aligned. */
export function decodeAccessor(input: DecodeAccessorInput): Result<DecodedAccessor, GltfError> {
  const { accessorIndex, accessor, role } = input;
  const fail = (reason: AccessorFailure) =>
    err(gltfErr('gltf-accessor-type-mismatch', { accessorIndex, reason }));
  if (accessor == null || typeof accessor !== 'object') return fail('layout');
  const layout = elementLayout(accessor);
  if (layout === undefined) return fail('unknownComponentType');
  if (!isDeclarationAdmissible(accessor, layout, role)) return fail('layout');
  let dense: DenseRange | undefined;
  if (accessor.bufferView !== undefined) {
    if (!isDenseStrideValid(input, accessor.bufferView, layout)) return fail('layout');
    const base = denseRange(input, accessor.bufferView, layout);
    if (!base.ok) return base;
    dense = base.value;
  } else if ((accessor.byteOffset ?? 0) !== 0) return fail('layout');
  let sparseData: SparseRanges | undefined;
  if (accessor.sparse !== undefined) {
    const sparse = sparseRanges(input, accessor.sparse, layout);
    if (!sparse.ok) return sparse;
    if (sparse.value === undefined) return fail('sparse');
    sparseData = sparse.value;
  }
  const out = allocateOutput(accessor, role, layout.length);
  if (dense !== undefined && !fillDense(out, accessor, layout, dense)) return fail('layout');
  if (sparseData !== undefined && accessor.sparse !== undefined) {
    const failure = applySparse(out, accessor, accessor.sparse, layout, sparseData);
    if (failure !== undefined) return fail(failure);
  }
  return ok(decodedAccessor(out));
}

function elementLayout(accessor: AccessorJson): ElementLayout | undefined {
  const componentWidth = accessorStorage(accessor.componentType)?.BYTES_PER_ELEMENT,
    shape = accessorShape(accessor.type);
  if (componentWidth === undefined || shape === undefined) return undefined;
  const width: number = componentWidth;
  const [rows, columns] = shape;
  const components = rows * columns;
  const columnBytes = columns === 1 ? rows * width : Math.ceil((rows * width) / 4) * 4;
  return {
    width,
    rows,
    components,
    columnBytes,
    elementBytes: columnBytes * columns,
    finalElementBytes: columnBytes * (columns - 1) + rows * width,
    alignment: columns > 1 ? 4 : width,
    length: accessor.count * components,
  };
}

/** Bounded element count; normalization is attribute-only; index and joint accessors admit only their integer types. */
function isDeclarationAdmissible(
  accessor: AccessorJson,
  layout: ElementLayout,
  role: AccessorRole,
): boolean {
  if (!integer(accessor.count) || !integer(layout.length) || layout.length > 67_108_864)
    return false;
  if (
    accessor.normalized === true &&
    (accessor.componentType === 5126 || accessor.componentType === 5125 || role !== 'attribute')
  )
    return false;
  if (
    role === 'indices' &&
    (accessor.type !== 'SCALAR' || ![5121, 5123, 5125].includes(accessor.componentType))
  )
    return false;
  return !(
    role === 'joints' &&
    (accessor.type !== 'VEC4' || ![5121, 5123].includes(accessor.componentType))
  );
}

/** Attributes decode to floats; indices and joints keep their integer width. */
function allocateOutput(
  accessor: AccessorJson,
  role: AccessorRole,
  length: number,
): AccessorOutput {
  if (role === 'attribute') return new Float32Array(length);
  return accessor.componentType === 5125 ? new Uint32Array(length) : new Uint16Array(length);
}

function decodedAccessor(out: AccessorOutput): DecodedAccessor {
  if (out instanceof Float32Array) return { kind: 'f32', data: out };
  if (out instanceof Uint32Array) return { kind: 'u32', data: out };
  return { kind: 'u16', data: out };
}

function denseStride(input: DecodeAccessorInput, viewIndex: number, layout: ElementLayout): number {
  return input.bufferViews[viewIndex]?.byteStride ?? layout.elementBytes;
}

function isDenseStrideValid(
  input: DecodeAccessorInput,
  viewIndex: number,
  layout: ElementLayout,
): boolean {
  const stride = denseStride(input, viewIndex, layout);
  return !(
    !integer(stride) ||
    stride < layout.elementBytes ||
    stride % layout.width !== 0 ||
    (input.bufferViews[viewIndex]?.byteStride !== undefined &&
      (stride < 4 || stride > 252 || stride % 4 !== 0 || input.role === 'indices'))
  );
}

function denseRange(
  input: DecodeAccessorInput,
  viewIndex: number,
  layout: ElementLayout,
): Result<DenseRange, GltfError> {
  const stride = denseStride(input, viewIndex, layout);
  const base = byteRange(
    input,
    viewIndex,
    input.accessor.byteOffset ?? 0,
    input.accessor.count,
    layout.finalElementBytes,
    stride,
    layout.alignment,
  );
  if (!base.ok) return base;
  return ok({ ...base.value, stride });
}

type SparseJson = NonNullable<AccessorJson['sparse']>;

/** Sparse index/value ranges; `undefined` is a malformed sparse declaration. */
function sparseRanges(
  input: DecodeAccessorInput,
  sparse: SparseJson,
  layout: ElementLayout,
): Result<SparseRanges | undefined, GltfError> {
  if (
    sparse === null ||
    !integer(sparse.count) ||
    sparse.count < 1 ||
    sparse.count > input.accessor.count ||
    sparse.indices == null ||
    sparse.values == null ||
    ![5121, 5123, 5125].includes(sparse.indices.componentType)
  )
    return ok(undefined);
  const indexWidth = accessorStorage(sparse.indices.componentType)?.BYTES_PER_ELEMENT;
  if (indexWidth === undefined) return ok(undefined);
  if (
    input.bufferViews[sparse.indices.bufferView]?.byteStride !== undefined ||
    input.bufferViews[sparse.values.bufferView]?.byteStride !== undefined
  )
    return ok(undefined);
  const indices = byteRange(
    input,
    sparse.indices.bufferView,
    sparse.indices.byteOffset ?? 0,
    sparse.count,
    indexWidth,
    indexWidth,
    indexWidth,
  );
  if (!indices.ok) return indices;
  const values = byteRange(
    input,
    sparse.values.bufferView,
    sparse.values.byteOffset ?? 0,
    sparse.count,
    layout.finalElementBytes,
    layout.elementBytes,
    layout.alignment,
  );
  if (!values.ok) return values;
  return ok({ indices: indices.value, values: values.value, indexWidth });
}

function byteRange(
  input: DecodeAccessorInput,
  viewIndex: number,
  offset: number,
  count: number,
  size: number,
  stride: number,
  alignment: number,
): Result<ByteRange, GltfError> {
  const bv = input.bufferViews[viewIndex] ?? undefined;
  const buffer = bv === undefined ? undefined : input.buffers[bv.buffer];
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
        accessor: input.accessorIndex,
        byteOffset: start,
        byteLength: bytes,
        bufferIndex: bv?.buffer ?? -1,
      }),
    );
  }
  return ok({ view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), start });
}

/** Bulk-copy tightly packed little-endian floats; otherwise convert element by element. */
function fillDense(
  out: AccessorOutput,
  accessor: AccessorJson,
  layout: ElementLayout,
  dense: DenseRange,
): boolean {
  const absolute = dense.view.byteOffset + dense.start;
  if (
    out instanceof Float32Array &&
    accessor.componentType === 5126 &&
    dense.stride === layout.elementBytes &&
    absolute % 4 === 0 &&
    LITTLE_ENDIAN
  ) {
    out.set(new Float32Array(dense.view.buffer, absolute, layout.length));
    for (let i = 0; i < layout.length; i++) if (!Number.isFinite(out[i])) return false;
    return true;
  }
  for (let i = 0; i < accessor.count; i++)
    if (!copyElement(out, accessor, layout, dense.view, dense.start + i * dense.stride, i))
      return false;
  return true;
}

function applySparse(
  out: AccessorOutput,
  accessor: AccessorJson,
  sparse: SparseJson,
  layout: ElementLayout,
  ranges: SparseRanges,
): AccessorFailure | undefined {
  const { indices, values, indexWidth } = ranges;
  let previous = -1;
  for (let i = 0; i < sparse.count; i++) {
    const target = readComponent(
      indices.view,
      indices.start + i * indexWidth,
      sparse.indices.componentType,
    );
    if (target <= previous || target >= accessor.count) return 'sparse';
    previous = target;
    if (
      !copyElement(
        out,
        accessor,
        layout,
        values.view,
        values.start + i * layout.elementBytes,
        target,
      )
    )
      return 'layout';
  }
  return undefined;
}

function readComponent(view: DataView, offset: number, type: number): number {
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

function normalizedComponent(value: number, componentType: number): number {
  return componentType === 5120
    ? Math.max(-1, value / 127)
    : componentType === 5122
      ? Math.max(-1, value / 32767)
      : value / (componentType === 5121 ? 255 : 65535);
}

function copyElement(
  out: AccessorOutput,
  accessor: AccessorJson,
  layout: ElementLayout,
  view: DataView,
  source: number,
  target: number,
): boolean {
  const { components, rows, columnBytes, width } = layout;
  for (let c = 0; c < components; c++) {
    let value = readComponent(
      view,
      source + Math.floor(c / rows) * columnBytes + (c % rows) * width,
      accessor.componentType,
    );
    if (!Number.isFinite(value)) return false;
    if (accessor.normalized === true) value = normalizedComponent(value, accessor.componentType);
    out[target * components + c] = value;
  }
  return true;
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
