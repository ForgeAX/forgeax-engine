import { it } from 'vitest';
import { verifyManagedMeshRange } from './managed-mesh-range.gpu-fixture';

it.each(['vertices', 'indices'] as const)(
  'renders accepted %s ranges while a shared asset and fixed candidate retain their old pixels',
  verifyManagedMeshRange,
);
