import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { CLEARCOAT_ROUGHNESS, CLEARCOAT_STRENGTH, cloneWithClearcoat } from '../assets/plugins/clearcoat-material';

describe('private clearcoat material', () => {
  it('copies the PBR source and updates only the private coat values', () => {
    const assets = new AssetRegistry();
    const source = assets.create({ kind: 'material', passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }], values: { baseColor: [0.8, 0.2, 0.1, 1], roughness: 0.4 } }).unwrap();
    const before = assets.read(source).unwrap();
    const coated = cloneWithClearcoat(source, assets);
    expect(coated).toBeDefined();
    if (coated === undefined) throw new Error('missing PBR copy');
    const content = assets.read(coated).unwrap();
    expect(content.passes).toEqual(before.passes);
    expect(content.values).toMatchObject({ ...before.values, clearcoat: CLEARCOAT_STRENGTH, clearcoatRoughness: CLEARCOAT_ROUGHNESS });
    expect(assets.read(source).unwrap()).toEqual(before);
    assets.release(coated).unwrap();
    assets.release(source).unwrap();
    assets.dispose();
  });

  it('leaves non-PBR authored materials untouched', () => {
    const assets = new AssetRegistry();
    const source = assets.create({ kind: 'material', passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }] }).unwrap();
    expect(cloneWithClearcoat(source, assets)).toBeUndefined();
    assets.release(source).unwrap();
    assets.dispose();
  });
});
