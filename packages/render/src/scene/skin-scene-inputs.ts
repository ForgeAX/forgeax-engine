import { RhiError } from '@forgeax/engine-rhi';
import type { SkeletonAsset } from '@forgeax/engine-types';
import { dynamicCapacity, shouldShrinkCapacity } from '../dynamic-capacity';
import type { GpuInputArena } from '../gpu-input-arena';
import { slotContent } from './mesh-draw';
import type { RenderSceneApplyResult, RenderSceneSlot } from './render-scene-types';
import type { SceneSlotFrame } from './scene-slots';
import {
  type SkinInputFrame,
  type SkinInputSlot,
  SkinInputs,
  skeletonDefinitionValid,
} from './skin-inputs';

/** Already-admitted static author facts, owned by the ordinary Scene slot. */
export interface SkinBindingInput {
  readonly skeleton: number;
  readonly joints: readonly number[];
  readonly affinePoint?: boolean;
}

/** An affected winding keeps the accepted binding even without an authored edit. */
function priorUpdatedBinding(
  delta: RenderSceneApplyResult,
  row: RenderSceneSlot,
): SkinBindingInput | undefined {
  return slotContent(delta.previous.get(row) ?? row).skinBinding;
}

/** Borrowed by one recording until discard or its actual GPU completion.
 * Both numeric roots and the Scene slot root describe the same accepted frame.
 */
export interface SkinSceneFrame {
  readonly slots: SceneSlotFrame;
  /** Previous accepted uniform-backend affine input. Borrow only during CPU recording. */
  readonly previousTranslation?: SkinTranslationReader;
  readonly current: SkinInputFrame;
  readonly previous: SkinInputFrame | undefined;
}

/** A malformed shared Skeleton is unavailable to its own consumers, whose
 * actual demand omits their draws, rather than failing the whole Scene.
 */
function admissible(definition: SkeletonAsset | undefined): SkeletonAsset | undefined {
  return definition !== undefined &&
    skeletonDefinitionValid(
      definition.jointCount,
      definition.inverseBindMatrices,
      definition.shadowCapsules,
    )
    ? definition
    : undefined;
}

function retireRoot(
  root: SkinInputFrame | undefined,
  failure: AggregateError | undefined,
): AggregateError | undefined {
  try {
    root?.release();
  } catch (cause) {
    if (failure === undefined)
      return new AggregateError([cause], 'Skin frame retirement failed', { cause });
    failure.errors.push(cause);
  }
  return failure;
}

/** Fixed root population, with no temporary collection on successful retirement. */
function releaseRoots(
  current: SkinInputFrame | undefined,
  previous?: SkinInputFrame,
  history?: SkinInputFrame,
  submitted?: SkinInputFrame,
): void {
  let failure = retireRoot(current, undefined);
  failure = retireRoot(previous, failure);
  failure = retireRoot(history, failure);
  failure = retireRoot(submitted, failure);
  if (failure !== undefined) throw failure;
}

interface Skeleton {
  readonly slot: SkinInputSlot;
  references: number;
}
interface Source {
  readonly slot: SkinInputSlot;
  readonly skeletons: Map<number, Skeleton>;
  /** Reference counts, never joint-to-consumer lists. Matrices live only in SkinInputs. */
  readonly joints: Map<number, number>;
  readonly first: Set<number>;
  bindings: number;
}

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'apply known Scene slot edits and source deltas; rebuild the Scene after partial adoption failure',
  });
}

/** Scene admission over one shared numeric root. Before facts come from the
 * accepted Scene slot; this owner retains no second Binding/palette catalogue.
 */
