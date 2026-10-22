import { type Mat4, mat4 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import {
  MAX_SHADOW_CAPSULES_PER_SKELETON,
  SHADOW_CAPSULE_STRIDE,
  type ShadowCapsuleSet,
} from '@forgeax/engine-types';
import type { GpuInputArena } from '../gpu-input-arena';
import { StableRangeAllocator } from '../stable-range-allocator';

const ABSENT = 0xffffffff;
const PAGE_WORDS = 256;
const SKELETONS = 0;
const BINDINGS = 1;

type Shift = 0 | 8 | 16 | 24 | 32 | 40 | 48 | 56;

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'admit complete Skin facts and keep the owning input root until its last actual reader retires',
  });
}

function u32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw invalid('complete u32 Skin identities and addresses');
}

function disjoint(a: Float32Array, b: Float32Array): void {
  if (
    a.buffer === b.buffer &&
    a.byteOffset < b.byteOffset + b.byteLength &&
    b.byteOffset < a.byteOffset + a.byteLength
  )
    throw invalid('disjoint Skin output and scratch storage');
}

/** Static Skeleton admission facts; the GPU rows store representable f32 values. */
export function skeletonDefinitionValid(
  count: number,
  inverseBinds: Float32Array,
  capsules?: ShadowCapsuleSet,
): boolean {
  if (!Number.isSafeInteger(count) || count <= 0 || inverseBinds.length !== count * 16)
    return false;
  for (const value of inverseBinds)
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) return false;
  if (capsules === undefined) return true;
  const { joints, shapes } = capsules;
  if (
    !(joints instanceof Uint16Array) ||
    !(shapes instanceof Float32Array) ||
    joints.length > MAX_SHADOW_CAPSULES_PER_SKELETON ||
    shapes.length !== joints.length * SHADOW_CAPSULE_STRIDE
  )
    return false;
  for (const joint of joints) if (joint >= count) return false;
  for (let lane = 0; lane < shapes.length; lane++) {
    const value = Math.fround(shapes[lane] as number);
    if (!Number.isFinite(value) || (lane % SHADOW_CAPSULE_STRIDE === 6 && !(value > 0)))
      return false;
  }
  return true;
}

function composedOverflow(cause: unknown): boolean {
  return (
    cause instanceof RhiError &&
    cause.code === 'rhi-descriptor-invalid' &&
    cause.expected === 'finite composed Skin matrices'
  );
}

function validateMatrixOutputs(a: Mat4, b: Mat4): void {
  if (a.length !== 16 || b.length !== 16)
    throw invalid('complete Skin matrix and inverse-bind scratch outputs');
  disjoint(a, b);
}

interface State {
  readonly slots: StableRangeAllocator;
  frames: number;
  disposed: boolean;
  failed: boolean;
}

export interface SkinInputSlot {
  readonly id: number;
  readonly kind: 'source' | 'skeleton';
}

/** Logical identity only: never retains the source tree, World, or GPU arena. */
class Slot implements SkinInputSlot {
  #holders = 1;
  #retired = false;
  readonly #state: State;
  constructor(
    state: State,
    readonly id: number,
    readonly kind: SkinInputSlot['kind'],
  ) {
    this.#state = state;
    Object.freeze(this);
  }
  belongsTo(state: State): boolean {
    return this.#state === state;
  }
  get active(): boolean {
    return !this.#retired && !this.#state.disposed;
  }
  retain(): void {
    if (!this.active) throw invalid('a live logical Skin identity');
    this.#holders++;
  }
  release(): void {
    if (--this.#holders !== 0) return;
    try {
      this.#state.slots.release(this.id, 1);
    } catch (cause) {
      this.#state.failed = true;
      throw cause;
    }
  }
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.release();
  }
}

interface Row {
  readonly address: number;
  readonly words: number;
  readonly kind: 'joint' | 'skeleton' | 'binding';
  readonly owner: Slot;
  readonly skeleton: Slot | undefined;
  holders: number;
}

type Page = { readonly address: number; holders: number; jointCount: number } & (
  | { readonly shift: 0; readonly entries: Map<number, Row> }
  | { readonly shift: Exclude<Shift, 0>; readonly entries: Map<number, Page> }
);

type LeafPage = Extract<Page, { readonly shift: 0 }>;

function keyByte(space: number, key: number | undefined, shift: Shift): number {
  return shift >= 32 ? (space >>> (shift - 32)) & 255 : ((key as number) >>> shift) & 255;
}

function find(root: Page | undefined, space: number, key: number): Row | undefined {
  let page = root;
  while (page !== undefined && page.shift !== 0)
    page = page.entries.get(keyByte(space, key, page.shift));
  return page?.entries.get(key & 255);
}

function releaseRange(inputs: GpuInputArena, state: State, address: number, words: number): void {
  try {
    inputs.releaseDescriptor(address, words);
  } catch (cause) {
    state.failed = true;
    throw cause;
  }
}

function retirementFailure(
  previous: AggregateError | undefined,
  cause: unknown,
  message: string,
): AggregateError {
  if (previous === undefined) return new AggregateError([cause], message, { cause });
  previous.errors.push(cause);
  return previous;
}

function retireRow(inputs: GpuInputArena, state: State, row: Row): void {
  if (--row.holders !== 0) return;
  let failure: AggregateError | undefined;
  try {
    releaseRange(inputs, state, row.address, row.words);
  } catch (cause) {
    failure = retirementFailure(failure, cause, 'Skin row retirement failed');
  }
  try {
    row.owner.release();
  } catch (cause) {
    failure = retirementFailure(failure, cause, 'Skin row retirement failed');
    state.failed = true;
  }
  try {
    row.skeleton?.release();
  } catch (cause) {
    failure = retirementFailure(failure, cause, 'Skin row retirement failed');
    state.failed = true;
  }
  if (failure !== undefined) throw failure;
}

