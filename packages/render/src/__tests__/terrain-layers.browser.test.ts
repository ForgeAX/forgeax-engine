import { it } from 'vitest';
import sampling from '../../../shader/src/terrain-layer-sampling.wgsl?raw';
import { verifyTerrainLayerEdits } from './terrain-layers.gpu-fixture';

it('follows shared Terrain Material/Texture edits without root or section rewrites and replays fixed versions', async () => {
  await verifyTerrainLayerEdits(sampling);
}, 60000);
