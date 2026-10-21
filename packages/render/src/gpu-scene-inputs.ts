import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { type BatchMemberEntry, BatchSources, MemberCandidates } from './gpu-driven/batch-members';
import type { GpuDrivenBatch, GpuDrivenCandidate } from './gpu-driven/batch-topology';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from './gpu-usage';
import type { FrameList } from './scene/frame-list';
import type { Node } from './scene/frame-tree';
import { StableRangeAllocator } from './stable-range-allocator';

/** binding3 addresses are u32 word offsets; zero is the null child. */
export const GPU_MEMBER_WORDS = 8;
export const GPU_MATERIAL_DESCRIPTOR = Object.freeze({ words: 2, payload: 0, radius: 1 });
export const GPU_MESH_DESCRIPTOR = Object.freeze({ words: 7, flags: 0, min: 1, max: 4 });

/** Numeric encoding/lifetime only: never holds a CPU source or native Mesh payload. */
class InputNode {
  holders = 1;
  constructor(
    readonly address: number,
    readonly words: number,
    public left: InputNode | undefined,
    public right: InputNode | undefined,
    public members: InputNode | undefined = undefined,
  ) {}
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
  private readonly ranges = new StableRangeAllocator();
  private readonly resourceSlots = new StableRangeAllocator();
  private resources: ResourcePage | undefined;
  private resourceRevision = 0;
  resourcePagesWritten = 0;
  resourcePagesReleased = 0;
  private readonly memberMemo = new WeakMap<Node<BatchMemberEntry>, InputNode>();
  private readonly sourceMemo = new WeakMap<Node<GpuDrivenBatch>, InputNode>();
  private source: Node<GpuDrivenBatch> | undefined;
  private current: InputNode | undefined;
  private words = new Uint32Array(256);
  private readonly pending = new Map<number, number>();
  private buffer: Buffer | undefined;
  private bufferBytes = 0;
  private readonly bufferHolders = new Map<Buffer, number>();
  private readonly retiredBuffers = new Set<Buffer>();
  private disposed = false;
  memberNodesWritten = 0;
  memberNodesReleased = 0;
  uploadBytes = 0;

