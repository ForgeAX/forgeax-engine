import { ok, type Result } from '@forgeax/engine-rhi';
import type {
  AssetError,
  CatalogDelta,
  CatalogDiagnostic,
  CatalogEntry,
  CatalogRevisionWindow,
  ResourceRevision,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source';

export interface CatalogReplicaSnapshot {
  readonly version: number;
  readonly entries: readonly CatalogEntry[];
  readonly stale: boolean;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

type SnapshotResult = Result<CatalogReplicaSnapshot, AssetError>;
type CatalogDeltaListener = (delta: CatalogDelta) => void;

function guidKey(guid: string): string {
  return guid.toLowerCase();
}

function freezeEntry(entry: CatalogEntry): CatalogEntry {
  return Object.freeze({ ...entry });
}

function freezeSnapshot(snapshot: CatalogReplicaSnapshot): CatalogReplicaSnapshot {
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze(snapshot.entries.map(freezeEntry)),
    diagnostics: Object.freeze([...snapshot.diagnostics]),
  });
}

function revisionIsOlder(
  incoming: ResourceRevision | undefined,
  current: ResourceRevision | undefined,
): boolean {
  return (
    incoming !== undefined && current !== undefined && incoming.observedAt < current.observedAt
  );
}

function sameRevision(left: ResourceRevision, right: ResourceRevision): boolean {
  return (
    left.digest === right.digest &&
    left.observedAt === right.observedAt &&
    left.rootId === right.rootId
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diagnosticForGap(): CatalogDiagnostic {
  return {
    code: 'catalog-gap',
    severity: 'blocking',
    expected: 'a contiguous producer revision window',
    hint: 'reconcile the catalog before consuming incremental changes',
    authority: 'catalog',
  };
}

function diagnosticForDegradedRows(): CatalogDiagnostic {
  return {
    code: 'catalog-degraded-rows',
    severity: 'blocking',
    expected: 'a degraded catalog delta to contain no identity-bearing rows',
    hint: 'keep the last verified catalog and reconcile before applying a replacement',
    authority: 'catalog',
  };
}

function hasIdentityChanges(delta: CatalogDelta): boolean {
  return delta.added.length > 0 || delta.changed.length > 0 || delta.removed.length > 0;
}

function revisionDiagnostic(
  revisions: CatalogRevisionWindow,
  hasChanges: boolean,
): CatalogDiagnostic | undefined {
  const baselineByRoot = new Map(revisions.baseline.map((point) => [point.rootId, point]));
  const currentByRoot = new Map(revisions.current.map((point) => [point.rootId, point]));

  for (const point of revisions.current) {
    const baseline = baselineByRoot.get(point.rootId);
    if (baseline === undefined) {
      return {
        code: 'catalog-revision-conflict',
        severity: 'blocking',
        expected: 'every current root to have a verified baseline',
        actual: point.rootId,
        hint: 'restore the latest verified snapshot for this root before applying the delta',
        authority: 'catalog',
      };
    }
    if (point.revision < baseline.revision) {
      return {
        code: 'catalog-revision-stale',
        severity: 'blocking',
        expected: 'current revision to be at least the verified baseline',
        actual: `${baseline.revision} -> ${point.revision}`,
        hint: 'discard the stale update and request a fresh catalog snapshot',
        authority: 'catalog',
      };
    }
    if (point.revision === baseline.revision && hasChanges) {
      return {
        code: 'catalog-revision-conflict',
        severity: 'blocking',
        expected: 'a changed delta to advance the root revision',
        actual: `${baseline.revision} -> ${point.revision}`,
        hint: 'keep the verified baseline and serialize concurrent updates before retrying',
        authority: 'catalog',
      };
    }
    if (point.revision > baseline.revision + 1) {
      return {
        code: 'catalog-revision-conflict',
        severity: 'blocking',
        expected: 'the next revision to be exactly baseline + 1',
        actual: `${baseline.revision} -> ${point.revision}`,
        hint: 'request the missing revisions or rebuild from the latest verified snapshot',
        authority: 'catalog',
      };
    }
  }

  for (const point of revisions.baseline) {
    if (!currentByRoot.has(point.rootId)) {
      return {
        code: 'catalog-revision-conflict',
        severity: 'blocking',
        expected: 'every baseline root to be present in the current revision set',
        actual: point.rootId,
        hint: 'do not apply a partial root set over the verified baseline',
        authority: 'catalog',
      };
    }
  }

  return undefined;
}

function rowRevisionDiagnostic(
  entries: ReadonlyMap<string, CatalogEntry>,
  delta: CatalogDelta,
): CatalogDiagnostic | undefined {
  for (const entry of [...delta.added, ...delta.changed]) {
    const prior = entries.get(guidKey(entry.guid));
    if (prior?.revision === undefined) continue;
    if (prior !== undefined && sameValue(prior, entry)) continue;
    if (entry.revision === undefined) {
      return {
        code: 'catalog-revision-conflict',
        severity: 'blocking',
        expected: 'a replacement row to carry a newer producer revision',
        actual: `${prior.revision.rootId}@${prior.revision.observedAt} -> missing`,
        hint: 'restore the producer revision before applying the catalog change',
        authority: 'catalog',
      };
    }
    if (entry.revision.observedAt < prior.revision.observedAt) {
      return {
        code: 'catalog-revision-stale',
        severity: 'blocking',
        expected: 'a replacement row to carry a non-decreasing producer revision',
        actual: `${prior.revision.observedAt} -> ${entry.revision.observedAt}`,
        hint: 'discard the stale update and request a fresh catalog snapshot',
        authority: 'catalog',
      };
    }
    if (entry.revision.observedAt === prior.revision.observedAt) {
      return {
        code: 'catalog-revision-conflict',
        severity: 'blocking',
        expected: 'a changed row to advance its producer revision',
        actual: sameRevision(prior.revision, entry.revision)
          ? `${prior.revision.observedAt} -> ${entry.revision.observedAt}`
          : `${prior.revision.digest} -> ${entry.revision.digest}`,
        hint: 'publish a new producer revision for changed payload bytes',
        authority: 'catalog',
      };
    }
  }
  return undefined;
}

function diagnosticForScopeMismatch(): CatalogDiagnostic {
  return {
    code: 'catalog-scope-mismatch',
    severity: 'blocking',
    expected: 'catalog delta scopeId and generation to match the active runtime binding',
    hint: 'discard the stale publication and reconcile the active runtime catalog',
    authority: 'catalog',
  };
}

function appendDiagnostic(
  diagnostics: readonly CatalogDiagnostic[],
  incoming: readonly CatalogDiagnostic[] | undefined,
): readonly CatalogDiagnostic[] {
  const next = [...diagnostics];
  for (const diagnostic of incoming ?? []) {
    if (!next.some((existing) => existing.code === diagnostic.code)) next.push(diagnostic);
  }
  return next;
}

/**
 * One authoritative catalog read model owned by AssetRegistry.
 *
 * The source subscription is installed before the first enumeration. Deltas
 * observed during that baseline read are buffered and folded afterwards, so
 * an early publication cannot disappear between the two operations.
 */
export class CatalogReplica {
  private readonly source: CatalogSource;
  private readonly listeners = new Set<CatalogDeltaListener>();
  private readonly entries = new Map<string, CatalogEntry>();
  private pendingBeforeBaseline: CatalogDelta[] = [];
  private pendingDuringReconcile: CatalogDelta[] | undefined;
  private unsubscribe: (() => void) | undefined;
  private startPromise: Promise<SnapshotResult> | undefined;
  private baselineReady = false;
  private version = 0;
  private stale = false;
  private diagnostics: readonly CatalogDiagnostic[] = [];
  private currentSnapshot: CatalogReplicaSnapshot | undefined;
  private readonly expectedScope: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'> | undefined;

  constructor(source: CatalogSource) {
    this.source = source;
    this.expectedScope = source.expectedScope;
    this.currentSnapshot = freezeSnapshot({
      version: 0,
      entries: [],
      stale: false,
      diagnostics: [],
    });
  }

  subscribe(listener: CatalogDeltaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CatalogReplicaSnapshot {
    return this.currentSnapshot ?? this.makeSnapshot();
  }

  /** Read an accepted row without materializing or sorting the full observation. */
  get(guid: string): CatalogEntry | undefined {
    return this.entries.get(guidKey(guid));
  }

  /**
   * Adopt an already accepted baseline without reading the source again.
   *
   * AssetRegistry uses this when a URL-backed pack index was loaded before a
   * CatalogSource was attached. The replica still subscribes before exposing
   * the baseline, so later deltas retain the same ordering and validation
   * semantics as a normal `start()`.
   */
  seed(entries: readonly CatalogEntry[]): void {
    if (this.startPromise !== undefined || this.baselineReady) return;
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    }
    this.entries.clear();
    for (const entry of entries) this.entries.set(guidKey(entry.guid), freezeEntry(entry));
    this.stale = false;
    this.diagnostics = [];
    this.baselineReady = true;
    const pending = this.pendingBeforeBaseline;
    this.pendingBeforeBaseline = [];
    this.pendingDuringReconcile = undefined;
    for (const delta of pending) this.fold(delta, false);
    this.currentSnapshot = this.makeSnapshot();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.startPromise = undefined;
    this.pendingBeforeBaseline = [];
    this.pendingDuringReconcile = undefined;
    this.listeners.clear();
  }

  async start(): Promise<SnapshotResult> {
    if (this.startPromise !== undefined) return this.startPromise;
    // `reconcile()` accepts a fresh baseline without populating startPromise.
    // Once that baseline is ready, a later consumer start is only another
    // view of the same authoritative snapshot; fetching again would duplicate
    // the catalog read for constrained sources that must reconcile first.
    // Disposal removes the subscription, so a deliberately restarted replica
    // still takes the normal subscribe-and-load path.
    if (this.baselineReady && this.unsubscribe !== undefined) {
      return Promise.resolve(ok(this.snapshot()));
    }
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    }
    const promise = this.loadBaseline(false);
    this.startPromise = promise;
    void promise.then((result) => {
      if (!result.ok) this.startPromise = undefined;
    });
    return promise;
  }

  async reconcile(): Promise<SnapshotResult> {
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    }
    this.pendingDuringReconcile = [];
    return this.loadBaseline(true);
  }

  private async loadBaseline(isReconcile: boolean): Promise<SnapshotResult> {
    const result = await this.source.enumerate();
    if (!result.ok) {
      this.stale = true;
      this.currentSnapshot = this.makeSnapshot();
      if (!isReconcile) this.pendingBeforeBaseline = [];
      this.pendingDuringReconcile = undefined;
      return result;
    }

    this.entries.clear();
    for (const entry of result.value) this.entries.set(guidKey(entry.guid), freezeEntry(entry));
    this.stale = false;
    this.diagnostics = [];
    this.baselineReady = true;
    const pending = isReconcile ? (this.pendingDuringReconcile ?? []) : this.pendingBeforeBaseline;
    this.pendingBeforeBaseline = [];
    this.pendingDuringReconcile = undefined;
    for (const delta of pending) this.fold(delta, false);
    this.currentSnapshot = this.makeSnapshot();
    return ok(this.currentSnapshot);
  }

  private receive(delta: CatalogDelta): void {
    if (!this.baselineReady) {
      if (this.pendingDuringReconcile !== undefined) this.pendingDuringReconcile.push(delta);
      else this.pendingBeforeBaseline.push(delta);
      this.publish(this.safeDelta(delta));
      return;
    }
    if (this.pendingDuringReconcile !== undefined) {
      this.pendingDuringReconcile.push(delta);
      this.publish(this.safeDelta(delta));
      return;
    }
    this.fold(delta, true);
  }

  private fold(delta: CatalogDelta, publish: boolean): void {
    const safeDelta = this.safeDelta(delta);
    const degraded = safeDelta.authority === 'degraded';
    this.stale = this.stale || degraded;
    this.diagnostics = appendDiagnostic(
      this.diagnostics,
      safeDelta.diagnostics?.some((diagnostic) => diagnostic.code === 'catalog-gap')
        ? [...(safeDelta.diagnostics ?? []), diagnosticForGap()]
        : safeDelta.diagnostics,
    );

    if (degraded) {
      // A failed producer observation cannot replace asset identity or payload.
      // Retain recovery evidence from our accepted baseline, never from the
      // rejected delta's rows or locators.
      const affected = new Set(
        (safeDelta.diagnostics ?? [])
          .filter((diagnostic) => diagnostic.code.startsWith('source-package-'))
          .flatMap((diagnostic) =>
            (diagnostic.evidence ?? [])
              .filter((evidence) => evidence.type === 'asset')
              .map((evidence) => guidKey(evidence.id)),
          ),
      );
      for (const key of affected) {
        const entry = this.entries.get(key);
        if (
          entry?.lifecycle !== 'current' ||
          entry.revision === undefined ||
          entry.projection === undefined ||
          entry.projection.lastKnownGood !== undefined
        )
          continue;
        this.entries.set(
          key,
          freezeEntry({
            ...entry,
            projection: { ...entry.projection, lastKnownGood: { packageUrl: entry.packageUrl } },
          }),
        );
      }
    }

    if (!degraded) {
      let changed = false;
      for (const entry of [...safeDelta.added, ...safeDelta.changed]) {
        const key = guidKey(entry.guid);
        const prior = this.entries.get(key);
        if (revisionIsOlder(entry.revision, prior?.revision)) continue;
        if (prior !== undefined && sameValue(prior, entry)) continue;
        this.entries.set(key, freezeEntry(entry));
        changed = true;
      }
      for (const guid of safeDelta.removed) {
        if (this.entries.delete(guidKey(guid))) changed = true;
      }
      if (changed) this.version += 1;
    }

    this.currentSnapshot = undefined;
    if (publish) {
      this.publish(safeDelta);
    }
  }

  private safeDelta(delta: CatalogDelta): CatalogDelta {
    const diagnostic =
      this.expectedScope !== undefined &&
      (delta.scopeId !== this.expectedScope.scopeId ||
        delta.generation !== this.expectedScope.generation)
        ? diagnosticForScopeMismatch()
        : delta.revisions === undefined
          ? rowRevisionDiagnostic(this.entries, delta)
          : (revisionDiagnostic(delta.revisions, hasIdentityChanges(delta)) ??
            rowRevisionDiagnostic(this.entries, delta));
    const degradedRows = delta.authority === 'degraded' && hasIdentityChanges(delta);
    if (diagnostic === undefined && !degradedRows) return delta;
    return {
      ...delta,
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: appendDiagnostic(
        [],
        [
          ...(diagnostic === undefined ? [] : [diagnostic]),
          ...(degradedRows ? [diagnosticForDegradedRows()] : []),
        ],
      ),
    };
  }

  private publish(delta: CatalogDelta): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(delta);
      } catch {
        // One observer cannot prevent the remaining catalog observers from seeing a fact.
      }
    }
  }

  private makeSnapshot(): CatalogReplicaSnapshot {
    const entries = [...this.entries.values()].sort((left, right) =>
      guidKey(left.guid).localeCompare(guidKey(right.guid)),
    );
    this.currentSnapshot = freezeSnapshot({
      version: this.version,
      entries,
      stale: this.stale,
      diagnostics: this.diagnostics,
    });
    return this.currentSnapshot;
  }
}
