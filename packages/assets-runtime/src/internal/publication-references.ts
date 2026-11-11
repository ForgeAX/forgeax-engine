import {
  type AssetLoadError,
  type AssetPublicationOutput,
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
  // A large generated Pack shares one output table across all referenced rows.
  // Index each table once for this synchronous check, without retaining source
  // generations or reusing a successful validation across later source changes.
  const tables = new Map<
    readonly AssetPublicationOutput[],
    Map<string, AssetPublicationOutput> | undefined
  >();
  const findOutput = (outputs: readonly AssetPublicationOutput[], guid: string) => {
    const key = guid.toLowerCase();
    // Most mesh reads inspect just one leaf. Build an index only when a large
    // table is used again in this traversal, rather than charging every leaf
    // for every sibling in its Pack.
    if (outputs.length < 16 || !tables.has(outputs)) {
      if (outputs.length >= 16) tables.set(outputs, undefined);
      return outputs.find((output) => output.guid.toLowerCase() === key);
    }
    let index = tables.get(outputs);
    if (index === undefined) {
      index = new Map();
      for (const output of outputs) {
        const key = output.guid.toLowerCase();
        if (!index.has(key)) index.set(key, output);
      }
      tables.set(outputs, index);
    }
    return index.get(key);
  };
  const visit = (
    current: string,
    row: PublicationRow | undefined,
  ): Result<void, AssetLoadError> => {
    const key = current.toLowerCase();
    if (visited.has(key)) return ok(undefined);
    visited.add(key);
    const publication = row?.publication;
    if (!publication) return ok(undefined);
    for (const evidence of publication.externalEvidence) {
      if (evidence.usage === 'content') continue;
      const actual = lookup(evidence.guid)?.publication;
      const output = actual === undefined ? undefined : findOutput(actual.outputs, evidence.guid);
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
    for (const ref of findOutput(publication.outputs, current)?.refs ?? []) {
      const result = visit(ref, lookup(ref));
      if (!result.ok) return result;
    }
    return ok(undefined);
  };
  return visit(guid, row);
}
