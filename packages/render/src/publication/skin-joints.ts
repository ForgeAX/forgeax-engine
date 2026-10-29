import { RenderPublicationError } from './contract';
/** Source-side reference counts only; shared presentation matrices have their own owner. */
export class SkinJointReferences {
  private readonly bindings = new Map<number, readonly number[]>();
  private readonly counts = new Map<number, number>();
  private readonly pending = new Set<number>();
  private failed = false;
  private healthy(): void {
    if (this.failed)
      throw new RenderPublicationError({
        reason: 'disposed',
        subject: 'Skin reference adoption failed; restart the source session',
      });
  }
  hasBinding(entity: number): boolean {
    this.healthy();
    return this.bindings.has(entity);
  }
  has(joint: number): boolean {
    this.healthy();
    return this.counts.has(joint);
  }
  mark(joint: number): void {
    this.healthy();
    if (this.counts.has(joint)) this.pending.add(joint);
  }
  get changes(): ReadonlySet<number> {
    this.healthy();
    return this.pending;
  }
  acknowledged(joints: Iterable<number>): void {
    this.healthy();
    for (const joint of joints) this.pending.delete(joint);
  }
  /** Only known Binding edits enter here; unchanged Binding populations are never visited. */
  prepare(edits: Iterable<readonly [number, readonly number[] | undefined]>) {
    this.healthy();
    const bindings = new Map<number, readonly number[] | undefined>();
    const deltas = new Map<number, number>();
    const touched = new Set<number>();
    for (const [entity, next] of edits) {
      if (touched.has(entity))
        throw new RenderPublicationError({
          reason: 'shape',
          subject: 'one source Binding edit per entity',
        });
      touched.add(entity);
      const previous = this.bindings.get(entity);
      if (
        previous === next ||
        (previous !== undefined &&
          next !== undefined &&
          previous.length === next.length &&
          previous.every((joint, index) => joint === next[index]))
      )
        continue;
      bindings.set(entity, next);
      for (const joint of previous ?? []) deltas.set(joint, (deltas.get(joint) ?? 0) - 1);
      for (const joint of next ?? []) deltas.set(joint, (deltas.get(joint) ?? 0) + 1);
    }
    const first = new Set<number>(),
      retired = new Set<number>();
    for (const [joint, delta] of deltas) {
      const before = this.counts.get(joint) ?? 0,
        next = before + delta;
      if (!Number.isSafeInteger(next) || next < 0)
        throw new RenderPublicationError({
          reason: 'base',
          subject: 'balanced source joint references',
        });
      if (before === 0 && next > 0) first.add(joint);
      if (before > 0 && next === 0) retired.add(joint);
    }
    let closed = false;
    return {
      first,
      retired,
      has: (joint: number) => {
        this.healthy();
        return (this.counts.get(joint) ?? 0) + (deltas.get(joint) ?? 0) > 0;
      },
      commit: () => {
        this.healthy();
        if (closed)
          throw new RenderPublicationError({
            reason: 'in-flight',
            subject: 'closed source joint reference candidate',
          });
        closed = true;
        try {
          for (const [entity, joints] of bindings) {
            if (joints === undefined) this.bindings.delete(entity);
            else this.bindings.set(entity, joints); // Borrow the already-owned static Binding row.
          }
          for (const [joint, delta] of deltas) {
            const count = (this.counts.get(joint) ?? 0) + delta;
            if (count === 0) {
              this.counts.delete(joint);
              this.pending.delete(joint);
            } else this.counts.set(joint, count);
          }
        } catch (cause) {
          this.failed = true;
          throw cause;
        }
      },
    };
  }
  clear(): void {
    this.bindings.clear();
    this.counts.clear();
    this.pending.clear();
  }
}
