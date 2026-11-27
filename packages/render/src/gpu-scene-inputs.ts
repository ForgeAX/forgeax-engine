import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import {
  BatchSources,
  MEMBER_PAGE,
  MemberCandidates,
  type MemberPage,
} from './gpu-driven/batch-members';
import type {
  GpuDrivenBatch,
  GpuDrivenCandidate,
  SubmissionPlan,
} from './gpu-driven/batch-topology';
import { hasFixedTaskHeaders } from './gpu-driven/fixed-task-plan';
import {
  encodeTaskHeader,
  GPU_TASK_HEADER_WORDS,
  GPU_TASK_MEMBER_WORD,
} from './gpu-driven/task-header';
import {
  GpuInputArena,
  type GpuInputDescriptorReservation,
  type GpuInputPreparation,
  type GpuInputPreparationStatus,
  type GpuInputUpload,
  gpuInputByteLimit,
} from './gpu-input-arena';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from './gpu-usage';
import type { FrameList } from './scene/frame-list';
import type { Node } from './scene/frame-tree';
import { StableRangeAllocator } from './stable-range-allocator';

/**
 * binding3 addresses are u32 word offsets; zero is the null child. A member
 * node mirrors one member page: [left, right, leftWeight, weight, records,
 * recordCount, 0, 0]. Its records are a separate descriptor shared by every
 * node incarnation of the same page.
 */
export const GPU_MEMBER_WORDS = 8;
/** One record per member: [laneStart, physical, generation, sourceSlot, ordinalBase]. */
export const GPU_MEMBER_RECORD_WORDS = 5;
const RECORD_PAGE = 64;
export const GPU_MATERIAL_DESCRIPTOR = Object.freeze({
  words: 3,
  payload: 0,
  radius: 1,
  positionBounds: 2,
});
export const GPU_MESH_DESCRIPTOR = Object.freeze({
  words: 8,
  flags: 0,
  min: 1,
  max: 4,
  skinEnvelopes: 7,
});

const NODE_ADDRESS = 0;
const NODE_WORDS = 1;
const NODE_LEFT = 2;
const NODE_RIGHT = 3;
const NODE_MEMBERS = 4;
const NODE_HOLDERS = 5;
const NODE_GENERATION = 6;
const NODE_KIND = 7;
const NODE_WIDTH = 8;
/** A memo value names one node incarnation: handle plus its generation. */
const NODE_HANDLE_SPAN = 2 ** 24;

/**
 * Numeric encodings and their lifetimes as pooled columns: handle 0 is the
 * null node. No object per encoded member; memos retain handle+generation.
 */
class InputNodes {
  private columns = new Uint32Array(64 * NODE_WIDTH);
  private readonly free: number[] = [];
  private next = 1;

  create(
    address: number,
    words: number,
    left: number,
    right: number,
    members = 0,
    header = false,
  ): number {
    let handle = this.free.pop();
    if (handle === undefined) {
      handle = this.next++;
      if (handle >= NODE_HANDLE_SPAN) throw invalid('fewer than 2^24 live GPU input nodes');
      if ((handle + 1) * NODE_WIDTH > this.columns.length) {
        const grown = new Uint32Array(this.columns.length * 2);
        grown.set(this.columns);
        this.columns = grown;
      }
    }
    const base = handle * NODE_WIDTH;
    const columns = this.columns;
    columns[base + NODE_ADDRESS] = address;
    columns[base + NODE_WORDS] = words;
    columns[base + NODE_LEFT] = left;
    columns[base + NODE_RIGHT] = right;
    columns[base + NODE_MEMBERS] = members;
    columns[base + NODE_HOLDERS] = 1;
    columns[base + NODE_GENERATION] = ((columns[base + NODE_GENERATION] as number) + 1) >>> 0;
    columns[base + NODE_KIND] = header ? 1 : 0;
    return handle;
  }

  field(handle: number, field: number): number {
    return this.columns[handle * NODE_WIDTH + field] as number;
  }

  setField(handle: number, field: number, value: number): void {
    this.columns[handle * NODE_WIDTH + field] = value;
  }

  /** Memo key of a live node incarnation. */
  memo(handle: number): number {
    return this.field(handle, NODE_GENERATION) * NODE_HANDLE_SPAN + handle;
  }

  /** The live handle a memo names, or 0 when that incarnation was retired. */
  resolve(memo: number | undefined): number {
    if (memo === undefined) return 0;
    const handle = memo % NODE_HANDLE_SPAN;
    return handle < this.next &&
      this.field(handle, NODE_GENERATION) === (memo - handle) / NODE_HANDLE_SPAN &&
      this.field(handle, NODE_HOLDERS) > 0
      ? handle
      : 0;
  }

  retire(handle: number): void {
    this.setField(handle, NODE_HOLDERS, 0);
    this.free.push(handle);
  }
}

/** A radix page holds numeric descriptors, never the resources they name. */
class ResourcePage {
  holders = 1;
  constructor(
    readonly address: number,
    readonly children: Map<number, ResourcePage>,
    public occupied: number,
    public prepared?: {
      readonly descriptor: GpuInputDescriptorReservation;
      readonly pages: PrivateResourcePages;
    },
  ) {}
}
type PrivateResourcePages = Map<GpuInputDescriptorReservation, ResourcePage | undefined>;
const RESOURCE_PAGE_WORDS = 256;
const ABSENT_RESOURCE = 0xffffffff;

interface GpuInputBuffer {
  readonly buffer: Buffer;
  readonly byteLength: number;
  readonly resourceRoot: number;
}

/** A task-owned logical address; no active resource tree or revision has changed. */
export interface GpuSceneResourceReservation {
  readonly logicalSlot: number;
  readonly descriptor: number;
  isCurrent(): boolean;
  release(): void;
}

/** Native buffer custody and numeric bytes only; consumers qualify their own bindings. */
export interface GpuSceneInputPreparation extends GpuInputPreparation {
  readonly buffer: Buffer;
  readonly byteLength: number;
  readonly resourceRoot: number;
  readonly privatePageBytes: number;
  superseded(): boolean;
  retirement(): Result<{ readonly done: boolean; readonly pending?: Promise<void> }, RhiError>;
}

interface PreparingInputBuffer {
  api: GpuSceneInputPreparation | undefined;
  readonly upload: GpuInputUpload;
  readonly parentUpload: GpuInputUpload;
  readonly parentBuffer: Buffer | undefined;
  bytes: number;
  resourceRoot: number;
  resources?: PrivateResources;
  buffer: Buffer | undefined;
  originalBuffer: Buffer | undefined;
  numeric: GpuInputPreparation | undefined;
  state: 'preparing' | 'committed' | 'released';
  busy: boolean;
  accounted: boolean;
}

interface PrivateResources {
  root: ResourcePage | undefined;
  readonly revision: number;
  reservations: readonly GpuSceneResourceReservation[];
  readonly pages: PrivateResourcePages;
  current: (() => boolean) | undefined;
  retirement?: Generator<void>;
  failure?: { readonly cause: unknown };
}

interface RetiringInputBuffer {
  phase: 'waiting' | 'fencing' | 'safe' | 'destroying' | 'fence-failed' | 'destroy-failed';
  scheduled: boolean;
  pending?: Promise<void>;
  cause?: unknown;
}

export interface GpuInputReadFrame {
  isCurrent(): boolean;
  /** A still-held physical buffer and, when supplied, its captured mapping root. */
  holdsBuffer(buffer: Buffer, resourceRoot?: number): boolean;
  resource(slot: number): number | undefined;
  members(candidates: FrameList<GpuDrivenCandidate>): number;
  header(input: GpuTaskHeaderInput): GpuTaskHeader;
  reuseHeader(header: GpuTaskHeader, batch: GpuDrivenBatch): boolean;
  buffer(): Result<GpuInputBuffer, RhiError>;
  seal(): Result<void, RhiError>;
  release(): void;
}

/** The address is observable; ownership requires this exact issuer-created object. */
export interface GpuTaskHeader {
  readonly address: number;
  readonly candidateCount: number;
}
export interface GpuTaskHeaderInput {
  readonly plan: SubmissionPlan;
  readonly index: number;
  readonly batch: GpuDrivenBatch;
  readonly candidates: FrameList<GpuDrivenCandidate>;
  readonly materialAddress: number;
  readonly geometryAddress: number;
  readonly previous?: GpuTaskHeader | undefined;
}
interface HeaderMemo {
  readonly memo: number;
  readonly value: GpuTaskHeader;
  readonly materialAddress: number;
  readonly geometryAddress: number;
  readonly candidates: FrameList<GpuDrivenCandidate>;
}

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'prepare a current canonical member root with checked u32 addresses and weights',
  });
}
function u32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw invalid('shared GPU input values fit u32');
  return value;
}

