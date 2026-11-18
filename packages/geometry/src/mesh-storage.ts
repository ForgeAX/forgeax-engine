import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import { decodeTangentFrame32 } from './tangent-frame32';
import {
  deriveVertexLayoutProjection,
  elementView,
  type VertexLayoutProjection,
} from './vertex-attribute-layout';

export type MeshAttributeKey = keyof VertexAttributeMap;

/** One sequential finite scan. Integer skin words may spell float NaNs and
 * must be skipped; the error-only lookup retains channel-specific diagnostics. */
export function interleavedMeshFiniteFailure(
  vertices: Float32Array,
  layout: VertexLayoutProjection,
): MeshAttributeKey | undefined {
  const stride = layout.arrayStride / 4;
  const integers = layout.attributes.filter(
    (entry) => entry.format === 'uint16x4' || entry.format === 'uint32',
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
  readonly data: Float32Array | Uint16Array | Uint32Array;
}

/** One empty backing per mesh: transferring a declaration cannot detach another
 * mesh's layout metadata, and empty subviews never pin vertex-sized storage. */
export function meshAttributeLayout(attributes: VertexAttributeMap): VertexAttributeMap {
  const result: VertexAttributeMap = {};
  const storage = new ArrayBuffer(0);
  const floats = new Float32Array(storage);
  let shorts: Uint16Array | undefined;
  let words: Uint32Array | undefined;
  for (const entry of deriveVertexLayoutProjection(attributes).attributes) {
    if (entry.format === 'uint16x4' && shorts === undefined) shorts = new Uint16Array(storage);
    if (entry.format === 'uint32' && words === undefined) words = new Uint32Array(storage);
    Reflect.set(
      result,
      entry.key,
      entry.format === 'uint32' ? words : entry.format === 'uint16x4' ? shorts : floats,
    );
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
  const bytes = entry.format === 'uint16x4' ? 2 : 4;
  const components = entry.byteLength / bytes;
  if (mesh.attributeStorage !== 'interleaved') {
    const data = elementView(mesh.attributes[key], entry.format);
    if (
      data === undefined ||
      (entry.format === 'uint16x4'
        ? !(data instanceof Uint16Array)
        : entry.format === 'uint32'
          ? !(data instanceof Uint32Array)
          : !(data instanceof Float32Array))
    )
      return undefined;
    return { data, offset: 0, stride: components, components, count: data.length / components };
  }
  const data =
    bytes === 2
      ? new Uint16Array(
          mesh.vertices.buffer,
          mesh.vertices.byteOffset,
          mesh.vertices.byteLength / 2,
        )
      : entry.format === 'uint32'
        ? new Uint32Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.length)
        : mesh.vertices;
  return {
    data,
    offset: entry.offset / bytes,
    stride: layout.arrayStride / bytes,
    components,
    count: mesh.vertices.byteLength / layout.arrayStride,
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
  const window = meshAttributeWindow(mesh, key);
  if (window === undefined) return undefined;
  const { data, offset, stride, components, count } = window;
  const length = count * components;
  const out =
    output ??
    (data instanceof Uint16Array
      ? new Uint16Array(length)
      : data instanceof Uint32Array
        ? new Uint32Array(length)
        : new Float32Array(length));
  if (out.length !== length || out.constructor !== data.constructor)
    throw new RangeError('mesh attribute output must match channel type and cardinality');
  // A packed input can share this output's backing; avoid overwriting unread rows.
  if (out.buffer === data.buffer)
    throw new RangeError('mesh attribute output must not alias its source');
  if (data instanceof Uint16Array) {
    for (let row = 0; row < count; row++)
      for (let lane = 0; lane < components; lane++)
        out[row * components + lane] = data[offset + row * stride + lane] as number;
  } else {
    // Preserve signed zero and all admitted float32 bits, rather than converting lanes.
    const source = new Uint32Array(data.buffer, data.byteOffset, data.length);
    const target = new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
    for (let row = 0; row < count; row++)
      for (let lane = 0; lane < components; lane++)
        target[row * components + lane] = source[offset + row * stride + lane] as number;
  }
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
  if (mesh.attributeStorage !== 'interleaved' && mesh.attributes.tangentFrame === undefined)
    return mesh.attributes;
  const result: VertexAttributeMap = {};
  for (const key of Object.keys(mesh.attributes) as MeshAttributeKey[])
    if (key !== 'tangentFrame') Reflect.set(result, key, copyMeshAttribute(mesh, key));
  if (mesh.attributes.tangentFrame !== undefined) {
    const normal = copyMeshAttribute(mesh, 'normal'),
      tangent = copyMeshAttribute(mesh, 'tangent');
    if (!normal || !tangent) throw new RangeError('Invalid packed tangent frame attribute');
    result.normal = normal;
    result.tangent = tangent;
  }
  return result;
}