function retireEntries(inputs: GpuInputArena, state: State, page: Page): void {
  let failure: AggregateError | undefined;
  if (page.shift === 0) {
    for (const row of page.entries.values()) {
      try {
        retireRow(inputs, state, row);
      } catch (cause) {
        failure = retirementFailure(failure, cause, 'Skin page children retirement failed');
      }
    }
  } else {
    for (const child of page.entries.values()) {
      try {
        retirePage(inputs, state, child);
      } catch (cause) {
        failure = retirementFailure(failure, cause, 'Skin page children retirement failed');
      }
    }
  }
  page.entries.clear();
  if (failure !== undefined) throw failure;
}

function retirePage(inputs: GpuInputArena, state: State, page: Page | undefined): void {
  if (page === undefined || --page.holders !== 0) return;
  let failure: AggregateError | undefined;
  try {
    retireEntries(inputs, state, page);
  } catch (cause) {
    failure = retirementFailure(failure, cause, 'Skin page retirement failed');
  }
  try {
    releaseRange(inputs, state, page.address, PAGE_WORDS);
  } catch (cause) {
    failure = retirementFailure(failure, cause, 'Skin page retirement failed');
  }
  if (failure !== undefined) throw failure;
}

/** All GPU-readable Skin facts have one owning root, including static Binding bytes. */
export class SkinInputs {
  private current: Page | undefined;
  private readonly state: State = {
    slots: new StableRangeAllocator(),
    frames: 0,
    disposed: false,
    failed: false,
  };
  /** Last exclusive leaf path. Sharing only changes through capture (root
   * holders) or path copy (a new root), so the root identity validates it. */
  private leaf: { root: Page; space: number; high: number; page: LeafPage } | undefined;
  private readonly jointScratch = new DataView(new ArrayBuffer(17 * 4));
  private readonly pageWords = new Uint32Array(PAGE_WORDS);
  private readonly pageView = new DataView(this.pageWords.buffer);
  constructor(private readonly inputs: GpuInputArena) {
    this.state.slots.reset(2);
  }

  private healthy(): void {
    if (this.state.disposed || this.state.failed) throw invalid('a live healthy Skin input owner');
    this.inputs.assertLive();
  }

  private slot(value: SkinInputSlot, kind: SkinInputSlot['kind']): Slot {
    if (
      !(value instanceof Slot) ||
      !value.belongsTo(this.state) ||
      value.kind !== kind ||
      !value.active
    )
      throw invalid(`a live ${kind} identity from this Skin input owner`);
    return value;
  }

  source(): SkinInputSlot {
    this.healthy();
    return this.identity('source');
  }

  private identity(kind: SkinInputSlot['kind']): Slot {
    const id = this.state.slots.allocate(1);
    try {
      u32(id);
      return new Slot(this.state, id, kind);
    } catch (cause) {
      try {
        this.state.slots.release(id, 1);
      } catch (cleanup) {
        this.state.failed = true;
        throw new AggregateError([cause, cleanup], 'Skin identity rollback failed', { cause });
      }
      throw cause;
    }
  }

  /** A resource identity survives missing/invalid versions without rewriting its Bindings. */
  reserveSkeleton(): SkinInputSlot {
    this.healthy();
    return this.identity('skeleton');
  }

  clearSkeleton(value: SkinInputSlot): void {
    this.healthy();
    const slot = this.slot(value, 'skeleton');
    if (find(this.current, SKELETONS, slot.id) !== undefined)
      this.replace(SKELETONS, slot.id, undefined);
  }

  skeleton(count: number, inverseBinds: Float32Array, capsules?: ShadowCapsuleSet): SkinInputSlot {
    this.healthy();
    const slot = this.identity('skeleton');
    try {
      this.updateSkeleton(slot, count, inverseBinds, capsules);
    } catch (cause) {
      try {
        slot.retire();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Skeleton admission rollback failed', { cause });
      }
      throw cause;
    }
    return slot;
  }

  private allocate(words: number, kind: Row['kind'], owner: Slot, skeleton?: Slot): Row {
    const address = this.inputs.allocateDescriptor(words);
    let retained = false;
    try {
      owner.retain();
      retained = true;
      skeleton?.retain();
      return { address, words, kind, owner, skeleton, holders: 1 };
    } catch (cause) {
      const failures = [cause];
      try {
        if (retained) owner.release();
      } catch (cleanup) {
        failures.push(cleanup);
        this.state.failed = true;
      }
      try {
        releaseRange(this.inputs, this.state, address, words);
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length > 1)
        throw new AggregateError(failures, 'Skin allocation rollback failed', { cause });
      throw cause;
    }
  }

  private publish(space: number, key: number, row: Row, data: DataView): void {
    try {
      this.inputs.writeDescriptor(row.address, data, row.words);
      this.replace(space, key, row);
    } catch (cause) {
      try {
        retireRow(this.inputs, this.state, row);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Skin publication rollback failed', { cause });
      }
      throw cause;
    }
    retireRow(this.inputs, this.state, row);
  }

