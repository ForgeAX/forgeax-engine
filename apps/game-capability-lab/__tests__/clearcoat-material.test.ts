import { describe, expect, it } from 'vitest';
import type { MaterialAsset } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { CLEARCOAT_ROUGHNESS, CLEARCOAT_STRENGTH, withClearcoat } from '../assets/plugins/clearcoat-material';

describe('withClearcoat', () => {
  const parsed = AssetGuid.parse('019fb264-1000-7000-8000-000000000100');
  if (!parsed.ok) throw parsed.error;
  const parent = parsed.value;
  it('inherits the published root and varies normalized PBR coat parameters', () => {
    const sourceValues = { baseColor: [0.8, 0.2, 0.1, 1], roughness: 0.4 };
    const source: MaterialAsset = {
      kind: 'material' as const,
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
      values: sourceValues,
    };
    const coated = withClearcoat(source, parent);
    expect(coated?.parent).toBe(parent);
    expect(coated?.passes).toBeUndefined();
    expect(coated?.values).toEqual({
      clearcoat: CLEARCOAT_STRENGTH,
      clearcoatRoughness: CLEARCOAT_ROUGHNESS,
    });
    expect(source.values).not.toHaveProperty('clearcoat');
  });

  it('leaves non-PBR authored materials untouched', () => {
    const source: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    };
    expect(withClearcoat(source, parent)).toBeUndefined();
  });
});
