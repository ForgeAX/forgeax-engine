import type { AccessorJson, BufferViewJson } from './accessor/decode-accessor.js';
import { accessorStorage, accessorVectorSize, COMPONENT_TYPE } from './accessor/layout.js';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import type { MeshJson, MeshPrimitiveJson } from './parse-gltf.js';

export interface DracoCompressionJson {
  readonly bufferView: number;
  readonly attributes: Readonly<Record<string, number>>;
}

export type DracoAttributeArray = InstanceType<NonNullable<ReturnType<typeof accessorStorage>>>;

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

/** Accessor, view and buffer tables of one glTF document; projection appends to copies. */
interface AccessorTables {
  readonly accessors: readonly AccessorJson[];
  readonly bufferViews: readonly BufferViewJson[];
  readonly buffers: readonly Uint8Array[];
}

interface ProjectedTables {
  readonly accessors: AccessorJson[];
  readonly bufferViews: BufferViewJson[];
  readonly buffers: Uint8Array[];
}

type DracoDeclarations = Record<string, { id: number; accessor: AccessorJson }>;
type DracoDecoded = Awaited<ReturnType<GltfDracoDecodeCapability['decode']>>;

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
  const source: AccessorTables = {
    accessors: sourceAccessors,
    bufferViews: sourceViews,
    buffers: sourceBuffers,
  };
  const projected: ProjectedTables = {
    accessors: [...sourceAccessors],
    bufferViews: [...sourceViews],
    buffers: [...sourceBuffers],
  };
  const meshes: MeshJson[] = [];
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
      if (!isDracoExtensionShape(extension))
        return dracoFailure(detail, 'invalid Draco extension or attribute map');
      const fallback = hasUncompressedFallback(primitive, source);
      if (capability === undefined) {
        if (!required.includes('KHR_draco_mesh_compression') && fallback) {
          primitives.push(primitive);
          continue;
        }
        return err(gltfErr('gltf-draco-decoder-required', detail));
      }
      const decoded = await decodeDracoPrimitive(
        primitive,
        extension,
        source,
        projected,
        capability,
      );
      if (!decoded.ok) return dracoFailure(detail, decoded.error);
      primitives.push(decoded.value);
    }
    meshes.push({ ...mesh, primitives });
  }
  return ok({ meshes, ...projected });
}

function dracoFailure(
  detail: {
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly bufferView: number;
  },
  reason: string,
): Result<never, GltfError> {
  return err(gltfErr('gltf-draco-decode-failed', { ...detail, reason }));
}

function isDracoExtensionShape(extension: DracoCompressionJson): boolean {
  return !(
    extension === null ||
    typeof extension !== 'object' ||
    Array.isArray(extension) ||
    extension.attributes === null ||
    typeof extension.attributes !== 'object' ||
    Array.isArray(extension.attributes)
  );
}

/** Whether every uncompressed accessor of the primitive is a usable non-sparse fallback. */
function hasUncompressedFallback(primitive: MeshPrimitiveJson, source: AccessorTables): boolean {
  return (
    Object.keys(primitive.attributes ?? {}).length > 0 &&
    Object.values(primitive.attributes ?? {}).every((index) =>
      isFallbackAccessorInBounds(index, source),
    ) &&
    (primitive.indices === undefined || isFallbackAccessorInBounds(primitive.indices, source))
  );
}

function isFallbackAccessorInBounds(index: number, source: AccessorTables): boolean {
  const accessor = source.accessors[index];
  const view = accessor === undefined ? undefined : source.bufferViews[accessor.bufferView ?? -1];
  const buffer = view === undefined ? undefined : source.buffers[view.buffer];
  if (
    accessor === undefined ||
    view === undefined ||
    buffer === undefined ||
    accessor.sparse !== undefined
  )
    return false;
  const Storage = accessorStorage(accessor.componentType);
  const components = accessorVectorSize(accessor.type);
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
}