/** One Scene-owned encoding of the existing source/member roots, shared by views. */
export class GpuSceneInputs {
  private readonly resourceSlots = new StableRangeAllocator();
  private resources: ResourcePage | undefined;
  private resourceRevision = 0;
  private readonly privateResources = new WeakMap<
    GpuSceneResourceReservation,
    { readonly descriptor: GpuInputDescriptorReservation; consume(): void }
  >();
  resourcePagesWritten = 0;
  resourcePagesReleased = 0;
  private readonly nodes = new InputNodes();
  private readonly memberMemo = new WeakMap<Node<MemberPage>, number>();
  private readonly pageMemo = new WeakMap<MemberPage, number>();
  private readonly sourceMemo = new WeakMap<Node<GpuDrivenBatch>, number>();
  private readonly headerMemo = new WeakMap<GpuDrivenBatch, HeaderMemo>();
  private readonly headerRecords = new WeakMap<
    GpuTaskHeader,
    {
      readonly memo: number;
      readonly batch: GpuDrivenBatch;
      readonly candidates: FrameList<GpuDrivenCandidate>;
    }
  >();
  private source: Node<GpuDrivenBatch> | undefined;
  /** Encoded source root handle; 0 is none. */
  private current = 0;
  private upload: GpuInputUpload;
  private previousUploadBytes = 0;
  private preparingBuffer: PreparingInputBuffer | undefined;
  private readonly ownsArena: boolean;
  readonly arena: GpuInputArena;
  private buffer: Buffer | undefined;
  private bufferBytes = 0;
  private readonly bufferHolders = new Map<Buffer, number>();
  private readonly retiredBuffers = new Map<Buffer, RetiringInputBuffer>();
  private nativeInputWrites = 0;
  private readonly readFrames = new WeakMap<
    GpuInputReadFrame,
    Pick<GpuInputReadFrame, 'isCurrent' | 'holdsBuffer'>
  >();
  private disposed = false;
  private failure: AggregateError | undefined;
  /** Unknown numeric effects are retained until explicit owner reconstruction. */
  private readonly unconfirmed: {
    readonly root: number;
    readonly address: number | undefined;
    readonly cause: unknown;
    readonly page?: ResourcePage;
  }[] = [];
  memberNodesWritten = 0;
  memberNodesReleased = 0;
  taskHeadersWritten = 0;
  taskHeadersReleased = 0;
  get uploadBytes(): number {
    return (
      this.previousUploadBytes +
      this.upload.uploadBytes +
      (this.preparingBuffer?.upload.uploadBytes ?? 0)
    );
  }

  /** Parent retirement observes late native failures without replaying child disposal. */
  get lifetimeFailure(): AggregateError | undefined {
    return this.failure;
  }

  constructor(
    private readonly device: RhiDevice,
    private readonly primitiveIndex: (slot: number) => number | undefined,
    arena?: GpuInputArena,
  ) {
    this.ownsArena = arena === undefined;
    this.arena = arena ?? new GpuInputArena(gpuInputByteLimit(device));
    this.upload = this.arena.connect();
    if (this.ownsArena) this.upload.activate();
    this.resourceSlots.reset(1);
  }

  adoptSources(sources: BatchSources): void {
    this.assertLive();
    if (!BatchSources.isFixed(sources)) throw invalid('an owned fixed source publication');
    if (this.disposed) throw invalid('a live GPU input owner');
    if (sources.root === this.source) return;
    const next = this.encodeSource(sources.root);
    const previous = this.current;
    this.current = next;
    this.source = sources.root;
    this.release(previous);
  }

  /**
   * Keep a view-owned member subset encoded between read domains, so its
   * successor re-encodes only changed paths. The returned release is idempotent.
   */
  holdMembers(candidates: MemberCandidates): () => void {
    this.assertLive();
    let held = this.encodeMember(candidates.root);
    return () => {
      const node = held;
      held = 0;
      if (node !== 0) this.release(node);
    };
  }

  /** Exact native input incarnation; a disposed owner cannot qualify a cached lease. */
  isLiveOn(device: RhiDevice): boolean {
    return (
      !this.disposed && this.failure === undefined && this.arena.live && this.device === device
    );
  }

  ownsRead(frame: GpuInputReadFrame): boolean {
    return this.readFrames.has(frame);
  }

  readIsCurrent(frame: GpuInputReadFrame): boolean {
    return this.readFrames.get(frame)?.isCurrent() === true;
  }

  readHoldsBuffer(frame: GpuInputReadFrame, buffer: Buffer, resourceRoot?: number): boolean {
    return this.readFrames.get(frame)?.holdsBuffer(buffer, resourceRoot) === true;
  }

  isCurrentBuffer(buffer: Buffer): boolean {
    return !this.disposed && this.failure === undefined && this.buffer === buffer;
  }

  /** Observe only the actual fully uploaded current buffer; allocate, copy and publish nothing. */
  uploadedBuffer(): { readonly buffer: Buffer; readonly byteLength: number } | undefined {
    const buffer = this.buffer;
    return this.isLiveOn(this.device) &&
      this.preparingBuffer === undefined &&
      buffer !== undefined &&
      this.bufferBytes >= this.arena.byteLength &&
      this.upload.isCurrent(this.device.queue, buffer)
      ? { buffer, byteLength: this.bufferBytes }
      : undefined;
  }

  /** Current logical mapping only; acquires neither a read domain nor a native buffer. */
  resourceIsCurrent(slot: number, descriptor: number): boolean {
    return (
      !this.disposed &&
      this.failure === undefined &&
      this.arena.live &&
      Number.isSafeInteger(slot) &&
      slot >= 0 &&
      slot <= 0xffffffff &&
      Number.isSafeInteger(descriptor) &&
      descriptor >= 0 &&
      descriptor <= 0xffffffff &&
      this.readResource(this.resources, slot) === descriptor
    );
  }

  /** Source/mapping observation only; this grants no read or submission custody. */
  captureGuard(): () => boolean {
    const source = this.currentKey();
    const revision = this.resourceRevision;
    return () =>
      !this.disposed &&
      this.failure === undefined &&
      this.arena.live &&
      source === this.currentKey() &&
      revision === this.resourceRevision;
  }

