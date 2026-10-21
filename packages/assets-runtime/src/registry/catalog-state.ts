import { err, ok, type Result } from '@forgeax/engine-rhi';
import type {
  AssetLoadError,
  CatalogDelta,
  CatalogDiagnostic,
  CatalogEntry,
  CatalogRevisionPoint,
  ResourceRevision,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { AssetError, checkCatalogRevisionContinuity } from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source';
import { type RuntimeCatalogRow, validateRuntimeRow } from '../internal/validate-runtime-row';
import { waitForAsset } from '../internal/wait-for-asset';
import { resolveCatalogAssetUrl } from './catalog';

export interface CatalogReplicaSnapshot {
  readonly version: number;
  readonly entries: readonly CatalogEntry[];
  readonly stale: boolean;
  readonly diagnostics: readonly CatalogDiagnostic[];
  readonly revisions: readonly CatalogRevisionPoint[];
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
    revisions: Object.freeze(snapshot.revisions.map((point) => Object.freeze({ ...point }))),
  });
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

function rowRevisionDiagnostic(
  entries: ReadonlyMap<string, CatalogEntry>,
  delta: CatalogDelta,
  ordered = false,
): CatalogDiagnostic | undefined {
  for (const entry of [...delta.added, ...delta.changed]) {
    const prior = entries.get(guidKey(entry.guid));
    if (prior !== undefined && sameValue(prior, entry)) continue;
    const previous = prior?.publication;
    const incoming = entry.publication;
    if (previous !== undefined) {
      const stale = !ordered && incoming !== undefined && incoming.generation < previous.generation;
      if (
        incoming === undefined ||
        stale ||
        (incoming.generation === previous.generation &&
          (incoming.sourcePath !== previous.sourcePath ||
            incoming.sourceRevision !== previous.sourceRevision ||
            incoming.digest !== previous.digest ||
            incoming.outputSetDigest !== previous.outputSetDigest ||
            entry.packageUrl !== prior?.packageUrl))
      )
        return {
          code: stale ? 'catalog-revision-stale' : 'catalog-revision-conflict',
          severity: 'blocking',
          expected: 'changed runtime output to advance its publication generation',
          actual: `${previous.generation} -> ${incoming?.generation ?? 'missing'}`,
          hint: 'retain the accepted publication and request the current producer output',
          authority: 'catalog',
        };
      // A dependency-only rebuild can leave the author file timestamp unchanged.
      if (ordered || incoming.generation > previous.generation) continue;
    }
    if (prior?.revision === undefined) continue;
    if (
      incoming !== undefined &&
      previous === undefined &&
      entry.revision !== undefined &&
      sameRevision(prior.revision, entry.revision)
    )
      continue;
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
  private readonly revisions = new Map<string, number>();
  private readonly changedAt = new Map<string, number>();
  private pendingBeforeBaseline: CatalogDelta[] = [];
  private pendingDuringReconcile: CatalogDelta[] | undefined;
  private unsubscribe: (() => void) | undefined;
  private startPromise: Promise<SnapshotResult> | undefined;
  private baselineReady = false;
  private version = 0;
  private stale = false;
  private diagnostics: readonly CatalogDiagnostic[] = [];
  private currentSnapshot: CatalogReplicaSnapshot | undefined;
  private readonly configuredScope: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'> | undefined;
  private get expectedScope() {
    return this.configuredScope ?? this.source.expectedScope;
  }
  get scopeId(): string {
    return this.expectedScope?.scopeId ?? 'asset-runtime';
  }
  get generation(): number {
    return this.expectedScope?.generation ?? 0;
  }
  private readonly lifetime = new AbortController();
  private readonly reads = new Map<string, Promise<Result<RuntimeCatalogRow, AssetLoadError>>>();
  private reconcilePromise: Promise<SnapshotResult> | undefined;
  private disposed = false;

  constructor(
    source: CatalogSource,
    options: { readonly scopeId?: string; readonly generation?: number } = {},
  ) {
    this.source = source;
    this.configuredScope =
      options.scopeId === undefined && options.generation === undefined
        ? source.expectedScope
        : {
            scopeId: options.scopeId ?? source.expectedScope?.scopeId ?? 'asset-runtime',
            generation: options.generation ?? source.expectedScope?.generation ?? 0,
          };
    this.currentSnapshot = freezeSnapshot({
      version: 0,
      entries: [],
      stale: false,
      diagnostics: [],
      revisions: [],
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

  get isStale(): boolean {
    return this.stale;
  }

  discontinuity(): AssetLoadError | undefined {
    return this.stale
      ? {
          code: 'catalog-discontinuous',
          expected: 'an authoritative, contiguous Catalog publication',
          hint: 'reconcile the Catalog before loading the current publication',
          detail: {
            scopeId: this.scopeId,
            expectedGeneration: this.generation,
            actualGeneration: this.generation,
          },
        }
      : undefined;
  }

  /** Demand admission and explicit refresh fold only the requested producer rows. */
  require(guid: string, refresh = false): Promise<Result<RuntimeCatalogRow, AssetLoadError>> {
    if (this.disposed) return Promise.resolve(err(this.disposedError()));
    const id = guidKey(guid);
    const row = this.get(id);
    const produce = this.source.get?.bind(this.source);
    if (!row)
      return Promise.resolve(
        err({
          code: 'asset-not-found',
          expected: 'a declared Catalog GUID',
          hint: 'inspect the producer Catalog',
          detail: { guid },
        }),
      );
    if (
      produce === undefined ||
      (!refresh && (row.lifecycle !== 'missing' || row.publication !== undefined))
    )
      return Promise.resolve(validateRuntimeRow(row));
    const prior = this.reads.get(id);
    if (prior) return prior;
    const startedAt = this.version;
    const request = Promise.resolve().then(
      async (): Promise<Result<RuntimeCatalogRow, AssetLoadError>> => {
        const imported = await waitForAsset(
          Promise.resolve()
            .then(() => produce(guid))
            .then((result) =>
              result.ok ? ok(result.value) : err(this.sourceError(guid, result.error.code)),
            )
            .catch((cause: unknown) =>
              err(this.sourceError(guid, cause instanceof Error ? cause.message : String(cause))),
            ),
          this.lifetime.signal,
          guid,
        );
        if (this.disposed) return err(this.disposedError());
        if (this.reads.get(id) !== request) return err(this.superseded(guid));
        const discontinuity = this.discontinuity();
        if (discontinuity) return err(discontinuity);
        if (!imported.ok) return imported;
        const rows: RuntimeCatalogRow[] = [];
        for (const candidate of imported.value) {
          const checked = validateRuntimeRow(this.resolveRow(candidate));
          if (!checked.ok) return checked;
          const key = guidKey(candidate.guid);
          const current = this.get(key);
          if (
            (this.changedAt.get(key) ?? 0) > startedAt &&
            (current === undefined || !sameValue(current, checked.value))
          )
            return err(this.superseded(candidate.guid));
          // A demand response covers only one publication's rows. It cannot
          // advance a root stream past updates to other assets under that root.
          if (this.revisions.size > 0 && !sameValue(current, checked.value))
            return err(
              this.sourceError(
                candidate.guid,
                'sequenced demand must publish its complete Catalog window before returning rows',
              ),
            );
          rows.push(checked.value);
        }
        const published = rows.find((candidate) => guidKey(candidate.guid) === id);
        if (!published) return err(this.sourceError(guid, 'producer omitted the requested GUID'));
        this.fold(
          {
            added: rows,
            changed: [],
            removed: [],
            scopeId: this.scopeId,
            generation: this.generation,
          },
          true,
        );
        const failed = this.discontinuity();
        return failed ? err(failed) : ok(published);
      },
    );
    this.reads.set(id, request);
    void request.finally(() => {
      if (this.reads.get(id) === request) this.reads.delete(id);
      if (this.reads.size === 0) this.changedAt.clear();
    });
    return request;
  }

  private resolveRow(row: CatalogEntry): CatalogEntry {
    if (this.source.url === undefined) return row;
    const packageUrl = resolveCatalogAssetUrl({ packIndexUrl: this.source.url }, row.packageUrl);
    return packageUrl === row.packageUrl ? row : { ...row, packageUrl };
  }

  private sourceError(guid: string, reason: string): AssetLoadError {
    return {
      code: 'asset-package-invalid',
      expected: 'a verified Catalog source',
      hint: 'repair the source and retry',
      detail: { guid, reason },
    };
  }

  private superseded(guid: string): AssetLoadError {
    return {
      code: 'asset-superseded',
      expected: 'the same declared source until publication completes',
      hint: 'retry the current Catalog publication',
      detail: { guid, generation: this.generation },
    };
  }

  private retired(): SnapshotResult {
    return err(
      new AssetError({
        code: 'asset-invalidated',
        expected: 'the active Catalog source',
        hint: 'obtain the current runtime owner after source retirement',
      }),
    );
  }

  private disposedError(): AssetLoadError {
    return {
      code: 'asset-runtime-disposed',
      expected: 'an active asset source',
      hint: 'obtain the current runtime owner',
      detail: { scopeId: this.scopeId },
    };
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
    this.revisions.clear();
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
    this.disposed = true;
    this.lifetime.abort();
    this.reads.clear();
    this.changedAt.clear();
    this.revisions.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.startPromise = undefined;
    this.pendingBeforeBaseline = [];
    this.pendingDuringReconcile = undefined;
    this.listeners.clear();
  }

  async start(): Promise<SnapshotResult> {
    if (this.disposed) return this.retired();
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
    if (this.disposed) return this.retired();
    if (this.reconcilePromise) return this.reconcilePromise;
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    }
    this.pendingDuringReconcile = [];
    this.reads.clear();
    this.changedAt.clear();
    const promise = this.loadBaseline(true);
    this.reconcilePromise = promise;
    void promise.finally(() => {
      if (this.reconcilePromise === promise) this.reconcilePromise = undefined;
    });
    return promise;
  }

  private async loadBaseline(isReconcile: boolean): Promise<SnapshotResult> {
    let result: Awaited<ReturnType<CatalogSource['enumerate']>>;
    try {
      result = await this.source.enumerate();
    } catch (cause) {
      result = err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: 'a Catalog source that resolves a Result',
          hint: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
    if (this.disposed) return this.retired();
    if (!result.ok) {
      this.stale = true;
      this.currentSnapshot = this.makeSnapshot();
      if (!isReconcile) this.pendingBeforeBaseline = [];
      this.pendingDuringReconcile = undefined;
      return result;
    }

    const previous = new Map(this.entries);
    const previousRevisions = [...this.revisions].map(([rootId, revision]) => ({
      rootId,
      revision,
    }));
    this.entries.clear();
    this.revisions.clear();
    for (const point of result.revisions ?? []) this.revisions.set(point.rootId, point.revision);
    const changed: CatalogEntry[] = [];
    for (const input of result.value) {
      const entry = this.resolveRow(input);
      const key = guidKey(entry.guid);
      const old = previous.get(key);
      const equal = old !== undefined && sameValue(old, entry);
      this.entries.set(key, equal ? old : freezeEntry(entry));
      if (!equal) {
        changed.push(entry);
        if (this.reads.size > 0) this.changedAt.set(key, this.version + 1);
      }
      previous.delete(key);
    }
    for (const key of previous.keys())
      if (this.reads.size > 0) this.changedAt.set(key, this.version + 1);
    if (changed.length || previous.size) this.version += 1;
    this.stale = false;
    this.diagnostics = [];
    this.baselineReady = true;
    const pending = isReconcile ? (this.pendingDuringReconcile ?? []) : this.pendingBeforeBaseline;
    this.pendingBeforeBaseline = [];
    this.pendingDuringReconcile = undefined;
    const baselineRevisions = new Map(this.revisions);
    const reconciledGuids = new Set([
      ...changed.map((entry) => guidKey(entry.guid)),
      ...previous.keys(),
    ]);
    for (const delta of pending) {
      // The enumeration can already include commits observed while it was in flight.
      if (
        delta.authority !== 'degraded' &&
        (this.expectedScope === undefined ||
          (delta.scopeId === this.scopeId && delta.generation === this.generation)) &&
        delta.revisions !== undefined &&
        delta.revisions.current.length > 0 &&
        checkCatalogRevisionContinuity(delta.revisions, hasIdentityChanges(delta)) === undefined &&
        delta.revisions.current.every(
          (point) => point.revision <= (baselineRevisions.get(point.rootId) ?? -1),
        ) &&
        (delta.revisions.current.every(
          (point) => point.revision < (baselineRevisions.get(point.rootId) ?? -1),
        ) ||
          this.matchesDelta(delta))
      )
        continue;
      this.fold(delta, false);
      if (isReconcile) {
        for (const entry of [...delta.added, ...delta.changed])
          reconciledGuids.add(guidKey(entry.guid));
        for (const guid of delta.removed) reconciledGuids.add(guidKey(guid));
      }
    }
    this.currentSnapshot = this.makeSnapshot();
    if (isReconcile) {
      const current: CatalogEntry[] = [];
      const removed: string[] = [];
      for (const guid of reconciledGuids) {
        const entry = this.entries.get(guid);
        if (entry) current.push(entry);
        else removed.push(guid);
      }
      this.publish({
        scopeId: this.scopeId,
        generation: this.generation,
        added: [],
        changed: current,
        removed,
        ...(previousRevisions.length || this.revisions.size
          ? { revisions: { baseline: previousRevisions, current: this.currentSnapshot.revisions } }
          : {}),
      });
    }
    return ok(this.currentSnapshot);
  }

  private receive(delta: CatalogDelta): void {
    if (this.disposed) return;
    if (!this.baselineReady) {
      if (this.pendingDuringReconcile !== undefined) this.pendingDuringReconcile.push(delta);
      else this.pendingBeforeBaseline.push(delta);
      return;
    }
    if (this.pendingDuringReconcile !== undefined) {
      this.pendingDuringReconcile.push(delta);
      return;
    }
    this.fold(delta, true);
  }

  private fold(delta: CatalogDelta, publish: boolean): void {
    delta = {
      ...delta,
      added: delta.added.map((entry) => this.resolveRow(entry)),
      changed: delta.changed.map((entry) => this.resolveRow(entry)),
    };
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
      for (const point of safeDelta.revisions?.current ?? [])
        this.revisions.set(point.rootId, point.revision);
      let changed = false;
      for (const entry of [...safeDelta.added, ...safeDelta.changed]) {
        const key = guidKey(entry.guid);
        const prior = this.entries.get(key);
        if (prior !== undefined && sameValue(prior, entry)) continue;
        this.entries.set(key, freezeEntry(entry));
        if (this.reads.size > 0) this.changedAt.set(key, this.version + 1);
        changed = true;
      }
      for (const guid of safeDelta.removed) {
        this.reads.delete(guidKey(guid));
        if (this.entries.delete(guidKey(guid))) {
          if (this.reads.size > 0) this.changedAt.set(guidKey(guid), this.version + 1);
          changed = true;
        }
      }
      if (changed) this.version += 1;
    }

    this.currentSnapshot = undefined;
    if (publish) {
      this.publish(safeDelta);
    }
  }

  private safeDelta(delta: CatalogDelta): CatalogDelta {
    const window = delta.revisions;
    const ordered =
      window !== undefined &&
      window.baseline.length > 0 &&
      window.baseline.every((point) => this.revisions.get(point.rootId) === point.revision);
    const duplicate =
      window !== undefined &&
      window.current.length > 0 &&
      window.current.every((point) => this.revisions.get(point.rootId) === point.revision) &&
      this.matchesDelta(delta);
    const discontinuous = window?.baseline.find((point) => {
      const accepted = this.revisions.get(point.rootId);
      return accepted !== undefined && accepted !== point.revision;
    });
    const diagnostic =
      this.expectedScope !== undefined &&
      (delta.scopeId !== this.expectedScope.scopeId ||
        delta.generation !== this.expectedScope.generation)
        ? diagnosticForScopeMismatch()
        : window === undefined
          ? rowRevisionDiagnostic(this.entries, delta)
          : (checkCatalogRevisionContinuity(window, hasIdentityChanges(delta)) ??
            (!duplicate && discontinuous !== undefined
              ? {
                  code: 'catalog-revision-stale',
                  severity: 'blocking' as const,
                  authority: 'catalog' as const,
                  expected: 'the delta baseline to match the accepted producer revision',
                  actual: `${this.revisions.get(discontinuous.rootId)} -> ${discontinuous.revision}`,
                  hint: 'retain the accepted catalog and reconcile the producer snapshot',
                }
              : rowRevisionDiagnostic(this.entries, delta, ordered || duplicate)));
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

  private matchesDelta(delta: CatalogDelta): boolean {
    return (
      [...delta.added, ...delta.changed].every((entry) =>
        sameValue(this.entries.get(guidKey(entry.guid)), this.resolveRow(entry)),
      ) && delta.removed.every((guid) => !this.entries.has(guidKey(guid)))
    );
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
      revisions: [...this.revisions].map(([rootId, revision]) => ({ rootId, revision })),
    });
    return this.currentSnapshot;
  }
}
