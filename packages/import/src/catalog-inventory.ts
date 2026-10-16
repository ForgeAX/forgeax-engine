import {
  buildCatalogProjection,
  type CatalogBuildProjectionOptions,
  type CatalogBuildResult,
  type CatalogProducerVisibility,
} from '@forgeax/engine-pack/build';
import type { ScanOptions } from '@forgeax/engine-pack/scanner';
import { catalogImporterPolicy } from './catalog-importer-policy.js';

export async function buildCatalogResult(
  roots: readonly string[],
  base = '/',
  registeredImporterKeys: ReadonlySet<string> = new Set(),
  scanOptions: ScanOptions = {},
  catalogVisibility: CatalogProducerVisibility = () => true,
  sourceIdentityFor?: (sourcePath: string) => string,
): Promise<CatalogBuildResult> {
  const options: CatalogBuildProjectionOptions = {
    base,
    scanOptions,
    importerPolicy: (importer) => catalogImporterPolicy(importer, registeredImporterKeys),
    visibility: catalogVisibility,
    ...(sourceIdentityFor === undefined ? {} : { sourceIdentityFor }),
  };
  return buildCatalogProjection(roots, options);
}
