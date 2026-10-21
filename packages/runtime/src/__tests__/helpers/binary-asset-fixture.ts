import { createHash } from 'node:crypto';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { installDefaultAssetDecoders } from '../../asset-contributions';

/** A verified Pack envelope and an actual external binary artifact response. */
export async function binaryAssetFixture(
  kind: string,
  payload: unknown,
  bytes: Uint8Array,
  mediaType: string,
  contentEncoding?: 'identity' | 'zstd',
  transportBytes?: Uint8Array,
) {
  const compressed = contentEncoding === 'zstd' ? await compressZstd(bytes) : undefined;
  if (compressed !== undefined && !compressed.ok) throw compressed.error;
  const body = transportBytes ?? compressed?.value ?? bytes;
  const guid = 'b0000000-0000-4000-a000-0000636f6465';
  const packageUrl = 'https://binary.invalid/asset.pack.json';
  const sourcePath = 'binary.fixture';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind,
          payload,
          refs: [],
          artifacts: {
            body: {
              path: 'body.bin',
              mediaType,
              byteLength: bytes.byteLength,
              integrity: {
                algorithm: 'sha256',
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
              ...(contentEncoding === undefined ? {} : { contentEncoding }),
            },
          },
        },
      ],
    },
  });
  const requests: string[] = [];
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: [{ guid, kind, sourcePath, packageUrl, publication: produced.publication }],
    }),
    fetcher: async (input) => {
      requests.push(String(input));
      if (String(input) === packageUrl) return Response.json(produced.pack);
      if (String(input) === new URL('body.bin', packageUrl).href)
        return new Response(new Uint8Array(body));
      return new Response('missing', { status: 404 });
    },
  });
  installDefaultAssetDecoders(assets);
  return { assets, guid, requests };
}
