import type { AccessorJson, BufferViewJson } from './accessor/decode-accessor.js';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import type { MeshJson } from './parse-gltf.js';

export interface DracoCompressionJson {
  readonly bufferView: number;
  readonly attributes: Readonly<Record<string, number>>;
}

export type DracoAttributeArray =
  | Float32Array
  | Uint32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Int8Array;

/** Decoder produces raw accessor components; normalized integer attributes stay integers. */
export interface GltfDracoDecodeCapability {
  readonly decode: (input: {
    readonly source: Uint8Array;
    readonly attributes: Readonly<
      Record<string, { readonly id: number; readonly accessor: AccessorJson }>
    >;
  }) => Promise<{
    readonly attributes: Readonly<Record<string, DracoAttributeArray>>;
    readonly indices: Uint32Array;
    readonly vertexCount: number;
  }>;
}

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const STORAGE = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

/** Project compressed primitives onto the ordinary accessor path, without mutating source facts. */
export async function projectDracoPrimitives(
  sourceMeshes: readonly MeshJson[],
  sourceAccessors: readonly AccessorJson[],
  sourceViews: readonly BufferViewJson[],
  sourceBuffers: readonly Uint8Array[],
  required: readonly string[],
  capability?: GltfDracoDecodeCapability,
): Promise<
  Result<
    {
      meshes: readonly MeshJson[];
      accessors: readonly AccessorJson[];
      bufferViews: readonly BufferViewJson[];
      buffers: readonly Uint8Array[];
    },
    GltfError
  >
