import type { EntityHandle } from '@forgeax/engine-ecs';

/** A synchronous stage consumes one row per view in presentation order. Unlisted
 * views (including the primary recorder) follow in their original query order. */
export class FrameViewList<T> {
  private readonly byEntity = new Map<EntityHandle, T>();
  private readonly ordered: T[] = [];

  add(entity: EntityHandle, value: T): void {
    this.byEntity.set(entity, value);
  }

  inOrder(views: readonly { readonly entity: EntityHandle }[]): readonly T[] {
    for (const view of views) {
      const value = this.byEntity.get(view.entity);
      if (value === undefined) continue;
      this.ordered.push(value);
      this.byEntity.delete(view.entity);
    }
    for (const value of this.byEntity.values()) this.ordered.push(value);
    return this.ordered;
  }

  clear(): void {
    this.byEntity.clear();
    this.ordered.length = 0;
  }
}