/** Decode one compressed triangle primitive and append its outputs as ordinary accessors. */
async function decodeDracoPrimitive(
  primitive: MeshPrimitiveJson,
  extension: DracoCompressionJson,
  source: AccessorTables,
  projected: ProjectedTables,
  capability: GltfDracoDecodeCapability,
): Promise<Result<MeshPrimitiveJson, string>> {
  const compressed = compressedDracoBytes(primitive, extension, projected);
  if (compressed === undefined) return err('invalid compressed range or primitive mode');
  const attributes = declaredDracoAttributes(primitive, extension, source);
  if (!attributes.ok) return attributes;
  try {
    const decoded = await capability.decode({ source: compressed, attributes: attributes.value });
    const projectedAttributes = appendDecodedAttributes(
      primitive,
      attributes.value,
      decoded,
      projected,
    );
    if (!projectedAttributes.ok) return projectedAttributes;
    const indices = appendDecodedIndices(primitive, decoded, source, projected);
    if (!indices.ok) return indices;
    const { KHR_draco_mesh_compression: _draco, ...extensions } = primitive.extensions ?? {};
    return ok({
      ...primitive,
      extensions,
      attributes: projectedAttributes.value,
      indices: indices.value,
    });
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
}

function compressedDracoBytes(
  primitive: MeshPrimitiveJson,
  extension: DracoCompressionJson,
  projected: ProjectedTables,
): Uint8Array | undefined {
  const view = projected.bufferViews[extension.bufferView];
  const bytes = view === undefined ? undefined : projected.buffers[view.buffer];
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
    return undefined;
  return bytes.subarray(offset, offset + view.byteLength);
}

function declaredDracoAttributes(
  primitive: MeshPrimitiveJson,
  extension: DracoCompressionJson,
  source: AccessorTables,
): Result<DracoDeclarations, string> {
  const attributes: DracoDeclarations = {};
  for (const [semantic, id] of Object.entries(extension.attributes)) {
    const accessor = source.accessors[primitive.attributes?.[semantic] ?? -1];
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      accessor === undefined ||
      accessor.sparse !== undefined ||
      !Number.isSafeInteger(accessor.count) ||
      accessor.count <= 0 ||
      accessor.count > 10_000_000 ||
      accessorVectorSize(accessor.type) === undefined ||
      accessorStorage(accessor.componentType) === undefined
    )
      return err(`invalid ${semantic} attribute declaration`);
    attributes[semantic] = { id, accessor };
  }
  if (attributes.POSITION === undefined) return err('compressed POSITION is required');
  return ok(attributes);
}

function appendDecodedAttributes(
  primitive: MeshPrimitiveJson,
  attributes: DracoDeclarations,
  decoded: DracoDecoded,
  projected: ProjectedTables,
): Result<Record<string, number>, string> {
  const projectedAttributes = { ...primitive.attributes };
  for (const [semantic, declaration] of Object.entries(attributes)) {
    const data = decoded.attributes[semantic];
    const Storage = accessorStorage(declaration.accessor.componentType);
    if (
      Storage === undefined ||
      !(data instanceof Storage) ||
      decoded.vertexCount !== declaration.accessor.count ||
      data.length !==
        declaration.accessor.count * (accessorVectorSize(declaration.accessor.type) ?? 0) ||
      !data.every(Number.isFinite)
    )
      return err(`decoder output mismatches ${semantic} accessor`);
    projectedAttributes[semantic] = appendAccessor(projected, data, declaration.accessor);
  }
  return ok(projectedAttributes);
}

function appendDecodedIndices(
  primitive: MeshPrimitiveJson,
  decoded: DracoDecoded,
  source: AccessorTables,
  projected: ProjectedTables,
): Result<number, string> {
  if (
    !(decoded.indices instanceof Uint32Array) ||
    decoded.indices.length === 0 ||
    decoded.indices.length % 3 !== 0 ||
    decoded.indices.some((index) => index >= decoded.vertexCount)
  )
    return err('invalid decoded triangle indices');
  const indexAccessor =
    primitive.indices === undefined
      ? {
          bufferView: 0,
          count: decoded.indices.length,
          type: 'SCALAR',
          componentType: COMPONENT_TYPE.U32,
        }
      : source.accessors[primitive.indices];
  const IndexStorage = accessorStorage(indexAccessor?.componentType);
  if (
    indexAccessor === undefined ||
    indexAccessor.count !== decoded.indices.length ||
    indexAccessor.type !== 'SCALAR' ||
    (IndexStorage !== Uint8Array && IndexStorage !== Uint16Array && IndexStorage !== Uint32Array)
  )
    return err('decoded indices mismatch accessor');
  const limit = 2 ** (IndexStorage.BYTES_PER_ELEMENT * 8) - 1;
  if (decoded.indices.some((index) => index > limit))
    return err('decoded index exceeds component range');
  return ok(appendAccessor(projected, new IndexStorage(decoded.indices), indexAccessor));
}

/** Append decoded components as a dense, non-sparse accessor over a fresh buffer. */
function appendAccessor(
  projected: ProjectedTables,
  array: DracoAttributeArray,
  accessor: AccessorJson,
): number {
  const buffer = projected.buffers.length;
  projected.buffers.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice());
  const bufferView = projected.bufferViews.length;
  projected.bufferViews.push({ buffer, byteLength: array.byteLength });
  const index = projected.accessors.length;
  const { sparse: _sparse, ...plain } = accessor;
  projected.accessors.push({ ...plain, bufferView, byteOffset: 0 });
  return index;
}
