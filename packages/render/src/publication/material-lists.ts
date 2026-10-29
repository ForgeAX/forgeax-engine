const NO_MATERIALS: readonly number[] = Object.freeze([]);

/**
 * Accepted material ids per published entity. Entities that draw the same
 * material list share one interned, reference-counted list, so a million
 * renderables cost one map entry each instead of one array each.
 */
export class EntityMaterialLists {
  private readonly byEntity = new Map<number, number>();
  private readonly lists: (readonly number[] | undefined)[] = [];
  private readonly refs: number[] = [];
  private readonly ids = new Map<string, number>();
  private readonly free: number[] = [];

  get(entity: number): readonly number[] {
    const list = this.byEntity.get(entity);
    return list === undefined ? NO_MATERIALS : (this.lists[list] ?? NO_MATERIALS);
  }

  set(entity: number, materials: readonly number[]): void {
    const key = materials.join(',');
    let list = this.ids.get(key);
    if (list === undefined) {
      list = this.free.pop() ?? this.lists.length;
      this.lists[list] = Object.freeze([...materials]);
      this.refs[list] = 0;
      this.ids.set(key, list);
    }
    this.refs[list] = (this.refs[list] as number) + 1;
    this.delete(entity);
    this.byEntity.set(entity, list);
  }

  delete(entity: number): void {
    const list = this.byEntity.get(entity);
    if (list === undefined) return;
    this.byEntity.delete(entity);
    const refs = (this.refs[list] as number) - 1;
    this.refs[list] = refs;
    if (refs > 0) return;
    this.ids.delete((this.lists[list] as readonly number[]).join(','));
    this.lists[list] = undefined;
    this.free.push(list);
  }

  clear(): void {
    this.byEntity.clear();
    this.lists.length = 0;
    this.refs.length = 0;
    this.ids.clear();
    this.free.length = 0;
  }
}
