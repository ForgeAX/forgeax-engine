import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { IES_PROFILE_BYTE_LENGTH } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { iesProfileContribution } from '../loaders/ies-profile';

it('loads published IES byte arrays through the owner decoder and rejects nonfinite half floats', async () => {
  const guid = '00000000-0000-7000-8000-000000000126';
  const packageUrl = 'https://ies.invalid/main.pack.json';
  for (const high of [0x3c, 0x7c, 0x7d, 0xfc]) {
    const data = new Uint8Array(IES_PROFILE_BYTE_LENGTH);
    data[1] = high;
    const publication = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: 'ies.pack',
      sourceRevision: String(high),
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'ies-profile',
            refs: [],
            artifacts: {},
            payload: { kind: 'ies-profile', data: [...data] },
          },
        ],
      },
    });
    const assets = new AssetRegistry({
      catalog: createCatalogSource({
        entries: [
          {
            guid,
            kind: 'ies-profile',
            packageUrl,
            sourcePath: 'ies.pack',
            publication: publication.publication,
          },
        ],
        fetch: async () => Response.json(publication.pack),
      }),
    });
    assets.installDecoder(iesProfileContribution.kind, iesProfileContribution.decoder);
    try {
      const loaded = await assets.load(guid, 'ies-profile');
      expect(loaded.ok).toBe(high === 0x3c);
      if (loaded.ok) expect(assets.read(loaded.value).unwrap().data).toEqual(data);
    } finally {
      assets.dispose();
    }
  }
});
