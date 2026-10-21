import { it } from 'vitest';
import { verifyRuntimeGlyph } from './managed-glyph.gpu-fixture';

it.each(['local', 'worker'] as const)(
  'renders native Font edits and recovery (%s)',
  (mode) => verifyRuntimeGlyph(mode, '/shaders/manifest.json'),
  120_000,
);
