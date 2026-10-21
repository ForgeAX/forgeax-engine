import { it } from 'vitest';
import { verifyRuntimeTerrain } from './managed-terrain.gpu-fixture';

it.each(['weights', 'ids'] as const)(
  'renders native Terrain edits without rebinding (%s)',
  (encoding) => verifyRuntimeTerrain(encoding, '/shaders/manifest.json'),
  120_000,
);
