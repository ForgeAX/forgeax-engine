export type GpuResourceNamespace = number | symbol;

/** Scope tokens never retain Worlds; empty scopes retire with their last resource. */
export class ScopedGpuResources<T> {
  private readonly scopes = new Map<GpuResourceNamespace, Map<number, T>>();

  get size(): number {
    let size = 0;
    for (const resources of this.scopes.values()) size += resources.size;
    return size;
  }

  get(handle: number, namespace: GpuResourceNamespace): T | undefined {
    return this.scopes.get(namespace)?.get(handle);
  }

  has(handle: number, namespace: GpuResourceNamespace): boolean {
    return this.scopes.get(namespace)?.has(handle) ?? false;
  }

  set(handle: number, value: T, namespace: GpuResourceNamespace): void {
    let resources = this.scopes.get(namespace);
    if (resources === undefined) {
      resources = new Map();
      this.scopes.set(namespace, resources);
    }
    resources.set(handle, value);
  }

  delete(handle: number, namespace: GpuResourceNamespace): void {
    const resources = this.scopes.get(namespace);
    if (resources === undefined) return;
    resources.delete(handle);
    if (resources.size === 0) this.scopes.delete(namespace);
  }

  clear(): void {
    this.scopes.clear();
  }

  *values(): IterableIterator<T> {
    for (const resources of this.scopes.values()) yield* resources.values();
  }

  entries(): IterableIterator<[GpuResourceNamespace, Map<number, T>]> {
    return this.scopes.entries();
  }
}
