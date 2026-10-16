import { readFileSync } from 'node:fs';
import type { IMAGE_ERROR_HINTS } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';

type AtlasErrorCode = Extract<keyof typeof IMAGE_ERROR_HINTS, `atlas-${string}`>;

const ownerSource = readFileSync(new URL('../atlas/run-atlas.ts', import.meta.url), 'utf8');

describe('runAtlas ErrorEnvelope.code owner', () => {
  it('retains the exact public atlas code membership', () => {
    expectTypeOf<AtlasErrorCode>().toEqualTypeOf<
      'atlas-empty-input' | 'atlas-size-exceeded' | 'atlas-region-mismatch'
    >();
    expectTypeOf<'atlas-unknown'>().not.toExtend<AtlasErrorCode>();
  });

  it('derives ErrorEnvelope.code from ATLAS_EXPECTED', () => {
    expect(ownerSource).toContain('readonly code: keyof typeof ATLAS_EXPECTED;');
    expect(ownerSource).not.toContain(
      "readonly code: 'atlas-empty-input' | 'atlas-size-exceeded' | 'atlas-region-mismatch';",
    );
  });
});
