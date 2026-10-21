import { it } from 'vitest';
import { verifyManagedTextureRange } from './managed-texture-range.gpu-fixture';

it.each(['none', 'generate'] as const)(
  'samples changed %s-mip texture regions and retains fixed previous content',
  verifyManagedTextureRange,
);
