import type { DecoderModule } from 'draco3d';
import type { DracoAttributeArray, GltfDracoDecodeCapability } from './draco-decode.js';

/** Build-only adapter; WASM initializes on the first compressed primitive. */
export function createDracoDecoder(
  loadModule: () => Promise<DecoderModule>,
): GltfDracoDecodeCapability {
  let modulePromise: Promise<DecoderModule> | undefined;
  return {
    async decode({ source, attributes }) {
      modulePromise ??= loadModule();
      const module = await modulePromise;
      const decoder = new module.Decoder();
      const buffer = new module.DecoderBuffer();
      const mesh = new module.Mesh();
      const types = {
        5120: { Storage: Int8Array, type: module.DT_INT8 },
        5121: { Storage: Uint8Array, type: module.DT_UINT8 },
        5122: { Storage: Int16Array, type: module.DT_INT16 },
        5123: { Storage: Uint16Array, type: module.DT_UINT16 },
        5125: { Storage: Uint32Array, type: module.DT_UINT32 },
        5126: { Storage: Float32Array, type: module.DT_FLOAT32 },
      };
      try {
        buffer.Init(
          new Int8Array(source.buffer, source.byteOffset, source.byteLength),
          source.length,
        );
        if (decoder.GetEncodedGeometryType(buffer) !== module.TRIANGULAR_MESH)
          throw new Error('Draco glTF requires a triangle mesh');
        const status = decoder.DecodeBufferToMesh(buffer, mesh);
        try {
          if (!status.ok()) throw new Error(status.error_msg());
        } finally {
          module.destroy(status);
        }
        const vertexCount = mesh.num_points();
        const indexCount = mesh.num_faces() * 3;
        if (
          vertexCount <= 0 ||
          vertexCount > 10_000_000 ||
          indexCount <= 0 ||
          indexCount > 30_000_000
        )
          throw new Error('Draco output exceeds mesh limits');
        const indicesPointer = module._malloc(indexCount * 4);
        let indices: Uint32Array;
        try {
          // The pinned JS binding returns bool; @types/draco3d declares void.
          if (
            (decoder.GetTrianglesUInt32Array(mesh, indexCount * 4, indicesPointer) as unknown) !==
            true
          )
            throw new Error('Draco triangle projection failed');
          indices = new Uint32Array(module.HEAPU8.buffer, indicesPointer, indexCount).slice();
        } finally {
          module._free(indicesPointer);
        }
        const decoded: Record<string, DracoAttributeArray> = {};
        for (const [semantic, { id, accessor }] of Object.entries(attributes)) {
          const attribute = decoder.GetAttributeByUniqueId(mesh, id);
          const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[
            accessor.type
          ];
          if (
            !attribute ||
            attribute.num_components() !== components ||
            accessor.count !== vertexCount
          )
            throw new Error(`${semantic} Draco attribute is missing or has a different shape`);
          const storage = types[accessor.componentType as keyof typeof types];
          if (storage === undefined)
            throw new Error(`${semantic} has an unsupported component type`);
          const count = vertexCount * attribute.num_components();
          const length = count * storage.Storage.BYTES_PER_ELEMENT;
          const pointer = module._malloc(length);
          try {
            if (
              (decoder.GetAttributeDataArrayForAllPoints(
                mesh,
                attribute,
                storage.type,
                length,
                pointer,
              ) as unknown) !== true
            )
              throw new Error(`${semantic} Draco attribute projection failed`);
            decoded[semantic] = new storage.Storage(
              module.HEAPU8.buffer as ArrayBuffer,
              pointer,
              count,
            ).slice();
          } finally {
            module._free(pointer);
          }
        }
        return { attributes: decoded, indices, vertexCount };
      } finally {
        module.destroy(mesh);
        module.destroy(buffer);
        module.destroy(decoder);
      }
    },
  };
}