  setJoint(source: SkinInputSlot, entity: number, world: Float32Array): void {
    this.healthy();
    const slot = this.slot(source, 'source');
    u32(entity);
    if (world.length !== 16) throw invalid('one finite presentation matrix per joint');
    // No allocation for an equal row; never borrow caller iterators or views.
    const previous =
      this.exclusiveLeaf(slot.id, entity)?.entries.get(entity & 255) ??
      find(this.current, slot.id, entity);
    this.jointScratch.setUint32(0, entity, true);
    let equal = previous !== undefined;
    for (let lane = 0; lane < 16; lane++) {
      const value = world[lane];
      if (value === undefined || !Number.isFinite(value))
        throw invalid('finite presentation joint matrices');
      this.jointScratch.setFloat32((lane + 1) * 4, value, true);
      const captured = this.jointScratch.getFloat32((lane + 1) * 4, true);
      if (!Number.isFinite(captured))
        throw invalid('representable finite presentation joint matrices');
      if (
        previous !== undefined &&
        this.jointScratch.getUint32((lane + 1) * 4, true) !==
          this.inputs.readWord(previous.address + lane + 1)
      )
        equal = false;
    }
    if (equal) return;
    const row = this.allocate(17, 'joint', slot);
    this.publish(slot.id, entity, row, this.jointScratch);
  }

  removeJoint(source: SkinInputSlot, entity: number): void {
    this.healthy();
    const slot = this.slot(source, 'source');
    u32(entity);
    if (find(this.current, slot.id, entity) !== undefined) this.replace(slot.id, entity, undefined);
  }

  updateSkeleton(
    skeleton: SkinInputSlot,
    count: number,
    inverseBinds: Float32Array,
    capsules?: ShadowCapsuleSet,
  ): void {
    this.healthy();
    const slot = this.slot(skeleton, 'skeleton');
    if (!Number.isSafeInteger(count) || count <= 0 || inverseBinds.length !== count * 16)
      throw invalid('one complete inverse bind per declared Skeleton joint');
    const capsuleJoints = capsules?.joints;
    const capsuleShapes = capsules?.shapes;
    const capsuleCount = capsuleJoints?.length;
    if (
      capsules !== undefined &&
      (!(capsuleJoints instanceof Uint16Array) ||
        !(capsuleShapes instanceof Float32Array) ||
        capsuleCount === undefined ||
        capsuleCount > MAX_SHADOW_CAPSULES_PER_SKELETON ||
        capsuleShapes.length !== capsuleCount * SHADOW_CAPSULE_STRIDE)
    )
      throw invalid('complete bounded Skeleton shadow capsules');
    const capsuleBase = 1 + count * 16;
    const words = capsuleBase + 1 + (capsuleCount ?? 0) * 8;
    const previous = find(this.current, SKELETONS, slot.id);
    let equal =
      previous !== undefined &&
      previous.words === words &&
      this.inputs.readWord(previous.address) === count &&
      this.inputs.readWord(previous.address + capsuleBase) === (capsuleCount ?? ABSENT);
    for (let lane = 0; lane < count * 16; lane++) {
      const value = inverseBinds[lane];
      if (value === undefined || !Number.isFinite(value))
        throw invalid('finite shared inverse binds');
      this.jointScratch.setFloat32(0, value, true);
      if (!Number.isFinite(this.jointScratch.getFloat32(0, true)))
        throw invalid('representable finite inverse binds');
      if (
        equal &&
        previous !== undefined &&
        this.jointScratch.getUint32(0, true) !== this.inputs.readWord(previous.address + 1 + lane)
      )
        equal = false;
    }
    if (capsuleJoints !== undefined && capsuleShapes !== undefined) {
      for (let index = 0; index < capsuleJoints.length; index++) {
        const joint = capsuleJoints[index] as number;
        if (!Number.isInteger(joint) || joint < 0 || joint >= count)
          throw invalid('Skeleton capsule joint positions inside the declared Skeleton');
        const base = capsuleBase + 1 + index * 8;
        if (
          equal &&
          previous !== undefined &&
          this.inputs.readWord(previous.address + base) !== joint
        )
          equal = false;
        for (let lane = 0; lane < SHADOW_CAPSULE_STRIDE; lane++) {
          const value = capsuleShapes[index * SHADOW_CAPSULE_STRIDE + lane] as number;
          this.jointScratch.setFloat32(0, value, true);
          if (
            !Number.isFinite(value) ||
            !Number.isFinite(this.jointScratch.getFloat32(0, true)) ||
            (lane === 6 && !(this.jointScratch.getFloat32(0, true) > 0))
          )
            throw invalid('finite representable Skeleton capsules with positive radii');
          if (
            equal &&
            previous !== undefined &&
            this.jointScratch.getUint32(0, true) !==
              this.inputs.readWord(previous.address + base + 1 + lane)
          )
            equal = false;
        }
      }
    }
    if (equal) return;
    const row = this.allocate(words, 'skeleton', slot);
    let data: DataView;
    try {
      data = new DataView(new ArrayBuffer(row.words * 4));
      data.setUint32(0, count, true);
      for (let lane = 0; lane < count * 16; lane++) {
        const value = inverseBinds[lane];
        if (value === undefined || !Number.isFinite(value))
          throw invalid('finite shared inverse binds');
        data.setFloat32((lane + 1) * 4, value, true);
        if (!Number.isFinite(data.getFloat32((lane + 1) * 4, true)))
          throw invalid('representable finite inverse binds');
      }
      data.setUint32(capsuleBase * 4, capsuleCount ?? ABSENT, true);
      if (capsuleJoints !== undefined && capsuleShapes !== undefined) {
        if (
          capsuleJoints.length !== capsuleCount ||
          capsuleShapes.length !== capsuleCount * SHADOW_CAPSULE_STRIDE
        )
          throw invalid('complete captured Skeleton capsule arrays');
        for (let index = 0; index < capsuleJoints.length; index++) {
          const base = capsuleBase + 1 + index * 8;
          const joint = capsuleJoints[index] as number;
          if (!Number.isInteger(joint) || joint < 0 || joint >= count)
            throw invalid('captured Skeleton capsule joint positions inside the declared Skeleton');
          data.setUint32(base * 4, joint, true);
          for (let lane = 0; lane < SHADOW_CAPSULE_STRIDE; lane++) {
            const offset = (base + 1 + lane) * 4;
            data.setFloat32(
              offset,
              capsuleShapes[index * SHADOW_CAPSULE_STRIDE + lane] as number,
              true,
            );
            const captured = data.getFloat32(offset, true);
            if (!Number.isFinite(captured) || (lane === 6 && !(captured > 0)))
              throw invalid('captured finite Skeleton capsules with positive radii');
          }
        }
      }
    } catch (cause) {
      try {
        retireRow(this.inputs, this.state, row);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Skeleton capture rollback failed', { cause });
      }
      throw cause;
    }
    this.publish(SKELETONS, slot.id, row, data);
  }

