import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import {
  BatchSources,
  MEMBER_PAGE,
  MemberCandidates,
  type MemberPage,
} from './gpu-driven/batch-members';
import type { GpuDrivenBatch, GpuDrivenCandidate } from './gpu-driven/batch-topology';
import { GpuInputArena, type GpuInputUpload, gpuInputByteLimit } from './gpu-input-arena';
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
const NODE_WIDTH = 7;
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

  create(address: number, words: number, left: number, right: number, members = 0): number {
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
  ) {}
}
const RESOURCE_PAGE_WORDS = 256;
const ABSENT_RESOURCE = 0xffffffff;

interface GpuInputBuffer {
  readonly buffer: Buffer;
  readonly byteLength: number;
  readonly resourceRoot: number;
}

export interface GpuInputReadFrame {
  resource(slot: number): number | undefined;
  members(candidates: FrameList<GpuDrivenCandidate>): number;
  buffer(): Result<GpuInputBuffer, RhiError>;
  seal(): Result<void, RhiError>;
  release(): void;
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
  resourcePagesWritten = 0;
  resourcePagesReleased = 0;
  private readonly nodes = new InputNodes();
  private readonly memberMemo = new WeakMap<Node<MemberPage>, number>();
  private readonly pageMemo = new WeakMap<MemberPage, number>();
  private readonly sourceMemo = new WeakMap<Node<GpuDrivenBatch>, number>();
  private source: Node<GpuDrivenBatch> | undefined;
  /** Encoded source root handle; 0 is none. */
  private current = 0;
  private readonly upload: GpuInputUpload;
  private readonly ownsArena: boolean;
  readonly arena: GpuInputArena;
  private buffer: Buffer | undefined;
  private bufferBytes = 0;
  private readonly bufferHolders = new Map<Buffer, number>();
  private readonly retiredBuffers = new Set<Buffer>();
  private disposed = false;
  memberNodesWritten = 0;
  memberNodesReleased = 0;
  get uploadBytes(): number {
    return this.upload.uploadBytes;
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
    if (this.disposed) throw invalid('a live GPU input owner');
    let held = this.encodeMember(candidates.root);
    return () => {
      const node = held;
      held = 0;
      if (node !== 0 && !this.disposed) this.release(node);
    };
  }

  allocateResource(descriptor: number): number {
    if (this.disposed) throw invalid('a live GPU input owner');
    const slot = this.resourceSlots.allocate(1);
    try {
      this.updateResource(slot, descriptor);
    } catch (cause) {
      this.resourceSlots.release(slot, 1);
      throw cause;
    }
    return slot;
  }

  updateResource(slot: number, descriptor: number): void {
    if (this.disposed) throw invalid('a live GPU input owner');
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
    const current = this.readResource(this.resources, slot);
    if (current === descriptor || (current === undefined && descriptor === ABSENT_RESOURCE)) return;
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

  private copyResourcePath(
    previous: ResourcePage | undefined,
    slot: number,
    descriptor: number,
    shift: number,
  ): ResourcePage | undefined {
    const children = new Map<number, ResourcePage>();
    let address: number | undefined;
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
      if (shift > 0 && children.size === 0) return undefined;
      if (shift === 0 && descriptor === ABSENT_RESOURCE && previous !== undefined) {
        let remaining = false;
        for (let index = 0; index < RESOURCE_PAGE_WORDS; index++) {
          if (index !== key && this.arena.readWord(previous.address + index) !== ABSENT_RESOURCE) {
            remaining = true;
            break;
          }
        }
        if (!remaining) return undefined;
      }
      address = this.arena.allocateDescriptor(RESOURCE_PAGE_WORDS);
      if (previous === undefined)
        this.arena.fillDescriptor(address, RESOURCE_PAGE_WORDS, ABSENT_RESOURCE);
      else this.arena.copyDescriptor(address, previous.address, RESOURCE_PAGE_WORDS);
      this.arena.writeDescriptorWord(
        address,
        RESOURCE_PAGE_WORDS,
        key,
        shift === 0 ? descriptor : (children.get(key)?.address ?? ABSENT_RESOURCE),
      );
      this.resourcePagesWritten++;
      return new ResourcePage(address, children);
    } catch (cause) {
      for (const child of children.values()) this.releasePage(child);
      if (address !== undefined) {
        this.arena.releaseDescriptor(address, RESOURCE_PAGE_WORDS);
      }
      throw cause;
    }
  }

  private releasePage(page: ResourcePage | undefined): void {
    if (page === undefined || --page.holders !== 0) return;
    let failure: AggregateError | undefined;
    for (const child of page.children.values()) {
      try {
        this.releasePage(child);
      } catch (cause) {
        if (failure === undefined)
          failure = new AggregateError([cause], 'Resource page retirement failed', { cause });
        else failure.errors.push(cause);
      }
    }
    page.children.clear();
    try {
      this.arena.releaseDescriptor(page.address, RESOURCE_PAGE_WORDS);
      this.resourcePagesReleased++;
    } catch (cause) {
      if (failure === undefined)
        failure = new AggregateError([cause], 'Resource page retirement failed', { cause });
      else failure.errors.push(cause);
    }
    if (failure !== undefined) throw failure;
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
      nodes.retire(node);
      if (words !== 0) {
        try {
          this.arena.releaseDescriptor(address, words);
          this.memberNodesReleased++;
        } catch (cause) {
          if (failure === undefined)
            failure = new AggregateError([cause], 'Member retirement failed', { cause });
          else failure.errors.push(cause);
        }
      }
    }
    if (failure !== undefined) throw failure;
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
  private encodeRaw(candidates: FrameList<GpuDrivenCandidate>): number {
    const count = u32(candidates.length);
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
    this.retiredBuffers.add(buffer);
    if (this.bufferHolders.has(buffer)) return;
    // Held reads cover submitted work; a disposed owner retires the rest now.
    if (this.disposed) {
      this.retiredBuffers.delete(buffer);
      this.device.destroyBuffer(buffer);
      return;
    }
    void this.device.queue.onSubmittedWorkDone().then(
      () => {
        if (this.retiredBuffers.delete(buffer)) this.device.destroyBuffer(buffer);
      },
      () => {
        if (this.retiredBuffers.delete(buffer)) this.device.destroyBuffer(buffer);
      },
    );
  }

