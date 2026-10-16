import { dracoDecoder } from './draco-node.js';
import { createGltfImporter } from './gltf-importer.js';
import { meshoptDecoder } from './importer-entry.js';
export const gltfImporter = createGltfImporter({ meshopt: meshoptDecoder, draco: dracoDecoder });
export { dracoDecoder, meshoptDecoder };
