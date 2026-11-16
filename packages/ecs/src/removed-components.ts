// @forgeax/engine-ecs — removed-component events.
//
// One double-buffered queue per component that has a reader. A removal or a
// despawn appends the entity; `World.update()` rotates the buffers once per
// frame, so an event stays readable for two updates. Each reader keeps its own
// cursor and sees every event retained since its previous read.

import type { EntityHandle } from './entity-handle';

/** Per-reader position in one component's removal stream. */
export interface RemovedComponentsCursor {
  value: number;
}

export class RemovedComponentEvents {
  private older: EntityHandle[] = [];
  private newer: EntityHandle[] = [];
  private olderStart = 0;
  private newerStart = 0;
  private count = 0;

  send(entity: EntityHandle): void {
    this.newer.push(entity);
    this.count += 1;
  }

  /** Drop the older buffer; the current one becomes older. */
  update(): void {
    const dropped = this.older;
    this.older = this.newer;
    this.olderStart = this.newerStart;
    dropped.length = 0;
    this.newer = dropped;
    this.newerStart = this.count;
  }

  /** Visit events after `cursor` that are still retained, then advance it. */
  read(cursor: RemovedComponentsCursor, visit: (entity: EntityHandle) => void): void {
    const from = cursor.value;
    for (let index = Math.max(0, from - this.olderStart); index < this.older.length; index++)
      visit(this.older[index] as EntityHandle);
    for (let index = Math.max(0, from - this.newerStart); index < this.newer.length; index++)
      visit(this.newer[index] as EntityHandle);
    cursor.value = this.count;
  }
}
