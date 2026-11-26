import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import { decodeTangentFrame32 } from './tangent-frame32';
import {
  deriveVertexLayoutProjection,
  elementView,
  interleaveStaticMeshVertexStreams,
  staticMeshLayoutForCount,
  type VertexAttributeArray,
  type VertexLayoutProjection,
  vertexAttributeArrayType,
} from './vertex-attribute-layout';

export type MeshAttributeKey = keyof VertexAttributeMap;

/** One sequential finite scan. Integer skin words may spell float NaNs and
 * must be skipped; the error-only lookup retains channel-specific diagnostics. */
export function interleavedMeshFiniteFailure(
  vertices: Float32Array,
  layout: Pick<VertexLayoutProjection, 'arrayStride' | 'attributes'>,
): MeshAttributeKey | undefined {
  const stride = layout.arrayStride / 4;
  const integers = layout.attributes.filter(
    (entry) => vertexAttributeArrayType(entry.format) !== Float32Array,
  );
  const channel = (index: number) =>
    layout.attributes.find(
      (entry) =>
        index % stride >= entry.offset / 4 &&
        index % stride < (entry.offset + entry.byteLength) / 4,
    )?.key;
  if (integers.length === 0) {
    for (let index = 0; index < vertices.length; index++)
      if (!Number.isFinite(vertices[index])) return channel(index);
  } else {
    const spans: [number, number][] = [];
    let cursor = 0;
    for (const entry of integers) {
      spans.push([cursor, entry.offset / 4]);
      cursor = (entry.offset + entry.byteLength) / 4;
    }
    spans.push([cursor, stride]);
    for (let row = 0; row < vertices.length; row += stride) {
      for (const [first, end] of spans)
        for (let index = row + first; index < row + end; index++)
          if (!Number.isFinite(vertices[index])) return channel(index);
    }
  }
  return undefined;
}

/** Validate float lanes in their actual packed order without unfolding packed integer words. */
export function staticMeshStreamsFiniteFailure(
  vertices: Float32Array,
  layout: VertexLayoutProjection,
): MeshAttributeKey | undefined {
  const count = vertices.byteLength / layout.arrayStride;
  const streams = staticMeshLayoutForCount(layout, count)?.streams;
  if (streams === undefined) throw new TypeError('invalid static stream projection');
  let start = 0;
  for (const stream of streams) {
    const end = start + (stream.arrayStride * count) / 4;
    const issue = interleavedMeshFiniteFailure(vertices.subarray(start, end), stream);
    if (issue !== undefined) return issue;
    start = end;
  }
  return undefined;
}

/** A numeric window, resolved once outside a CPU loop. No vertex bytes are copied.
 * Read data[offset + vertex * stride + component]. Offsets and strides are in
 * elements of data, including uint16 skin indices in mixed packed rows. */
export interface ReadonlyMeshAttributeWindow {
  readonly data: ArrayLike<number>;
  readonly offset: number;
  readonly stride: number;
  readonly components: number;
  readonly count: number;
}

export interface MeshAttributeWindow extends ReadonlyMeshAttributeWindow {
  readonly data: VertexAttributeArray;
}

/** Return the first packed layout declaration that still owns data or has the wrong format. */
export function invalidMeshAttributeDeclaration(
  attributes: VertexAttributeMap,
  layout: VertexLayoutProjection,
): MeshAttributeKey | undefined {
  for (const attribute of layout.attributes) {
    const value = attributes[attribute.key];
    const ArrayType = vertexAttributeArrayType(attribute.format);
    if (!(value instanceof ArrayType) || value.length !== 0 || value.buffer.byteLength !== 0)
      return attribute.key;
  }
  return undefined;
}

/** One empty backing per mesh: transferring a declaration cannot detach another
 * mesh's layout metadata, and empty subviews never pin vertex-sized storage. */