  private assertLive(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.disposed || !this.arena.live) throw invalid('a live shared GPU input owner');
  }

  private unconfirmedRetirement(
    root: number,
    address: number | undefined,
    cause: unknown,
    page?: ResourcePage,
  ): AggregateError {
    this.unconfirmed.push({ root, address, cause, ...(page === undefined ? {} : { page }) });
    this.failure = new AggregateError(
      this.failure === undefined ? [cause] : [this.failure, cause],
      'GPU input lifetime effect is unconfirmed',
    );
    return this.failure;
  }

  /** Independent resident custody; a copied address or retired incarnation cannot acquire it. */
  holdHeader(header: GpuTaskHeader, batch: GpuDrivenBatch): () => void {
    this.assertLive();
    const node = this.headerNode(header, batch);
    if (node === 0)
      throw invalid('a current task header issued by these Inputs for this exact batch');
    let held = this.retain(node);
    return () => {
      const root = held;
      held = 0;
      if (root !== 0) this.release(root);
    };
  }

  private headerNode(header: GpuTaskHeader, batch: GpuDrivenBatch): number {
    const record = this.headerRecords.get(header);
    return record?.batch === batch ? this.nodes.resolve(record.memo) : 0;
  }

  private retainReadRoot(root: number, roots: Set<number>): void {
    if (roots.has(root)) return;
    this.retain(root);
    try {
      roots.add(root);
    } catch (cause) {
      this.release(root);
      throw cause;
    }
  }

  private encodeHeader(
    batch: GpuDrivenBatch,
    candidates: FrameList<GpuDrivenCandidate>,
    materialAddress: number,
    geometryAddress: number,
    previous?: GpuTaskHeader,
  ): HeaderMemo {
    const words = encodeTaskHeader(batch, u32(materialAddress), u32(geometryAddress));
    const candidateCount = u32(candidates.length);
    const record = previous === undefined ? undefined : this.headerRecords.get(previous);
    const known = record === undefined ? 0 : this.nodes.resolve(record.memo);
    if (
      previous !== undefined &&
      record?.candidates === candidates &&
      known !== 0 &&
      MemberCandidates.is(candidates)
    ) {
      words[GPU_TASK_MEMBER_WORD] = this.arena.readWord(previous.address + GPU_TASK_MEMBER_WORD);
      if (
        candidateCount === previous.candidateCount &&
        words.every((word, index) => word === this.arena.readWord(previous.address + index))
      ) {
        this.retain(known);
        return this.headerValue(
          known,
          batch,
          candidates,
          candidateCount,
          materialAddress,
          geometryAddress,
        );
      }
    }
    const members = MemberCandidates.is(candidates)
      ? this.encodeMember(candidates.root)
      : this.encodeRaw(candidates, candidateCount);
    let address: number | undefined;
    let node = 0;
    try {
      words[GPU_TASK_MEMBER_WORD] = this.address(members);
      address = this.arena.allocateDescriptor(GPU_TASK_HEADER_WORDS);
      this.arena.writeDescriptor(address, new DataView(words.buffer), GPU_TASK_HEADER_WORDS);
      node = this.nodes.create(address, GPU_TASK_HEADER_WORDS, 0, 0, members, true);
      this.taskHeadersWritten++;
      return this.headerValue(
        node,
        batch,
        candidates,
        candidateCount,
        materialAddress,
        geometryAddress,
      );
    } catch (cause) {
      const failures: unknown[] = [cause];
      const attempt = (action: () => void) => {
        try {
          action();
        } catch (failure) {
          failures.push(failure);
        }
      };
      if (node !== 0) attempt(() => this.release(node));
      else {
        if (address !== undefined) {
          const allocated = address;
          attempt(() => this.arena.releaseDescriptor(allocated, GPU_TASK_HEADER_WORDS));
        }
        attempt(() => this.release(members));
      }
      if (failures.length > 1)
        throw this.unconfirmedRetirement(
          node,
          address,
          new AggregateError(failures, 'Task header allocation rollback failed'),
        );
      throw cause;
    }
  }

  private headerValue(
    node: number,
    batch: GpuDrivenBatch,
    candidates: FrameList<GpuDrivenCandidate>,
    candidateCount: number,
    materialAddress: number,
    geometryAddress: number,
  ): HeaderMemo {
    const value = Object.freeze({ address: this.address(node), candidateCount });
    const memo = this.nodes.memo(node);
    this.headerRecords.set(value, { memo, batch, candidates });
    return { memo, value, materialAddress, geometryAddress, candidates };
  }

  private readHeader(input: GpuTaskHeaderInput, roots: Set<number>): GpuTaskHeader {
    const { plan, index, batch, candidates, materialAddress, geometryAddress } = input;
    if (!Number.isSafeInteger(index) || index < 0) throw invalid('a current task index');
    const fixed = hasFixedTaskHeaders(plan);
    if (fixed && (plan.batches.at(index) !== batch || batch.candidates !== candidates))
      throw invalid('the exact task and member root of an owned fixed plan');
    const observed = this.headerMemo.get(batch);
    let cached = fixed ? observed : undefined;
    let root = cached === undefined ? 0 : this.nodes.resolve(cached.memo);
    if (
      cached === undefined ||
      root === 0 ||
      cached.materialAddress !== materialAddress ||
      cached.geometryAddress !== geometryAddress ||
      cached.candidates !== candidates
    ) {
      cached = this.encodeHeader(
        batch,
        candidates,
        materialAddress,
        geometryAddress,
        observed?.value ?? input.previous,
      );
      root = this.nodes.resolve(cached.memo);
      if (roots.has(root)) this.release(root);
      else
        try {
          roots.add(root);
        } catch (cause) {
          roots.delete(root);
          this.release(root);
          throw cause;
        }
      this.headerMemo.set(batch, cached);
    } else if (!roots.has(root)) {
      this.retainReadRoot(root, roots);
    }
    return cached.value;
  }

  allocateResource(descriptor: number): number {
    this.assertLive();
    const slot = this.resourceSlots.allocate(1);
    try {
      this.updateResource(slot, descriptor);
    } catch (cause) {
      this.resourceSlots.release(slot, 1);
      throw cause;
    }
    return slot;
  }

  reserveResource(
    descriptor: GpuInputDescriptorReservation,
    capture?: (reservation: GpuSceneResourceReservation) => void,
  ): GpuSceneResourceReservation {
    this.assertLive();
    if (!this.arena.ownsDescriptorReservation(descriptor))
      throw invalid('a private descriptor from this Inputs arena');
    const range = this.resourceSlots.reserve(1);
    let scope: { owner: GpuSceneInputs; descriptor: GpuInputDescriptorReservation } | undefined = {
      owner: this,
      descriptor,
    };
    let complete = false;
    let failure: { cause: unknown } | undefined;
    const api: GpuSceneResourceReservation = Object.freeze({
      logicalSlot: range.start,
      descriptor: descriptor.address,
      isCurrent: () =>
        complete &&
        failure === undefined &&
        scope !== undefined &&
        !scope.owner.disposed &&
        scope.owner.failure === undefined &&
        range.isCurrent() &&
        scope.owner.arena.ownsDescriptorReservation(scope.descriptor),
      release: () => {
        if (failure !== undefined) throw failure.cause;
        const held = scope;
        if (held === undefined) return;
        scope = undefined;
        try {
          range.release();
          held.owner.privateResources.delete(api);
        } catch (cause) {
          scope = held;
          held.owner.failure ??= new AggregateError(
            [cause],
            'Private resource address retirement remains unconfirmed',
            { cause },
          );
          failure = { cause };
          throw cause;
        }
      },
    });
    this.privateResources.set(api, {
      descriptor,
      consume: () => {
        if (scope?.owner !== this || !range.isCurrent())
          throw invalid('the original logical address before owner transfer');
        range.accept();
        scope = undefined;
        this.privateResources.delete(api);
      },
    });
    try {
      capture?.(api);
      u32(range.start);
      this.assertLive();
      if (scope === undefined || !this.arena.ownsDescriptorReservation(descriptor))
        throw invalid('the original private logical resource reservation');
      complete = true;
      return api;
    } catch (cause) {
      try {
        api.release();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          'Private logical resource capture and rollback failed',
          { cause },
        );
      }
      throw cause;
    }
  }

  updateResource(slot: number, descriptor: number): void {
    this.assertLive();
    u32(slot);
    u32(descriptor);
    if (descriptor === ABSENT_RESOURCE)
      throw invalid('a representable physical resource descriptor');
    this.publishResource(slot, descriptor);
    this.resourceRevision++;
  }

  releaseResource(slot: number): void {
    if (this.disposed) return;
    this.publishResource(u32(slot), ABSENT_RESOURCE);
    this.resourceRevision++;
    this.resourceSlots.release(slot, 1);
  }

  private publishResource(slot: number, descriptor: number): void {
    let leaf = this.resources;
    let exclusive = true;
    for (let shift = 24; leaf !== undefined && shift > 0; shift -= 8) {
      exclusive &&= leaf.holders === 1 && leaf.prepared === undefined;
      leaf = leaf.children.get((slot >>> shift) & 255);
    }
    if (leaf !== undefined) {
      const key = slot & 255;
      const previous = this.resourceWord(leaf, key);
      if (previous === descriptor) return;
      // Readers retain the root. Sibling roots may still share a deeper page,
      // so a live edit needs exclusive ownership along the entire path.
      if (
        exclusive &&
        leaf.holders === 1 &&
        leaf.prepared === undefined &&
        (descriptor !== ABSENT_RESOURCE || leaf.occupied > 1)
      ) {
        this.arena.writeDescriptorWord(leaf.address, RESOURCE_PAGE_WORDS, key, descriptor);
        if (previous === ABSENT_RESOURCE) leaf.occupied++;
        else if (descriptor === ABSENT_RESOURCE) leaf.occupied--;
        return;
      }
    } else if (descriptor === ABSENT_RESOURCE) return;
    const next = this.copyResourcePath(this.resources, slot, descriptor, 24);
    const previous = this.resources;
    this.resources = next;
    this.releasePage(previous);
  }

  private readResource(root: ResourcePage | undefined, slot: number): number | undefined {
    let page = root;
    for (let shift = 24; shift > 0; shift -= 8) page = page?.children.get((slot >>> shift) & 255);
    if (page === undefined) return undefined;
    const descriptor = this.arena.readWord(page.address + (slot & 255));
    return descriptor === ABSENT_RESOURCE ? undefined : descriptor;
  }

  private resourceWord(page: ResourcePage, index: number): number {
    return page.prepared === undefined
      ? this.arena.readWord(page.address + index)
      : page.prepared.descriptor.readWord(index);
  }

  private copyResourcePath(
    previous: ResourcePage | undefined,
    slot: number,
    descriptor: number,
    shift: number,
    pages?: PrivateResourcePages,
  ): ResourcePage | undefined {
    const children = new Map<number, ResourcePage>();
    try {
      if (previous !== undefined) {
        for (const [key, child] of previous.children) {
          children.set(key, child);
          child.holders++;
        }
      }
      const key = (slot >>> shift) & 255;
      if (shift > 0) {
        const child = this.copyResourcePath(
          previous?.children.get(key),
          slot,
          descriptor,
          shift - 8,
          pages,
        );
        const old = children.get(key);
        try {
          if (child === undefined) children.delete(key);
          else children.set(key, child);
        } catch (cause) {
          this.releasePage(child);
          throw cause;
        }
        this.releasePage(old);
      }
      let occupied = children.size;
      if (shift === 0) {
        const old = previous === undefined ? ABSENT_RESOURCE : this.resourceWord(previous, key);
        occupied =
          (previous?.occupied ?? 0) +
          Number(descriptor !== ABSENT_RESOURCE) -
          Number(old !== ABSENT_RESOURCE);
      }
      if (occupied === 0) return undefined;
      return this.writeResourcePage(
        previous,
        children,
        occupied,
        key,
        shift === 0 ? descriptor : (children.get(key)?.address ?? ABSENT_RESOURCE),
        pages,
      );
    } catch (cause) {
      this.rollbackResourceChildren(children, cause);
    }
  }

  private rollbackResourceChildren(children: Map<number, ResourcePage>, cause: unknown): never {
    const failures: unknown[] = [cause];
    for (const child of children.values())
      try {
        this.releasePage(child);
      } catch (cleanup) {
        failures.push(this.unconfirmedRetirement(0, child.address, cleanup, child));
      }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Resource path capture and rollback failed', { cause });
    throw cause;
  }

  private writeResourcePage(
    previous: ResourcePage | undefined,
    children: Map<number, ResourcePage>,
    occupied: number,
    key: number,
    value: number,
    pages: PrivateResourcePages | undefined,
  ): ResourcePage {
    if (pages !== undefined) {
      const descriptor = this.arena.reserveDescriptor(
        RESOURCE_PAGE_WORDS,
        (_address, target) => {
          for (let index = 0; index < RESOURCE_PAGE_WORDS; index++)
            target.setUint32(
              index * 4,
              previous === undefined ? ABSENT_RESOURCE : this.resourceWord(previous, index),
              true,
            );
          target.setUint32(key * 4, value, true);
        },
        (captured) => pages.set(captured, undefined),
      );
      this.resourcePagesWritten++;
      const page = new ResourcePage(descriptor.address, children, occupied, { descriptor, pages });
      pages.set(descriptor, page);
      return page;
    }
    const address = this.arena.allocateDescriptor(RESOURCE_PAGE_WORDS);
    try {
      if (previous === undefined)
        this.arena.fillDescriptor(address, RESOURCE_PAGE_WORDS, ABSENT_RESOURCE);
      else this.arena.copyDescriptor(address, previous.address, RESOURCE_PAGE_WORDS);
      this.arena.writeDescriptorWord(address, RESOURCE_PAGE_WORDS, key, value);
      this.resourcePagesWritten++;
      return new ResourcePage(address, children, occupied);
    } catch (cause) {
      try {
        this.arena.releaseDescriptor(address, RESOURCE_PAGE_WORDS);
      } catch (cleanup) {
        throw new AggregateError(
          [cause, this.unconfirmedRetirement(0, address, cleanup)],
          'Resource page capture and rollback failed',
          { cause },
        );
      }
      throw cause;
    }
  }

  private *releasePages(root: ResourcePage | undefined): Generator<void> {
    const pending = root === undefined ? [] : [root];
    let failure: AggregateError | undefined;
    while (pending.length > 0) {
      const page = pending.pop();
      if (page === undefined || --page.holders !== 0) continue;
      try {
        for (const child of page.children.values()) pending.push(child);
        page.children.clear();
        if (page.prepared === undefined)
          this.arena.releaseDescriptor(page.address, RESOURCE_PAGE_WORDS);
        else {
          page.prepared.descriptor.release();
          page.prepared.pages.delete(page.prepared.descriptor);
        }
        this.resourcePagesReleased++;
      } catch (cause) {
        failure = this.unconfirmedRetirement(0, page.address, cause, page);
      }
      yield;
    }
    if (failure !== undefined) throw failure;
  }

  private releasePage(page: ResourcePage | undefined): void {
    for (const _ of this.releasePages(page)) {
      /* ordinary synchronous owner */
    }
  }

  private get byteLimit(): number {
    return gpuInputByteLimit(this.device);
  }

  private retain(node: number): number {
    if (node !== 0) {
      const holders = this.nodes.field(node, NODE_HOLDERS);
      if (holders <= 0) throw invalid('a live shared GPU encoding');
      this.nodes.setField(node, NODE_HOLDERS, holders + 1);
    }
    return node;
  }

  private release(root: number): void {
    if (root === 0) return;
    const nodes = this.nodes;
    const rootHolders = nodes.field(root, NODE_HOLDERS);
    if (rootHolders > 1) {
      nodes.setField(root, NODE_HOLDERS, rootHolders - 1);
      return;
    }
    const pending = [root];
    let failure: AggregateError | undefined;
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) break;
      const holders = nodes.field(node, NODE_HOLDERS);
      if (holders <= 0) throw invalid('balanced GPU input leases');
      if (holders !== 1) {
        nodes.setField(node, NODE_HOLDERS, holders - 1);
        continue;
      }
      const left = nodes.field(node, NODE_LEFT);
      const right = nodes.field(node, NODE_RIGHT);
      const members = nodes.field(node, NODE_MEMBERS);
      if (left !== 0) pending.push(left);
      if (right !== 0) pending.push(right);
      if (members !== 0) pending.push(members);
      const words = nodes.field(node, NODE_WORDS);
      const address = nodes.field(node, NODE_ADDRESS);
      const header = nodes.field(node, NODE_KIND) === 1;
      nodes.retire(node);
      if (words !== 0) {
        try {
          this.arena.releaseDescriptor(address, words);
          if (header) this.taskHeadersReleased++;
          else this.memberNodesReleased++;
        } catch (cause) {
          if (failure === undefined)
            failure = new AggregateError([cause], 'Member retirement failed', { cause });
          else failure.errors.push(cause);
        }
      }
    }
    if (failure !== undefined) throw this.unconfirmedRetirement(root, undefined, failure);
  }

  /** The current source encoding's incarnation; 0 when none. */
  private currentKey(): number {
    return this.current === 0 ? 0 : this.nodes.memo(this.current);
  }

  private address(node: number): number {
    return node === 0 ? 0 : this.nodes.field(node, NODE_ADDRESS);
  }

  private encodeSource(source: Node<GpuDrivenBatch> | undefined): number {
    if (source === undefined) return 0;
    const old = this.nodes.resolve(this.sourceMemo.get(source));
    if (old !== 0) return this.retain(old);
    let left = 0,
      right = 0,
      members = 0;
    let node = 0;
    try {
      left = this.encodeSource(source.left);
      right = this.encodeSource(source.right);
      const candidates = source.value.candidates;
      if (!MemberCandidates.is(candidates)) throw invalid('canonical source membership');
      members = this.encodeMember(candidates.root);
      // Source branches own physical children but have no unread GPU record.
      node = this.nodes.create(0, 0, left, right, members);
      this.sourceMemo.set(source, this.nodes.memo(node));
      return node;
    } catch (cause) {
      if (node !== 0) this.release(node);
      else {
        this.release(left);
        this.release(right);
        this.release(members);
      }
      throw cause;
    }
  }

  private encodeMember(source: Node<MemberPage> | undefined): number {
    if (source === undefined) return 0;
    const old = this.nodes.resolve(this.memberMemo.get(source));
    if (old !== 0) return this.retain(old);
    let left = 0,
      right = 0,
      records = 0,
      node = 0;
    try {
      left = this.encodeMember(source.left);
      right = this.encodeMember(source.right);
      records = this.encodePage(source.value);
      u32(source.count);
      node = this.writeNode(
        left,
        right,
        source.left?.count ?? 0,
        source.weight,
        records,
        source.value.length / MEMBER_PAGE.stride,
      );
      this.memberMemo.set(source, this.nodes.memo(node));
      return node;
    } catch (cause) {
      if (node !== 0) this.release(node);
      else {
        this.release(left);
        this.release(right);
        this.release(records);
      }
      throw cause;
    }
  }

  /** One records descriptor per member page; unchanged pages keep theirs. */
  private encodePage(page: MemberPage): number {
    const old = this.nodes.resolve(this.pageMemo.get(page));
    if (old !== 0) return this.retain(old);
    const { stride, slot, generation, count } = MEMBER_PAGE;
    const members = page.length / stride;
    const words = members * GPU_MEMBER_RECORD_WORDS;
    const address = this.arena.allocateDescriptor(words);
    try {
      let start = 0;
      for (let member = 0; member < members; member++) {
        const base = member * stride;
        const sourceSlot = page[base + slot] as number;
        const physical = this.primitiveIndex(sourceSlot);
        if (physical === undefined) throw invalid('an admitted live primitive for each member');
        const record = member * GPU_MEMBER_RECORD_WORDS;
        this.arena.writeDescriptorWord(address, words, record, u32(start));
        this.arena.writeDescriptorWord(address, words, record + 1, u32(physical));
        this.arena.writeDescriptorWord(
          address,
          words,
          record + 2,
          u32(page[base + generation] as number),
        );
        this.arena.writeDescriptorWord(address, words, record + 3, u32(sourceSlot));
        start += page[base + count] as number;
      }
      this.memberNodesWritten++;
      const node = this.nodes.create(address, words, 0, 0);
      this.pageMemo.set(page, this.nodes.memo(node));
      return node;
    } catch (cause) {
      this.arena.releaseDescriptor(address, words);
      throw cause;
    }
  }

  /** A node owns its children and records; on failure the caller still holds them. */
  private writeNode(
    left: number,
    right: number,
    leftWeight: number,
    weight: number,
    records: number,
    recordCount: number,
  ): number {
    const address = this.arena.allocateDescriptor(GPU_MEMBER_WORDS);
    try {
      const values = [
        this.address(left),
        this.address(right),
        leftWeight,
        weight,
        this.address(records),
        recordCount,
      ];
      for (let index = 0; index < values.length; index++)
        this.arena.writeDescriptorWord(
          address,
          GPU_MEMBER_WORDS,
          index,
          u32(values[index] as number),
        );
      this.memberNodesWritten++;
      return this.nodes.create(address, GPU_MEMBER_WORDS, left, right, records);
    } catch (cause) {
      this.arena.releaseDescriptor(address, GPU_MEMBER_WORDS);
      throw cause;
    }
  }

  /** Raw lists encode in the canonical page format: one record per candidate. */
  private encodeRaw(
    candidates: FrameList<GpuDrivenCandidate>,
    count = u32(candidates.length),
  ): number {
    if (count * GPU_MEMBER_RECORD_WORDS * 4 > this.byteLimit)
      throw invalid('raw candidate input fits device limits');
    const values = new Uint32Array(count * GPU_MEMBER_RECORD_WORDS);
    let index = 0;
    const read = (candidate: GpuDrivenCandidate | undefined) => {
      if (candidate === undefined || index >= count) throw invalid('the declared candidate extent');
      const offset = index * GPU_MEMBER_RECORD_WORDS;
      // Preserve ordinary raw property-read order and separate source-slot read.
      const physical = this.primitiveIndex(candidate.primitiveIndex);
      if (physical === undefined) throw invalid('an admitted live raw primitive');
      values[offset] = index % RECORD_PAGE;
      values[offset + 1] = u32(physical);
      values[offset + 2] = u32(candidate.generation);
      values[offset + 4] = u32(candidate.instanceOrdinal);
      values[offset + 3] = u32(candidate.primitiveIndex);
      index++;
    };
    if (Array.isArray(candidates)) {
      for (let i = 0; i < count; i++) read(candidates[i]);
    } else {
      for (const candidate of candidates) read(candidate);
    }
    if (index !== count) throw invalid('a complete candidate stream');
    const writePage = (page: number): number => {
      const first = page * RECORD_PAGE;
      const records = Math.min(RECORD_PAGE, count - first);
      const words = records * GPU_MEMBER_RECORD_WORDS;
      const address = this.arena.allocateDescriptor(words);
      try {
        for (let word = 0; word < words; word++)
          this.arena.writeDescriptorWord(
            address,
            words,
            word,
            values[first * GPU_MEMBER_RECORD_WORDS + word] as number,
          );
        this.memberNodesWritten++;
        return this.nodes.create(address, words, 0, 0);
      } catch (cause) {
        this.arena.releaseDescriptor(address, words);
        throw cause;
      }
    };
    const build = (start: number, end: number): number => {
      if (start === end) return 0;
      const middle = start + Math.floor((end - start) / 2);
      let left = 0,
        right = 0,
        records = 0;
      try {
        left = build(start, middle);
        right = build(middle + 1, end);
        records = writePage(middle);
        const first = middle * RECORD_PAGE;
        const weight = Math.min(RECORD_PAGE, count - first);
        return this.writeNode(left, right, (middle - start) * RECORD_PAGE, weight, records, weight);
      } catch (cause) {
        this.release(left);
        this.release(right);
        this.release(records);
        throw cause;
      }
    };
    return build(0, Math.ceil(count / RECORD_PAGE));
  }

  private retireBuffer(buffer: Buffer): void {
    let retirement = this.retiredBuffers.get(buffer);
    if (retirement === undefined) {
      retirement = { phase: 'waiting', scheduled: false };
      this.retiredBuffers.set(buffer, retirement);
    }
    if (this.bufferHolders.has(buffer)) return;
    if (this.nativeInputWrites > 0) {
      this.scheduleBufferRetirement(buffer, retirement);
      return;
    }
    if (retirement.phase === 'safe') {
      this.destroyRetiredBuffer(buffer, retirement);
      return;
    }
    if (retirement.phase !== 'waiting') return;
    // Existing read custody covers submitted work. Preserve synchronous owner
    // disposal for an unheld target, after any enclosing write has returned.
    if (this.disposed) {
      this.destroyRetiredBuffer(buffer, retirement);
      return;
    }
    retirement.phase = 'fencing';
    try {
      retirement.pending = this.device.queue.onSubmittedWorkDone().then(
        () => {
          retirement.phase = 'safe';
          if (!this.bufferHolders.has(buffer)) this.destroyRetiredBuffer(buffer, retirement);
        },
        (cause: unknown) => this.failBufferRetirement(retirement, 'fence-failed', cause),
      );
    } catch (cause) {
      this.failBufferRetirement(retirement, 'fence-failed', cause);
    }
  }

  private failBufferRetirement(
    retirement: RetiringInputBuffer,
    phase: 'fence-failed' | 'destroy-failed',
    cause: unknown,
  ): void {
    retirement.phase = phase;
    retirement.cause = cause;
    this.unconfirmedRetirement(0, undefined, cause);
  }

  private destroyRetiredBuffer(buffer: Buffer, retirement: RetiringInputBuffer): void {
    // Mark first: an unknown destroy effect must never be retried after reentrancy.
    retirement.phase = 'destroying';
    try {
      const result = this.device.destroyBuffer(buffer);
      if (result.ok) this.retiredBuffers.delete(buffer);
      else this.failBufferRetirement(retirement, 'destroy-failed', result.error);
    } catch (cause) {
      this.failBufferRetirement(retirement, 'destroy-failed', cause);
    }
  }

  private beginBufferPreparation(
    bytes: number,
    resources?: PrivateResources,
  ): PreparingInputBuffer {
    this.assertLive();
    if (this.preparingBuffer !== undefined) throw invalid('one private Inputs preparation');
    const role: PreparingInputBuffer = {
      api: undefined,
      upload: this.arena.connect(),
      parentUpload: this.upload,
      parentBuffer: this.buffer,
      bytes,
      resourceRoot: this.resources?.address ?? ABSENT_RESOURCE,
      ...(resources === undefined ? {} : { resources }),
      buffer: undefined,
      originalBuffer: undefined,
      numeric: undefined,
      state: 'preparing',
      busy: true,
      accounted: false,
    };
    this.preparingBuffer = role;
    role.api = this.bufferPreparationApi(role);
    return role;
  }

  /** Prepare another physical target without replacing this owner's logical mapping or reads. */
  prepareBuffer(
    capacityBytes = this.arena.byteLength,
    capture?: (preparation: GpuSceneInputPreparation) => void,
  ): Result<GpuSceneInputPreparation, RhiError> {
    this.assertLive();
    if (
      this.preparingBuffer !== undefined ||
      !Number.isSafeInteger(capacityBytes) ||
      capacityBytes % 4 !== 0 ||
      capacityBytes < this.arena.byteLength ||
      capacityBytes > this.byteLimit
    )
      return err(invalid('one private input buffer with aligned capacity within device limits'));
    const role = this.beginBufferPreparation(capacityBytes);
    try {
      if (role.api === undefined) throw invalid('a captured Inputs preparation');
      capture?.(role.api);
      return this.createPreparedBuffer(role);
    } finally {
      role.busy = false;
      if (role.numeric === undefined || role.state === 'released') this.releasePreparedBuffer(role);
    }
  }

  /** Same resource tree and upload owner, with a private successor for exact cold mappings. */
  *prepareResourceBuffer(
    reservations: readonly GpuSceneResourceReservation[],
    current: () => boolean,
    capture: (preparation: GpuSceneInputPreparation) => void,
  ): Generator<void, GpuSceneInputPreparation> {
    const resources: PrivateResources = {
      root: undefined,
      revision: this.resourceRevision,
      reservations: [...new Set(reservations)],
      pages: new Map(),
      current,
    };
    const role = this.beginBufferPreparation(this.arena.byteLength, resources);
    try {
      if (role.api === undefined) throw invalid('a captured private resource preparation');
      capture(role.api);
      if (!this.bufferPreparationLive(role))
        throw invalid('the original private resource constructor');
      resources.root = this.resources;
      if (resources.root !== undefined) resources.root.holders++;
      for (const reservation of resources.reservations) {
        if (!this.bufferPreparationLive(role))
          throw invalid('current Source resource reservations');
        const descriptor = this.privateResources.get(reservation)?.descriptor;
        if (
          descriptor === undefined ||
          !reservation.isCurrent() ||
          !this.arena.ownsDescriptorReservation(descriptor)
        )
          throw invalid('exact resource reservations issued by these Inputs');
        const previous = resources.root;
        resources.root = this.copyResourcePath(
          previous,
          reservation.logicalSlot,
          reservation.descriptor,
          24,
          resources.pages,
        );
        role.resourceRoot = resources.root?.address ?? ABSENT_RESOURCE;
        this.releasePage(previous);
        role.busy = false;
        yield;
        role.busy = true;
      }
      const descriptors = [...resources.pages.keys()];
      for (const reservation of resources.reservations) {
        const descriptor = this.privateResources.get(reservation)?.descriptor;
        if (descriptor === undefined) throw invalid('retained private descriptor custody');
        descriptors.push(descriptor);
      }
      role.bytes = this.arena.preparationByteLength(descriptors);
      return this.createPreparedBuffer(role, descriptors).unwrap();
    } finally {
      role.busy = false;
      if (role.numeric === undefined || role.state === 'released') this.releasePreparedBuffer(role);
    }
  }

  private createPreparedBuffer(
    role: PreparingInputBuffer,
    descriptors?: readonly GpuInputDescriptorReservation[],
  ): Result<GpuSceneInputPreparation, RhiError> {
    if (!this.bufferPreparationLive(role) || role.api === undefined || role.bytes > this.byteLimit)
      return err(invalid('a live Inputs constructor with capacity within device limits'));
    const created = this.device.createBuffer({
      label: 'gpu-scene-prepared-inputs',
      size: role.bytes,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
      mappedAtCreation: false,
    });
    if (!created.ok) return created;
    role.buffer = created.value;
    role.originalBuffer = created.value;
    if (!this.bufferPreparationLive(role))
      return err(invalid('the original live Inputs owner after buffer creation'));
    const prepared = role.upload.prepare(this.device.queue, created.value, descriptors);
    if (!prepared.ok) return prepared;
    role.numeric = prepared.value;
    return ok(role.api);
  }

  private bufferPreparationLive(role: PreparingInputBuffer): boolean {
    return (
      role.state === 'preparing' &&
      this.preparingBuffer === role &&
      !this.disposed &&
      this.failure === undefined &&
      this.arena.live &&
      this.upload === role.parentUpload &&
      this.buffer === role.parentBuffer &&
      this.privateResourcesLive(role.resources) &&
      role.state === 'preparing' &&
      this.preparingBuffer === role
    );
  }

  private privateResourcesLive(resources: PrivateResources | undefined): boolean {
    if (resources === undefined) return true;
    if (
      resources.failure !== undefined ||
      resources.revision !== this.resourceRevision ||
      resources.current?.() !== true
    )
      return false;
    for (const reservation of resources.reservations)
      if (!this.privateResources.has(reservation) || !reservation.isCurrent()) return false;
    for (const descriptor of resources.pages.keys())
      if (!this.arena.ownsDescriptorReservation(descriptor)) return false;
    return resources.revision === this.resourceRevision;
  }

  private bufferPreparationCurrent(role: PreparingInputBuffer): boolean {
    return this.observePreparedBuffer(role, true);
  }

  private observePreparedBuffer(role: PreparingInputBuffer, requireCopied: boolean): boolean {
    if (role.busy) return false;
    role.busy = true;
    try {
      return this.bufferPreparationDataCurrent(role, requireCopied);
    } finally {
      role.busy = false;
      if (role.state === 'released') this.releasePreparedBuffer(role);
    }
  }

  private bufferPreparationDataCurrent(role: PreparingInputBuffer, requireCopied = true): boolean {
    return (
      this.bufferPreparationLive(role) &&
      this.arena.byteLength <= role.bytes &&
      (requireCopied ? role.numeric?.isCurrent() === true : role.buffer !== undefined)
    );
  }

  /** The actual private issuer's target, also while numeric copying is pending. */
  preparationTarget(
    preparation: GpuSceneInputPreparation,
  ): Pick<GpuSceneInputPreparation, 'buffer' | 'byteLength'> | undefined {
    const role = this.preparingBuffer;
    return role?.api === preparation && this.observePreparedBuffer(role, false)
      ? role.api
      : undefined;
  }

  preparationIsCurrent(preparation: GpuSceneInputPreparation): boolean {
    const role = this.preparingBuffer;
    return role?.api === preparation && this.bufferPreparationCurrent(role);
  }

  private bufferPreparationApi(role: PreparingInputBuffer): GpuSceneInputPreparation {
    const resourceRoot = () =>
      role.resources === undefined
        ? (this.resources?.address ?? ABSENT_RESOURCE)
        : role.resourceRoot;
    const inspect = (): GpuInputPreparationStatus => {
      const current = this.bufferPreparationCurrent(role);
      const numeric = role.numeric?.inspect();
      return {
        phase:
          role.state === 'preparing'
            ? this.failure !== undefined
              ? 'failed'
              : current
                ? 'current'
                : numeric?.phase === 'current'
                  ? 'copying'
                  : (numeric?.phase ?? 'copying')
            : role.state,
        copiedBytes: numeric?.copiedBytes ?? 0,
        extentBytes: numeric?.extentBytes ?? this.arena.byteLength,
        uploadBytes: numeric?.uploadBytes ?? role.upload.uploadBytes,
      };
    };
    return Object.freeze({
      get buffer() {
        if (role.originalBuffer === undefined)
          throw invalid('a constructed private Inputs allocation');
        return role.originalBuffer;
      },
      get byteLength() {
        return role.bytes;
      },
      get resourceRoot() {
        return resourceRoot();
      },
      get privatePageBytes() {
        return (role.resources?.pages.size ?? 0) * RESOURCE_PAGE_WORDS * 4;
      },
      superseded: () => this.supersededSourceBuffer(role),
      retirement: () => {
        try {
          return this.preparationRetirement(role);
        } catch (cause) {
          return err(
            Object.assign(invalid('confirmed private Inputs resource retirement'), { cause }),
          );
        }
      },
      step: (bytes: number) => this.stepPreparedBuffer(role, bytes, inspect),
      inspect,
      isCurrent: () => this.bufferPreparationCurrent(role),
      commitPrepared: () => this.commitPreparedBuffer(role),
      release: () => this.releasePreparedBuffer(role),
    });
  }

  private supersededSourceBuffer(role: PreparingInputBuffer): boolean {
    const resources = role.resources;
    return (
      resources !== undefined &&
      role.state !== 'committed' &&
      !this.disposed &&
      this.failure === undefined &&
      this.arena.live &&
      resources.failure === undefined &&
      resources.current?.() === true &&
      (role.parentBuffer !== this.buffer ||
        role.parentUpload !== this.upload ||
        resources.revision !== this.resourceRevision ||
        this.arena.byteLength > role.bytes)
    );
  }

  private preparationRetirement(
    role: PreparingInputBuffer,
  ): Result<{ readonly done: boolean; readonly pending?: Promise<void> }, RhiError> {
    if (
      role.state === 'committed' ||
      (role.state === 'released' && role.originalBuffer === undefined)
    )
      return ok({ done: this.retirePreparedResources(role) });
    if (role.state !== 'released' || role.originalBuffer === undefined) return ok({ done: false });
    const state = this.retiredBuffers.get(role.originalBuffer);
    if (state === undefined) return ok({ done: this.retirePreparedResources(role) });
    if (state.phase === 'fence-failed' || state.phase === 'destroy-failed')
      return err(
        Object.assign(invalid('confirmed private Inputs retirement'), { cause: state.cause }),
      );
    return ok({ done: false, ...(state.pending === undefined ? {} : { pending: state.pending }) });
  }

  private stepPreparedBuffer(
    role: PreparingInputBuffer,
    bytes: number,
    inspect: () => GpuInputPreparationStatus,
  ): Result<GpuInputPreparationStatus, RhiError> {
    if (role.busy || role.numeric === undefined)
      return err(invalid('an idle current Inputs preparation with sufficient native capacity'));
    role.busy = true;
    try {
      if (!this.bufferPreparationDataCurrent(role, false))
        return err(invalid('an idle current Inputs preparation with sufficient native capacity'));
      const result = role.numeric.step(bytes);
      if (!result.ok) return result;
      if (!this.bufferPreparationLive(role) || this.arena.byteLength > role.bytes)
        return err(invalid('unchanged Inputs ownership and sufficient capacity after writing'));
    } finally {
      role.busy = false;
      if (role.state === 'released') this.releasePreparedBuffer(role);
    }
    return ok(inspect());
  }

  private commitPreparedBuffer(role: PreparingInputBuffer): Result<void, RhiError> {
    const numeric = role.numeric,
      buffer = role.buffer;
    if (role.busy || numeric === undefined || buffer === undefined)
      return err(invalid('the issuing current prepared Inputs buffer'));
    role.busy = true;
    try {
      if (!this.resourcePublicationCurrent(role) || !this.bufferPreparationDataCurrent(role))
        return err(invalid('the issuing current prepared Inputs buffer'));
      return this.transferPreparedBuffer(role, numeric, buffer);
    } finally {
      role.busy = false;
      if (role.state === 'released') this.releasePreparedBuffer(role);
    }
  }

  private transferPreparedBuffer(
    role: PreparingInputBuffer,
    numeric: GpuInputPreparation,
    buffer: Buffer,
  ): Result<void, RhiError> {
    const previous = this.buffer,
      previousRoot = this.resources;
    try {
      const accepted = numeric.commitPrepared();
      if (!accepted.ok) return accepted;
      this.consumePreparedResources(role);
      this.previousUploadBytes += this.upload.uploadBytes;
      this.upload.release();
      this.upload = role.upload;
      this.buffer = buffer;
      this.bufferBytes = role.bytes;
      this.preparingBuffer = undefined;
      role.state = 'committed';
      if (previous !== undefined) this.deferBufferRetirement(previous);
      if (role.resources !== undefined) this.deferResourceRootRetirement(previousRoot);
      return ok(undefined);
    } catch (cause) {
      if (role.resources !== undefined) role.resources.failure = { cause };
      return err(
        Object.assign(invalid('confirmed complete Inputs owner transfer'), {
          cause: this.unconfirmedRetirement(0, previousRoot?.address, cause, previousRoot),
        }),
      );
    }
  }

  private resourcePublicationCurrent(role: PreparingInputBuffer): boolean {
    const resources = role.resources;
    if (resources === undefined) return true;
    if ((resources.root?.address ?? ABSENT_RESOURCE) !== role.resourceRoot) return false;
    for (const reservation of resources.reservations)
      if (!this.privateResources.has(reservation) || !reservation.isCurrent()) return false;
    for (const [descriptor, page] of resources.pages)
      if (page?.prepared?.descriptor !== descriptor || page.prepared.pages !== resources.pages)
        return false;
    return true;
  }

  private consumePreparedResources(role: PreparingInputBuffer): void {
    const resources = role.resources;
    if (resources === undefined) return;
    for (const reservation of resources.reservations) {
      const claim = this.privateResources.get(reservation);
      if (claim === undefined) throw invalid('the original logical address transfer');
      claim.consume();
    }
    for (const page of resources.pages.values()) {
      if (page === undefined) throw invalid('a fully constructed private resource page');
      delete page.prepared;
    }
    if (this.resources !== resources.root) this.resourceRevision++;
    this.resources = resources.root;
    resources.root = undefined;
    resources.pages.clear();
    resources.reservations = [];
    resources.current = undefined;
  }

  private deferResourceRootRetirement(root: ResourcePage | undefined): void {
    if (root === undefined) return;
    queueMicrotask(() => {
      try {
        this.releasePage(root);
      } catch (cause) {
        this.unconfirmedRetirement(0, root.address, cause, root);
      }
    });
  }

  private deferBufferRetirement(buffer: Buffer): void {
    const retirement: RetiringInputBuffer = { phase: 'waiting', scheduled: false };
    this.retiredBuffers.set(buffer, retirement);
    this.scheduleBufferRetirement(buffer, retirement);
  }

  private scheduleBufferRetirement(buffer: Buffer, retirement: RetiringInputBuffer): void {
    if (retirement.scheduled) return;
    retirement.scheduled = true;
    // Publication performs no RHI work. Retirement also progresses without another frame.
    queueMicrotask(() => {
      retirement.scheduled = false;
      if (this.retiredBuffers.get(buffer) === retirement) this.retireBuffer(buffer);
    });
  }

  private releasePreparedBuffer(role: PreparingInputBuffer): void {
    if (role.state === 'committed') return;
    if (role.state !== 'released') {
      role.state = 'released';
      role.numeric?.release();
      role.upload.release();
      if (this.preparingBuffer === role) this.preparingBuffer = undefined;
    }
    if (role.busy) return;
    if (!role.accounted) {
      role.accounted = true;
      this.previousUploadBytes += role.upload.uploadBytes;
    }
    if (role.buffer === undefined) return;
    const buffer = role.buffer;
    role.buffer = undefined;
    this.retireBuffer(buffer);
  }

  /** One page or orphan constructor receipt per grant, after candidate native retirement. */
  private retirePreparedResources(role: PreparingInputBuffer): boolean {
    const resources = role.resources;
    if (resources === undefined) return true;
    if (resources.failure !== undefined) throw resources.failure.cause;
    if (role.busy) return false;
    try {
      if (resources.retirement === undefined) {
        resources.retirement = this.releasePages(resources.root);
        resources.root = undefined;
      }
      if (!resources.retirement.next().done) return false;
      const orphan = resources.pages.keys().next().value;
      if (orphan !== undefined) {
        orphan.release();
        resources.pages.delete(orphan);
        return false;
      }
      resources.reservations = [];
      resources.current = undefined;
      return true;
    } catch (cause) {
      resources.failure = { cause };
      throw this.unconfirmedRetirement(0, undefined, cause);
    }
  }

  private flush(): Result<GpuInputBuffer, RhiError> {
    this.assertLive();
    const byteLength = this.arena.byteLength;
    if (byteLength > this.byteLimit)
      return err(invalid('shared GPU input arena fits device storage limits'));
    const upload = this.upload,
      buffer = this.buffer;
    if (buffer === undefined || this.bufferBytes < byteLength)
      return this.replaceInputBuffer(upload, buffer, byteLength);
    const uploaded = this.writeInputBuffer(upload, buffer, false);
    if (!uploaded.ok) return uploaded;
    if (!this.inputBufferCurrent(upload, buffer) || this.arena.byteLength > this.bufferBytes)
      return err(invalid('unchanged Inputs ownership after native upload'));
    return this.inputBufferResult(buffer);
  }

  private inputBufferCurrent(upload: GpuInputUpload, buffer: Buffer | undefined): boolean {
    return (
      !this.disposed &&
      this.failure === undefined &&
      this.arena.live &&
      this.upload === upload &&
      this.buffer === buffer
    );
  }

  private writeInputBuffer(
    upload: GpuInputUpload,
    buffer: Buffer,
    initial: boolean,
  ): Result<void, RhiError> {
    this.nativeInputWrites++;
    try {
      return upload.flush(this.device.queue, buffer, initial);
    } finally {
      this.nativeInputWrites--;
    }
  }

  private replaceInputBuffer(
    upload: GpuInputUpload,
    previous: Buffer | undefined,
    bytes: number,
  ): Result<GpuInputBuffer, RhiError> {
    if (this.preparingBuffer !== undefined) this.releasePreparedBuffer(this.preparingBuffer);
    if (!this.inputBufferCurrent(upload, previous))
      return err(invalid('live unchanged Inputs after cancelling the old preparation'));
    const created = this.device.createBuffer({
      label: 'gpu-scene-shared-inputs',
      size: bytes,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
      mappedAtCreation: false,
    });
    if (!created.ok) return created;
    let published = false;
    try {
      if (!this.inputBufferCurrent(upload, previous))
        return err(invalid('live unchanged Inputs after native buffer creation'));
      const uploaded = this.writeInputBuffer(upload, created.value, true);
      if (!uploaded.ok) return uploaded;
      if (!this.inputBufferCurrent(upload, previous) || this.arena.byteLength > bytes)
        return err(invalid('live unchanged Inputs after native buffer upload'));
      this.buffer = created.value;
      this.bufferBytes = bytes;
      published = true;
      if (previous !== undefined) this.retireBuffer(previous);
      if (!this.inputBufferCurrent(upload, created.value) || this.arena.byteLength > bytes)
        return err(invalid('live unchanged Inputs after old buffer retirement'));
      return this.inputBufferResult(created.value);
    } finally {
      if (!published) this.retireBuffer(created.value);
    }
  }

  private inputBufferResult(buffer: Buffer): Result<GpuInputBuffer, RhiError> {
    return ok({
      buffer,
      byteLength: this.bufferBytes,
      resourceRoot: this.resources?.address ?? ABSENT_RESOURCE,
    });
  }

  /** Transfer the single incremental upload owner only after candidate acceptance. */
  activate(): void {
    this.assertLive();
    if (this.preparingBuffer !== undefined) this.releasePreparedBuffer(this.preparingBuffer);
    this.assertLive();
    this.upload.activate();
  }

  capture(): GpuInputReadFrame {
    this.assertLive();
    const current = this.captureGuard();
    let resources = this.resources;
    const resourceRoot = resources?.address ?? ABSENT_RESOURCE;
    const resourceRevision = this.resourceRevision;
    if (resources !== undefined) resources.holders++;
    let roots: Set<number> | undefined;
    let state: 'reading' | 'sealed' | 'released' = 'reading';
    let firstBuffer: Buffer | undefined;
    let otherBuffers: Set<Buffer> | undefined;
    const isCurrent = () => state !== 'released' && current();
    const holdsBuffer = (buffer: Buffer, expectedRoot = resourceRoot) =>
      state !== 'released' &&
      expectedRoot === resourceRoot &&
      (buffer === firstBuffer || otherBuffers?.has(buffer) === true);
    const readBuffer = () => {
      this.assertLive();
      if (state !== 'reading' || this.disposed)
        return err(invalid('an open GPU input read domain'));
      const result = this.flush();
      if (!result.ok) return result;
      // Native upload callbacks can retire this reader before returning the physical buffer.
      if (state !== 'reading' || this.disposed)
        return err(invalid('an open GPU input read domain'));
      const buffer = result.value.buffer;
      if (buffer !== firstBuffer && !otherBuffers?.has(buffer)) {
        if (firstBuffer === undefined) firstBuffer = buffer;
        else {
          otherBuffers ??= new Set();
          otherBuffers.add(buffer);
        }
        this.bufferHolders.set(buffer, (this.bufferHolders.get(buffer) ?? 0) + 1);
      }
      return result.value.resourceRoot === resourceRoot
        ? result
        : ok({ ...result.value, resourceRoot });
    };
    const frame: GpuInputReadFrame = {
      isCurrent,
      holdsBuffer,
      resource: (slot) => {
        this.assertLive();
        if (state !== 'reading' || this.disposed) throw invalid('an open GPU resource read domain');
        if (resourceRevision !== this.resourceRevision) return undefined;
        return this.readResource(resources, u32(slot));
      },
      members: (candidates) => {
        this.assertLive();
        if (state !== 'reading' || this.disposed) throw invalid('an open GPU input read domain');
        const canonical = MemberCandidates.is(candidates);
        const known =
          !canonical || candidates.root === undefined
            ? 0
            : this.nodes.resolve(this.memberMemo.get(candidates.root));
        if (known !== 0 && roots?.has(known)) return this.address(known);
        const root = canonical ? this.encodeMember(candidates.root) : this.encodeRaw(candidates);
        if (root === 0) return 0;
        try {
          roots ??= new Set();
          roots.add(root);
        } catch (cause) {
          roots?.delete(root);
          this.release(root);
          throw cause;
        }
        return this.address(root);
      },
      header: (input) => {
        this.assertLive();
        if (state !== 'reading' || this.disposed || !this.arena.live)
          throw invalid('an open live task-header read domain');
        roots ??= new Set();
        return this.readHeader(input, roots);
      },
      reuseHeader: (header, batch) => {
        this.assertLive();
        if (state !== 'reading') throw invalid('an open task-header read domain');
        const root = this.headerNode(header, batch);
        if (root === 0) return false;
        roots ??= new Set();
        this.retainReadRoot(root, roots);
        return true;
      },
      buffer: readBuffer,
      seal: () => {
        if (state !== 'reading' || !isCurrent())
          return err(invalid('current complete GPU input demands before sealing'));
        if (firstBuffer !== undefined) {
          const result = readBuffer();
          if (!result.ok) return result;
        }
        state = 'sealed';
        return ok(undefined);
      },
      release: () => {
        if (state === 'released') return;
        state = 'released';
        const held = resources;
        resources = undefined;
        let failure: AggregateError | undefined;
        const failed = (cause: unknown) => {
          if (failure === undefined)
            failure = new AggregateError([cause], 'GPU read retirement failed', { cause });
          else failure.errors.push(cause);
        };
        try {
          this.releasePage(held);
        } catch (cause) {
          failed(cause);
        }
        if (roots !== undefined) {
          for (const root of roots) {
            try {
              this.release(root);
            } catch (cause) {
              failed(cause);
            }
          }
          roots = undefined;
        }
        const releaseBuffer = (buffer: Buffer) => {
          try {
            const holders = (this.bufferHolders.get(buffer) ?? 1) - 1;
            if (holders > 0) this.bufferHolders.set(buffer, holders);
            else {
              this.bufferHolders.delete(buffer);
              if (this.retiredBuffers.has(buffer)) this.retireBuffer(buffer);
            }
          } catch (cause) {
            failed(cause);
          }
        };
        if (firstBuffer !== undefined) releaseBuffer(firstBuffer);
        firstBuffer = undefined;
        if (otherBuffers !== undefined) {
          for (const buffer of otherBuffers) releaseBuffer(buffer);
          otherBuffers = undefined;
        }
        if (failure !== undefined) throw failure;
      },
    };
    try {
      this.readFrames.set(frame, { isCurrent, holdsBuffer });
    } catch (cause) {
      try {
        frame.release();
      } catch (retirement) {
        throw new AggregateError([cause, retirement], 'Input read registration retirement failed');
      }
      throw cause;
    }
    return frame;
  }

  dispose(): void {
    if (this.disposed) {
      if (this.failure !== undefined) throw this.failure;
      return;
    }
    this.disposed = true;
    const source = this.current,
      resources = this.resources,
      buffer = this.buffer;
    this.current = 0;
    this.source = undefined;
    this.resources = undefined;
    this.buffer = undefined;
    let failure: AggregateError | undefined;
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (cause) {
        if (failure === undefined)
          failure = new AggregateError([cause], 'GPU input retirement failed', { cause });
        else failure.errors.push(cause);
      }
    };
    if (this.preparingBuffer !== undefined) {
      const preparation = this.preparingBuffer;
      attempt(() => this.releasePreparedBuffer(preparation));
    }
    attempt(() => this.release(source));
    attempt(() => this.releasePage(resources));
    attempt(() => this.upload.release());
    this.resourceSlots.reset(1);
    if (this.ownsArena) attempt(() => this.arena.dispose());
    if (buffer !== undefined) attempt(() => this.retireBuffer(buffer));
    if (failure !== undefined) this.unconfirmedRetirement(source, undefined, failure);
    if (this.failure !== undefined) throw this.failure;
  }
}
