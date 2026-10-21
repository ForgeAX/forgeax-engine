// Dawn has no HTMLVideoElement; this gate verifies the source/decode/adopt
// path while browser video tests cover native frames and rendered pixels.
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { installDefaultAssetDecoders } from '../asset-contributions';

describe('VideoAsset source admission in Dawn', () => {
  it('loads the published URL into a live typed asset', async () => {
    const assets = new AssetRegistry();
    installDefaultAssetDecoders(assets);
    const guid = '00000000-0000-7000-8000-00000000a010';
    try {
      publishRuntimeAssets(assets, [{ guid, asset: { kind: 'video', url: 'test-clip.webm' } }]);
      const handle = (await assets.load(guid, 'video')).unwrap();
      expect(assets.read(handle).unwrap()).toMatchObject({ kind: 'video', url: 'test-clip.webm' });
      expect(assets.source(handle).unwrap()).toMatchObject({ guid });
    } finally {
      assets.dispose();
    }
  });

  it('uses the runtime default video decoder through the ordinary load path', async () => {
    const assets = new AssetRegistry();
    installDefaultAssetDecoders(assets);
    const guid = '00000000-0000-7000-8000-00000000a011';
    try {
      publishRuntimeAssets(assets, [
        { guid, asset: { kind: 'video', url: 'loader-dispatch.webm' } },
      ]);
      const first = (await assets.load(guid, 'video')).unwrap();
      const second = (await assets.load(guid, 'video')).unwrap();
      expect(second).toBe(first);
      expect(assets.read(second).unwrap().url).toBe('loader-dispatch.webm');
      assets.release(first).unwrap();
      expect(assets.read(second).ok).toBe(true);
    } finally {
      assets.dispose();
    }
  });
});