> {
  const accessors = [...sourceAccessors];
  const bufferViews = [...sourceViews];
  const buffers = [...sourceBuffers];
  const meshes: MeshJson[] = [];
  const append = (array: DracoAttributeArray, accessor: AccessorJson): number => {
    const buffer = buffers.length;
    buffers.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice());
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer, byteLength: array.byteLength });
    const index = accessors.length;
    const { sparse: _sparse, ...plain } = accessor;
    accessors.push({ ...plain, bufferView, byteOffset: 0 });
    return index;
  };
  for (let meshIndex = 0; meshIndex < sourceMeshes.length; meshIndex++) {
    const mesh = sourceMeshes[meshIndex];
    if (mesh === undefined) continue;
    const primitives = [];
    for (let primitiveIndex = 0; primitiveIndex < mesh.primitives.length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if (primitive === undefined) continue;
      const extension = primitive.extensions?.KHR_draco_mesh_compression;
      if (extension === undefined) {
        primitives.push(primitive);
        continue;
      }
      const detail = { meshIndex, primitiveIndex, bufferView: extension?.bufferView ?? -1 };
      const fail = (reason: string) =>
        err(gltfErr('gltf-draco-decode-failed', { ...detail, reason }));
      if (
        extension === null ||
        typeof extension !== 'object' ||
        Array.isArray(extension) ||
        extension.attributes === null ||
        typeof extension.attributes !== 'object' ||
        Array.isArray(extension.attributes)
      )
        return fail('invalid Draco extension or attribute map');
      const fallbackAccessor = (index: number): boolean => {
        const accessor = sourceAccessors[index];
        const view = accessor === undefined ? undefined : sourceViews[accessor.bufferView ?? -1];
        const buffer = view === undefined ? undefined : sourceBuffers[view.buffer];
        if (
          accessor === undefined ||
          view === undefined ||
          buffer === undefined ||
          accessor.sparse !== undefined
        )
          return false;
        const Storage = STORAGE[accessor.componentType as keyof typeof STORAGE];
        const components = COMPONENTS[accessor.type];
        if (
          Storage === undefined ||
          components === undefined ||
          !Number.isSafeInteger(accessor.count) ||
          accessor.count <= 0
        )
          return false;
        const elementBytes = components * Storage.BYTES_PER_ELEMENT;
        const stride = view.byteStride ?? elementBytes;
        const offset = accessor.byteOffset ?? 0;
        const viewOffset = view.byteOffset ?? 0;
        const length = (accessor.count - 1) * stride + elementBytes;
        return (
          [stride, offset, viewOffset, length, view.byteLength].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          ) &&
          stride >= elementBytes &&
          offset + length <= view.byteLength &&
          viewOffset + offset + length <= buffer.byteLength
        );
      };
      const fallback =
        Object.keys(primitive.attributes ?? {}).length > 0 &&
        Object.values(primitive.attributes ?? {}).every((index) => fallbackAccessor(index)) &&
        (primitive.indices === undefined || fallbackAccessor(primitive.indices));
      if (capability === undefined) {
        if (!required.includes('KHR_draco_mesh_compression') && fallback) {
          primitives.push(primitive);
          continue;
        }
        return err(gltfErr('gltf-draco-decoder-required', detail));
      }
      const view = bufferViews[extension.bufferView];
      const bytes = view === undefined ? undefined : buffers[view.buffer];
      const offset = view?.byteOffset ?? 0;
      if (
        !Number.isInteger(extension.bufferView) ||
        view === undefined ||
        bytes === undefined ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(view.byteLength) ||
        view.byteLength <= 0 ||
        offset + view.byteLength > bytes.length ||
        (primitive.mode ?? 4) !== 4
      )
        return fail('invalid compressed range or primitive mode');
      const attributes: Record<string, { id: number; accessor: AccessorJson }> = {};
      for (const [semantic, id] of Object.entries(extension.attributes)) {
        const accessor = sourceAccessors[primitive.attributes?.[semantic] ?? -1];
        if (
          !Number.isInteger(id) ||
          id < 0 ||
          accessor === undefined ||
          accessor.sparse !== undefined ||
          !Number.isSafeInteger(accessor.count) ||
          accessor.count <= 0 ||
          accessor.count > 10_000_000 ||
          COMPONENTS[accessor.type] === undefined ||
          !(accessor.componentType in STORAGE)
        )
          return fail(`invalid ${semantic} attribute declaration`);
        attributes[semantic] = { id, accessor };
      }
      if (attributes.POSITION === undefined) return fail('compressed POSITION is required');
      try {
        const decoded = await capability.decode({
          source: bytes.subarray(offset, offset + view.byteLength),
          attributes,
        });
        const projectedAttributes = { ...primitive.attributes };
        for (const [semantic, declaration] of Object.entries(attributes)) {
          const data = decoded.attributes[semantic];
          const Storage = STORAGE[declaration.accessor.componentType as keyof typeof STORAGE];
          if (
            !(data instanceof Storage) ||
            decoded.vertexCount !== declaration.accessor.count ||
            data.length !==
              declaration.accessor.count * (COMPONENTS[declaration.accessor.type] ?? 0) ||
            !data.every(Number.isFinite)
          )
            return fail(`decoder output mismatches ${semantic} accessor`);
          projectedAttributes[semantic] = append(data, declaration.accessor);
        }
        if (
          !(decoded.indices instanceof Uint32Array) ||
          decoded.indices.length === 0 ||
          decoded.indices.length % 3 !== 0 ||
          decoded.indices.some((index) => index >= decoded.vertexCount)
        )
          return fail('invalid decoded triangle indices');
        const indexAccessor =
          primitive.indices === undefined
            ? { bufferView: 0, count: decoded.indices.length, type: 'SCALAR', componentType: 5125 }
            : sourceAccessors[primitive.indices];
        if (
          indexAccessor === undefined ||
          indexAccessor.count !== decoded.indices.length ||
          indexAccessor.type !== 'SCALAR' ||
          ![5121, 5123, 5125].includes(indexAccessor.componentType)
        )
          return fail('decoded indices mismatch accessor');
        const IndexStorage = STORAGE[indexAccessor.componentType as 5121 | 5123 | 5125];
        const limit =
          indexAccessor.componentType === 5121
            ? 255
            : indexAccessor.componentType === 5123
              ? 65535
              : 0xffffffff;
        if (decoded.indices.some((index) => index > limit))
          return fail('decoded index exceeds component range');
        const indices = append(new IndexStorage(decoded.indices), indexAccessor);
        const { KHR_draco_mesh_compression: _draco, ...extensions } = primitive.extensions ?? {};
        primitives.push({ ...primitive, extensions, attributes: projectedAttributes, indices });
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    }
    meshes.push({ ...mesh, primitives });
  }
  return ok({ meshes, accessors, bufferViews, buffers });
}
