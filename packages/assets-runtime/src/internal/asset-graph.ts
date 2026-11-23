import type { AssetLoadError, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { freezeRuntimePayload } from './immutable-payload.js';
import { assetLoadCancelled as cancelled, waitForAsset } from './wait-for-asset.js';

interface AssetGraphOptions<
  P extends { readonly value: unknown; readonly refs: readonly string[] },
  S,
> {
  /** `scope` lives for one closure load and is shared by every read in it. */
  readonly read: (
    guid: string,
    signal: AbortSignal,
    scope: S,
  ) => Promise<Result<P, AssetLoadError>>;
  /** Opens the per-load scope; reads without shared state may omit it. */
  readonly openScope?: () => S;
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

interface ClosureRead {
  readonly root: string;
  readonly guids: Set<string>;
  holders: number;
}

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

export class AssetGraph<
  P extends { readonly value: unknown; readonly refs: readonly string[] },
  S = undefined,
> {
  private readonly read: AssetGraphOptions<P, S>['read'];
  private readonly openScope: () => S;
  private readonly limit: number;
  private readonly ready = new Map<string, P>();
  private readonly pendingDiscards = new Set<string>();
  private readonly closures = new Map<string, ClosureRead>();
  private readonly borrowers = new Map<string, number>();
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

  constructor(options: AssetGraphOptions<P, S>) {
    this.read = options.read;
    this.openScope = options.openScope ?? (() => undefined as S);
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

  load(guid: string, signal = new AbortController().signal, scope?: S): Promise<GraphResult<P>> {
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
    const closure = this.retainClosure(canonicalGuid);
    const request = Promise.resolve()
      .then(() => this.loadClosure(closure, this.lifetime.signal, ticketEpoch, current, scope))
      .finally(() => {
        if (this.requests.get(canonicalGuid) === request) this.requests.delete(canonicalGuid);
        this.releaseClosure(closure);
        this.publish();
      });
    this.requests.set(canonicalGuid, request);
    this.publish();
    return waitForAsset(request, signal, canonicalGuid);
  }

  /** Read one output without populating the Ready cache or loading its dependencies. */
  readOutput(
    guid: string,
    signal: AbortSignal,
    acceptsReady: (entry: P) => boolean,
  ): Promise<GraphResult<P>> {
    const key = guid.toLowerCase();
    if (this.disposed) return Promise.resolve(err(disposed()));
    if (signal.aborted) return Promise.resolve(err(cancelled(key)));
    const ready = this.ready.get(key);
    if (ready !== undefined && acceptsReady(ready)) return Promise.resolve(ok(ready));
    return waitForAsset(this.readOnce(key, this.lifetime.signal, this.openScope()), signal, key);
  }

  /** A verified publication may prepare values before its Catalog notification. */
  prepare(entries: ReadonlyMap<string, P>): void {
    if (this.disposed) throw new TypeError('asset source is disposed');
    this.drop(new Set(entries.keys()));
    for (const [guid, entry] of entries) this.promote(guid, entry);
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

  /** Keep the decoded closure through the caller's adoption after load settles. */
  async withDecodedClosure<T>(guid: string, read: () => Promise<T>): Promise<T> {
    const closure = this.retainClosure(guid.toLowerCase());
    try {
      return await read();
    } finally {
      if (this.releaseClosure(closure)) this.publish();
    }
  }

  /** Drop decoded content without superseding the publication or a pending load. */
  discardReady(guid: string, entry: P): void {
    if (this.ready.get(guid) !== entry) return;
    if (this.borrowers.has(guid)) {
      this.pendingDiscards.add(guid);
      return;
    }
    this.evictDecoded(guid);
    this.publish();
  }

  /** A completed closure may take an output when it is the sole borrower. */
  canTakeReady(root: string, guid: string, entry: P): boolean {
    const closure = this.closures.get(root);
    return (
      this.ready.get(guid) === entry &&
      closure?.holders === 1 &&
      closure.guids.has(guid) &&
      this.borrowers.get(guid) === 1 &&
      !this.reads.has(guid)
    );
  }

  /** Remove an exclusively borrowed decoded value before returning control to another caller. */
  takeReady(guid: string): void {
    this.pendingDiscards.delete(guid);
    this.evictDecoded(guid);
    this.currentSnapshot = undefined;
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
    this.pendingDiscards.clear();
    this.closures.clear();
    this.borrowers.clear();
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
    closure: ClosureRead,
    signal: AbortSignal,
    ticketEpoch: number,
    current: () => boolean,
    scope = this.openScope(),
  ): Promise<GraphResult<P>> {
    if (this.disposed) return err(disposed());
    const { root } = closure;
    const values = new Map<string, P>();
    const seen = new Map<string, number>();
    const result = await this.visit(root, signal, seen, values, current, scope, closure);
    if (this.disposed) return err(disposed());
    if (!current()) return err(superseded(root, ticketEpoch));
    if (!result.ok) return result;
    if (signal.aborted) return err(cancelled(root));
    for (const [guid, generation] of seen)
      if ((this.generations.get(guid) ?? 0) !== generation)
        return err(superseded(guid, generation));
    for (const [guid, value] of values) this.promote(guid, value);
    return ok(this.ready.get(root) as P);
  }

  private async visit(
    guid: string,
    signal: AbortSignal,
    seen: Map<string, number>,
    values: Map<string, P>,
    current: () => boolean,
    scope: S,
    closure: ClosureRead,
  ): Promise<GraphResult<void>> {
    if (seen.has(guid)) return ok(undefined);
    const generation = this.generations.get(guid) ?? 0;
    seen.set(guid, generation);
    this.borrowDecoded(closure, guid);
    const cached = this.ready.get(guid);
    const read = cached === undefined ? await this.readOnce(guid, signal, scope) : ok(cached);
    if (!read.ok) return read;
    if (this.disposed) return err(disposed());
    if (!current() || generation !== (this.generations.get(guid) ?? 0))
      return err(superseded(guid, generation));
    values.set(guid, read.value);
    const references = (read.value as P & { readonly references?: 'eager' | 'deferred' })
      .references;
    for (const ref of references === 'deferred' ? [] : read.value.refs) {
      const child = await this.visit(
        ref.toLowerCase(),
        signal,
        seen,
        values,
        current,
        scope,
        closure,
      );
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

  private readOnce(guid: string, signal: AbortSignal, scope: S): Promise<GraphResult<P>> {
    const existing = this.reads.get(guid);
    if (existing !== undefined) return existing;
    const request = this.withPermit(async () => {
      if (this.disposed) return err(disposed());
      if (signal.aborted) return err(cancelled(guid));
      try {
        const result = await waitForAsset(this.read(guid, signal, scope), signal, guid);
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

  private retainClosure(root: string): ClosureRead {
    let closure = this.closures.get(root);
    if (closure === undefined) {
      closure = { root, guids: new Set(), holders: 0 };
      this.closures.set(root, closure);
      this.borrowDecoded(closure, root);
    }
    closure.holders += 1;
    return closure;
  }

  private borrowDecoded(closure: ClosureRead, guid: string): void {
    if (closure.guids.has(guid)) return;
    closure.guids.add(guid);
    this.borrowers.set(guid, (this.borrowers.get(guid) ?? 0) + 1);
  }

  private releaseClosure(closure: ClosureRead): boolean {
    // Shared load work can outlive a cancelled caller. Adoption can outlive the load.
    closure.holders -= 1;
    if (closure.holders !== 0 || this.closures.get(closure.root) !== closure) return false;
    this.closures.delete(closure.root);
    let discarded = false;
    for (const guid of closure.guids) {
      const readers = (this.borrowers.get(guid) ?? 1) - 1;
      if (readers > 0) {
        this.borrowers.set(guid, readers);
        continue;
      }
      this.borrowers.delete(guid);
      if (this.pendingDiscards.delete(guid)) {
        this.evictDecoded(guid);
        discarded = true;
      }
    }
    return discarded;
  }

  private evictDecoded(guid: string): void {
    this.ready.delete(guid);
    this.forward.delete(guid);
  }

  private drop(affected: ReadonlySet<string>): void {
    for (const guid of affected) {
      this.generations.set(guid, (this.generations.get(guid) ?? 0) + 1);
      this.evictDecoded(guid);
      this.pendingDiscards.delete(guid);
      this.requests.delete(guid);
      this.reads.delete(guid);
    }
  }

  private promote(guid: string, value: P): void {
    // Concurrent closures share the first decoded entry of this generation.
    if (this.ready.has(guid)) return;
    this.ready.set(
      guid,
      Object.freeze({
        ...value,
        value: freezeRuntimePayload(value.value),
        refs: Object.freeze([...value.refs]),
      }) as P,
    );
    this.forward.set(guid, new Set(value.refs.map((ref) => ref.toLowerCase())));
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
