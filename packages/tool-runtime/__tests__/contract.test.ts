import { expectTypeOf, it } from 'vitest';
import type {
  PreviewArtifactKind,
  PreviewArtifactManifest,
  PreviewArtifactRole,
} from '../src/index.js';

it('keeps preview roles and kinds closed', () => {
  expectTypeOf<PreviewArtifactRole>().toEqualTypeOf<
    'report' | 'rhi-tape' | 'capture' | 'fresh-replay' | 'profile-capture' | 'contact-sheet'
  >();
  expectTypeOf<PreviewArtifactKind>().toEqualTypeOf<
    'report' | 'rhi-tape' | 'png' | 'profile-capture' | 'contact-sheet'
  >();
  expectTypeOf<PreviewArtifactManifest['identity']['subjectDigest']>().toEqualTypeOf<string>();
});