export class SkinSceneInputs {
  private readonly inputs: SkinInputs;
  private sourceValue: Source | undefined;
  private failed = false;
  private disposed = false;
  constructor(
    arena: GpuInputArena,
    private resolve: ((handle: number) => SkeletonAsset | undefined) | undefined,
  ) {
    this.inputs = new SkinInputs(arena);
  }
  private healthy(): void {
    if (this.disposed || this.failed) throw invalid('a live healthy shared Skin Scene');
  }
  /** No source binds a Skin; a view without submitted history then records none. */
  get empty(): boolean {
    return this.sourceValue === undefined;
  }
  private source(): Source {
    let source = this.sourceValue;
    if (source !== undefined) return source;
    const slot = this.inputs.source();
    source = { slot, skeletons: new Map(), joints: new Map(), first: new Set(), bindings: 0 };
    try {
      this.sourceValue = source;
    } catch (cause) {
      this.inputs.remove(slot);
      throw cause;
    }
    return source;
  }
  private skeleton(source: Source, handle: number): Skeleton {
    const current = source.skeletons.get(handle);
    if (current !== undefined) return current;
    const slot = this.inputs.reserveSkeleton();
    try {
      const definition = admissible(this.resolve?.(handle));
      if (definition !== undefined)
        this.inputs.updateSkeleton(
          slot,
          definition.jointCount,
          definition.inverseBindMatrices,
          definition.shadowCapsules,
        );
      const value = { slot, references: 0 };
      source.skeletons.set(handle, value);
      return value;
    } catch (cause) {
      this.inputs.remove(slot);
      throw cause;
    }
  }

