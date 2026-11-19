import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  copyMeshAttribute,
  createPrimitiveMesh,
  meshAttributeWindow,
} from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';

const GUID = '00000000-0000-7000-8000-000000000021';

function fixture() {
  const assets = new AssetRegistry();
  const mesh = createPrimitiveMesh('cube').unwrap();
  publishRuntimeAssets(assets, [{ guid: GUID, asset: mesh }]);
  return { assets, mesh };
}

describe('browser source loading into the runtime asset owner', () => {
  it('decodes JSON publication into canonical mesh content', async () => {
    const { assets, mesh } = fixture();
    try {
      const handle = (await assets.load(GUID, 'mesh')).unwrap();
      const content = assets.read(handle).unwrap();
      expect(content.kind).toBe('mesh');
      expect(copyMeshAttribute(content, 'position')).toEqual(mesh.attributes.position);
      expect(ArrayBuffer.isView(content.indices)).toBe(true);
      expect(Array.from(content.indices ?? [])).toEqual(Array.from(mesh.indices ?? []));
    } finally {
      assets.dispose();
    }
  });

  it('reuses the loaded identity while returning detached reads', async () => {
    const { assets } = fixture();
    try {
      const first = (await assets.load(GUID, 'mesh')).unwrap();
      const second = (await assets.load(GUID, 'mesh')).unwrap();
      expect(first).toBe(second);
      const content = assets.read(first).unwrap();
      const position = meshAttributeWindow(content, 'position');
      if (!position || position.count === 0) throw new Error('expected canonical positions');
      position.data[position.offset] = 999;
      expect(position.data[position.offset]).toBe(999);
      const current = meshAttributeWindow(assets.read(second).unwrap(), 'position');
      if (!current || current.count === 0) throw new Error('expected canonical positions');
      expect(current.data[current.offset]).not.toBe(999);
      assets.release(first).unwrap();
      expect(assets.read(second).ok).toBe(true);
    } finally {
      assets.dispose();
    }
  });

  it('keeps the accepted source GUID with the live typed asset', async () => {
    const { assets } = fixture();
    try {
      const handle = (await assets.load(GUID, 'mesh')).unwrap();
      expect(assets.source(handle).unwrap()).toMatchObject({ guid: GUID });
      expect(assets.catalogEntry(GUID)?.kind).toBe('mesh');
      expect(assets.read(handle).unwrap().kind).toBe('mesh');
    } finally {
      assets.dispose();
    }
  });
});
