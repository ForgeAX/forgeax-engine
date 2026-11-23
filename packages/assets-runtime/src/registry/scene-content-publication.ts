import {
  type Asset,
  AssetError,
  type AssetPublicationEnvelope,
  type CatalogEntry,
  err,
  ok,
  type Result,
  type SceneAsset,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';
import type { AssetContentLease } from '../internal/asset-records';
import {
  runtimeAssetCatalog,
  runtimeAssetOwnsPublicationReads,
  runtimeAssets,
} from '../internal/runtime-assets';
import type { CatalogReplica } from './catalog-state';
import {
  compareNestedScenePublication,
  compareScenePublicationFences,
  createScenePublicationFence,
  type ScenePublicationFence,
  type ScenePublicationFenceError,
  scenePublicationFenceForRow,
} from './scene-publication-fence';

type Failure = AssetError | ScenePublicationFenceError;

interface PublicationEvidence {
  readonly catalog: CatalogReplica | undefined;
  readonly version: number | undefined;
  readonly recordsRevision: number;
  readonly scenes: number;
}

/** Derived proof only. The caller continues to own the fixed lease and its real holds. */
export interface SceneContentPublicationGuard {
  validate(): Result<void, Failure>;
}

export interface SceneContentPublicationTask {
  /** A quantum indexes one closure member, visits one Scene edge or checks one authored node. */
  step(maxWork: number): Result<SceneContentPublicationGuard | undefined, Failure>;
  /** Close suspended fixed-value readers before the candidate retires its lease. */
  dispose(): void;
}

interface AdoptedScene {
  readonly handle: number;
  readonly guid: string | undefined;
  readonly fence: ScenePublicationFence | undefined;
  normalized?: AssetPublicationEnvelope;
}

interface CatalogFacts {
  readonly root: CatalogEntry;
  readonly rows: ReadonlyMap<string, CatalogEntry>;
  readonly fence: ScenePublicationFence;
  readonly ownedRows: boolean;
  readonly catalog: CatalogReplica | undefined;
  readonly version: number | undefined;
}

interface PublicationProofs {
  readonly scenes: Map<number, AdoptedScene>;
  readonly tuples: Map<string, ScenePublicationFence>;
  readonly catalogs: Map<string, CatalogFacts>;
  failure?: Failure;
}

function mismatch(hint: string): ScenePublicationFenceError {
  return {
    code: 'asset-generation-fence-mismatch',
    phase: 'instantiate',
    hint,
    retryable: true,
    recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
  };
}

/** Reuse Catalog's complete-publication checker, reading only that publication's output rows. */
/** The mutable public projection is copied; only its owner-frozen descendants are reused. */
function immutableFenceInputs(publication: AssetPublicationEnvelope): boolean {
  return (
    Object.isFrozen(publication.outputs) &&
    publication.outputs.every(Object.isFrozen) &&
    Object.isFrozen(publication.receipt)
  );
}

function sameFenceInputs(
  before: AssetPublicationEnvelope,
  after: AssetPublicationEnvelope,
): boolean {
  return (
    before.sourcePath === after.sourcePath &&
    before.sourceRevision === after.sourceRevision &&
    before.generation === after.generation &&
    before.digest === after.digest &&
    before.outputSetDigest === after.outputSetDigest &&
    before.receipt === after.receipt &&
    before.outputs === after.outputs
  );
}

function catalogRowsCurrent(
  registry: AssetRegistry,
  rows: ReadonlyMap<string, CatalogEntry>,
  proofs: PublicationProofs,
): boolean {
  for (const [guid, row] of rows) {
    const actual = registry.catalogEntry(guid);
    if (proofs.failure !== undefined || actual !== row) return false;
  }
  return true;
}

/** Share only the exact complete row map already proved by each root's full checker. */
function shareCatalogRows(proofs: PublicationProofs, rows: ReadonlyMap<string, CatalogEntry>) {
  for (const fact of proofs.catalogs.values()) {
    if (fact.rows.size !== rows.size) continue;
    let same = true;
    for (const [guid, row] of rows)
      if (fact.rows.get(guid) !== row) {
        same = false;
        break;
      }
    if (same) return fact.rows;
  }
  return rows;
}

/** The complete checker authenticated every member's fence in this exact accepted row set. */
function siblingCatalogProof(
  registry: AssetRegistry,
  proofs: PublicationProofs,
  guid: string,
  root: CatalogEntry | undefined,
  catalog: CatalogReplica | undefined,
  version: number | undefined,
): CatalogFacts | undefined {
  if (root?.publication === undefined || !runtimeAssetOwnsPublicationReads(registry))
    return undefined;
  const publication = root.publication;
  for (const fact of proofs.catalogs.values())
    if (
      fact.ownedRows &&
      fact.rows.get(guid) === root &&
      catalogProofCurrent(registry, fact, catalog, version) &&
      // A wire Catalog may supply distinct envelopes. Compare the exact output
      // membership after the root's own receipt and unique GUIDs were checked.
      (fact.root.publication === publication ||
        (publication.outputs.length === fact.rows.size &&
          publication.outputs.every((output) => fact.rows.has(output.guid.toLowerCase()))))
    )
      return { ...fact, root };
  return undefined;
}

function validateCatalog(
  registry: AssetRegistry,
  guid: string,
  expected: ScenePublicationFence,
  proofs: PublicationProofs,
  checked: Set<ReadonlyMap<string, CatalogEntry>>,
): Result<void, Failure> {
  const catalog = runtimeAssetCatalog(registry);
  const version = catalog?.publicationVersion;
  const ownReads = runtimeAssetOwnsPublicationReads(registry);
  // Check this root even when another root's equal scalar fence was already visited.
  const root = registry.catalogEntry(guid);
  if (proofs.failure !== undefined) return err(proofs.failure);
  const cached = proofs.catalogs.get(guid);
  const reusable =
    root !== undefined &&
    cached?.root === root &&
    cached.rows.get(guid) === root &&
    (checked.has(cached.rows) ||
      catalogProofCurrent(registry, cached, catalog, version) ||
      catalogRowsCurrent(registry, cached.rows, proofs));
  if (proofs.failure !== undefined) return err(proofs.failure);
  if (reusable) {
    checked.add(cached.rows);
    if (cached.catalog !== catalog || cached.version !== version)
      proofs.catalogs.set(guid, {
        ...cached,
        ownedRows: cached.ownedRows && ownReads,
        catalog,
        version,
      });
    return ok(undefined);
  }
  const shared = siblingCatalogProof(registry, proofs, guid, root, catalog, version);
  if (shared !== undefined) {
    const same = compareScenePublicationFences(expected, shared.fence);
    if (!same.ok) return same;
    proofs.catalogs.set(guid, shared);
    checked.add(shared.rows);
    return ok(undefined);
  }
  const current = scenePublicationFenceForRow(root, (guid) =>
    proofs.failure === undefined ? registry.catalogEntry(guid) : undefined,
  );
  if (proofs.failure !== undefined) return err(proofs.failure);
  if (!current.ok) return current;
  const same = compareScenePublicationFences(expected, current.value.fence);
  if (!same.ok) return same;
  if (root === undefined) return err(mismatch('current Scene root is missing'));
  const rows = shareCatalogRows(
    proofs,
    new Map(current.value.entries.map((entry) => [entry.guid.toLowerCase(), entry])),
  );
  const ownedRows = ownReads && runtimeAssetOwnsPublicationReads(registry);
  proofs.catalogs.set(guid, {
    root,
    rows,
    fence: current.value.fence,
    ownedRows,
    catalog,
    version,
  });
  checked.add(rows);
  return ok(undefined);
}

/** Replica rows can change without a publication revision only in degraded recovery. */
function catalogProofCurrent(
  registry: AssetRegistry,
  cached: CatalogFacts,
  catalog: CatalogReplica | undefined,
  version: number | undefined,
): boolean {
  return (
    catalog !== undefined &&
    cached.catalog === catalog &&
    cached.version === version &&
    !catalog.isStale &&
    catalog.publicationVersion === version &&
    runtimeAssetCatalog(registry) === catalog
  );
}

function validateAdoptedScene(
  registry: AssetRegistry,
  proof: AdoptedScene,
  proofs: PublicationProofs,
  checked: Set<ReadonlyMap<string, CatalogEntry>>,
): Result<void, Failure> {
  const source = registry.sourceOf(proof.handle);
  if (proofs.failure !== undefined) return err(proofs.failure);
  if (source?.guid.toLowerCase() !== proof.guid)
    return err(mismatch('captured Scene source identity changed'));
  if (source === undefined) return ok(undefined);
  if (source.modified || source.publication === undefined || proof.fence === undefined)
    return err(mismatch('captured Scene has no unmodified adopted publication'));
  if (proof.normalized === undefined || !sameFenceInputs(proof.normalized, source.publication)) {
    const adopted = createScenePublicationFence(source.publication);
    if (!adopted.ok) return adopted;
    const sameAdoption = compareScenePublicationFences(proof.fence, adopted.value);
    if (!sameAdoption.ok) return sameAdoption;
    if (immutableFenceInputs(source.publication)) proof.normalized = { ...source.publication };
    else delete proof.normalized;
  }
  return validateCatalog(registry, source.guid.toLowerCase(), proof.fence, proofs, checked);
}

function observeScene(
  registry: AssetRegistry,
  handle: number,
  proofs: PublicationProofs,
): Result<AssetPublicationEnvelope | undefined, Failure> {
  const source = registry.sourceOf(handle);
  if (proofs.failure !== undefined) return err(proofs.failure);
  if (source === undefined) {
    proofs.scenes.set(handle, { handle, guid: undefined, fence: undefined });
    return ok(undefined);
  }
  if (source.modified || source.publication === undefined)
    return err(mismatch('captured Scene has no unmodified adopted publication'));
  const fence = createScenePublicationFence(source.publication);
  if (!fence.ok) return fence;
  const key = JSON.stringify(fence.value);
  const tuple = proofs.tuples.get(key) ?? fence.value;
  proofs.tuples.set(key, tuple);
  const proof = { handle, guid: source.guid.toLowerCase(), fence: tuple };
  const valid = validateAdoptedScene(registry, proof, proofs, new Set());
  if (!valid.ok) return valid;
  proofs.scenes.set(handle, proof);
  return ok(source.publication);
}

interface SceneVisit {
  readonly handle: number;
  readonly address: string;
  readonly parent: AssetPublicationEnvelope | undefined;
}

/** Only fixed values cross yields. No current Registry payload or World borrow is retained. */
function* publicationSteps(
  registry: AssetRegistry,
  content: AssetContentLease,
  root: number,
  proofs: PublicationProofs,
): Generator<void, Result<void, Failure>> {
  const byGuid = new Map<string, number>();
  for (const handle of content.handles) {
    const source = registry.sourceOf(handle);
    if (proofs.failure !== undefined) return err(proofs.failure);
    if (source !== undefined) {
      const guid = source.guid.toLowerCase();
      if (byGuid.has(guid))
        return err(mismatch('captured closure has duplicate source identities'));
      byGuid.set(guid, handle);
    }
    yield;
  }
  const visited = new Set<number>();
  const pending: SceneVisit[] = [{ handle: root, address: 'root', parent: undefined }];
  while (pending.length > 0) {
    const visit = pending.pop() as SceneVisit;
    const value = content.read<Asset>(visit.handle);
    if (proofs.failure !== undefined) return err(proofs.failure);
    if (!value.ok) return value;
    if (value.value.kind !== 'scene')
      return err(mismatch(`captured nested source is not a Scene at ${visit.address}`));
    const observed = observeScene(registry, visit.handle, proofs);
    if (!observed.ok) return observed;
    const source = registry.sourceOf(visit.handle);
    if (proofs.failure !== undefined) return err(proofs.failure);
    if (visit.parent !== undefined && observed.value !== undefined && source !== undefined) {
      const edge = compareNestedScenePublication(
        visit.parent,
        observed.value,
        source.guid,
        visit.address,
      );
      if (!edge.ok) return edge;
    }
    // Check every incoming edge, even when a shared child's own descendants were already visited.
    if (visited.has(visit.handle)) {
      yield;
      continue;
    }
    visited.add(visit.handle);
    yield;
    for (const [key, node] of Object.entries((value.value as SceneAsset).entities)) {
      const reference = node.instance?.source;
      if (reference !== undefined) {
        const handle =
          typeof reference === 'number' ? reference : byGuid.get(reference.toLowerCase());
        if (handle === undefined)
          return err(
            mismatch(`nested Scene is outside the captured closure at ${visit.address}/${key}`),
          );
        pending.push({ handle, address: `${visit.address}/${key}`, parent: observed.value });
      }
      yield;
    }
  }
  return ok(undefined);
}

/**
 * Validate root and nested producer receipts against one sealed exact closure.
 * No current GUID resolver is consulted. All resumes and final acceptance recheck
 * the initial content and every observed adopted/Catalog tuple; failures stay terminal.
 * Closure guards and complete-publication checks are measured, indivisible work.
 */
export function createSceneContentPublicationTask(
  registry: AssetRegistry,
  content: AssetContentLease,
  root: number,
): SceneContentPublicationTask {
  const proofs: PublicationProofs = { scenes: new Map(), tuples: new Map(), catalogs: new Map() };
  const records = runtimeAssets(registry);
  let evidence: PublicationEvidence | undefined;
  let complete = false;
  let stepping = false;
  let validating = false;
  const steps = publicationSteps(registry, content, root, proofs);
  const reject = (cause: Failure): Result<never, Failure> => {
    proofs.failure ??= cause;
    // A source observation can cancel its running iterator. Its step closes
    // that iterator when control returns, rather than recursively returning it.
    if (!stepping) steps.return(ok(undefined));
    proofs.scenes.clear();
    proofs.tuples.clear();
    proofs.catalogs.clear();
    return err(proofs.failure);
  };
  const busy = () => err(mismatch('Scene publication observation is already in progress'));
  const checkContent = (): Result<void, Failure> => {
    if (proofs.failure !== undefined) return err(proofs.failure);
    const current = content.matchesCurrent();
    if (proofs.failure !== undefined) return err(proofs.failure);
    return current
      ? ok(undefined)
      : reject(
          new AssetError({
            code: 'asset-write-conflict',
            expected: 'the initially captured exact Scene closure',
            hint: 'captured Scene closure changed',
          }),
        );
  };
  const catalogIntact = (
    catalog: CatalogReplica | undefined,
    version: number | undefined,
    stale: boolean | undefined,
  ) =>
    runtimeAssetCatalog(registry) === catalog &&
    catalog?.publicationVersion === version &&
    catalog?.isStale === stale;
  const validate = (): Result<void, Failure> => {
    if (proofs.failure !== undefined) return err(proofs.failure);
    if (validating) return busy();
    validating = true;
    try {
      const catalog = runtimeAssetCatalog(registry);
      const version = catalog?.publicationVersion;
      const stale = catalog?.isStale;
      const revision = records.currentRevision;
      const owned = runtimeAssetOwnsPublicationReads(registry);
      const current = checkContent();
      if (!current.ok) return current;
      // A committed content revision precedes any adopted source metadata change.
      // A healthy Catalog's version covers the complete accepted publication.
      if (
        owned &&
        stale !== true &&
        evidence !== undefined &&
        evidence.scenes === proofs.scenes.size &&
        evidence.recordsRevision === revision &&
        evidence.catalog === catalog &&
        evidence.version === version &&
        records.currentRevision === revision &&
        catalogIntact(catalog, version, stale)
      )
        return current;
      evidence = undefined;
      const checked = new Set<ReadonlyMap<string, CatalogEntry>>();
      for (const proof of proofs.scenes.values()) {
        const valid = validateAdoptedScene(registry, proof, proofs, checked);
        if (!valid.ok) return reject(valid.error);
      }
      const confirmed = checkContent();
      if (!confirmed.ok) return confirmed;
      if (!catalogIntact(catalog, version, stale))
        return reject(mismatch('Catalog publication changed during Scene observation'));
      if (stale !== true && records.currentRevision === revision && owned)
        evidence = { catalog, version, recordsRevision: revision, scenes: proofs.scenes.size };
      return confirmed;
    } finally {
      validating = false;
    }
  };
  const guard: SceneContentPublicationGuard = {
    validate: () =>
      proofs.failure !== undefined ? err(proofs.failure) : stepping ? busy() : validate(),
  };
  return {
    step(maxWork) {
      if (proofs.failure !== undefined) return err(proofs.failure);
      if (stepping || validating) return busy();
      if (!Number.isSafeInteger(maxWork) || maxWork <= 0)
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: 'a positive safe-integer publication work budget',
            hint: 'pass a positive safe integer to step',
          }),
        );
      stepping = true;
      try {
        for (let work = 0; work < maxWork; work++) {
          const valid = validate();
          if (!valid.ok) return valid;
          if (complete) return ok(guard);
          const next = steps.next();
          if (proofs.failure !== undefined) return reject(proofs.failure);
          if (!next.done) continue;
          if (!next.value.ok) return reject(next.value.error);
          complete = true;
        }
        const valid = validate();
        return valid.ok ? ok(complete ? guard : undefined) : valid;
      } finally {
        stepping = false;
        if (proofs.failure !== undefined) steps.return(ok(undefined));
      }
    },
    dispose() {
      reject(mismatch('Scene publication preparation was disposed'));
    },
  };
}
