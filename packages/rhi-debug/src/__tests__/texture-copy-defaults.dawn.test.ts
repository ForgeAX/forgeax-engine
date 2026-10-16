import { it } from 'vitest';
import { verifyTextureCopyDefaults } from './texture-copy-defaults.fixture';

it.each([1, 2])(
  'replays omitted texture copy strides for %i rows on Dawn',
  verifyTextureCopyDefaults,
);
