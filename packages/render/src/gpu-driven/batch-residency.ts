import type { FrameSet } from '../scene/frame-set';
import { slotContent } from '../scene/mesh-draw';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';

declare const groupBrand: unique symbol;
/** Renderer-internal capability, issued by one source topology and never serialized. */
export interface RenderResidencyGroup {
  readonly id: number;
  readonly [groupBrand]: true;
}

/** Immutable observation of this owner's execution gate, not a readiness receipt. */
export interface RenderResidencySelection {
  readonly phase: 'active' | 'resident';
  readonly includes: (group: RenderResidencyGroup | undefined) => boolean;
  readonly selectSlots: (source: FrameSet) => FrameSet;
  readonly isCurrent: () => boolean;
}

const issuedSelections = new WeakSet<RenderResidencySelection>();

/** Verify the exact frozen issuer fact before invoking caller-visible methods. */
export function assertRenderResidencySelection(
  selection: RenderResidencySelection,
  phase: RenderResidencySelection['phase'] = 'active',
): void {
  if (!issuedSelections.has(selection)) throw new Error('Residency selection is foreign or forged');
  if (selection.phase !== phase) throw new Error('Residency selection has the wrong phase');
  if (!selection.isCurrent()) throw new Error('Residency selection is stale');
}

/** Ordinary rows have no service gate; grouped rows require their exact owner. */
export function residencySelected(
  selection: RenderResidencySelection | undefined,
  group: RenderResidencyGroup | undefined,
): boolean {
  if (group === undefined) return true;
  if (selection === undefined)
    throw new Error('Grouped source requires its owning residency selection');
  assertRenderResidencySelection(selection);
  return selection.includes(group);
}
interface GroupState {
  readonly token: RenderResidencyGroup;
  active: boolean;
  members: number;
  claimRevision: number;
}
interface Claim {
  readonly token: RenderResidencyGroup;
  readonly entity: number;
  readonly generation: number;
}

/** One gate authority; slot claims derive from the same Scene delta as batch membership. */
export class BatchResidency {
  constructor(private readonly ownerCurrent: () => boolean = () => true) {}

  private selection: RenderResidencySelection | undefined;
  private residentSelection: RenderResidencySelection | undefined;
  private nextId = 0;
  private readonly groups = new Map<number, GroupState>();
  private readonly claims = new Map<number, Claim>();
  private revision = 0;
  private residentRevision = 0;
  private unbatched:
    | { readonly source: FrameSet; readonly revision: number; readonly selected: FrameSet }
    | undefined;

  create(): RenderResidencyGroup {
    if (!Number.isSafeInteger(this.nextId)) throw new Error('Residency group identity exhausted');
    const token = Object.freeze({ id: this.nextId++ }) as RenderResidencyGroup;
    this.groups.set(token.id, { token, active: false, members: 0, claimRevision: 0 });
    this.changed();
    return token;
  }

  private changed(): void {
    this.revision++;
    this.residentRevision++;
  }

  private version(phase: RenderResidencySelection['phase']): number {
    return phase === 'active' ? this.revision : this.residentRevision;
  }