  bind(
    bindingSlot: number,
    source: SkinInputSlot,
    skeleton: SkinInputSlot,
    joints: ArrayLike<number>,
  ): void {
    this.healthy();
    u32(bindingSlot);
    const namespace = this.slot(source, 'source');
    const asset = this.slot(skeleton, 'skeleton');
    // Static membership survives a temporarily incompatible Skeleton version.
    // Whole-pose demand, not Binding admission, checks the current joint count.
    const count = joints.length;
    u32(count);
    if (count === 0 || count > 0xffffffff - 3)
      throw invalid('a nonempty bounded ordered Skin binding');
    const previous = find(this.current, BINDINGS, bindingSlot);
    let equal =
      previous !== undefined &&
      this.inputs.readWord(previous.address) === count &&
      this.inputs.readWord(previous.address + 1) === namespace.id &&
      this.inputs.readWord(previous.address + 2) === asset.id;
    for (let index = 0; index < count; index++) {
      const entity = joints[index];
      if (entity === undefined) throw invalid('complete ordered joint identities');
      u32(entity);
      if (
        equal &&
        previous !== undefined &&
        this.inputs.readWord(previous.address + 3 + index) !== entity
      )
        equal = false;
    }
    if (joints.length !== count) throw invalid('stable ordered Skin binding extent');
    if (equal) return;
    const row = this.allocate(3 + count, 'binding', namespace, asset);
    let data: DataView;
    try {
      data = new DataView(new ArrayBuffer(row.words * 4));
      data.setUint32(0, count, true);
      data.setUint32(4, namespace.id, true);
      data.setUint32(8, asset.id, true);
      for (let index = 0; index < count; index++) {
        const entity = joints[index];
        if (entity === undefined) throw invalid('complete ordered joint identities');
        u32(entity);
        data.setUint32((3 + index) * 4, entity, true);
      }
      if (joints.length !== count) throw invalid('stable ordered Skin binding extent');
    } catch (cause) {
      try {
        retireRow(this.inputs, this.state, row);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Skin binding capture rollback failed', {
          cause,
        });
      }
      throw cause;
    }
    this.publish(BINDINGS, bindingSlot, row, data);
  }

  unbind(bindingSlot: number): void {
    this.healthy();
    u32(bindingSlot);
    if (find(this.current, BINDINGS, bindingSlot) !== undefined)
      this.replace(BINDINGS, bindingSlot, undefined);
  }

  remove(value: SkinInputSlot): void {
    this.healthy();
    const slot = this.slot(value, value.kind);
    if (slot.kind === 'source') this.replace(slot.id, undefined, undefined);
    else if (find(this.current, SKELETONS, slot.id) !== undefined)
      this.replace(SKELETONS, slot.id, undefined);
    slot.retire();
  }

  /** The leaf for (space, key) when every page on its path has one holder. */
  private exclusiveLeaf(space: number, key: number): LeafPage | undefined {
    const root = this.current;
    if (root === undefined || root.holders !== 1) return undefined;
    const high = key >>> 8;
    const memo = this.leaf;
    if (memo !== undefined && memo.root === root && memo.space === space && memo.high === high)
      return memo.page;
    let page: Page | undefined = root;
    while (page !== undefined && page.holders === 1 && page.shift !== 0)
      page = page.entries.get(keyByte(space, key, page.shift));
    if (page?.shift !== 0 || page.holders !== 1) return undefined;
    this.leaf = { root, space, high, page };
    return page;
  }

  private replace(space: number, key: number | undefined, row: Row | undefined): void {
    if (row !== undefined && key !== undefined) {
      const page = this.exclusiveLeaf(space, key);
      if (page !== undefined) {
        const at = key & 255;
        const previous = page.entries.get(at);
        if (previous !== undefined) {
          try {
            page.entries.set(at, row);
            this.inputs.writeDescriptorWord(page.address, PAGE_WORDS, at, row.address);
          } catch (cause) {
            try {
              page.entries.set(at, previous);
              this.inputs.writeDescriptorWord(page.address, PAGE_WORDS, at, previous.address);
            } catch (cleanup) {
              this.state.failed = true;
              throw new AggregateError([cause, cleanup], 'Exclusive Skin row rollback failed', {
                cause,
              });
            }
            throw cause;
          }
          row.holders++;
          const delta =
            (row.kind === 'binding' ? row.words - 3 : 0) -
            (previous.kind === 'binding' ? previous.words - 3 : 0);
          if (delta !== 0) {
            let ancestor = this.current;
            while (ancestor !== undefined) {
              ancestor.jointCount += delta;
              if (ancestor.shift === 0) break;
              ancestor = ancestor.entries.get(keyByte(space, key, ancestor.shift));
            }
          }
          retireRow(this.inputs, this.state, previous);
          return;
        }
      }
    }
    const next = this.copy(this.current, space, key, row, 56);
    const previous = this.current;
    this.current = next;
    retirePage(this.inputs, this.state, previous);
  }

  private copy(
    previous: Page | undefined,
    space: number,
    key: number | undefined,
    row: Row | undefined,
    shift: Shift,
  ): Page | undefined {
    const at = keyByte(space, key, shift);
    let page: Page;
    if (shift === 0) {
      if (previous !== undefined && previous.shift !== 0) throw invalid('a terminal Skin page');
      const entries = new Map(previous?.entries);
      if (row === undefined) entries.delete(at);
      else entries.set(at, row);
      if (entries.size === 0) return undefined;
      let jointCount = 0;
      for (const retained of entries.values()) {
        retained.holders++;
        if (retained.kind === 'binding') jointCount += retained.words - 3;
      }
      page = { shift, entries, address: 0, holders: 1, jointCount };
    } else {
      if (previous?.shift === 0) throw invalid('a branch Skin page');
      const entries = new Map(previous?.entries);
      let child: Page | undefined;
      try {
        child =
          shift === 32 && key === undefined
            ? undefined
            : this.copy(entries.get(at), space, key, row, (shift - 8) as Shift);
        if (child === undefined) entries.delete(at);
        else entries.set(at, child);
      } catch (cause) {
        try {
          retirePage(this.inputs, this.state, child);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Skin path rollback failed', { cause });
        }
        throw cause;
      }
      if (entries.size === 0) return undefined;
      let jointCount = 0;
      for (const [index, retained] of entries) {
        if (index !== at) retained.holders++;
        jointCount += retained.jointCount;
      }
      page = { shift, entries, address: 0, holders: 1, jointCount };
    }
    let address: number | undefined;
    try {
      address = this.inputs.allocateDescriptor(PAGE_WORDS);
      this.pageWords.fill(ABSENT);
      for (const [index, entry] of page.entries) this.pageWords[index] = entry.address;
      this.inputs.writeDescriptor(address, this.pageView, PAGE_WORDS);
      return { ...page, address };
    } catch (cause) {
      const failures = [cause];
      try {
        if (address !== undefined) releaseRange(this.inputs, this.state, address, PAGE_WORDS);
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        retireEntries(this.inputs, this.state, page);
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length > 1)
        throw new AggregateError(failures, 'Skin page rollback failed', { cause });
      throw cause;
    }
  }

  capture(): SkinInputFrame {
    this.healthy();
    return retainFrame(this.inputs, this.state, this.current);
  }

  dispose(): void {
    if (this.state.disposed) return;
    this.state.disposed = true;
    const previous = this.current;
    this.current = undefined;
    this.leaf = undefined;
    retirePage(this.inputs, this.state, previous);
  }
}