  /** One known static edit. Acquire before release so shared unchanged facts
   * survive replacing the last reference with another reference to the same row.
   */
  binding(
    slot: number,
    before: SkinBindingInput | undefined,
    after: SkinBindingInput | undefined,
  ): void {
    this.healthy();
    if (before === after) return;
    try {
      if (after === undefined) this.inputs.unbind(slot);
      else this.acquireBinding(slot, after);
      if (before !== undefined) this.releaseBinding(before);
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }
  private acquireBinding(slot: number, after: SkinBindingInput): void {
    if (!Number.isSafeInteger(after.skeleton) || after.skeleton <= 0 || after.skeleton > 0xffffffff)
      throw invalid('a nonzero u32 Skeleton handle');
    const source = this.source(),
      next = this.skeleton(source, after.skeleton);
    this.inputs.bind(slot, source.slot, next.slot, after.joints, after.affinePoint);
    next.references++;
    for (const joint of after.joints) {
      const count = source.joints.get(joint) ?? 0;
      if (!Number.isSafeInteger(count + 1)) throw invalid('bounded joint reference counts');
      source.joints.set(joint, count + 1);
      if (count === 0) source.first.add(joint);
    }
    source.bindings++;
  }
  /** Release static references only. The caller already replaced/retired the
   * Binding row; this must never unbind a new identity reusing that Scene slot.
   */
  private releaseBinding(before: SkinBindingInput): void {
    const source = this.sourceValue,
      previous = source?.skeletons.get(before.skeleton);
    if (
      source === undefined ||
      previous === undefined ||
      previous.references <= 0 ||
      source.bindings <= 0
    )
      throw invalid('balanced accepted Skin and Skeleton references');
    if (--previous.references === 0) {
      source.skeletons.delete(before.skeleton);
      this.inputs.remove(previous.slot);
    }
    for (const joint of before.joints) {
      const count = source.joints.get(joint);
      if (count === undefined || count <= 0) throw invalid('balanced accepted joint references');
      if (count === 1) {
        source.joints.delete(joint);
        source.first.delete(joint);
        this.inputs.removeJoint(source.slot, joint);
      } else source.joints.set(joint, count - 1);
    }
    if (--source.bindings === 0) {
      this.sourceValue = undefined;
      this.inputs.remove(source.slot);
    }
  }

  /** Adopt one accepted Scene delta exactly once, from its carried prior records.
   * Retire old Binding identities first, acquire every new reference, then
   * release all old references. Joint/source/Skeleton facts therefore survive
   * same-packet handoff and swaps when publication sends no unchanged matrices.
   * Only known static edits are visited; transform-only updates do no work.
   */
  apply(delta: RenderSceneApplyResult): void {
    this.healthy();
    try {
      for (const removed of delta.removedSlots)
        if (slotContent(removed).skinBinding !== undefined) this.inputs.unbind(removed.slot);
      for (const recreated of delta.recreatedSlots) {
        const previous = this.previousRecord(delta, recreated);
        if (slotContent(previous).skinBinding !== undefined) this.inputs.unbind(previous.slot);
      }
      for (const updated of delta.contentUpdatedSlots)
        if (
          slotContent(updated).skinBinding === undefined &&
          priorUpdatedBinding(delta, updated) !== undefined
        )
          this.inputs.unbind(updated.slot);

      for (const created of delta.createdSlots) {
        const after = slotContent(created).skinBinding;
        if (after !== undefined) this.acquireBinding(created.slot, after);
      }
      for (const recreated of delta.recreatedSlots) {
        const after = slotContent(recreated).skinBinding;
        if (after !== undefined) this.acquireBinding(recreated.slot, after);
      }
      for (const updated of delta.contentUpdatedSlots) {
        const after = slotContent(updated).skinBinding;
        if (after !== undefined && priorUpdatedBinding(delta, updated) !== after)
          this.acquireBinding(updated.slot, after);
      }

      for (const removed of delta.removedSlots) {
        const previous = slotContent(removed).skinBinding;
        if (previous !== undefined) this.releaseBinding(previous);
      }
      for (const recreated of delta.recreatedSlots) {
        const previous = slotContent(this.previousRecord(delta, recreated)).skinBinding;
        if (previous !== undefined) this.releaseBinding(previous);
      }
      for (const updated of delta.contentUpdatedSlots) {
        const binding = priorUpdatedBinding(delta, updated);
        if (binding !== undefined && binding !== slotContent(updated).skinBinding)
          this.releaseBinding(binding);
      }
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }
  private previousRecord(delta: RenderSceneApplyResult, record: RenderSceneSlot): RenderSceneSlot {
    const previous = delta.previous.get(record);
    if (previous === undefined || previous.entityKey !== record.entityKey)
      throw invalid('the carried prior record of this accepted Skin edit');
    return previous;
  }

  /** Asset change evidence updates one shared definition, including removal. */
  skeletonChanged(handle: number, changed: SkeletonAsset | undefined): void {
    this.healthy();
    const skeleton = this.sourceValue?.skeletons.get(handle);
    if (skeleton === undefined) return;
    const definition = admissible(changed);
    try {
      if (definition === undefined) this.inputs.clearSkeleton(skeleton.slot);
      else
        this.inputs.updateSkeleton(
          skeleton.slot,
          definition.jointCount,
          definition.inverseBindMatrices,
          definition.shadowCapsules,
        );
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }
  readonly hasJoint = (entity: number): boolean => {
    this.healthy();
    return this.sourceValue?.joints.has(entity) ?? false;
  };
  /** Borrowed first-reference work, sampled once after the known Binding edits.
   * Each successful joint admission drains only its own pending identity.
   */
  firstJoints(): ReadonlySet<number> | undefined {
    this.healthy();
    return this.sourceValue?.first;
  }
  readonly joint = (entity: number, matrix: Float32Array | undefined, offset?: number): void => {
    this.healthy();
    const source = this.sourceValue;
    if (source === undefined || !source.joints.has(entity)) return;
    try {
      if (matrix === undefined) this.inputs.removeJoint(source.slot, entity);
      else this.inputs.setJoint(source.slot, entity, matrix, offset);
      source.first.delete(entity);
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  };

  /** Consume only the selected joint rows before the receiver can recycle the packet. */
  publishedJoints(rows: Iterable<number>, entities: Uint32Array, transforms: Float32Array): void {
    this.healthy();
    const source = this.sourceValue;
    if (source === undefined) return;
    // Shared buffers use checked scalar capture. Ordinary packets borrow one word view.
    const buffer = transforms.buffer;
    let words: Int32Array<ArrayBuffer> | undefined;
    try {
      for (const row of rows) {
        const entity = entities[row] as number;
        if (!source.joints.has(entity)) continue;
        const start = row * 16;
        if (buffer instanceof ArrayBuffer) {
          words ??= new Int32Array(buffer, transforms.byteOffset, transforms.length);
          this.inputs.setPublishedJoint(source.slot, entity, words, start);
        } else this.inputs.setJoint(source.slot, entity, transforms, start);
        source.first.delete(entity);
      }
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }

  capture() {
    this.healthy();
    return this.inputs.capture();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resolve = undefined;
    this.sourceValue = undefined;
    this.inputs.dispose();
  }
}

type SkinTranslationReader = (slot: number, entity: number, out: Float32Array) => boolean;

const TRANSLATION_ROW = 5;
const EMPTY_TRANSLATIONS = new Float64Array(0);

/**
 * Submitted uniform Skin reads three historical floats and the address owner.
 * Use two view-owned banks so a failed recording cannot modify accepted history.
 * Sorted physical addresses support sparse Scene slots without reserving gaps.
 */
class SkinTranslations {
  private rows = EMPTY_TRANSLATIONS;
  private length = 0;
  private version = 0;

  capture(slots: SceneSlotFrame): void {
    this.length = 0;
    this.version++;
    const members = slots.indexedSlots('skin');
    if (members !== undefined) {
      if (shouldShrinkCapacity(members.size, this.rows.length / TRANSLATION_ROW))
        this.rows = EMPTY_TRANSLATIONS;
      this.reserve(members.size);
      for (const slot of members.borrowKeys()) {
        const entity = slots.entityAt(slot);
        if (entity === undefined) throw invalid('a live Scene address for each Skin row');
        this.append(slots, slot, entity);
      }
    } else {
      slots.findContent((content, entity, slot) => {
        if (content.skinBinding !== undefined) this.append(slots, slot, entity);
        return undefined;
      });
    }
    if (this.length === 0) this.rows = EMPTY_TRANSLATIONS;
  }

  private reserve(count: number): void {
    if (count <= this.rows.length / TRANSLATION_ROW) return;
    const rows = new Float64Array(dynamicCapacity(count) * TRANSLATION_ROW);
    if (this.length > 0) rows.set(this.rows);
    this.rows = rows;
  }

  private append(slots: SceneSlotFrame, slot: number, entity: number): void {
    const at = this.length * TRANSLATION_ROW;
    this.reserve(this.length + 1);
    this.rows[at] = slot;
    this.rows[at + 1] = entity;
    if (slots.writeTranslation(slot, this.rows, at + 2) === undefined)
      throw invalid('the captured Scene translation of a Skin row');
    this.length++;
  }

  borrow(): SkinTranslationReader | undefined {
    if (this.length === 0) return undefined;
    const version = this.version;
    return (slot, entity, out) => this.version === version && this.write(slot, entity, out);
  }

  private write(slot: number, entity: number, out: Float32Array): boolean {
    const rows = this.rows;
    let low = 0;
    let high = this.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((rows[middle * TRANSLATION_ROW] as number) < slot) low = middle + 1;
      else high = middle;
    }
    const at = low * TRANSLATION_ROW;
    if (low === this.length || rows[at] !== slot || rows[at + 1] !== entity) return false;
    out[0] = rows[at + 2] as number;
    out[1] = rows[at + 3] as number;
    out[2] = rows[at + 4] as number;
    return true;
  }

  reset(): void {
    this.rows = EMPTY_TRANSLATIONS;
    this.length = 0;
    this.version++;
  }
}

/**
 * One view's recording lifecycle over a shared {@link SkinSceneInputs}: its
 * pending recording and its own submitted history. Views submit at their own
 * cadence, so history never belongs to the shared inputs.
 */
export class SkinFrames {
  private pending: SkinSceneFrame | undefined;
  /** Reserved before submission: post-submit transfer must not allocate a root. */
  private pendingHistory: SkinInputFrame | undefined;
  /** Physical reads transfer before any post-submit observer can retire the Scene. */
  private pendingRelease: Promise<void> | undefined;
  private submitted: SkinInputFrame | undefined;
  private submittedTranslations = new SkinTranslations();
  private pendingTranslations = new SkinTranslations();
  constructor(readonly inputs: SkinSceneInputs) {}

  /** Capture once before visibility/recording, independently of TAA demand.
   * Preparing or abandoning a newer frame never advances submitted history.
   */
  prepareFrame(slots: SceneSlotFrame, uniformHistory = true): SkinSceneFrame | undefined {
    if (this.pending !== undefined) throw invalid('submit or discard the current Skin recording');
    if (this.inputs.empty && this.submitted === undefined) return undefined;
    const current = this.inputs.capture();
    let previous: SkinInputFrame | undefined;
    let history: SkinInputFrame | undefined;
    try {
      previous = this.submitted?.retain();
      history = current.jointCapacity === 0 ? undefined : current.retain();
      if (uniformHistory && history !== undefined) this.pendingTranslations.capture(slots);
      else this.pendingTranslations.reset();
      const previousTranslation = uniformHistory ? this.submittedTranslations.borrow() : undefined;
      const frame = Object.freeze({
        slots,
        current,
        previous,
        ...(previousTranslation === undefined ? {} : { previousTranslation }),
      });
      this.pending = frame;
      this.pendingHistory = history;
      return frame;
    } catch (cause) {
      try {
        releaseRoots(current, previous, history);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Skin frame preparation rollback failed', {
          cause,
        });
      }
      throw cause;
    }
  }

  /** Borrow the pair for the active recording; never a publication field. */
  recordingFrame(): SkinSceneFrame | undefined {
    return this.pending;
  }

  /** Physical submission always transfers reads to completion. Only an accepted
   * Scene submission advances history; a preparation/depth-only submit does not.
   * All root leases were reserved before submission. Completion captures only
   * the numeric roots, never the fixed Scene slots or this admission owner.
   */
  trackSubmittedWork(frame: SkinSceneFrame, completed: Promise<void>): Promise<void> {
    if (frame !== this.pending || this.pendingRelease !== undefined)
      throw invalid('one physical submission of the current Skin recording');
    const { current, previous } = frame;
    const released = completed.then(
      () => releaseRoots(current, previous),
      (cause) => {
        try {
          releaseRoots(current, previous);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Skin completion and retirement failed', {
            cause,
          });
        }
        throw cause;
      },
    );
    this.pendingRelease = released;
    return released;
  }

