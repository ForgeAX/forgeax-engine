import { createHash } from 'node:crypto';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { expect, it, vi } from 'vitest';

const guid = '8d9e1619-519f-49e3-96b2-c830732de501';
const packageUrl = 'https://hdr.invalid/texture.pack.json';
const sourcePath = 'environment.hdr';

it('loads cooked HDR bytes through the ordinary Catalog and rejects missing body content', async () => {
  const bytes = new Uint8Array(new Uint16Array([0x3800, 0x3400, 0x3c00, 0x3c00]).buffer);
  const payload = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba16float',
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  const publication = createRuntimePackPublication({
    scopeId: 'hdr',
    sourcePath,
    sourceRevision: 'one',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'texture',
          payload,
          refs: [],
          artifacts: {
            body: {
              path: 'texture.bin',
              contentEncoding: 'identity',
              mediaType: 'application/x-forgeax-rgba16f',
              byteLength: bytes.length,
              integrity: {
                algorithm: 'sha256',
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
            },
          },
        },
      ],
    },
  });
  for (const available of [true, false]) {
    const assets = new AssetRegistry({
      scopeId: 'hdr',
      catalog: createCatalogSource({
        entries: [
          { guid, kind: 'texture', packageUrl, sourcePath, publication: publication.publication },
        ],
        fetch: async (input) =>
          String(input) === packageUrl
            ? Response.json(publication.pack)
            : new Response(available ? bytes : null, { status: available ? 200 : 404 }),
      }),
    });
    assets.installDecoder(textureContribution.kind, textureContribution.decoder);
    const loaded = await assets.load(guid, 'texture');
    if (available)
      expect(assets.read(loaded.unwrap()).unwrap()).toEqual({ ...payload, data: bytes });
    else expect(loaded).toMatchObject({ ok: false, error: { code: 'asset-integrity-failed' } });
    assets.dispose();
  }
});

it('does not fetch a raw HDR source from an unpublished catalog declaration', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: [{ guid, kind: 'texture', packageUrl, sourcePath, lifecycle: 'missing' }],
      fetch,
    }),
  });
  assets.installDecoder(textureContribution.kind, textureContribution.decoder);
  const loaded = await assets.load(guid, 'texture');
  expect(loaded.ok).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  assets.dispose();
});
