import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import type { CatalogListener } from '../../catalog-source';

type PublicationInput = Parameters<typeof createRuntimePackPublication>[0];
type Origin = Pick<PublicationInput, 'sourcePath' | 'packageUrl'> &
  Partial<Pick<PublicationInput, 'scopeId' | 'sourceRevision' | 'generation'>>;

/** Build the Pack and matching rows from the Asset envelopes used by a Registry test. */
export function catalogPack(
  assets: PublicationInput['pack']['assets'],
  { scopeId = 'asset-runtime', sourceRevision = '1', ...origin }: Origin,
) {
  const result = createRuntimePackPublication({
    ...origin,
    scopeId,
    sourceRevision,
    pack: { assets },
  });
  const rows: CatalogEntry[] = assets.map(({ guid, kind }) => ({
    guid,
    kind,
    sourcePath: origin.sourcePath,
    packageUrl: origin.packageUrl,
    publication: result.publication,
  }));
  return { ...result, rows };
}

export function catalogChannel() {
  let listener: CatalogListener = () => {};
  return {
    subscribe(next: CatalogListener) {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
    emit(delta: CatalogDelta) {
      listener(delta);
    },
  };
}
