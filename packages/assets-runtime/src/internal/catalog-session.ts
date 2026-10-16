import type {
  CatalogDelta,
  CatalogDiagnostic,
  CatalogEntry,
  ResourceRevision,
} from '@forgeax/engine-types';
import { type AssetLoadError, err, ok, type Result } from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source.js';
import { resolveCatalogAssetUrl } from '../registry/catalog.js';
import {
  type RuntimeCatalogRow,
  validateCatalogRow,
  validateRuntimeRow,
} from './validate-runtime-row.js';
import { waitForAsset } from './wait-for-asset.js';

export interface CatalogSessionOptions {
  readonly scopeId?: string;
  readonly generation?: number;
}

export interface CatalogSessionSnapshot {
  readonly scopeId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly revision?: ResourceRevision;
  readonly entries: readonly CatalogEntry[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly diagnostics: readonly CatalogDiagnostic[];
  readonly listenerFailures: number;
  readonly stale: boolean;
}

type SessionResult = Result<CatalogSessionSnapshot, AssetLoadError>;
type SessionListener = (snapshot: CatalogSessionSnapshot) => void;

function runtimeError(
  code: AssetLoadError['code'],
  guid: string,
  detail: Record<string, unknown>,
): AssetLoadError {
  if (code === 'catalog-discontinuous') {
    return {
      code,
      expected: 'an ordered catalog revision window',
      hint: 'reconcile the current Catalog before consuming this delta',
      detail: {
        scopeId: String(detail.scopeId ?? 'unknown'),
        expectedGeneration: Number(detail.expectedGeneration ?? 0),
        actualGeneration: Number(detail.actualGeneration ?? 0),
      },
    };
  }
  return {
    code: 'asset-package-invalid',
    expected: 'a verified Catalog source',
    hint: 'repair the producer Catalog and retry with the current publication',
    detail: { guid, reason: String(detail.reason ?? 'catalog source failed') },
  };
}

function freezeSnapshot(snapshot: CatalogSessionSnapshot): CatalogSessionSnapshot {
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze([...snapshot.entries]),
    changed: Object.freeze([...snapshot.changed]),
    removed: Object.freeze([...snapshot.removed]),
    diagnostics: Object.freeze([...snapshot.diagnostics]),
  });
}

