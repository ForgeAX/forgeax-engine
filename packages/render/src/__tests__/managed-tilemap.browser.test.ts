import { it } from 'vitest';
import { verifyRuntimeTilemap } from './managed-tilemap.gpu-fixture';

it.each([
  ['local', 0],
  ['local', 1],
  ['worker', 0],
  ['worker', 1],
] as const)(
  'renders native Tilemap updates and recovery (%s, sort %s)',
  (mode, scope) => verifyRuntimeTilemap(mode, scope, '/shaders/manifest.json'),
  120_000,
);
