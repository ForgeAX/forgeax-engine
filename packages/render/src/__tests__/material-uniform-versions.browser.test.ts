import { it } from 'vitest';
import { verifyMaterialUniformVersions } from './material-uniform-versions.gpu-fixture';

it.each([
  'material',
  'texture',
  'prepared-parameters',
] as const)('preserves old and new %s numeric pixels within one native submission', (kind) =>
  verifyMaterialUniformVersions(kind));
