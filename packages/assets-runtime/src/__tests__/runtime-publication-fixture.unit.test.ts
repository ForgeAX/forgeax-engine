import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../index';
import { runtimeAssets } from '../internal';
import { prepareRuntimeAssetPublication } from './fixtures/runtime-publication';

it('installs prepared wire bytes into independent runtime sources and decoded payloads', async () => {
  const guid = '01900000-0000-7000-8000-000000000abc';
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const install = prepareRuntimeAssetPublication([{ guid, asset: mesh }]);
  const first = new AssetRegistry(),
    second = new AssetRegistry();
  try {
    install(first);
    install(second);
    const firstHandle = (await first.load(guid, 'mesh')).unwrap();
    const secondHandle = (await second.load(guid, 'mesh')).unwrap();
    const a = runtimeAssets(first).resolveAsset<typeof mesh>(firstHandle).unwrap();
    const b = runtimeAssets(second).resolveAsset<typeof mesh>(secondHandle).unwrap();
    expect(a).not.toBe(b);
    expect(a.attributes.position).toBeInstanceOf(Float32Array);
    expect(b.attributes.position).toEqual(a.attributes.position);
    expect(b.attributes.position).not.toBe(a.attributes.position);
    first.dispose();
    expect((await second.load(guid, 'mesh')).unwrap()).toBe(secondHandle);
    expect(runtimeAssets(second).resolveAsset(secondHandle).ok).toBe(true);
  } finally {
    first.dispose();
    second.dispose();
  }
});
