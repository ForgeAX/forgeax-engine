import type { PhysicsContactObservation } from '@forgeax/engine-physics';

interface Owner {
  readonly entity: number;
  readonly id?: string;
  readonly grouped?: boolean;
  readonly groupIndex?: number;
}
interface Pair {
  readonly handleA: number;
  readonly handleB: number;
  readonly groupA?: number;
  readonly groupB?: number;
}
interface LogicalPair {
  readonly observation: Omit<PhysicsContactObservation, 'phase' | 'fixedStep'>;
  readonly pairs: Map<string, Pair>;
}

/** Only opted-in multi-collider shapes enter this ledger. Coalesce a complete
 * native drain, so migration/replacement between groups is not a logical stop/start.
 * Membership is bounded by the native contact pairs; retired entities clear it. */
export class GroupedContactEvents {
  private readonly logical = new Map<string, LogicalPair>();
  private readonly native = new Map<string, string>();
  private readonly changes = new Map<string, { before: boolean; pair: Pair }>();

  get active(): boolean {
    return this.logical.size > 0;
  }

  /** Admission-only seeding of an already active whole collider before splitting. */
  seed(handleA: number, handleB: number, a: Owner, b: Owner): void {
    this.consume(handleA, handleB, true, { ...a, grouped: true }, b);
    this.changes.clear();
  }

  consume(handleA: number, handleB: number, started: boolean, a?: Owner, b?: Owner): boolean {
    if (this.logical.size === 0 && !a?.grouped && !b?.grouped) return false;
    const nativeKey = handleA < handleB ? `${handleA}/${handleB}` : `${handleB}/${handleA}`;
    let key = this.native.get(nativeKey);
    let pair: Pair = { handleA, handleB };
    if (key === undefined) {
      if (a === undefined || b === undefined) return false;
      const ak = JSON.stringify([a.entity, a.id ?? ['native', handleA]]);
      const bk = JSON.stringify([b.entity, b.id ?? ['native', handleB]]);
      const reversed = ak > bk;
      key = reversed ? `${bk}/${ak}` : `${ak}/${bk}`;
      if (!a.grouped && !b.grouped && !this.logical.has(key)) return false;
      if (!this.logical.has(key)) {
        const first = reversed ? b : a,
          second = reversed ? a : b;
        this.logical.set(key, {
          observation: {
            entityA: first.entity,
            entityB: second.entity,
            ...(first.id === undefined ? {} : { shapeA: first.id }),
            ...(second.id === undefined ? {} : { shapeB: second.id }),
          },
          pairs: new Map(),
        });
      }
      pair = reversed
        ? {
            handleA: handleB,
            handleB: handleA,
            groupA: b.groupIndex ?? 0,
            groupB: a.groupIndex ?? 0,
          }
        : { handleA, handleB, groupA: a.groupIndex ?? 0, groupB: b.groupIndex ?? 0 };
    } else {
      pair = this.logical.get(key)?.pairs.get(nativeKey) ?? pair;
    }
    const state = this.logical.get(key);
    if (state === undefined) throw new Error('Missing logical contact owner');
    if (!this.changes.has(key)) this.changes.set(key, { before: state.pairs.size > 0, pair });
    if (started) {
      state.pairs.set(nativeKey, pair);
      this.native.set(nativeKey, key);
    } else {
      state.pairs.delete(nativeKey);
      this.native.delete(nativeKey);
    }
    return true;
  }

  drain(
    fixedStep: number,
    emit: (observation: PhysicsContactObservation, a: number, b: number) => void,
  ): void {
    for (const [key, change] of this.changes) {
      const state = this.logical.get(key);
      if (state === undefined) throw new Error('Missing logical contact owner');
      const active = state.pairs.size > 0;
      if (change.before !== active) {
        let pair = active ? (state.pairs.values().next().value ?? change.pair) : change.pair;
        if (active) {
          // Stable spatial roster order, independent of Native event queue order.
          for (const candidate of state.pairs.values())
            if (
              (candidate.groupA ?? 0) < (pair.groupA ?? 0) ||
              ((candidate.groupA ?? 0) === (pair.groupA ?? 0) &&
                (candidate.groupB ?? 0) < (pair.groupB ?? 0))
            )
              pair = candidate;
        }
        emit(
          { ...state.observation, phase: active ? 'started' : 'stopped', fixedStep },
          pair.handleA,
          pair.handleB,
        );
      }
      if (!active) this.logical.delete(key);
    }
    this.changes.clear();
  }

  removeEntity(entity: number): void {
    for (const [key, state] of this.logical) {
      if (state.observation.entityA !== entity && state.observation.entityB !== entity) continue;
      for (const native of state.pairs.keys()) this.native.delete(native);
      this.logical.delete(key);
      this.changes.delete(key);
    }
  }

  clear(): void {
    this.logical.clear();
    this.native.clear();
    this.changes.clear();
  }
}
