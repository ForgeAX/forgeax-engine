import { MeshoptDecoder } from 'meshoptimizer';
import { createGltfImporter } from './gltf-importer.js';
import type { GltfBufferViewDecodeCapability } from './meshopt-decode.js';

await MeshoptDecoder.ready;

/** Browser/build consumer capability for EXT_meshopt_compression. */
export const meshoptDecoder: GltfBufferViewDecodeCapability = {
  decode: ({ source, count, stride, mode, filter }) => {
    const target = new Uint8Array(count * stride);
    MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode, filter);
    return target;
  },
};

/**
 * Build-only glTF importer entry. The player-facing package remains free of
 * the Meshopt WASM dependency; hosts opt into this entry when importing files.
 */
export const gltfImporter = createGltfImporter({
  meshopt: meshoptDecoder,
});

export { createGltfImporter } from './gltf-importer.js';
