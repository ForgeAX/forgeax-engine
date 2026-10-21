import { it } from 'vitest';
import { verifyRuntimeMaterial } from './managed-material-runtime.gpu-fixture';

it.each([
  'mesh',
  'mesh-structure',
  'sprite',
  'sprite-flip',
] as const)('adopts shared material edits in actual browser pixels (%s)', (kind) =>
  verifyRuntimeMaterial(kind, '/shaders/manifest.json'));
