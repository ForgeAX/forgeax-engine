import { createHash } from 'node:crypto';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { decodeMeshBinary, meshAssetContribution } from '@forgeax/engine-geometry';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { AssetRef, ImportedArtifactBody } from '@forgeax/engine-types';
import type { DdcPack } from '../../import-runner';

/** Read the producer's sole geometry source, including its source reference table. */
export function importedMesh(row: {
  readonly artifacts: Readonly<Record<string, ImportedArtifactBody>>;
  readonly refs: readonly (string | AssetRef)[];
}) {
  const body = row.artifacts.body;
  if (body === undefined) throw new Error('missing imported mesh body');
  const mesh = decodeMeshBinary(
    body.bytes,
    row.refs.map((ref) => (typeof ref === 'string' ? ref : ref.guid)),
  );
  if (mesh === undefined) throw new Error('invalid imported mesh body');
  return mesh;
}

/** Exercise imported bytes through real publication validation, JSON transport and decode. */
export function importedSource(
  pack: Pick<DdcPack, 'assets'>,
  assets = new AssetRegistry({ scopeId: 'import-fixture' }),
) {
  const packageUrl = 'https://import-fixture.invalid/source/pack.json';
  const bodies = new Map<string, string | Uint8Array>();
  const rows = pack.assets.map((row) => ({
    ...row,
    artifacts: Object.fromEntries(
      Object.entries(row.artifacts).map(([name, artifact]) => {
        const path = `${row.guid}/${name}`;
        bodies.set(new URL(path, packageUrl).href, artifact.bytes);
        return [
          name,
          {
            path,
            mediaType: artifact.mediaType,
            assetCodec: artifact.assetCodec,
            contentEncoding: 'identity',
            byteLength: artifact.bytes.byteLength,
            integrity: {
              algorithm: 'sha256',
              digest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
            },
          },
        ];
      }),
    ),
  }));
  const publication = createRuntimePackPublication({
    scopeId: 'import-fixture',
    sourcePath: 'source.pack',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: JSON.parse(
        JSON.stringify(rows, (_key, value) =>
          ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
        ),
      ),
    },
  });
  bodies.set(packageUrl, JSON.stringify(publication.pack));
  const fetcher: typeof fetch = async (input) => {
    const body = bodies.get(String(input));
    return new Response(body as BodyInit, { status: body === undefined ? 404 : 200 });
  };
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.setCatalogSource(
    createCatalogSource({
      entries: publication.pack.assets.map(({ guid, kind, refs }) => ({
        guid,
        kind,
        refs,
        packageUrl,
        sourcePath: 'source.pack',
        publication: publication.publication,
      })),
      fetch: fetcher,
    }),
  );
  return { assets, bodies, packageUrl, publication };
}