function sameEntry(left: CatalogEntry, right: CatalogEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function key(guid: string): string {
  return guid.toLowerCase();
}

function validateSessionRow(row: CatalogEntry): Result<CatalogEntry, AssetLoadError> {
  if (row?.lifecycle === 'missing' && row.publication === undefined) {
    return validateCatalogRow(row);
  }
  return validateRuntimeRow(row);
}

export class CatalogSession {
  private readonly source: CatalogSource;
  private readonly scopeId: string;
  private readonly generation: number;
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly reads = new Map<string, Promise<Result<RuntimeCatalogRow, AssetLoadError>>>();
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<SessionListener>();
  private unsubscribe: (() => void) | undefined;
  private baselinePromise: Promise<SessionResult> | undefined;
  private reconcilePromise: Promise<SessionResult> | undefined;
  private pending: CatalogDelta[] = [];
  private currentSnapshot: CatalogSessionSnapshot;
  private revision: ResourceRevision | undefined;
  private diagnostics: CatalogDiagnostic[] = [];
  private listenerFailures = 0;
  private changed = new Set<string>();
  private removed = new Set<string>();
  private epoch = 0;
  private stale = false;
  private staleGeneration = 0;
  private started = false;
  private disposed = false;

  constructor(source: CatalogSource, options: CatalogSessionOptions = {}) {
    this.source = source;
    this.scopeId = options.scopeId ?? source.expectedScope?.scopeId ?? 'asset-runtime';
    this.generation = options.generation ?? source.expectedScope?.generation ?? 0;
    this.currentSnapshot = freezeSnapshot({
      scopeId: this.scopeId,
      generation: this.generation,
      epoch: 0,
      entries: [],
      changed: [],
      removed: [],
      diagnostics: [],
      listenerFailures: 0,
      stale: false,
    });
  }

  start(): Promise<SessionResult> {
    if (this.baselinePromise !== undefined) return this.baselinePromise;
    if (this.disposed) return Promise.resolve(err(this.disposedError()));
    this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    const promise = this.source
      .enumerate()
      .then((result) => {
        if (!result.ok) {
          this.markStale();
          this.publish();
          return err(runtimeError('asset-package-invalid', '', { reason: result.error.code }));
        }
        this.entries.clear();
        for (const entry of result.value) {
          const validated = validateSessionRow(this.resolveRow(entry));
          if (!validated.ok) {
            this.markStale();
            this.publish();
            return err(validated.error);
          }
          this.entries.set(key(validated.value.guid), validated.value);
        }
        this.started = true;
        this.stale = false;
        this.staleGeneration = this.generation;
        this.diagnostics = [];
        for (const delta of this.pending) this.fold(delta, false);
        this.pending = [];
        this.publish();
        return ok(this.currentSnapshot);
      })
      .catch((cause: unknown) => {
        this.markStale();
        this.addDiagnostic('catalog-degraded-rows', 'Catalog enumeration must resolve a Result');
        this.publish();
        return err(
          runtimeError('asset-package-invalid', '', {
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      });
    this.baselinePromise = promise;
    void promise.then(
      (result) => {
        if (!result.ok) this.baselinePromise = undefined;
      },
      () => {
        this.baselinePromise = undefined;
      },
    );
    return promise;
  }

  reconcile(): Promise<SessionResult> {
    if (this.disposed) return Promise.resolve(err(this.disposedError()));
    if (this.reconcilePromise !== undefined) return this.reconcilePromise;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
    this.reads.clear();
    this.pending = [];
    this.baselinePromise = undefined;
    this.epoch += 1;
    const promise = this.start();
    this.reconcilePromise = promise;
    void promise.then(
      () => {
        if (this.reconcilePromise === promise) this.reconcilePromise = undefined;
      },
      () => {
        if (this.reconcilePromise === promise) this.reconcilePromise = undefined;
      },
    );
    return promise;
  }

  current(guid: string): CatalogEntry | undefined {
    return this.entries.get(key(guid));
  }

  get(guid: string): Promise<Result<RuntimeCatalogRow, AssetLoadError>> {
    const row = this.current(guid);
    const get = this.source.get?.bind(this.source);
    if (this.disposed) return Promise.resolve(err(this.disposedError()));
    if (row === undefined)
      return Promise.resolve(
        err({
          code: 'asset-not-found',
          expected: 'the current Catalog to declare the requested GUID',
          hint: 'inspect the producer Catalog',
          detail: { guid },
        }),
      );
    if (row.lifecycle !== 'missing' || row.publication !== undefined || get === undefined) {
      return Promise.resolve(validateRuntimeRow(row));
    }
    const id = key(guid);
    const existing = this.reads.get(id);
    if (existing) return existing;
    const baseline = [...this.entries.values()].filter(
      (candidate) => candidate.sourcePath === row.sourcePath,
    );
    const current = () => this.reads.get(id) === request;
    const request = (async (): Promise<Result<RuntimeCatalogRow, AssetLoadError>> => {
      const imported = await waitForAsset(
        Promise.resolve()
          .then(() => get(guid))
          .then((result) =>
            result.ok
              ? ok(result.value)
              : err(runtimeError('asset-package-invalid', guid, { reason: result.error.code })),
          )
          .catch((cause: unknown) =>
            err(
              runtimeError('asset-package-invalid', guid, {
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
          ),
        this.lifetime.signal,
        guid,
      );
      if (this.disposed) return err(this.disposedError());
      if (!current())
        return err({
          code: 'asset-superseded',
          expected: 'the same declared GUID until publication completes',
          hint: 'retry the current Catalog publication',
          detail: { guid, generation: this.generation },
        });
      const discontinuity = this.discontinuity();
      if (discontinuity) return err(discontinuity);
      if (!imported.ok) return imported;
      const rows: RuntimeCatalogRow[] = [];
      for (const candidate of imported.value) {
        const validated = validateRuntimeRow(this.resolveRow(candidate));
        if (!validated.ok) return validated;
        rows.push(validated.value);
      }
      const published = rows.find((candidate) => key(candidate.guid) === id);
      if (published === undefined)
        return err(
          runtimeError('asset-package-invalid', guid, {
            reason: 'producer omitted the requested GUID',
          }),
        );
      for (const candidate of rows) {
        const prior = baseline.find((entry) => key(entry.guid) === key(candidate.guid));
        const current = this.current(candidate.guid);
        if (
          (prior !== undefined && current === undefined) ||
          (current !== undefined &&
            !sameEntry(current, candidate) &&
            (prior === undefined || current !== prior))
        ) {
          return err({
            code: 'asset-superseded',
            expected: 'the same declared source until publication completes',
            hint: 'retry the current Catalog publication',
            detail: { guid: candidate.guid, generation: this.generation },
          });
        }
      }
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
      return ok(published);
    })();
    this.reads.set(id, request);
    void request.finally(() => {
      if (this.reads.get(id) === request) this.reads.delete(id);
    });
    return request;
  }

  snapshot(): CatalogSessionSnapshot {
    return this.currentSnapshot;
  }

  discontinuity(): AssetLoadError | undefined {
    if (!this.stale) return undefined;
    return {
      code: 'catalog-discontinuous',
      expected: 'an ordered, authoritative catalog revision window',
      hint: 'reconcile the Catalog source and retry the current publication',
      detail: {
        scopeId: this.scopeId,
        expectedGeneration: this.generation,
        actualGeneration: this.staleGeneration,
      },
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending = [];
    this.reads.clear();
    this.listeners.clear();
  }

  private receive(delta: CatalogDelta): void {
    if (this.disposed) return;
    if (!this.started) {
      this.pending.push(delta);
      return;
    }
    this.fold(delta, true);
  }

  private resolveRow(row: CatalogEntry): CatalogEntry {
    if (this.source.url === undefined || typeof row?.packageUrl !== 'string') return row;
    const packageUrl = resolveCatalogAssetUrl({ packIndexUrl: this.source.url }, row.packageUrl);
    return packageUrl === row.packageUrl ? row : { ...row, packageUrl };
  }

  private fold(delta: CatalogDelta, publish: boolean): void {
    if (
      (delta.scopeId !== undefined && delta.scopeId !== this.scopeId) ||
      (delta.generation !== undefined && delta.generation !== this.generation)
    ) {
      this.markStale(delta.generation);
      this.addDiagnostic('catalog-scope-mismatch', 'delta scope does not match the session');
      if (publish) this.publish();
      return;
    }
    if (delta.authority === 'degraded') {
      this.markStale(delta.generation);
      this.addDiagnostic('catalog-degraded-rows', 'degraded rows are not identity-bearing');
      if (publish) this.publish();
      return;
    }
    if (delta.revisions !== undefined) {
      const baseline = delta.revisions.baseline;
      const current = delta.revisions.current;
      const valid =
        baseline.length === current.length &&
        current.every((point) => {
          const prior = baseline.find((item) => item.rootId === point.rootId);
          return prior !== undefined && point.revision === prior.revision + 1;
        });
      if (!valid) {
        this.markStale(delta.generation);
        this.addDiagnostic('catalog-gap', 'delta revision window is not contiguous');
        if (publish) this.publish();
        return;
      }
    }
    let changed = false;
    for (const entry of [...delta.added, ...delta.changed]) {
      const validated = validateSessionRow(this.resolveRow(entry));
      if (!validated.ok) {
        this.markStale(delta.generation);
        this.addDiagnostic('catalog-degraded-rows', 'delta contains an invalid runtime row');
        if (publish) this.publish();
        return;
      }
      const entryKey = key(validated.value.guid);
      const prior = this.entries.get(entryKey);
      if (prior === undefined || !sameEntry(prior, validated.value)) {
        this.entries.set(entryKey, validated.value);
        this.changed.add(entryKey);
        changed = true;
        if (validated.value.revision !== undefined) this.revision = validated.value.revision;
      }
    }
    for (const guid of delta.removed) {
      const entryKey = key(guid);
      this.reads.delete(entryKey);
      if (this.entries.delete(entryKey)) {
        this.removed.add(entryKey);
        changed = true;
      }
    }
    if (changed) this.epoch += 1;
    if (publish) this.publish();
  }

  private addDiagnostic(code: CatalogDiagnostic['code'], expected: string): void {
    if (this.diagnostics.some((diagnostic) => diagnostic.code === code)) return;
    this.diagnostics.push({
      code,
      severity: 'blocking',
      expected,
      hint: 'reconcile the Catalog before loading the affected publication',
      authority: 'catalog',
    });
  }

  private markStale(actualGeneration = this.generation): void {
    this.stale = true;
    this.staleGeneration = actualGeneration;
    this.epoch += 1;
  }

  private publish(): void {
    this.currentSnapshot = freezeSnapshot({
      scopeId: this.scopeId,
      generation: this.generation,
      epoch: this.epoch,
      ...(this.revision === undefined ? {} : { revision: this.revision }),
      entries: [...this.entries.values()].sort((left, right) =>
        key(left.guid).localeCompare(key(right.guid)),
      ),
      changed: [...this.changed].sort(),
      removed: [...this.removed].sort(),
      diagnostics: this.diagnostics,
      listenerFailures: this.listenerFailures,
      stale: this.stale,
    });
    this.changed.clear();
    this.removed.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentSnapshot);
      } catch {
        this.listenerFailures = Math.min(1024, this.listenerFailures + 1);
        this.currentSnapshot = freezeSnapshot({
          ...this.currentSnapshot,
          listenerFailures: this.listenerFailures,
        });
      }
    }
  }

  private disposedError(): AssetLoadError {
    return {
      code: 'asset-runtime-disposed',
      expected: 'a live asset runtime',
      hint: 'create a new runtime after disposal',
      detail: { scopeId: this.scopeId },
    };
  }
}