  submitFrame(
    frame: SkinSceneFrame,
    completed: Promise<void>,
    acceptHistory: boolean,
  ): Promise<void> {
    if (frame !== this.pending) throw invalid('the current accepted Skin recording');
    const released = this.pendingRelease ?? this.trackSubmittedWork(frame, completed);
    this.pendingRelease = undefined;
    const retiredHistory = acceptHistory ? this.submitted : this.pendingHistory;
    if (acceptHistory) {
      this.submitted = this.pendingHistory;
      const retired = this.submittedTranslations;
      this.submittedTranslations = this.pendingTranslations;
      this.pendingTranslations = retired;
      if (this.submitted === undefined) this.pendingTranslations.reset();
    }
    this.pendingHistory = undefined;
    this.pending = undefined;
    try {
      retiredHistory?.release();
    } catch (retirement) {
      // Physical reads already belong to completion. A retirement error must
      // not prevent the caller from receiving their cleanup promise.
      return released.then(
        () => {
          throw retirement;
        },
        (completion) => {
          throw new AggregateError([retirement, completion], 'Skin submission retirement failed', {
            cause: retirement,
          });
        },
      );
    }
    return released;
  }

  discardFrame(): void {
    const pending = this.pendingRelease === undefined ? this.pending : undefined;
    const history = this.pendingHistory;
    this.pending = undefined;
    this.pendingHistory = undefined;
    this.pendingRelease = undefined;
    releaseRoots(pending?.current, pending?.previous, history);
  }

  /** Recovery/retirement invalidates history without retiring in-flight roots. */
  resetHistory(): void {
    const pending = this.pendingRelease === undefined ? this.pending : undefined;
    const history = this.pendingHistory;
    const submitted = this.submitted;
    this.pending = undefined;
    this.pendingHistory = undefined;
    this.submitted = undefined;
    this.submittedTranslations.reset();
    this.pendingTranslations.reset();
    this.pendingRelease = undefined;
    releaseRoots(pending?.current, pending?.previous, history, submitted);
  }
}