  private flush(): Result<GpuInputBuffer, RhiError> {
    const byteLength = this.arena.byteLength;
    const limit = this.byteLimit;
    if (byteLength > limit)
      return err(invalid('shared GPU input arena fits device storage limits'));
    if (this.buffer === undefined || this.bufferBytes < byteLength) {
      const created = this.device.createBuffer({
        label: 'gpu-scene-shared-inputs',
        size: byteLength,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
        mappedAtCreation: false,
      });
      if (!created.ok) return created;
      const uploaded = this.upload.flush(this.device.queue, created.value, true);
      if (!uploaded.ok) {
        this.device.destroyBuffer(created.value);
        return uploaded;
      }
      const previous = this.buffer;
      this.buffer = created.value;
      this.bufferBytes = byteLength;
      if (previous !== undefined) this.retireBuffer(previous);
    } else {
      const uploaded = this.upload.flush(this.device.queue, this.buffer, false);
      if (!uploaded.ok) return uploaded;
    }
    return ok({
      buffer: this.buffer,
      byteLength: this.bufferBytes,
      resourceRoot: this.resources?.address ?? ABSENT_RESOURCE,
    });
  }

  /** Transfer the single incremental upload owner only after candidate acceptance. */
  activate(): void {
    if (this.disposed) throw invalid('a live GPU Scene input incarnation');
    this.upload.activate();
  }

  capture(): GpuInputReadFrame {
    if (this.disposed) throw invalid('a live shared GPU input owner');
    let source = this.currentKey();
    let resources = this.resources;
    const resourceRevision = this.resourceRevision;
    if (resources !== undefined) resources.holders++;
    const roots = new Set<number>();
    let state: 'reading' | 'sealed' | 'released' = 'reading';
    const buffers = new Set<Buffer>();
    const readBuffer = () => {
      if (state !== 'reading' || this.disposed)
        return err(invalid('an open GPU input read domain'));
      const result = this.flush();
      if (!result.ok) return result;
      const buffer = result.value.buffer;
      if (!buffers.has(buffer)) {
        buffers.add(buffer);
        this.bufferHolders.set(buffer, (this.bufferHolders.get(buffer) ?? 0) + 1);
      }
      return ok({ ...result.value, resourceRoot: resources?.address ?? ABSENT_RESOURCE });
    };
    return {
      resource: (slot) => {
        if (state !== 'reading' || this.disposed) throw invalid('an open GPU resource read domain');
        if (resourceRevision !== this.resourceRevision) return undefined;
        return this.readResource(resources, u32(slot));
      },
      members: (candidates) => {
        if (state !== 'reading' || this.disposed) throw invalid('an open GPU input read domain');
        const canonical = MemberCandidates.is(candidates);
        const known =
          !canonical || candidates.root === undefined
            ? 0
            : this.nodes.resolve(this.memberMemo.get(candidates.root));
        if (known !== 0 && roots.has(known)) return this.address(known);
        const root = canonical ? this.encodeMember(candidates.root) : this.encodeRaw(candidates);
        if (root === 0) return 0;
        try {
          roots.add(root);
        } catch (cause) {
          roots.delete(root);
          this.release(root);
          throw cause;
        }
        return this.address(root);
      },
      buffer: readBuffer,
      seal: () => {
        if (
          state !== 'reading' ||
          this.disposed ||
          source !== this.currentKey() ||
          resourceRevision !== this.resourceRevision
        )
          return err(invalid('current complete GPU input demands before sealing'));
        if (buffers.size > 0) {
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
        source = -1;
        let failure: AggregateError | undefined;
        const attempt = (operation: () => void) => {
          try {
            operation();
          } catch (cause) {
            if (failure === undefined)
              failure = new AggregateError([cause], 'GPU read retirement failed', { cause });
            else failure.errors.push(cause);
          }
        };
        attempt(() => this.releasePage(held));
        for (const root of roots) attempt(() => this.release(root));
        roots.clear();
        for (const buffer of buffers)
          attempt(() => {
            const holders = (this.bufferHolders.get(buffer) ?? 1) - 1;
            if (holders > 0) this.bufferHolders.set(buffer, holders);
            else {
              this.bufferHolders.delete(buffer);
              if (this.retiredBuffers.has(buffer)) this.retireBuffer(buffer);
            }
          });
        buffers.clear();
        if (failure !== undefined) throw failure;
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
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
    attempt(() => this.release(source));
    attempt(() => this.releasePage(resources));
    attempt(() => this.upload.release());
    this.resourceSlots.reset(1);
    if (this.ownsArena) attempt(() => this.arena.dispose());
    if (buffer !== undefined) attempt(() => this.retireBuffer(buffer));
    if (failure !== undefined) throw failure;
  }
}
