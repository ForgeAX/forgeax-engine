import { definePack } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import surfaceEvidence, {
  planarReflectionMaterials,
} from '../../../../../apps/preview/assets/surface-standard-evidence.pack';

export default definePack({
  schemaVersion: surfaceEvidence.schemaVersion,
  packageId: surfaceEvidence.packageId,
  name: 'Planar reflection capture materials',
  build: () => ok(planarReflectionMaterials),
});
