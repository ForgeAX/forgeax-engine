/** Minimal authored Direct Pack for tests that exercise parsing, scanning or publication. */
export function directPackFixture<T>(packageId: string, assets: T) {
  return { schemaVersion: '3.0.0' as const, packageId, assets };
}

export function packAssetFixture<Kind extends string, Payload>(
  guid: string,
  kind: Kind,
  payload: Payload,
) {
  return { guid, kind, payload, refs: [], artifacts: {} };
}

export function metaFixture(
  source: string,
  importer: string,
  subAssets: readonly unknown[],
  importSettings: unknown = {},
): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer,
    source,
    importSettings,
    subAssets,
  });
}
