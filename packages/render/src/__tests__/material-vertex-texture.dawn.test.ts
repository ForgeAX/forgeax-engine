import { it } from 'vitest';
import { verifyMaterialVertexTexture } from './material-vertex-texture.fixture';

it(
  'admits explicit-LOD vertex sampling in the native material user layout',
  verifyMaterialVertexTexture,
);
