import { createHash } from 'node:crypto';
import { AssetRegistry, terrainContribution } from '@forgeax/engine-assets-runtime';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { textureContribution } from '@forgeax/engine-image';
import { packMeshBin } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution, samplerContribution } from '@forgeax/engine-render';
import { type Asset, type CatalogDelta, type CatalogEntry, ok } from '@forgeax/engine-types';

/** Source fixtures serialize ordinary GUID closures through the actual Catalog transport. */
export function terrainSourceFixture(guid: (key: string) => string) {
  let rows: CatalogEntry[] = [];
  let revision = 0;
  const bodies = new Map<string, string | Uint8Array>();
  const listeners = new Set<(delta: CatalogDelta) => void>();
  const fetcher: typeof fetch = async (input) => {
    const body = bodies.get(String(input));
    return new Response((body as BodyInit) ?? '', { status: body === undefined ? 404 : 200 });
  };
  const assets = new AssetRegistry({
    scopeId: 'terrain-source',
    catalog: {
      enumerate: async () => ok(rows),
      openPackage: () => fetcher,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  assets.installDecoder(terrainContribution.kind, terrainContribution.decoder);
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.installDecoder(textureContribution.kind, textureContribution.decoder);
  assets.installDecoder(materialContribution.kind, materialContribution.decoder);
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const publication = (
    values: Readonly<Record<string, Asset>>,
    sourceRevision = String(++revision),
  ) => {
    const packageUrl = `https://terrain.invalid/${sourceRevision}/pack.json`;
    const artifacts = new Map<string, Uint8Array>();
    const packAssets = Object.entries(values).map(([key, asset]) => {
      const refs = sourceReferences(asset);
      if (asset.kind !== 'mesh')
        return { guid: guid(key), kind: asset.kind, refs, payload: asset, artifacts: {} };
      const bytes = packMeshBin(asset, guid(key), refs).unwrap();
      const path = `${key.replaceAll('/', '-')}.mesh`;
      artifacts.set(new URL(path, packageUrl).href, bytes);
      return {
        guid: guid(key),
        kind: asset.kind,
        refs,
        payload: { kind: 'mesh' },
        artifacts: {
          body: {
            path,
            mediaType: 'application/x-forgeax-mesh',
            contentEncoding: 'identity',
            byteLength: bytes.length,
            assetCodec: { name: 'mesh-binary', version: '5' },
            integrity: {
              algorithm: 'sha256',
              digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            },
          },
        },
      };
    });
    const produced = createRuntimePackPublication({
      scopeId: 'terrain-source',
      sourcePath: 'terrain.pack',
      sourceRevision,
      packageUrl,
      pack: {
        assets: JSON.parse(
          JSON.stringify(packAssets, (_key, value) =>
            ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value,
          ),
        ),
      },
    });
    const entries: CatalogEntry[] = produced.pack.assets.map(({ guid, kind, refs }) => ({
      guid,
      kind,
      refs,
      packageUrl,
      sourcePath: 'terrain.pack',
      publication: produced.publication,
      lifecycle: 'current',
    }));
    return { ...produced, rows: entries, packageUrl, artifacts };
  };
  const publish = (values: Readonly<Record<string, Asset>>) => {
    const next = publication(values);
    for (const [url, bytes] of next.artifacts) bodies.set(url, bytes);
    bodies.set(next.packageUrl, JSON.stringify(next.pack));
    const previous = new Set(rows.map((row) => row.guid));
    rows = next.rows;
    for (const listener of listeners)
      listener({
        added: rows.filter((row) => !previous.has(row.guid)),
        changed: rows.filter((row) => previous.has(row.guid)),
        removed: [...previous].filter((id) => !rows.some((row) => row.guid === id)),
      });
    return next;
  };
  return { assets, fetcher, publication, publish };
}

function sourceReferences(asset: Asset): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (AssetGuid.parse(value).ok) refs.add(value);
      return;
    }
    if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
    for (const item of Object.values(value)) visit(item);
  };
  visit(asset);
  return [...refs];
}
