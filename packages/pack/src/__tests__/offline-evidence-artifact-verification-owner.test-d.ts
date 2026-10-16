import { readFileSync } from 'node:fs';
import type {
  ArtifactDescriptor,
  ArtifactVerificationStatus,
  AssetEvidenceArtifact,
  AssetEvidencePackageInput,
} from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OfflineArtifactInput, OfflinePackageInput } from '../evidence/offline-evidence.js';
import type { buildOfflineAssetEvidence } from '../index.js';

const guid = '11111111-1111-4111-8111-111111111111';
const projectionSource = readFileSync(
  new URL('../evidence/offline-evidence.ts', import.meta.url),
  'utf8',
);

type SharedOptionalVerification = AssetEvidencePackageInput['artifacts'][string]['verification'];
type PublicOfflineArtifact = NonNullable<
  Parameters<typeof buildOfflineAssetEvidence>[0]['package']
>['artifacts'][string];

describe('offline artifact verification owner', () => {
  it('derives the optional offline projection from the shared status owner', () => {
    expectTypeOf<ArtifactVerificationStatus>().toEqualTypeOf<'notChecked' | 'passed' | 'failed'>();
    expectTypeOf<OfflineArtifactInput['verification']>().toEqualTypeOf<
      ArtifactVerificationStatus | undefined
    >();
    expectTypeOf<
      OfflineArtifactInput['verification']
    >().toEqualTypeOf<SharedOptionalVerification>();
    expectTypeOf<
      AssetEvidenceArtifact['verification']
    >().toEqualTypeOf<ArtifactVerificationStatus>();
    expectTypeOf<PublicOfflineArtifact['verification']>().toEqualTypeOf<
      ArtifactVerificationStatus | undefined
    >();
    expectTypeOf<'unknown'>().not.toExtend<ArtifactVerificationStatus>();
  });

  it('keeps artifact verification optional at the offline input boundary', () => {
    const descriptor = {
      path: 'artifacts/data.bin',
      mediaType: 'application/octet-stream',
    } satisfies ArtifactDescriptor;
    const input = {
      guid,
      artifacts: { data: descriptor },
    } satisfies OfflinePackageInput;
    const publicInput = {
      guid,
      package: input,
    } satisfies Parameters<typeof buildOfflineAssetEvidence>[0];
    void publicInput;
  });

  it('keeps the source projection tied to the shared type instead of a second ledger', () => {
    expect(projectionSource).toContain('ArtifactVerificationStatus');
    expect(projectionSource).toContain('readonly verification?: ArtifactVerificationStatus;');
    expect(projectionSource).not.toContain(
      "readonly verification?: 'notChecked' | 'passed' | 'failed';",
    );
  });
});
