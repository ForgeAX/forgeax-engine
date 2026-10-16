import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { PackAuthoringError } from '@forgeax/engine-pack/source';
import type { AssetGuid as AssetGuidType, ImportError, Result } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import type {
  ScriptablePackAssetSnapshot,
  ScriptablePackAssetSnapshotSource,
  ScriptablePackDomainError,
  ScriptablePackStagedOutput,
} from './scriptable-pack.js';
import { scriptablePackFingerprint as assetDigest } from './scriptable-pack-fingerprint.js';

export type ScriptablePackSnapshotError =
  | AssetError
  | ImportError
  | PackAuthoringError
  | ScriptablePackDomainError;

export interface ScriptablePackStagedOwner {
  readonly id: string;
  readonly guids: readonly AssetGuidType[];
  build(
    source: ScriptablePackAssetSnapshotSource,
  ): Promise<Result<readonly ScriptablePackStagedOutput[], ScriptablePackSnapshotError>>;
}

export interface ScriptablePackStagedSnapshotOptions {
  readonly generation: number;
  readonly owners: readonly ScriptablePackStagedOwner[];
  readonly declaredExternalOutputs?: readonly ScriptablePackStagedOutput[];
}

function cycleError(
  stack: readonly string[],
  owner: string,
  guid: string,
): ScriptablePackDomainError {
  const cycleStart = stack.indexOf(owner);
  const cycle = [...stack.slice(cycleStart), owner];
  return {
    code: 'pack-content-dependency-stalled',
    expected: 'the content dependency worklist to make progress',
    hint: 'inspect the waiting GUID and pending subjects, then break the content-read cycle',
    detail: { waitingGuids: [guid], pendingSubjects: cycle, iterations: 1 },
  };
}

function missingOutputError(owner: string, guid: string): ScriptablePackDomainError {
  return {
    code: 'pack-source-output-invalid',
    expected: `owner ${owner} to stage every declared output including ${guid}`,
    hint: 'return one output for every GUID declared by the staged owner',
    detail: { missingGuids: [guid], unexpectedSourceKeys: [], kindMismatches: [] },
  };
}

/**
 * One-build authority for current-generation ScriptablePack content reads.
 * Local owners are built lazily, memoized, and never resolved through an old Catalog/DDC generation.
 */
export function createScriptablePackStagedAssetSnapshotSource(
  options: ScriptablePackStagedSnapshotOptions,
): ScriptablePackAssetSnapshotSource & {
  /** Materialize an owner without copying its asset into an inspection-only reader. */
  prepareByGuid(guid: AssetGuidType): Promise<Result<void, ScriptablePackSnapshotError>>;
} {
  const owners =
    options.declaredExternalOutputs === undefined || options.declaredExternalOutputs.length === 0
      ? options.owners
      : [
          {
            id: '<declared-pack-external>',
            guids: options.declaredExternalOutputs.map((output) => output.guid),
            async build() {
              return ok(options.declaredExternalOutputs ?? []);
            },
          } satisfies ScriptablePackStagedOwner,
          ...options.owners,
        ];
  const ownerIds = new Set<string>();
  const ownerByGuid = new Map<string, ScriptablePackStagedOwner>();
  for (const owner of owners) {
    if (owner.id.trim().length === 0 || ownerIds.has(owner.id))
      throw new TypeError('staged owner ids must be non-empty and unique');
    ownerIds.add(owner.id);
    for (const guid of owner.guids) {
      const key = AssetGuid.format(guid).toLowerCase();
      const existing = ownerByGuid.get(key);
      if (existing !== undefined) {
        throw new TypeError(`staged GUID ${key} is owned by both ${existing.id} and ${owner.id}`);
      }
      ownerByGuid.set(key, owner);
    }
  }

  const snapshots = new Map<string, ScriptablePackAssetSnapshot>();
  const builds = new Map<string, Promise<Result<void, ScriptablePackSnapshotError>>>();

  // Active wait edges also detect cycles whose roots started concurrently.
  const waits = new Map<string, Set<string>>();
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return [...(waits.get(from) ?? [])].some((next) => reaches(next, target, visited));
  };
  const sourceFor = (stack: readonly string[]) => ({
    async prepareByGuid(guid: AssetGuidType): Promise<Result<void, ScriptablePackSnapshotError>> {
      const key = AssetGuid.format(guid).toLowerCase();
      const cached = snapshots.get(key);
      if (cached !== undefined) return ok(undefined);
      const owner = ownerByGuid.get(key);
      if (owner === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-imported',
            expected: 'a staged local owner for the requested GUID',
            hint: 'declare the local ScriptablePack output before rebuilding the generation',
          }),
        );
      }
      if (stack.includes(owner.id)) return err(cycleError(stack, owner.id, key));

      const requester = stack.at(-1);
      if (requester !== undefined && reaches(owner.id, requester)) {
        return err(cycleError([...stack, owner.id], requester, key));
      }
      const dependencies =
        requester === undefined ? undefined : (waits.get(requester) ?? new Set<string>());
      if (requester !== undefined && dependencies !== undefined) {
        dependencies.add(owner.id);
        waits.set(requester, dependencies);
      }
      let building = builds.get(owner.id);
      if (building === undefined) {
        let complete!: (result: Result<void, ScriptablePackSnapshotError>) => void;
        let reject!: (reason: unknown) => void;
        building = new Promise((resolve, fail) => {
          complete = resolve;
          reject = fail;
        });
        builds.set(owner.id, building);
        void (async () => {
          const built = await owner.build(sourceFor([...stack, owner.id]));
          if (!built.ok) {
            builds.delete(owner.id);
            return built;
          }
          const next = new Map<string, ScriptablePackAssetSnapshot>();
          for (const output of built.value) {
            const outputGuid = AssetGuid.format(output.guid).toLowerCase();
            if (ownerByGuid.get(outputGuid) !== owner) {
              builds.delete(owner.id);
              return err(missingOutputError(owner.id, outputGuid));
            }
            next.set(outputGuid, {
              asset: structuredClone(output.asset),
              generation: options.generation,
              digest: output.digest ?? (await assetDigest(output.asset)),
            });
          }
          for (const declared of owner.guids) {
            const declaredGuid = AssetGuid.format(declared).toLowerCase();
            if (!next.has(declaredGuid)) {
              builds.delete(owner.id);
              return err(missingOutputError(owner.id, declaredGuid));
            }
          }
          for (const [outputGuid, snapshot] of next) snapshots.set(outputGuid, snapshot);
          return ok(undefined);
        })().then(complete, (reason) => {
          builds.delete(owner.id);
          reject(reason);
        });
      }
      try {
        const built = await building;
        if (!built.ok) return built;
        return snapshots.has(key) ? ok(undefined) : err(missingOutputError(owner.id, key));
      } finally {
        dependencies?.delete(owner.id);
      }
    },
    async readByGuid(
      guid: AssetGuidType,
    ): Promise<Result<ScriptablePackAssetSnapshot, ScriptablePackSnapshotError>> {
      const ready = await this.prepareByGuid(guid);
      if (!ready.ok) return ready;
      const key = AssetGuid.format(guid).toLowerCase();
      const snapshot = snapshots.get(key);
      return snapshot === undefined
        ? err(missingOutputError('<prepared>', key))
        : ok(structuredClone(snapshot));
    },
  });

  return sourceFor([]);
}
