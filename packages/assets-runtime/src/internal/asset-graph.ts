import type { AssetLoadError, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { freezeRuntimePayload } from './immutable-payload.js';
import { assetLoadCancelled as cancelled, waitForAsset } from './wait-for-asset.js';

interface AssetGraphOptions<
  P extends { readonly value: unknown; readonly refs: readonly string[] },
> {
  readonly read: (guid: string, signal: AbortSignal) => Promise<Result<P, AssetLoadError>>;
  readonly maxConcurrentReads?: number;
}

interface AssetGraphCounters {
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
  private readonly generations = new Map<string, number>();
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
    if (cached !== undefined && cached.refs.length === 0) {
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
    const request = Promise.resolve()
      .then(() => this.loadClosure(canonicalGuid, this.lifetime.signal, ticketEpoch, current))
      .finally(() => {
        if (this.requests.get(canonicalGuid) === request) this.requests.delete(canonicalGuid);
        this.publish();
      });
    this.requests.set(canonicalGuid, request);
    this.publish();
    return waitForAsset(request, signal, canonicalGuid);
  }

  /** A verified publication may prepare values before its Catalog notification. */
  prepare(entries: ReadonlyMap<string, P>): void {
    if (this.disposed) throw new TypeError('asset source is disposed');
    this.drop(new Set(entries.keys()));
    for (const [guid, entry] of entries) {
      this.promote(guid, entry);
      this.link(guid, entry.refs);
    }
    this.epoch += 1;
    this.publish();
  }

  revision(guid: string): number {
    return this.generations.get(guid.toLowerCase()) ?? 0;
  }

  invalidate(guid: string): readonly string[] {
    const affected = new Set([guid.toLowerCase()]);
    this.drop(affected);
    this.epoch += 1;
    this.publish();
    return [...affected].sort();
  }

  invalidateForCatalogChange(guids: readonly string[]): void {
    if (this.disposed || guids.length === 0) return;
    this.drop(new Set(guids.map((guid) => guid.toLowerCase())));
    this.epoch += 1;
    this.publish();
  }

  subscribe(listener: GraphListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AssetGraphSnapshot {
    if (this.currentSnapshot === undefined) this.recordScc();
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

  entry(guid: string): P | undefined {
    return this.ready.get(guid.toLowerCase());
  }

  lookup(guid: string): P['value'] | undefined {
    return this.ready.get(guid.toLowerCase())?.value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.epoch += 1;
    this.ready.clear();
    this.forward.clear();
    this.generations.clear();
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
    const seen = new Map<string, number>();
    const result = await this.visit(root, signal, seen, values, ticketEpoch, current);
    if (this.disposed) return err(disposed());
    if (!current()) return err(superseded(root, ticketEpoch));
    if (!result.ok) return result;
    if (signal.aborted) return err(cancelled(root));
    for (const [guid, generation] of seen)
      if ((this.generations.get(guid) ?? 0) !== generation)
        return err(superseded(guid, generation));
    for (const [guid, value] of values) {
      this.promote(guid, value);
      this.link(guid, value.refs);
    }
    return ok(values.get(root) as P);
  }

  private async visit(
    guid: string,
    signal: AbortSignal,
    seen: Map<string, number>,
    values: Map<string, P>,
    ticketEpoch: number,
    current: () => boolean,
  ): Promise<GraphResult<void>> {
    if (seen.has(guid)) return ok(undefined);
    const generation = this.generations.get(guid) ?? 0;
    seen.set(guid, generation);
    const cached = this.ready.get(guid);
    const read = cached === undefined ? await this.readOnce(guid, signal) : ok(cached);
    if (!read.ok) return read;
    if (this.disposed) return err(disposed());
    if (!current() || generation !== (this.generations.get(guid) ?? 0))
      return err(superseded(guid, generation));
    values.set(guid, read.value);
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
    this.forward.set(guid, new Set(refs.map((ref) => ref.toLowerCase())));
  }

  private drop(affected: ReadonlySet<string>): void {
    for (const guid of affected) {
      this.generations.set(guid, (this.generations.get(guid) ?? 0) + 1);
      this.ready.delete(guid);
      this.requests.delete(guid);
      this.reads.delete(guid);
      this.forward.delete(guid);
    }
  }

  private promote(guid: string, value: P): void {
    if (value === undefined) return;
    if (this.ready.get(guid) === value) return;
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
        if (!this.forward.has(ref)) continue;
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
