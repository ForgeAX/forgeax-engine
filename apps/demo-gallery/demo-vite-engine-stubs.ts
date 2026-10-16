import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const galleryDir = dirname(fileURLToPath(import.meta.url));
const typesEntry = join(galleryDir, '..', '..', 'packages', 'types', 'src', 'index.ts');

export { createStandaloneRuntimeAssetBinding } from '../../packages/types/src/index.ts';

function stubImporter(key: string) {
  return {
    key,
    kind: key,
    extensions: [],
    importMeta: async () => ({}),
  };
}

export const fbxImporter = stubImporter('fbx');
export const gltfImporter = stubImporter('gltf');
export const imageImporter = stubImporter('image');
export const audioImporter = stubImporter('audio');
export const fontImporter = stubImporter('font');

export function createUiImporter() {
  return { key: 'ui', importUi: async () => ({}) };
}

export function createMaterialPackCooker(_roots?: readonly string[]) {
  return { kind: 'material-pack-native', name: 'material-pack' };
}

export function createParticleCodeNativeCookerFromRoots(_roots: readonly string[]) {
  return { kind: 'particle-code-native', name: 'particle-code-native' };
}

export function resolveProjectPort() {
  return { port: 5173, strictPort: true };
}

void typesEntry;