export function meshAttributeLayout(
  source: VertexAttributeMap | VertexLayoutProjection,
): VertexAttributeMap {
  const layout = 'arrayStride' in source ? source : deriveVertexLayoutProjection(source);
  const result: VertexAttributeMap = {};
  const storage = new ArrayBuffer(0);
  const floats = new Float32Array(storage);
  for (const entry of layout.attributes) {
    const ArrayType = vertexAttributeArrayType(entry.format);
    Reflect.set(result, entry.key, ArrayType === Float32Array ? floats : new ArrayType(storage));
  }
  return result;
}

/** Call after validation. Retains the existing packed rows without copying or
 * eagerly decoding CPU channels. Authoring inputs and their buffers stay intact. */
export function interleavedMesh<T extends MeshAsset>(mesh: T): T {
  if (mesh.attributeStorage === 'interleaved') return mesh;
  return {
    ...mesh,
    attributeStorage: 'interleaved',
    vertices:
      mesh.attributeStorage === 'static-streams'
        ? interleaveStaticMeshVertexStreams(
            mesh.vertices,
            deriveVertexLayoutProjection(mesh.attributes),
          )
        : mesh.vertices,
    attributes: meshAttributeLayout(mesh.attributes),
  };
}

export function meshAttributeWindow(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: MeshAttributeKey,
): MeshAttributeWindow | undefined {
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  const entry = layout.attributes.find((attribute) => attribute.key === key);
  if (entry === undefined) return undefined;
  const ArrayType = vertexAttributeArrayType(entry.format);
  const bytes = ArrayType.BYTES_PER_ELEMENT;
  const components = entry.byteLength / bytes;
  if (mesh.attributeStorage === undefined) {
    const data = elementView(mesh.attributes[key], entry.format);
    if (!(data instanceof ArrayType)) return undefined;
    return { data, offset: 0, stride: components, components, count: data.length / components };
  }
  const data =
    ArrayType === Float32Array
      ? mesh.vertices
      : new ArrayType(
          mesh.vertices.buffer,
          mesh.vertices.byteOffset,
          mesh.vertices.byteLength / bytes,
        );
  const count = mesh.vertices.byteLength / layout.arrayStride;
  if (mesh.attributeStorage === 'static-streams') {
    const streams = staticMeshLayoutForCount(layout, count)?.streams;
    if (streams === undefined) return undefined;
    let offset = 0;
    for (const stream of streams) {
      const physical = stream.attributes.find((attribute) => attribute.key === key);
      if (physical !== undefined)
        return {
          data,
          offset: (offset + physical.offset) / bytes,
          stride: stream.arrayStride / bytes,
          components,
          count,
        };
      offset += stream.arrayStride * count;
    }
    return undefined;
  }
  return {
    data,
    offset: entry.offset / bytes,
    stride: layout.arrayStride / bytes,
    components,
    count,
  };
}

/** Explicit temporary/output channel for algorithms requiring contiguous lanes.
 * No hidden cache: holding this result is an explicit second representation. */
export function copyMeshAttribute(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: 'tangentFrame',
  output?: Uint32Array,
): Uint32Array | undefined;
export function copyMeshAttribute(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: 'skinIndex',
  output?: Uint16Array,
): Uint16Array | undefined;
export function copyMeshAttribute(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: Exclude<MeshAttributeKey, 'skinIndex' | 'tangentFrame'>,
  output?: Float32Array,
): Float32Array | undefined;
export function copyMeshAttribute(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: MeshAttributeKey,
  output?: Float32Array | Uint16Array | Uint32Array,
): Float32Array | Uint16Array | Uint32Array | undefined;
export function copyMeshAttribute(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: MeshAttributeKey,
  output?: Float32Array | Uint16Array | Uint32Array,
): Float32Array | Uint16Array | Uint32Array | undefined {
  if ((key === 'normal' || key === 'tangent') && mesh.attributes.tangentFrame !== undefined) {
    return copyDecodedTangentFrame(mesh, key, output);
  }
  if (key === 'skinWeight') {
    const window = meshAttributeWindow(mesh, key);
    if (window === undefined) return undefined;
    const { data, count, stride, offset, components } = window;
    const scale = skinWeightDenominator(data);
    if (scale !== 1) {
      const out = output ?? new Float32Array(count * components);
      if (
        !(out instanceof Float32Array) ||
        out.length !== count * components ||
        out.buffer === data.buffer
      )
        throw new RangeError(
          'Decoded skin weight output must be an independent matching float channel',
        );
      for (let row = 0; row < count; row++)
        for (let lane = 0; lane < components; lane++)
          out[row * components + lane] = (data[offset + row * stride + lane] as number) / scale;
      return out;
    }
  }
  return copyMeshAttributeStorage(mesh, key, output) as
    | Float32Array
    | Uint16Array
    | Uint32Array
    | undefined;
}

