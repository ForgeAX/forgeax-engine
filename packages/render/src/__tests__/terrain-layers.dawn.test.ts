import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { verifyTerrainLayerEdits } from './terrain-layers.gpu-fixture';

it('follows shared Terrain Material/Texture edits without root or section rewrites and replays fixed versions', async () => {
  await verifyTerrainLayerEdits(
    readFileSync(
      new URL('../../../shader/src/terrain-layer-sampling.wgsl', import.meta.url),
      'utf8',
    ),
  );
}, 60000);
