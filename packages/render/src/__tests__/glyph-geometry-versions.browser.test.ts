import { it } from 'vitest';
import { verifyGlyphGeometryVersions } from './glyph-geometry-versions.gpu-fixture';

it(
  'retains old and new Font layout pixels through browser submission and LRU eviction',
  verifyGlyphGeometryVersions,
);