export function skinWeightDenominator(data: VertexAttributeArray): 1 | 255 | 65535 {
  if (data instanceof Uint8Array) return 255;
  if (data instanceof Uint16Array) return 65535;
  return 1;
}

/** Copy stored components without decoding normalized formats. */
export function copyMeshAttributeStorage(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: MeshAttributeKey,
  output?: VertexAttributeArray,
): VertexAttributeArray | undefined {
  const window = meshAttributeWindow(mesh, key);
  if (window === undefined) return undefined;
  const { data, offset, stride, components, count } = window;
  const length = count * components;
  const ArrayType = data.constructor as
    | typeof Uint8Array
    | typeof Uint16Array
    | typeof Uint32Array
    | typeof Float32Array;
  const out = output ?? new ArrayType(length);
  if (out.length !== length || out.constructor !== data.constructor)
    throw new RangeError('mesh attribute output must match channel type and cardinality');
  if (out.buffer === data.buffer)
    throw new RangeError('mesh attribute output must not alias its source');
  // Preserve all float bit patterns; integer lanes can be copied directly.
  const source =
    data instanceof Float32Array
      ? new Uint32Array(data.buffer, data.byteOffset, data.length)
      : data;
  const target =
    out instanceof Float32Array ? new Uint32Array(out.buffer, out.byteOffset, out.length) : out;
  for (let row = 0; row < count; row++)
    for (let lane = 0; lane < components; lane++)
      target[row * components + lane] = source[offset + row * stride + lane] as number;
  return out;
}

function copyDecodedTangentFrame(
  mesh: Pick<MeshAsset, 'vertices' | 'attributes' | 'attributeStorage'>,
  key: 'normal' | 'tangent',
  output: Float32Array | Uint16Array | Uint32Array | undefined,
): Float32Array | undefined {
  const frame = meshAttributeWindow(mesh, 'tangentFrame');
  if (!frame) return undefined;
  const components = key === 'normal' ? 3 : 4;
  const first = key === 'normal' ? 0 : 3;
  const out = output ?? new Float32Array(frame.count * components);
  if (
    !(out instanceof Float32Array) ||
    out.length !== frame.count * components ||
    out.buffer === frame.data.buffer
  )
    throw new RangeError(
      'Decoded tangent frame output must be an independent matching float channel',
    );
  const scratch = new Float32Array(7);
  for (let row = 0; row < frame.count; row++) {
    decodeTangentFrame32(frame.data[frame.offset + row * frame.stride] as number, scratch);
    for (let lane = 0; lane < components; lane++)
      out[row * components + lane] = scratch[first + lane] as number;
  }
  return out;
}

/** Authoring/cold conversion only; raster uploads and runtime edits use rows. */
export function meshAttributeChannels(mesh: MeshAsset): VertexAttributeMap {
  if (mesh.attributeStorage === undefined && mesh.attributes.tangentFrame === undefined)
    return mesh.attributes;
  const result: VertexAttributeMap = {};
  for (const key of Object.keys(mesh.attributes) as MeshAttributeKey[])
    if (key !== 'tangentFrame') Reflect.set(result, key, copyMeshAttributeStorage(mesh, key));
  if (mesh.attributes.tangentFrame !== undefined) {
    const normal = copyMeshAttribute(mesh, 'normal'),
      tangent = copyMeshAttribute(mesh, 'tangent');
    if (!normal || !tangent) throw new RangeError('Invalid packed tangent frame attribute');
    result.normal = normal;
    result.tangent = tangent;
  }
  return result;
}
