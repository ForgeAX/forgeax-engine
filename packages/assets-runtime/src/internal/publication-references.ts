import {
  type AssetLoadError,
  type CatalogEntry,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';

type PublicationRow = Pick<CatalogEntry, 'publication'>;

/** Check fixed evidence without loading referenced assets, including deferred plugin references. */
export function validatePublicationReferences(
  guid: string,
  row: PublicationRow | undefined,
  lookup: (guid: string) => PublicationRow | undefined,
): Result<void, AssetLoadError> {
  const visited = new Set<string>();
  const visit = (
    current: string,
    row: PublicationRow | undefined,
  ): Result<void, AssetLoadError> => {
    if (visited.has(current)) return ok(undefined);
    visited.add(current);
    const publication = row?.publication;
    if (!publication) return ok(undefined);
    for (const evidence of publication.externalEvidence) {
      if (evidence.usage === 'content') continue;
      const actual = lookup(evidence.guid)?.publication;
      const output = actual?.outputs.find(
        (output) => output.guid.toLowerCase() === evidence.guid.toLowerCase(),
      );
      if (
        (evidence.digest !== undefined && evidence.digest !== output?.digest) ||
        (evidence.generation !== undefined && evidence.generation !== actual?.generation)
      ) {
        return err({
          code: 'asset-dependency-failed',
          expected: `reference ${evidence.guid} to retain its recorded version ${evidence.digest ?? evidence.generation}`,
          hint: 'restore the recorded dependency version or rebuild this publication before switching consumers',
          detail: { guid, dependencyGuid: evidence.guid },
        });
      }
    }
    for (const ref of publication.outputs.find(
      (output) => output.guid.toLowerCase() === current.toLowerCase(),
    )?.refs ?? []) {
      const result = visit(ref, lookup(ref));
      if (!result.ok) return result;
    }
    return ok(undefined);
  };
  return visit(guid, row);
}