  constructor(
    private readonly device: RhiDevice,
    private readonly primitiveIndex: (slot: number) => number | undefined,
  ) {
    this.ranges.reset(1);
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

  /** The existing resource Version owns this numeric range until its last release. */
  allocateDescriptor(wordCount: number): number {
    if (this.disposed) throw invalid('a live GPU input owner');
    u32(wordCount);
    if (wordCount === 0) throw invalid('a nonempty numeric descriptor');
    const address = this.allocateWords(wordCount);
    try {
      this.words.fill(0, address, address + wordCount);
      this.pending.set(address, wordCount);
      return address;
    } catch (cause) {
      this.pending.delete(address);
      this.ranges.release(address, wordCount);
      throw cause;
    }
  }

  /** Numeric storage only; GpuScene owns version pins and resource publication. */
  writeDescriptor(address: number, source: DataView, wordCount: number): void {
    if (this.disposed) throw invalid('a live GPU input owner');
    u32(address);
    u32(wordCount);
    if (
      address === 0 ||
      wordCount === 0 ||
      address + wordCount > this.words.length ||
      wordCount * 4 > source.byteLength
    )
      throw invalid('a complete numeric descriptor within shared input storage');
    let changed = false;
    for (let index = 0; index < wordCount; index++) {
      const value = source.getUint32(index * 4, true);
      if (this.words[address + index] === value) continue;
      this.words[address + index] = value;
      changed = true;
    }
    if (changed) this.pending.set(address, wordCount);
  }

  releaseDescriptor(address: number, wordCount: number): void {
    if (this.disposed) return;
    u32(address);
    u32(wordCount);
    if (address === 0 || wordCount === 0 || address + wordCount > this.words.length)
      throw invalid('a numeric descriptor range within shared input storage');
    this.pending.delete(address);
    this.ranges.release(address, wordCount);
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
    const descriptor = this.words[page.address + (slot & 255)];
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
          if (index !== key && this.words[previous.address + index] !== ABSENT_RESOURCE) {
            remaining = true;
            break;
          }
        }
        if (!remaining) return undefined;
      }
      address = this.allocateWords(RESOURCE_PAGE_WORDS);
      if (previous === undefined)
        this.words.fill(ABSENT_RESOURCE, address, address + RESOURCE_PAGE_WORDS);
      else this.words.copyWithin(address, previous.address, previous.address + RESOURCE_PAGE_WORDS);
      this.words[address + key] =
        shift === 0 ? descriptor : (children.get(key)?.address ?? ABSENT_RESOURCE);
      this.pending.set(address, RESOURCE_PAGE_WORDS);
      this.resourcePagesWritten++;
      return new ResourcePage(address, children);
    } catch (cause) {
      for (const child of children.values()) this.releasePage(child);
      if (address !== undefined) {
        this.pending.delete(address);
        this.ranges.release(address, RESOURCE_PAGE_WORDS);
      }
      throw cause;
    }
  }

  private releasePage(page: ResourcePage | undefined): void {
    if (page === undefined || --page.holders !== 0) return;
    for (const child of page.children.values()) this.releasePage(child);
    page.children.clear();
    if (!this.disposed) {
      this.pending.delete(page.address);
      this.ranges.release(page.address, RESOURCE_PAGE_WORDS);
      this.resourcePagesReleased++;
    }
  }

  private get byteLimit(): number {
    // RHI Null deliberately reports no numeric limits. As with view allocation,
    // only finite positive device limits constrain the u32-addressable arena.
    const storage = Number(this.device.limits.maxStorageBufferBindingSize);
    const buffer = Number(this.device.limits.maxBufferSize);
    return Math.min(
      0xffffffff * 4,
      Number.isFinite(storage) && storage > 0 ? storage : Infinity,
      Number.isFinite(buffer) && buffer > 0 ? buffer : Infinity,
    );
  }

  /** Capacity growth is distinct from a normal bounded path copy. */
  private allocateWords(count: number): number {
    const address = this.ranges.allocate(count);
    try {
      const end = u32(address + count);
      const maxWords = Math.floor(this.byteLimit / 4);
      if (end > maxWords) throw invalid('shared GPU input allocation fits device limits');
      if (end > this.words.length) {
        let capacity = this.words.length;
        while (capacity < end) capacity = Math.min(capacity * 2, maxWords);
        const next = new Uint32Array(capacity);
        next.set(this.words);
        this.words = next;
      }
      return address;
    } catch (cause) {
      this.ranges.release(address, count);
      throw cause;
    }
  }

  private retain(node: InputNode | undefined): InputNode | undefined {
    if (node !== undefined) {
      if (node.holders <= 0) throw invalid('a live shared GPU encoding');
      node.holders++;
    }
    return node;
  }

  private release(root: InputNode | undefined): void {
    if (root === undefined) return;
    if (root.holders > 1) {
      root.holders--;
      return;
    }
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) break;
      if (node.holders <= 0) throw invalid('balanced GPU input leases');
      if (--node.holders !== 0) continue;
      if (node.left !== undefined) pending.push(node.left);
      if (node.right !== undefined) pending.push(node.right);
      if (node.members !== undefined) pending.push(node.members);
      node.left = node.right = node.members = undefined;
      if (node.words !== 0 && !this.disposed) {
        this.pending.delete(node.address);
        this.ranges.release(node.address, node.words);
        this.memberNodesReleased++;
      }
    }
  }

  private encodeSource(source: Node<GpuDrivenBatch> | undefined): InputNode | undefined {
    if (source === undefined) return undefined;
    const old = this.sourceMemo.get(source);
    if (old !== undefined && old.holders > 0) return this.retain(old);
    let left: InputNode | undefined, right: InputNode | undefined, members: InputNode | undefined;
    let node: InputNode | undefined;
    try {
      left = this.encodeSource(source.left);
      right = this.encodeSource(source.right);
      const candidates = source.value.candidates;
      if (!MemberCandidates.is(candidates)) throw invalid('canonical source membership');
      members = this.encodeMember(candidates.root);
      // Source branches own physical children but have no unread GPU record.
      node = new InputNode(0, 0, left, right, members);
      this.sourceMemo.set(source, node);
      return node;
    } catch (cause) {
      if (node !== undefined) this.release(node);
      else {
        this.release(left);
        this.release(right);
        this.release(members);
      }
      throw cause;
    }
  }

  private encodeMember(source: Node<BatchMemberEntry> | undefined): InputNode | undefined {
    if (source === undefined) return undefined;
    const old = this.memberMemo.get(source);
    if (old !== undefined && old.holders > 0) return this.retain(old);
    let left: InputNode | undefined, right: InputNode | undefined;
    let node: InputNode | undefined;
    try {
      left = this.encodeMember(source.left);
      right = this.encodeMember(source.right);
      const member = source.value.member;
      const physical = this.primitiveIndex(member.primitiveIndex);
      if (physical === undefined) throw invalid('an admitted live primitive for each member');
      u32(source.count);
      const values = [
        left?.address ?? 0,
        right?.address ?? 0,
        source.left?.count ?? 0,
        source.weight,
        physical,
        member.generation,
        member.primitiveIndex,
        0,
      ].map(u32);
      node = this.writeNode(values, left, right);
      this.memberMemo.set(source, node);
      return node;
    } catch (cause) {
      if (node !== undefined) this.release(node);
      else {
        this.release(left);
        this.release(right);
      }
      throw cause;
    }
  }

  private writeNode(values: readonly number[], left?: InputNode, right?: InputNode): InputNode {
    const address = this.allocateWords(GPU_MEMBER_WORDS);
    try {
      this.words.set(values, address);
      this.pending.set(address, GPU_MEMBER_WORDS);
      this.memberNodesWritten++;
      return new InputNode(address, GPU_MEMBER_WORDS, left, right);
    } catch (cause) {
      this.pending.delete(address);
      this.ranges.release(address, GPU_MEMBER_WORDS);
      throw cause;
    }
  }

  private encodeRaw(candidates: FrameList<GpuDrivenCandidate>): InputNode | undefined {
    const count = u32(candidates.length);
    if (count * GPU_MEMBER_WORDS * 4 > this.byteLimit)
      throw invalid('raw candidate input fits device limits');
    const values = new Uint32Array(count * 4);
    let index = 0;
    const read = (candidate: GpuDrivenCandidate | undefined) => {
      if (candidate === undefined || index >= count) throw invalid('the declared candidate extent');
      const offset = index++ * 4;
      // Preserve ordinary raw property-read order and separate source-slot read.
      const physical = this.primitiveIndex(candidate.primitiveIndex);
      if (physical === undefined) throw invalid('an admitted live raw primitive');
      values[offset] = u32(physical);
      values[offset + 1] = u32(candidate.generation);
      values[offset + 2] = u32(candidate.instanceOrdinal);
      values[offset + 3] = u32(candidate.primitiveIndex);
    };
    if (Array.isArray(candidates)) {
      for (let i = 0; i < count; i++) read(candidates[i]);
    } else {
      for (const candidate of candidates) read(candidate);
    }
    if (index !== count) throw invalid('a complete candidate stream');
    const build = (start: number, end: number): InputNode | undefined => {
      if (start === end) return undefined;
      const middle = start + Math.floor((end - start) / 2);
      let left: InputNode | undefined, right: InputNode | undefined;
      try {
        left = build(start, middle);
        right = build(middle + 1, end);
        const offset = middle * 4;
        return this.writeNode(
          [
            left?.address ?? 0,
            right?.address ?? 0,
            middle - start,
            1,
            values[offset] as number,
            values[offset + 1] as number,
            values[offset + 3] as number,
            values[offset + 2] as number,
          ],
          left,
          right,
        );
      } catch (cause) {
        this.release(left);
        this.release(right);
        throw cause;
      }
    };
    return build(0, count);
  }

  private retireBuffer(buffer: Buffer): void {
    this.retiredBuffers.add(buffer);
    if (this.bufferHolders.has(buffer)) return;
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
    const byteLength = this.words.byteLength;
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
      const uploaded = this.device.queue.writeBuffer(created.value, 0, this.words);
      if (!uploaded.ok) {
        this.device.destroyBuffer(created.value);
        return uploaded;
      }
      const previous = this.buffer;
      this.buffer = created.value;
      this.bufferBytes = byteLength;
      this.uploadBytes += byteLength;
      this.pending.clear();
      if (previous !== undefined) this.retireBuffer(previous);
    } else {
      for (const [address, count] of this.pending) {
        const uploaded = this.device.queue.writeBuffer(
          this.buffer,
          address * 4,
          this.words.subarray(address, address + count),
        );
        if (!uploaded.ok) return uploaded;
        this.uploadBytes += count * 4;
      }
      this.pending.clear();
    }
    return ok({
      buffer: this.buffer,
      byteLength: this.bufferBytes,
      resourceRoot: this.resources?.address ?? ABSENT_RESOURCE,
    });
  }

  capture(): GpuInputReadFrame {
    if (this.disposed) throw invalid('a live shared GPU input owner');
    let source = this.current;
    let resources = this.resources;
    const resourceRevision = this.resourceRevision;
    if (resources !== undefined) resources.holders++;
    const roots = new Set<InputNode>();
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
            ? undefined
            : this.memberMemo.get(candidates.root);
        if (known !== undefined && roots.has(known)) return known.address;
        const root = canonical ? this.encodeMember(candidates.root) : this.encodeRaw(candidates);
        if (root === undefined) return 0;
        try {
          roots.add(root);
        } catch (cause) {
          roots.delete(root);
          this.release(root);
          throw cause;
        }
        return root.address;
      },
      buffer: readBuffer,
      seal: () => {
        if (
          state !== 'reading' ||
          this.disposed ||
          source !== this.current ||
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
        this.releasePage(resources);
        resources = undefined;
        source = undefined;
        for (const root of roots) this.release(root);
        roots.clear();
        for (const buffer of buffers) {
          const holders = (this.bufferHolders.get(buffer) ?? 1) - 1;
          if (holders > 0) this.bufferHolders.set(buffer, holders);
          else {
            this.bufferHolders.delete(buffer);
            if (this.retiredBuffers.has(buffer)) this.retireBuffer(buffer);
          }
        }
        buffers.clear();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.release(this.current);
    this.releasePage(this.resources);
    this.resources = undefined;
    this.current = this.source = undefined;
    this.disposed = true;
    this.ranges.reset(1);
    this.resourceSlots.reset(1);
    this.words = new Uint32Array(0);
    this.pending.clear();
    if (this.buffer !== undefined) this.device.destroyBuffer(this.buffer);
    this.buffer = undefined;
    for (const buffer of this.retiredBuffers) this.device.destroyBuffer(buffer);
    this.retiredBuffers.clear();
    this.bufferHolders.clear();
  }
}
