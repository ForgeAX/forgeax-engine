import { IES_PROFILE_BYTE_LENGTH } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';

describe('IES profile runtime admission', () => {
  it('captures complete cooked bytes and preserves old content on rejected writes', () => {
    const assets = new AssetRegistry();
    const data = new Uint8Array(IES_PROFILE_BYTE_LENGTH);
    data[1] = 0x3c;
    const handle = assets.create({ kind: 'ies-profile', data }).unwrap();
    data[1] = 0x7c;
    expect(assets.read(handle).unwrap().data[1]).toBe(0x3c);
    const revision = runtimeAssets(assets).version(handle).unwrap();
    for (const high of [0x7c, 0x7d, 0xfc]) {
      data[1] = high;
      expect(assets.update(handle, { data }).ok).toBe(false);
      expect(assets.replace(handle, { kind: 'ies-profile', data }).ok).toBe(false);
    }
    expect(runtimeAssets(assets).version(handle).unwrap()).toBe(revision);
    expect(assets.read(handle).unwrap().data[1]).toBe(0x3c);
    expect(assets.create({ kind: 'ies-profile', data: new Uint8Array(2) }).ok).toBe(false);
    assets.dispose();
  });
});
