import type { MeshAsset } from '@forgeax/engine-types';
import { meshIrToMeshAsset } from '../bridge.js';

/** Test-only unwrap for fixtures whose validity is the subject under test. */
export function unwrapMeshAsset(...args: Parameters<typeof meshIrToMeshAsset>): MeshAsset {
  const result = meshIrToMeshAsset(...args);
  if (!result.ok) throw result.error;
  return result.value;
}