/** One reference increment on the exact fixed root; never samples the latest Scene. */
function retainFrame(inputs: GpuInputArena, state: State, page: Page | undefined): SkinInputFrame {
  if (state.frames >= 128) throw invalid('fewer than 128 retained Skin frames');
  if (page !== undefined) page.holders++;
  try {
    const frame = new SkinInputFrame(inputs, state, page);
    state.frames++;
    return frame;
  } catch (cause) {
    try {
      retirePage(inputs, state, page);
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Skin frame rollback failed', { cause });
    }
    throw cause;
  }
}

/** No per-binding pin table: the captured owning root protects every GPU-readable row. */
export class SkinInputFrame {
  readonly root: number;
  /** Conservative task capacity, derived only on known Binding edits. */
  readonly jointCapacity: number;
  #page: Page | undefined;
  #inputs: GpuInputArena | undefined;
  #state: State | undefined;
  constructor(inputs: GpuInputArena, state: State, page: Page | undefined) {
    this.root = page?.address ?? ABSENT;
    this.jointCapacity = page?.jointCount ?? 0;
    this.#inputs = inputs;
    this.#state = state;
    this.#page = page;
    Object.freeze(this);
  }
  private live(): GpuInputArena {
    const inputs = this.#inputs;
    if (this.#state === undefined || inputs === undefined)
      throw invalid('a retained fixed Skin frame');
    inputs.assertLive();
    return inputs;
  }
  readJoint(source: SkinInputSlot, entity: number, out: Float32Array): boolean {
    const inputs = this.live();
    u32(entity);
    if (
      !(source instanceof Slot) ||
      !source.belongsTo(this.#state as State) ||
      source.kind !== 'source' ||
      out.length !== 16
    )
      throw invalid('a source namespace and one complete joint output matrix');
    const row = find(this.#page, source.id, entity);
    if (row?.kind !== 'joint') return false;
    inputs.readFloatWords(row.address + 1, out);
    return true;
  }
  jointCount(slot: number): number | undefined {
    const inputs = this.live();
    u32(slot);
    const row = find(this.#page, BINDINGS, slot);
    return row?.kind === 'binding' ? inputs.readWord(row.address) : undefined;
  }
  available(slot: number): boolean {
    const inputs = this.live();
    u32(slot);
    const binding = find(this.#page, BINDINGS, slot);
    if (binding?.kind !== 'binding') return false;
    const count = inputs.readWord(binding.address);
    const skeleton = find(this.#page, SKELETONS, inputs.readWord(binding.address + 2));
    if (skeleton?.kind !== 'skeleton' || inputs.readWord(skeleton.address) !== count) return false;
    const namespace = inputs.readWord(binding.address + 1);
    for (let index = 0; index < count; index++) {
      const entity = inputs.readWord(binding.address + 3 + index);
      const joint = find(this.#page, namespace, entity);
      if (joint?.kind !== 'joint' || inputs.readWord(joint.address) !== entity) return false;
    }
    return true;
  }
  matrix(slot: number, index: number, out: Mat4, inverse: Mat4): boolean {
    const inputs = this.live();
    u32(slot);
    if (!Number.isInteger(index) || index < 0) throw invalid('a complete Skin joint position');
    validateMatrixOutputs(out, inverse);
    const binding = find(this.#page, BINDINGS, slot);
    if (binding?.kind !== 'binding') return false;
    const count = inputs.readWord(binding.address);
    const skeleton = find(this.#page, SKELETONS, inputs.readWord(binding.address + 2));
    if (
      index >= count ||
      skeleton?.kind !== 'skeleton' ||
      inputs.readWord(skeleton.address) !== count
    )
      return false;
    const entity = inputs.readWord(binding.address + 3 + index);
    const joint = find(this.#page, inputs.readWord(binding.address + 1), entity);
    if (joint?.kind !== 'joint' || inputs.readWord(joint.address) !== entity) return false;
    inputs.readFloatWords(joint.address + 1, out);
    inputs.readFloatWords(skeleton.address + 1 + index * 16, inverse);
    mat4.multiply(out, out, inverse);
    for (let lane = 0; lane < 16; lane++)
      if (!Number.isFinite(out[lane])) throw invalid('finite composed Skin matrices');
    return true;
  }
  /** Actual CPU visibility/shadow demand from shared Mesh envelopes. A false
   * result leaves the output untouched and grants no culling permission.
   * Work follows used joints, never vertices, World entities or Skin consumers.
   */
  bounds(
    slot: number,
    envelopes: Float32Array | undefined,
    displacementRadius: number,
    out: Float32Array,
    matrix: Mat4,
    inverse: Mat4,
  ): boolean {
    const inputs = this.live();
    u32(slot);
    if (
      envelopes === undefined ||
      !Number.isFinite(displacementRadius) ||
      !Number.isFinite(Math.fround(displacementRadius)) ||
      displacementRadius < 0
    )
      return false;
    if (out.length < 6) throw invalid('six caller-owned Skin bound coordinates');
    validateMatrixOutputs(matrix, inverse);
    disjoint(out, matrix);
    disjoint(out, inverse);
    disjoint(out, envelopes);
    disjoint(matrix, envelopes);
    disjoint(inverse, envelopes);
    const count = this.jointCount(slot);
    const minimumSum = envelopes[0] as number,
      maximumSum = envelopes[1] as number,
      required = envelopes[2] as number,
      used = envelopes[3] as number;
    if (
      count === undefined ||
      !this.available(slot) ||
      !Number.isFinite(minimumSum) ||
      minimumSum < 2 ** -126 ||
      !Number.isFinite(maximumSum) ||
      maximumSum < minimumSum ||
      !Number.isInteger(required) ||
      required < 1 ||
      required > count ||
      !Number.isInteger(used) ||
      used < 1 ||
      envelopes.length !== 4 + used * 8
    )
      return false;
    const binding = find(this.#page, BINDINGS, slot) as Row;
    const skeleton = find(this.#page, SKELETONS, inputs.readWord(binding.address + 2)) as Row;
    const namespace = inputs.readWord(binding.address + 1);
    const radius = Math.max(displacementRadius, Math.fround(displacementRadius));
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity,
      magnitude = 1,
      localMagnitude = 1;
    for (let index = 0; index < used; index++) {
      const base = 4 + index * 8,
        jointIndex = envelopes[base + 3] as number;
      if (!Number.isInteger(jointIndex) || jointIndex < 0 || jointIndex >= count) return false;
      const joint = find(
        this.#page,
        namespace,
        inputs.readWord(binding.address + 3 + jointIndex),
      ) as Row;
      inputs.readFloatWords(joint.address + 1, matrix);
      inputs.readFloatWords(skeleton.address + 1 + jointIndex * 16, inverse);
      // Requiring both source matrices affine avoids accepting a projective
      // cancellation that only rounds to an affine matrix on one processor.
      if (
        matrix[3] !== 0 ||
        matrix[7] !== 0 ||
        matrix[11] !== 0 ||
        matrix[15] !== 1 ||
        inverse[3] !== 0 ||
        inverse[7] !== 0 ||
        inverse[11] !== 0 ||
        inverse[15] !== 1
      )
        return false;
      let localSum = 1;
      for (let axis = 0; axis < 3; axis++)
        localSum += Math.max(
          Math.abs((envelopes[base + axis] as number) - radius),
          Math.abs((envelopes[base + 4 + axis] as number) + radius),
        );
      localMagnitude = Math.max(localMagnitude, localSum);
      for (let axis = 0; axis < 3; axis++) {
        let low = 0,
          high = 0,
          absolute = 0,
          compositionError = 0;
        for (let column = 0; column < 4; column++) {
          let coefficient = 0,
            products = 0;
          for (let lane = 0; lane < 4; lane++) {
            const left = matrix[lane * 4 + axis] as number,
              right = inverse[column * 4 + lane] as number;
            // Flushing a source operand can be amplified by the other operand;
            // the arithmetic-underflow allowance below cannot bound that case.
            if (
              (left !== 0 && Math.abs(left) < 2 ** -126) ||
              (right !== 0 && Math.abs(right) < 2 ** -126)
            )
              return false;
            const product = left * right;
            coefficient += product;
            products += Math.abs(product);
          }
          // A GPU partial dot product may overflow even when CPU cancellation
          // leaves a finite result. Such input grants no culling permission.
          if (products > 3.4028234663852886e38 / (1 + 64 * 2 ** -23)) return false;
          coefficient = Math.fround(coefficient);
          // Budget all multiply/add roundoff plus legal f32 subnormal flushing,
          // based on source products rather than a possibly cancelled result.
          const error = products === 0 ? 0 : 64 * 2 ** -23 * products + 64 * 2 ** -126;
          // Vertex blends matrices before multiplying position. A zero vertex
          // cannot make an overflowing weighted coefficient a valid cull proof.
          if (
            (Math.abs(coefficient) + error) * Math.max(1, maximumSum) >
            3.4028234663852886e38 / (1 + 64 * 2 ** -23)
          )
            return false;
          if (column === 3) {
            low += coefficient;
            high += coefficient;
            absolute += Math.abs(coefficient);
            compositionError += error;
          } else {
            const a = envelopes[base + column] as number,
              b = envelopes[base + 4 + column] as number;
            if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return false;
            let from = a - radius,
              to = b + radius;
            if (Math.abs(from) > 3.4028234663852886e38 || Math.abs(to) > 3.4028234663852886e38)
              return false;
            // Vertex fetch/local arithmetic may legally flush subnormals to 0.
            if (from > 0 && from < 2 ** -126) from = 0;
            if (to < 0 && to > -(2 ** -126)) to = 0;
            const first = coefficient * from,
              second = coefficient * to;
            low += Math.min(first, second);
            high += Math.max(first, second);
            absolute += Math.max(Math.abs(first), Math.abs(second));
            compositionError += error * Math.max(Math.abs(from), Math.abs(to));
          }
        }
        low -= compositionError;
        high += compositionError;
        magnitude = Math.max(magnitude, absolute + compositionError);
        if (axis === 0) {
          minX = Math.min(minX, low);
          maxX = Math.max(maxX, high);
        } else if (axis === 1) {
          minY = Math.min(minY, low);
          maxY = Math.max(maxY, high);
        } else {
          minZ = Math.min(minZ, low);
          maxZ = Math.max(maxZ, high);
        }
      }
    }
    // Match the GPU proof's roundoff allowance and positive-weight interval.
    // Blend performs four palette*weight products before multiplying position.
    // FTZ of those intermediate coefficients has an absolute, not relative,
    // error. Cover both xyz/W1 and homogeneous xyz/sum(weight) consumers.
    const blendUnderflow =
      Math.max(64 * 2 ** -126, (256 * 2 ** -126) / minimumSum) * localMagnitude;
    const padding = 64 * 2 ** -23 * magnitude * Math.max(1, maximumSum) + blendUnderflow;
    const lowX = Math.fround(
        Math.min(minX, minX * minimumSum, minX * maximumSum, maxX * minimumSum, maxX * maximumSum) -
          padding,
      ),
      lowY = Math.fround(
        Math.min(minY, minY * minimumSum, minY * maximumSum, maxY * minimumSum, maxY * maximumSum) -
          padding,
      ),
      lowZ = Math.fround(
        Math.min(minZ, minZ * minimumSum, minZ * maximumSum, maxZ * minimumSum, maxZ * maximumSum) -
          padding,
      ),
      highX = Math.fround(
        Math.max(maxX, minX * minimumSum, minX * maximumSum, maxX * minimumSum, maxX * maximumSum) +
          padding,
      ),
      highY = Math.fround(
        Math.max(maxY, minY * minimumSum, minY * maximumSum, maxY * minimumSum, maxY * maximumSum) +
          padding,
      ),
      highZ = Math.fround(
        Math.max(maxZ, minZ * minimumSum, minZ * maximumSum, maxZ * minimumSum, maxZ * maximumSum) +
          padding,
      );
    if (
      !Number.isFinite(lowX) ||
      !Number.isFinite(lowY) ||
      !Number.isFinite(lowZ) ||
      !Number.isFinite(highX) ||
      !Number.isFinite(highY) ||
      !Number.isFinite(highZ)
    )
      return false;
    out[0] = lowX;
    out[1] = lowY;
    out[2] = lowZ;
    out[3] = highX;
    out[4] = highY;
    out[5] = highZ;
    return true;
  }

  /** Static capsule membership belongs to the same fixed Skeleton row as its inverse binds. */
  capsuleCount(slot: number): number | undefined {
    const inputs = this.live();
    u32(slot);
    const binding = find(this.#page, BINDINGS, slot);
    if (binding?.kind !== 'binding') return undefined;
    const skeleton = find(this.#page, SKELETONS, inputs.readWord(binding.address + 2));
    const count = inputs.readWord(binding.address);
    if (skeleton?.kind !== 'skeleton' || inputs.readWord(skeleton.address) !== count)
      return undefined;
    const base = 1 + count * 16;
    const capsules = inputs.readWord(skeleton.address + base);
    return capsules === ABSENT ? undefined : capsules;
  }

  /** Actual CPU shadow demand only. False, including a composed-matrix overflow, invalidates the caller's whole task output. */
  capsules(slot: number, out: Float32Array, matrix: Mat4, inverse: Mat4): boolean {
    const inputs = this.live();
    const count = this.capsuleCount(slot);
    if (count === undefined || !this.available(slot)) return false;
    if (out.length < count * 8) throw invalid('enough caller-owned world-capsule output');
    validateMatrixOutputs(matrix, inverse);
    disjoint(out, matrix);
    disjoint(out, inverse);
    const binding = find(this.#page, BINDINGS, slot) as Row;
    const skeleton = find(this.#page, SKELETONS, inputs.readWord(binding.address + 2)) as Row;
    const capsuleBase = skeleton.address + 2 + inputs.readWord(binding.address) * 16;
    for (let index = 0; index < count; index++) {
      const base = capsuleBase + index * 8;
      try {
        this.matrix(slot, inputs.readWord(base), matrix, inverse);
      } catch (cause) {
        if (!composedOverflow(cause)) throw cause;
        return false;
      }
      for (let endpoint = 0; endpoint < 2; endpoint++) {
        // Read scalars from the arena without borrowing its replaceable backing store.
        const x = inputs.readFloatWord(base + 1 + endpoint * 3);
        const y = inputs.readFloatWord(base + 2 + endpoint * 3);
        const z = inputs.readFloatWord(base + 3 + endpoint * 3);
        const target = index * 8 + endpoint * 4;
        for (let lane = 0; lane < 3; lane++)
          out[target + lane] =
            (matrix[lane] as number) * x +
            (matrix[4 + lane] as number) * y +
            (matrix[8 + lane] as number) * z +
            (matrix[12 + lane] as number);
      }
      out[index * 8 + 3] =
        (inputs.readFloatWord(base + 7) *
          (Math.hypot(matrix[0] as number, matrix[1] as number, matrix[2] as number) +
            Math.hypot(matrix[4] as number, matrix[5] as number, matrix[6] as number) +
            Math.hypot(matrix[8] as number, matrix[9] as number, matrix[10] as number))) /
        3;
      out[index * 8 + 7] = 0;
      for (let lane = 0; lane < 8; lane++)
        if (!Number.isFinite(out[index * 8 + lane]))
          throw invalid('finite world-space Skin capsules');
    }
    return true;
  }

  /** Compose into task-owned storage. False leaves output untouched; a numerical throw invalidates the whole output, including any written prefix. */
  palette(slot: number, out: Float32Array, matrix: Mat4, inverse: Mat4): boolean {
    const inputs = this.live();
    const count = this.jointCount(slot);
    if (count === undefined || !this.available(slot)) return false;
    if (out.length < count * 16) throw invalid('enough caller-owned Skin palette output');
    validateMatrixOutputs(matrix, inverse);
    disjoint(out, matrix);
    disjoint(out, inverse);
    // The complete-pose check precedes all output writes, including joints not used by this mesh.
    const binding = find(this.#page, BINDINGS, slot) as Row;
    const skeleton = find(this.#page, SKELETONS, inputs.readWord(binding.address + 2)) as Row;
    const namespace = inputs.readWord(binding.address + 1);
    for (let index = 0; index < count; index++) {
      const joint = find(
        this.#page,
        namespace,
        inputs.readWord(binding.address + 3 + index),
      ) as Row;
      inputs.readFloatWords(joint.address + 1, matrix);
      inputs.readFloatWords(skeleton.address + 1 + index * 16, inverse);
      mat4.multiply(matrix, matrix, inverse);
      for (let lane = 0; lane < 16; lane++) {
        const value = matrix[lane] as number;
        if (!Number.isFinite(value)) throw invalid('finite composed Skin matrices');
        out[index * 16 + lane] = value;
      }
    }
    return true;
  }
  /** Actual Direct/uniform demand. Flags match GPU task descriptors: 0 absent,
   * 1 current with seeded history, 3 current with compatible previous pose.
   * Caller-owned outputs and scratch are reused; no per-draw views or palettes
   * are retained. Any current numerical failure invalidates the whole task.
   */
  palettes(
    slot: number,
    previous: SkinInputFrame | undefined,
    currentOut: Float32Array,
    previousOut: Float32Array,
    matrix: Mat4,
    inverse: Mat4,
  ): 0 | 1 | 3 {
    const count = this.jointCount(slot);
    if (count === undefined || !this.available(slot)) return 0;
    if (currentOut.length < count * 16 || previousOut.length < count * 16)
      throw invalid('enough caller-owned current and previous Skin palette output');
    validateMatrixOutputs(matrix, inverse);
    disjoint(currentOut, previousOut);
    disjoint(currentOut, matrix);
    disjoint(currentOut, inverse);
    disjoint(previousOut, matrix);
    disjoint(previousOut, inverse);
    const compatible = previous !== undefined && this.historyCompatible(previous, slot);
    // Finite source matrices can still overflow when composed. Like GPU
    // resolution, an overflowing current pose omits only this draw and an
    // overflowing previous pose seeds all history; lifecycle/admission errors
    // remain terminal rather than being mistaken for an unavailable pose.
    try {
      this.palette(slot, currentOut, matrix, inverse);
    } catch (cause) {
      if (!composedOverflow(cause)) throw cause;
      return 0;
    }
    if (compatible) {
      try {
        if (previous.palette(slot, previousOut, matrix, inverse)) return 3;
      } catch (cause) {
        if (!composedOverflow(cause)) throw cause;
      }
    }
    for (let lane = 0; lane < count * 16; lane++) previousOut[lane] = currentOut[lane] as number;
    return 1;
  }

  historyCompatible(previous: SkinInputFrame, slot: number): boolean {
    const inputs = this.live();
    previous.live();
    u32(slot);
    if (this.#state !== previous.#state || !this.available(slot) || !previous.available(slot))
      return false;
    const binding = find(this.#page, BINDINGS, slot);
    const prior = find(previous.#page, BINDINGS, slot);
    if (binding === undefined || binding !== prior) return false;
    const skeletonSlot = inputs.readWord(binding.address + 2);
    return (
      find(this.#page, SKELETONS, skeletonSlot) === find(previous.#page, SKELETONS, skeletonSlot)
    );
  }
  /** Transfer a submitted frame's input lifetime to history/completion without per-Binding pins. */
  retain(): SkinInputFrame {
    const inputs = this.live();
    return retainFrame(inputs, this.#state as State, this.#page);
  }
  release(): void {
    const state = this.#state;
    if (state === undefined) return;
    const inputs = this.#inputs as GpuInputArena,
      page = this.#page;
    this.#inputs = undefined;
    this.#state = undefined;
    this.#page = undefined;
    state.frames--;
    retirePage(inputs, state, page);
  }
}
