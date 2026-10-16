import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  characterizeMaterialWgslProfile,
  MATERIAL_WGSL_PROFILE,
  MATERIAL_WGSL_PROFILE_CAPABILITIES,
  type MaterialWgslProfileCapability,
  type MaterialWgslProfileFeature,
  validateMaterialWgslSource,
} from '../material/profile.js';

describe('forgeax-material-wgsl-v1 profile characterization', () => {
  it('pins the profile, adapter, and compiler provenance', () => {
    expect(MATERIAL_WGSL_PROFILE).toMatchObject({
      id: 'forgeax-material-wgsl-v1',
      language: 'wgsl',
    });
    expect(MATERIAL_WGSL_PROFILE.profileVersion).toMatch(/^1\./);
    expect(MATERIAL_WGSL_PROFILE.adapterVersion).toMatch(/^[0-9]/);
    expect(MATERIAL_WGSL_PROFILE.compilerVersion).toMatch(/^[0-9]/);
  });

  it('records the supported definition and composition capabilities', () => {
    const capabilities = characterizeMaterialWgslProfile();

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: 'bool-define', supported: true }),
        expect.objectContaining({ feature: 'int-define', supported: true }),
        expect.objectContaining({ feature: 'uint-define', supported: true }),
        expect.objectContaining({ feature: 'undefined-define', supported: true }),
        expect.objectContaining({ feature: 'conditional', supported: true }),
        expect.objectContaining({ feature: 'alias-import', supported: true }),
        expect.objectContaining({ feature: 'selective-import', supported: true }),
        expect.objectContaining({ feature: 'nested-import', supported: true }),
        expect.objectContaining({ feature: 'virtual-module', supported: true }),
        expect.objectContaining({ feature: 'override-module', supported: true }),
        expect.objectContaining({ feature: 'span-diagnostic', supported: true }),
      ]),
    );
  });

  it('derives the feature vocabulary from the capability rows', () => {
    expectTypeOf<MaterialWgslProfileFeature>().toEqualTypeOf<
      (typeof MATERIAL_WGSL_PROFILE_CAPABILITIES)[number]['feature']
    >();
    expectTypeOf(MATERIAL_WGSL_PROFILE_CAPABILITIES).toMatchTypeOf<
      readonly MaterialWgslProfileCapability[]
    >();
    expectTypeOf('bool-define' as const).toMatchTypeOf(
      undefined as unknown as MaterialWgslProfileFeature,
    );
    expectTypeOf('unknown-feature' as const).not.toMatchTypeOf(
      undefined as unknown as MaterialWgslProfileFeature,
    );
  });

  it('rejects unsupported language and unrestricted override requests explicitly', () => {
    const glsl = validateMaterialWgslSource('#version 450\nvoid main() {}');
    expect(glsl.ok).toBe(false);
    if (!glsl.ok) expect(glsl.error.code).toBe('material-profile-unsupported');

    const override = validateMaterialWgslSource('#override unrestricted\nfn main() {}');
    expect(override.ok).toBe(false);
    if (!override.ok) {
      expect(override.error.code).toBe('material-profile-unsupported');
      expect(override.error.detail.line).toBe(1);
      expect(override.error.detail.column).toBe(1);
    }
  });

  it('returns source span and context for a non-boolean define value', () => {
    const result = validateMaterialWgslSource('fn main() {}\n#define COUNT 4');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-profile-unsupported');
      expect(result.error.detail.line).toBe(2);
      expect(result.error.detail.column).toBe(1);
      expect(result.error.detail.context).toContain('#define COUNT 4');
    }
  });
});
