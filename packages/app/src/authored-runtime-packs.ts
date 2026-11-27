import type { CatalogReplica } from '@forgeax/engine-assets-runtime';
import type { RuntimePackProducer, RuntimeScriptablePackSource } from '@forgeax/engine-import';
import type { PackProgram } from '@forgeax/engine-pack/runtime';
import {
  AssetGuid,
  definePackageId,
  projectScriptablePackRuntimeOutputs,
} from '@forgeax/engine-pack/source';
import { AssetError, type CatalogEntry, err, ok, type Result } from '@forgeax/engine-types';

/** Immutable ordinary Pack declarations captured by the project build. */
export interface AuthoredRuntimePack {
  readonly source: RuntimeScriptablePackSource;
  readonly program: PackProgram;
}

type DemandResult = Result<readonly CatalogEntry[], AssetError>;

interface PackDemand {
  readonly pack: AuthoredRuntimePack;
  readonly anchor: string;
  pending?: Promise<DemandResult>;
}

export function authoredRuntimePacks(
  declarations: readonly AuthoredRuntimePack[],
  base: CatalogReplica,
  producer: RuntimePackProducer,
) {
  const owners = new Map<string, PackDemand>();
  const rows = new Map<string, CatalogEntry>();
  const lifetime = new AbortController();
  for (const pack of declarations) {
    const source = pack.source;
    const outputs = source.runtime?.outputs;
    if (!outputs || source.runtime.export !== pack.program.export)
      throw new TypeError(`Invalid ordinary Runtime Pack declaration: ${source.source}`);
    const packageId = definePackageId(source.packageId);
    // The existing Runtime Pack producer stores the generator recipe under a
    // separate identity. Its instance keeps the original authored package ID.
    const owner = {
      pack,
      anchor: AssetGuid.format(AssetGuid.derive(packageId, 'runtime-generator')),
    };
    for (const { guid, sourceKey, kind } of projectScriptablePackRuntimeOutputs({
      packageId,
      runtime: source.runtime,
    })) {
      if (owners.has(guid)) throw new TypeError(`Duplicate Runtime Pack output: ${guid}`);
      owners.set(guid, owner);
      rows.set(guid, {
        guid,
        kind,
        packageId: source.packageId,
        sourceKey,
        sourcePath: source.source,
        packageUrl: `forgeax-runtime-pack://declared/${source.packageId}`,
        lifecycle: 'missing',
        subject: 'internal-asset',
        execution: 'direct',
      });
    }
  }
  checkDependencyCycles(owners);

  async function generate(owner: PackDemand): Promise<DemandResult> {
    const { source, program } = owner.pack;
    const signal = lifetime.signal;
    try {
      (await base.start()).unwrap();
      const dependencies: Record<string, string> = {};
      for (const guid of source.runtime?.dependencies ?? []) {
        signal.throwIfAborted();
        const dep = owners.get(guid);
        let row: CatalogEntry | undefined;
        if (dep) row = (await get(dep)).unwrap().find((candidate) => candidate.guid === guid);
        else row = (await base.require(guid)).unwrap();
        const output = row?.publication?.outputs.find((candidate) => candidate.guid === guid);
        if (!output) throw new TypeError(`Missing runtime dependency publication: ${guid}`);
        dependencies[guid] = output.digest;
      }
      const admitted = await producer.admit(
        {
          source: { ...source, packageId: owner.anchor },
          programs: { [source.program]: { artifact: program } },
          dependencies,
        },
        signal,
      );
      if (!admitted.ok) throw admitted.error;
      const built = await producer.generate(
        { schemaVersion: '3.0.0', packageId: source.packageId, parent: owner.anchor, values: {} },
        signal,
      );
      if (!built.ok) {
        // Release the failed recipe and its dependency pins. A retry resolves
        // the current versions instead of inheriting the failed generation.
        if (!signal.aborted) producer.withdraw(owner.anchor);
        throw built.error;
      }
      return ok(built.value.rows);
    } catch (cause) {
      const reason =
        cause instanceof Error
          ? cause.message
          : cause && typeof cause === 'object' && 'code' in cause
            ? `${String(cause.code)} for ${source.source}`
            : String(cause);
      return err(
        new AssetError({
          code: 'asset-not-imported',
          expected: `generated assets from ${source.source}`,
          hint: reason,
        }),
      );
    }
  }

  function get(owner: PackDemand): Promise<DemandResult> {
    if (owner.pending) return owner.pending;
    const published = producer.rows().filter((row) => owners.get(row.guid) === owner);
    if (published.length) return Promise.resolve(ok(published));
    const request = Promise.resolve().then(() => generate(owner));
    owner.pending = request;
    const release = () => {
      if (owner.pending === request) delete owner.pending;
    };
    void request.then(release, release);
    return request;
  }

  return {
    rows,
    get(guid: string): Promise<DemandResult> | undefined {
      const owner = owners.get(guid.toLowerCase());
      return owner === undefined ? undefined : get(owner);
    },
    dispose() {
      lifetime.abort();
    },
  };
}

function checkDependencyCycles(owners: ReadonlyMap<string, PackDemand>): void {
  const checked = new Set<PackDemand>();
  const visiting = new Set<PackDemand>();
  const visit = (owner: PackDemand): void => {
    if (checked.has(owner)) return;
    if (visiting.has(owner))
      throw new TypeError(`Cyclic Runtime Pack dependencies: ${owner.pack.source.source}`);
    visiting.add(owner);
    for (const guid of owner.pack.source.runtime?.dependencies ?? []) {
      const dependency = owners.get(guid);
      if (dependency) visit(dependency);
    }
    visiting.delete(owner);
    checked.add(owner);
  };
  for (const owner of owners.values()) visit(owner);
}
