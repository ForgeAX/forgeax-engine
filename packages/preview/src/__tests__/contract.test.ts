import { expectTypeOf, it } from 'vitest';
import type { PreviewHost } from '../index.js';
import { previewHostCapability } from '../index.js';

it('exposes only a typed physical host capability', () => {
  expectTypeOf(previewHostCapability.id).toEqualTypeOf<string>();
  expectTypeOf<PreviewHost['withSession']>().toBeFunction();
});