  captureSelection(phase: RenderResidencySelection['phase'] = 'active'): RenderResidencySelection {
    const previous = phase === 'active' ? this.selection : this.residentSelection;
    if (previous?.isCurrent()) return previous;
    const revision = this.version(phase);
    const isCurrent = () => revision === this.version(phase) && this.ownerCurrent();
    const slots = new WeakMap<FrameSet, FrameSet>();
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error('Residency selection is stale');
    };
    const captured = Object.freeze({
      phase,
      isCurrent,
      includes: (group: RenderResidencyGroup | undefined) => {
        assertCurrent();
        return group === undefined || this.state(group).active || phase === 'resident';
      },
      selectSlots: (source: FrameSet) => {
        assertCurrent();
        const previous = slots.get(source);
        if (previous !== undefined) return previous;
        const selected = phase === 'resident' ? source : this.activeSlots(source);
        assertCurrent();
        slots.set(source, selected);
        return selected;
      },
    });
    if (phase === 'active') this.selection = captured;
    else this.residentSelection = captured;
    issuedSelections.add(captured);
    return captured;
  }

  private state(token: RenderResidencyGroup): GroupState {
    const state = this.groups.get(token?.id);
    if (state?.token !== token || state === undefined)
      throw new Error('Residency group is foreign or retired');
    return state;
  }

  owns(token: RenderResidencyGroup): boolean {
    const state = this.groups.get(token?.id);
    return state !== undefined && state.token === token;
  }

  claimRevision(token: RenderResidencyGroup): number {
    return this.state(token).claimRevision;
  }

  setActive(token: RenderResidencyGroup, active: boolean): boolean {
    const state = this.state(token);
    if (state.active === active) return false;
    state.active = active;
    this.revision++;
    return true;
  }

  isActive(key: number): boolean {
    return this.groups.get(key)?.active === true;
  }

  retire(token: RenderResidencyGroup): void {
    const state = this.state(token);
    if (state.members !== 0) throw new Error('Residency group still owns Scene rows');
    this.groups.delete(token.id);
    this.changed();
  }

  /** Validate fixed claims before batch mutation, then consume real row retirements. */
  beginDelta(delta: RenderSceneApplyResult): void {
    for (const updated of delta.contentUpdatedSlots) {
      const previous = delta.previous.get(updated);
      if (
        previous !== undefined &&
        slotContent(previous).residencyGroup !== slotContent(updated).residencyGroup
      )
        throw new Error('Residency claim cannot change within a Scene row lifetime');
    }
    this.validateNewRows(delta.createdSlots);
    this.validateNewRows(delta.recreatedSlots);
    for (const slot of delta.removedSlots) this.remove(slot);
    for (const slot of delta.recreatedSlots) {
      const previous = delta.previous.get(slot);
      if (previous !== undefined) this.remove(previous);
    }
  }

  private validateNewRows(slots: readonly RenderSceneSlot[]): void {
    for (const slot of slots) {
      const token = slotContent(slot).residencyGroup;
      if (token !== undefined) this.state(token);
    }
  }

  admit(slot: RenderSceneSlot): void {
    const token = slotContent(slot).residencyGroup;
    const previous = this.claims.get(slot.slot);
    if (previous !== undefined) {
      if (
        previous.token !== token ||
        previous.entity !== slot.entityKey ||
        previous.generation !== slot.generation
      )
        throw new Error('Residency claim cannot change within a Scene row lifetime');
      return;
    }
    if (token === undefined) return;
    const state = this.state(token);
    this.claims.set(slot.slot, { token, entity: slot.entityKey, generation: slot.generation });
    state.members++;
    state.claimRevision++;
    this.changed();
  }

  remove(slot: RenderSceneSlot): void {
    const claim = this.claims.get(slot.slot);
    if (claim === undefined) return;
    if (claim.entity !== slot.entityKey || claim.generation !== slot.generation)
      throw new Error('Residency retirement requires the exact Scene row identity');
    const state = this.state(claim.token);
    state.members--;
    state.claimRevision++;
    this.claims.delete(slot.slot);
    this.unbatched = undefined;
    this.changed();
  }

  selectUnbatched(source: FrameSet): FrameSet {
    if (this.claims.size === 0) {
      this.unbatched = undefined;
      return source;
    }
    const cached = this.unbatched;
    if (cached?.source === source && cached.revision === this.revision) return cached.selected;
    const selected = this.activeSlots(source);
    this.unbatched = { source, revision: this.revision, selected };
    return selected;
  }

  private activeSlots(source: FrameSet): FrameSet {
    if (this.claims.size === 0) return source;
    let selected = source;
    for (const slot of source) {
      const claim = this.claims.get(slot);
      if (claim !== undefined && !this.isActive(claim.token.id)) selected = selected.without(slot);
    }
    return selected;
  }

  reset(): void {
    this.groups.clear();
    this.claims.clear();
    this.unbatched = undefined;
    this.changed();
  }
}
