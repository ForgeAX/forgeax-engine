import { createdHandles, handleAccess } from '../protocol/event-semantics';
import type { HandleId, RhiCallEvent } from '../types';

interface BootstrapHandle {
  event: RhiCallEvent | undefined;
  dependencies: readonly HandleId[];
  dependents: number;
  live: boolean;
}

/** Recipes outlive their wrapper only while a live child or captured event needs them. */
export class RecorderBootstrap {
  readonly #handles = new Map<HandleId, BootstrapHandle>();
  readonly #captureRoots = new Set<HandleId>();
  readonly #finalizer = new FinalizationRegistry<HandleId>((handleId) => this.retire(handleId));
  #size = 0;

  get size(): number {
    return this.#size;
  }

  register(handleId: HandleId, handle: object): void {
    const entry = this.#entry(handleId);
    this.#finalizer.unregister(entry);
    entry.live = true;
    this.#finalizer.register(handle, handleId, entry);
  }

  get(handleId: HandleId): RhiCallEvent | undefined {
    return this.#handles.get(handleId)?.event;
  }

  *values(): IterableIterator<RhiCallEvent> {
    for (const entry of this.#handles.values()) {
      if (entry.event !== undefined) yield entry.event;
    }
  }

  *entries(): IterableIterator<[HandleId, RhiCallEvent]> {
    for (const [handleId, entry] of this.#handles) {
      if (entry.event !== undefined) yield [handleId, entry.event];
    }
  }

  set(handleId: HandleId, event: RhiCallEvent): void {
    const entry = this.#entry(handleId);
    const previous = entry.dependencies;
    const dependencies = handleAccess(event).read;
    if (entry.event === undefined) this.#size++;
    entry.event = event;
    entry.dependencies = dependencies;
    // Acquire the replacement edges before releasing old edges shared by both recipes.
    for (const dependency of dependencies) {
      const parent = this.#handles.get(dependency);
      if (parent !== undefined) parent.dependents++;
    }
    for (const dependency of previous) {
      const parent = this.#handles.get(dependency);
      if (parent !== undefined) parent.dependents--;
      this.#release(dependency);
    }
  }

  retire(handleId: HandleId): void {
    const entry = this.#handles.get(handleId);
    if (entry === undefined) return;
    entry.live = false;
    this.#finalizer.unregister(entry);
    this.#release(handleId);
  }

  retainHandle(handleId: HandleId): void {
    if (this.#handles.has(handleId)) this.#captureRoots.add(handleId);
  }

  retainEvent(event: RhiCallEvent): void {
    for (const handleId of createdHandles(event)) this.retainHandle(handleId);
    for (const handleId of handleAccess(event).read) this.retainHandle(handleId);
  }

  releaseCapture(): void {
    const roots = [...this.#captureRoots];
    this.#captureRoots.clear();
    for (const handleId of roots) this.#release(handleId);
  }

  #entry(handleId: HandleId): BootstrapHandle {
    let entry = this.#handles.get(handleId);
    if (entry === undefined) {
      entry = { event: undefined, dependencies: [], dependents: 0, live: false };
      this.#handles.set(handleId, entry);
    }
    return entry;
  }

  #release(handleId: HandleId): void {
    const pending = [handleId];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const entry = this.#handles.get(current);
      if (
        entry === undefined ||
        entry.live ||
        entry.dependents > 0 ||
        this.#captureRoots.has(current)
      )
        continue;
      this.#handles.delete(current);
      this.#finalizer.unregister(entry);
      if (entry.event !== undefined) this.#size--;
      for (const dependency of entry.dependencies) {
        const parent = this.#handles.get(dependency);
        if (parent === undefined) continue;
        parent.dependents--;
        if (parent.dependents === 0) pending.push(dependency);
      }
    }
  }
}
