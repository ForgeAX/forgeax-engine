import { it } from 'vitest';
import { verifySharedMeshCandidates } from './managed-mesh-structure.gpu-fixture';

it(
  'shares candidate bytes through submesh growth and empty execution intervals for 60 browser frames',
  verifySharedMeshCandidates,
  120_000,
);
