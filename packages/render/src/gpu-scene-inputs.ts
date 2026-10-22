import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { type BatchMemberEntry, BatchSources, MemberCandidates } from './gpu-driven/batch-members';
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

/** binding3 addresses are u32 word offsets; zero is the null child. */
export const GPU_MEMBER_WORDS = 8;
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
  private readonly resourceSlots = new StableRangeAllocator();
  private resources: ResourcePage | undefined;
  private resourceRevision = 0;
  resourcePagesWritten = 0;
  resourcePagesReleased = 0;
  private readonly memberMemo = new WeakMap<Node<BatchMemberEntry>, InputNode>();
  private readonly sourceMemo = new WeakMap<Node<GpuDrivenBatch>, InputNode>();
  private source: Node<GpuDrivenBatch> | undefined;
  private current: InputNode | undefined;
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
    let failure: AggregateError | undefined;
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) break;
      if (node.holders <= 0) throw invalid('balanced GPU input leases');
      if (--node.holders !== 0) continue;
      if (node.left !== undefined) pending.push(node.left);
      if (node.right !== undefined) pending.push(node.right);
      if (node.members !== undefined) pending.push(node.members);
      node.left = node.right = node.members = undefined;
      if (node.words !== 0) {
        try {
          this.arena.releaseDescriptor(node.address, node.words);
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
    const address = this.arena.allocateDescriptor(GPU_MEMBER_WORDS);
    try {
      for (let index = 0; index < GPU_MEMBER_WORDS; index++)
        this.arena.writeDescriptorWord(address, GPU_MEMBER_WORDS, index, values[index] as number);
      this.memberNodesWritten++;
      return new InputNode(address, GPU_MEMBER_WORDS, left, right);
    } catch (cause) {
      this.arena.releaseDescriptor(address, GPU_MEMBER_WORDS);
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
        const held = resources;
        resources = undefined;
        source = undefined;
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
    this.current = this.source = undefined;
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
