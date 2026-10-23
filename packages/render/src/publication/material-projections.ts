import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';

interface ProjectionRow {
  readonly materialProjection?: MaterialRenderProjection | null;
  readonly materialProjectionSource?: number;
}

/**
 * Material projections the receiver holds as of the last accepted packet, by
 * handle and by identity. Copies and variants of one cooked root share one
 * projection object, so a new row whose projection is already resident names a
 * holder handle instead of carrying the projection graph across the Worker
 * boundary again.
 */
export class PublishedMaterialProjections {
  readonly #byHandle = new Map<number, MaterialRenderProjection | undefined>();
  readonly #holders = new Map<object, Set<number>>();

  /**
   * Wire fields for one material row: omitted when this handle already holds
   * the projection, a resident holder outside `retiring`, or the detached copy.
   */
  row(
    handle: number,
    projection: MaterialRenderProjection | undefined,
    retiring: readonly number[],
    detach: (projection: MaterialRenderProjection | undefined) => MaterialRenderProjection | null,
  ): ProjectionRow {
    if (this.#byHandle.has(handle) && this.#byHandle.get(handle) === projection) return {};
    if (projection !== undefined)
      for (const holder of this.#holders.get(projection) ?? [])
        if (!retiring.includes(holder)) return { materialProjectionSource: holder };
    return { materialProjection: detach(projection) };
  }

  /** Apply one accepted packet: retired handles first, then the published rows. */
  accept(
    retired: readonly number[],
    published: ReadonlyMap<number, MaterialRenderProjection | undefined>,
  ): void {
    for (const handle of retired) this.#release(handle);
    for (const [handle, projection] of published) {
      this.#release(handle);
      this.#byHandle.set(handle, projection);
      if (projection === undefined) continue;
      let holders = this.#holders.get(projection);
      if (holders === undefined) {
        holders = new Set();
        this.#holders.set(projection, holders);
      }
      holders.add(handle);
    }
  }

  clear(): void {
    this.#byHandle.clear();
    this.#holders.clear();
  }

  #release(handle: number): void {
    const projection = this.#byHandle.get(handle);
    this.#byHandle.delete(handle);
    if (projection === undefined) return;
    const holders = this.#holders.get(projection);
    holders?.delete(handle);
    if (holders?.size === 0) this.#holders.delete(projection);
  }
}
