import type { AssetLoadError, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { freezeRuntimePayload } from './immutable-payload.js';
import { assetLoadCancelled as cancelled, waitForAsset } from './wait-for-asset.js';

export interface AssetGraphOptions<
  P extends { readonly value: unknown; readonly refs: readonly string[] },
> {
  readonly read: (guid: string, signal: AbortSignal) => Promise<Result<P, AssetLoadError>>;
  readonly maxConcurrentReads?: number;
}

export interface AssetGraphCounters {
  readonly loads: number;
  readonly cacheHits: number;
  readonly readErrors: number;
  readonly noChange: number;
  readonly listenerFailures: number;
}

export interface AssetGraphSnapshot {
  readonly epoch: number;
  readonly ready: readonly string[];
  readonly pending: number;
  readonly resources: number;
  readonly sccs: readonly (readonly string[])[];
  readonly counters: AssetGraphCounters;
}

type GraphResult<P> = Result<P, AssetLoadError>;
type GraphListener = (snapshot: AssetGraphSnapshot) => void;

function disposed(scopeId = 'asset-runtime'): AssetLoadError {
  return {
    code: 'asset-runtime-disposed',
    expected: 'an active asset runtime scope',
    hint: 'obtain a new Registry from the current realm',
    detail: { scopeId },
  };
}

function superseded(guid: string, generation: number): AssetLoadError {
  return {
    code: 'asset-superseded',
    expected: 'the load ticket to remain current until promotion',
    hint: 'load the current publication after the Catalog change',
    detail: { guid, generation },
  };
}

function thrown(guid: string): AssetLoadError {
  return {
    code: 'asset-decode-failed',
    expected: 'the graph reader to return a Result',
    hint: 'repair the owner reader and retry the current publication',
    detail: { guid, kind: 'asset-graph-reader' },
  };
}

function freezeSnapshot(snapshot: AssetGraphSnapshot): AssetGraphSnapshot {
  return Object.freeze({
    ...snapshot,
    ready: Object.freeze([...snapshot.ready]),
    sccs: Object.freeze(snapshot.sccs.map((scc) => Object.freeze([...scc]))),
    counters: Object.freeze({ ...snapshot.counters }),
  });
}

export class AssetGraph<P extends { readonly value: unknown; readonly refs: readonly string[] }> {
  private readonly read: AssetGraphOptions<P>['read'];
  private readonly limit: number;
  private readonly ready = new Map<string, P>();
  private readonly forward = new Map<string, Set<string>>();
  private readonly reverse = new Map<string, Set<string>>();
  private readonly reads = new Map<string, Promise<GraphResult<P>>>();
  private readonly requests = new Map<string, Promise<GraphResult<P>>>();
  private readonly listeners = new Set<GraphListener>();
  private readonly lifetime = new AbortController();
  private readonly sccs: (readonly string[])[] = [];
  private activeReads = 0;
  private readWaiters: (() => void)[] = [];
  private disposed = false;
  private epoch = 0;
  private counters: AssetGraphCounters = {
    loads: 0,
    cacheHits: 0,
    readErrors: 0,
    noChange: 0,
    listenerFailures: 0,
  };
  private currentSnapshot: AssetGraphSnapshot | undefined;

  constructor(options: AssetGraphOptions<P>) {
    this.read = options.read;
    this.limit = Math.max(1, Math.floor(options.maxConcurrentReads ?? 8));
    this.currentSnapshot = freezeSnapshot({
      epoch: 0,
      ready: [],
      pending: 0,
      resources: 0,
      sccs: [],
      counters: this.counters,
    });
  }

  load(guid: string, signal = new AbortController().signal): Promise<GraphResult<P>> {
    const canonicalGuid = guid.toLowerCase();
    if (this.disposed) return Promise.resolve(err(disposed()));
    if (signal.aborted) return Promise.resolve(err(cancelled(canonicalGuid)));
    const cached = this.ready.get(canonicalGuid);
    if (cached !== undefined) {
      this.counters = {
        ...this.counters,
        cacheHits: this.counters.cacheHits + 1,
        noChange: this.counters.noChange + 1,
      };
      this.publish();
      return Promise.resolve(ok(cached));
    }
    const existing = this.requests.get(canonicalGuid);
    if (existing !== undefined) {
      this.counters = { ...this.counters, cacheHits: this.counters.cacheHits + 1 };
      return waitForAsset(existing, signal, canonicalGuid);
    }
    this.counters = { ...this.counters, loads: this.counters.loads + 1 };
    const ticketEpoch = this.epoch;
    const current = () => this.requests.get(canonicalGuid) === request;
    const request = this.loadClosure(
      canonicalGuid,
      this.lifetime.signal,
      ticketEpoch,
      current,
    ).finally(() => {
      if (this.requests.get(canonicalGuid) === request) this.requests.delete(canonicalGuid);
      this.publish();
    });
    this.requests.set(canonicalGuid, request);
    this.publish();
    return waitForAsset(request, signal, canonicalGuid);
  }

  invalidate(guid: string): readonly string[] {
    const affected = this.collectAffected([guid.toLowerCase()]);
    this.drop(affected);
    this.epoch += 1;
    this.publish();
    return [...affected].sort();
  }

  invalidateForCatalogChange(guids?: readonly string[]): void {
    if (this.disposed) return;
    const affected =
      guids === undefined || guids.length === 0
        ? new Set([...this.ready.keys(), ...this.requests.keys(), ...this.reads.keys()])
        : this.collectAffected(guids.map((item) => item.toLowerCase()));
    this.drop(affected);
    this.epoch += 1;
    this.publish();
  }

  subscribe(listener: GraphListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AssetGraphSnapshot {
    this.currentSnapshot ??= freezeSnapshot({
      epoch: this.epoch,
      ready: [...this.ready.keys()].sort(),
      pending: this.requests.size + this.reads.size,
      resources: this.ready.size,
      sccs: this.sccs,
      counters: this.counters,
    });
    return this.currentSnapshot;
  }

  lookup(guid: string): P['value'] | undefined {
    return this.ready.get(guid.toLowerCase())?.value;
  }

  guidOf(value: P['value']): string | undefined {
    for (const [guid, entry] of this.ready) {
      if (entry.value === value) return guid;
    }
    return undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.epoch += 1;
    this.ready.clear();
    this.forward.clear();
    this.reverse.clear();
    this.reads.clear();
    this.requests.clear();
    const waiters = this.readWaiters;
    this.readWaiters = [];
    for (const resolve of waiters) resolve();
    this.publish();
  }

  private async loadClosure(
    root: string,
    signal: AbortSignal,
    ticketEpoch: number,
    current: () => boolean,
  ): Promise<GraphResult<P>> {
    const values = new Map<string, P>();
    const seen = new Set<string>();
    const result = await this.visit(root, signal, seen, values, ticketEpoch, current);
    if (this.disposed) return err(disposed());
    if (!current()) return err(superseded(root, ticketEpoch));
    if (!result.ok) return result;
    if (signal.aborted) return err(cancelled(root));
    for (const [guid, value] of values) this.promote(guid, value);
    this.recordScc();
    return ok(values.get(root) as P);
  }

  private async visit(
    guid: string,
    signal: AbortSignal,
    seen: Set<string>,
    values: Map<string, P>,
    ticketEpoch: number,
    current: () => boolean,
  ): Promise<GraphResult<void>> {
    if (seen.has(guid)) return ok(undefined);
    const cached = this.ready.get(guid);
    if (cached !== undefined) {
      values.set(guid, cached);
      seen.add(guid);
      return ok(undefined);
    }
    seen.add(guid);
    const read = await this.readOnce(guid, signal);
    if (!read.ok) {
      seen.delete(guid);
      return read;
    }
    if (this.disposed) return err(disposed());
    if (!current()) return err(superseded(guid, ticketEpoch));
    values.set(guid, read.value);
    this.link(guid, read.value.refs);
    const references = (read.value as P & { readonly references?: 'eager' | 'deferred' })
      .references;
    for (const ref of references === 'deferred' ? [] : read.value.refs) {
      const child = await this.visit(ref, signal, seen, values, ticketEpoch, current);
      if (!child.ok) {
        seen.delete(guid);
        return err({
          code: 'asset-dependency-failed',
          expected: 'every referenced asset to load successfully',
          hint: 'repair the dependency publication and retry the root asset',
          detail: { guid, dependencyGuid: ref },
        });
      }
    }
    return ok(undefined);
  }

  private readOnce(guid: string, signal: AbortSignal): Promise<GraphResult<P>> {
    const existing = this.reads.get(guid);
    if (existing !== undefined) return existing;
    const request = this.withPermit(async () => {
      if (this.disposed) return err(disposed());
      if (signal.aborted) return err(cancelled(guid));
      try {
        const result = await waitForAsset(this.read(guid, signal), signal, guid);
        if (signal.aborted) return err(cancelled(guid));
        if (!result.ok)
          this.counters = { ...this.counters, readErrors: this.counters.readErrors + 1 };
        return result;
      } catch {
        this.counters = { ...this.counters, readErrors: this.counters.readErrors + 1 };
        return err(thrown(guid));
      }
    });
    this.reads.set(guid, request);
    void request.finally(() => {
      if (this.reads.get(guid) === request) this.reads.delete(guid);
    });
    return request;
  }

  private async withPermit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeReads >= this.limit) {
      await new Promise<void>((resolve) => this.readWaiters.push(resolve));
    }
    this.activeReads += 1;
    try {
      return await operation();
    } finally {
      this.activeReads -= 1;
      this.readWaiters.shift()?.();
    }
  }

  private link(guid: string, refs: readonly string[]): void {
    const previous = this.forward.get(guid) ?? new Set<string>();
    for (const ref of previous) this.reverse.get(ref)?.delete(guid);
    const next = new Set(refs.map((ref) => ref.toLowerCase()));
    this.forward.set(guid, next);
    for (const ref of next) {
      const dependents = this.reverse.get(ref) ?? new Set<string>();
      dependents.add(guid);
      this.reverse.set(ref, dependents);
    }
  }

  private collectAffected(guids: readonly string[]): Set<string> {
    const affected = new Set<string>();
    const queue = [...guids];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || affected.has(current)) continue;
      affected.add(current);
      for (const dependent of this.reverse.get(current) ?? []) queue.push(dependent);
    }
    return affected;
  }

  private drop(affected: ReadonlySet<string>): void {
    for (const item of affected) {
      for (const ref of this.forward.get(item) ?? []) this.reverse.get(ref)?.delete(item);
      for (const dependent of this.reverse.get(item) ?? []) {
        this.forward.get(dependent)?.delete(item);
      }
    }
    for (const item of affected) {
      this.ready.delete(item);
      this.requests.delete(item);
      this.reads.delete(item);
      this.forward.delete(item);
      this.reverse.delete(item);
    }
    this.sccs.splice(0, this.sccs.length);
  }

  private promote(guid: string, value: P): void {
    if (value === undefined) return;
    this.ready.set(
      guid,
      Object.freeze({
        ...value,
        value: freezeRuntimePayload(value.value),
        refs: Object.freeze([...value.refs]),
      }) as P,
    );
  }

  private recordScc(): void {
    interface Vertex {
      readonly guid: string;
      readonly index: number;
      low: number;
      onStack: boolean;
    }
    const vertices = new Map<string, Vertex>();
    const stack: Vertex[] = [];
    const components: string[][] = [];
    const visit = (guid: string): Vertex => {
      const vertex: Vertex = { guid, index: vertices.size, low: vertices.size, onStack: true };
      vertices.set(guid, vertex);
      stack.push(vertex);
      for (const ref of this.forward.get(guid) ?? []) {
        const child = vertices.get(ref);
        if (child === undefined) {
          vertex.low = Math.min(vertex.low, visit(ref).low);
        } else if (child.onStack) {
          vertex.low = Math.min(vertex.low, child.index);
        }
      }
      if (vertex.low !== vertex.index) return vertex;
      const component: string[] = [];
      let member: Vertex | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        member.onStack = false;
        component.push(member.guid);
      } while (member !== vertex);
      if (component.length > 1 || this.forward.get(guid)?.has(guid) === true)
        components.push(component.sort());
      return vertex;
    };
    for (const guid of this.forward.keys()) if (!vertices.has(guid)) visit(guid);
    this.sccs.splice(
      0,
      this.sccs.length,
      ...components.map((component) => Object.freeze(component)),
    );
  }

  private publish(): void {
    this.currentSnapshot = undefined;
    if (this.listeners.size === 0) return;
    this.currentSnapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentSnapshot);
      } catch {
        this.counters = {
          ...this.counters,
          listenerFailures: Math.min(1024, this.counters.listenerFailures + 1),
        };
        this.currentSnapshot = freezeSnapshot({
          ...this.currentSnapshot,
          counters: this.counters,
        });
      }
    }
  }
}
