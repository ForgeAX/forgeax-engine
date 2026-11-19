import { it } from 'vitest';
import {
  verifyManagedTextureRange,
  verifyPackedMipSkip,
} from './managed-texture-range.gpu-fixture';

it.each(['none', 'generate'] as const)(
  'samples changed %s-mip texture regions and retains fixed previous content',
  verifyManagedTextureRange,
);

it('uploads, samples and reconstructs the explicit retained packed mip chain', verifyPackedMipSkip);
