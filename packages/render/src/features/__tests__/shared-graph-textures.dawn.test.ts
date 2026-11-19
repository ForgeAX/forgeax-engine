import { it } from 'vitest';
import { verifySharedTexturePhysicalReplacement } from './shared-graph-textures-gpu.fixture';

it(
  'samples current shared physical textures through one reused consumer graph',
  verifySharedTexturePhysicalReplacement,
);
