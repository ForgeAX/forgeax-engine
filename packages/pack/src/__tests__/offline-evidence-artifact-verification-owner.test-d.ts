import type {
  ArtifactVerificationStatus,
  AssetEvidenceArtifact,
  AssetEvidencePackageInput,
} from '@forgeax/engine-types';
import { expectTypeOf, it } from 'vitest';

it('uses the shared status for optional producer verification and projected artifacts', () => {
  expectTypeOf<ArtifactVerificationStatus>().toEqualTypeOf<'notChecked' | 'passed' | 'failed'>();
  expectTypeOf<AssetEvidencePackageInput['artifacts'][string]['verification']>().toEqualTypeOf<
    ArtifactVerificationStatus | undefined
  >();
  expectTypeOf<AssetEvidenceArtifact['verification']>().toEqualTypeOf<ArtifactVerificationStatus>();
});
