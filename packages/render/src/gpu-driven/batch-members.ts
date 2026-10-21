import { type FrameList, FrameListBase, FrameProjection } from '../scene/frame-list';
import { changes, type Node, nodes, prefix, put, remove } from '../scene/frame-tree';
import { TreeFrame } from '../scene/frame-tree-list';
import { captureMaterialOverrides } from '../scene/mesh-materials';
import { captureBatchGeometry, captureBatchLod } from './batch-execution';
import type {
  EligibleGpuDrivenDraw,
  GpuDrivenBatch,
  GpuDrivenBatchBinding,
  GpuDrivenBatchMember,
  GpuDrivenCandidate,
  MeshBatchSource,
} from './batch-topology';

/** Seal only newly created paths. Unchanged children are already sealed by this owner. */
function sealPath<T>(root: Node<T> | undefined): Node<T> | undefined {
  if (root === undefined || Object.isFrozen(root)) return root;
  sealPath(root.left);
  sealPath(root.right);
  return Object.freeze(root);
}
function numeric(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Batch membership facts are non-negative safe integers');
  return value;
}

const WIDTH = 64;
type Page = readonly GpuDrivenCandidate[];
const EMPTY: Page = Object.freeze([]);
type Candidates = GpuDrivenCandidate | Page | CandidatePages;

function isSingle(value: Candidates): value is GpuDrivenCandidate {
  return 'primitiveIndex' in value;
}

function candidateCount(value: Candidates): number {
  return isSingle(value) ? 1 : value.length;
}

function candidateAt(value: Candidates, index: number): GpuDrivenCandidate | undefined {
  return isSingle(value) ? (index === 0 ? value : undefined) : value.at(index);
}

function candidate(member: GpuDrivenBatchMember, instanceOrdinal: number): GpuDrivenCandidate {
  return Object.freeze({
    primitiveIndex: member.primitiveIndex,
    generation: member.generation,
    drawItemIndex: member.drawItemIndex,
    instanceOrdinal,
  });
}

function resizedPage(
  member: GpuDrivenBatchMember,
  start: number,
  length: number,
  previous: Candidates = EMPTY,
): Page {
  const values = new Array<GpuDrivenCandidate>(length);
  const retained = Math.min(length, candidateCount(previous));
  for (let lane = 0; lane < retained; lane++)
    values[lane] = candidateAt(previous, lane) as GpuDrivenCandidate;
  for (let lane = retained; lane < length; lane++) values[lane] = candidate(member, start + lane);
  return Object.freeze(values);
}

function pageAt(root: Node<Page> | undefined, key: number): Page | undefined {
  while (root !== undefined) {
    if (key === root.key) return root.value;
    root = key < root.key ? root.left : root.right;
  }
  return undefined;
}

/** Candidate objects are created at admission, never at each execution read. */
class CandidatePages extends FrameListBase<GpuDrivenCandidate> {
  readonly length: number;
  constructor(readonly root: Node<Page> | undefined) {
    super();
    sealPath(root);
    this.length = root?.count ?? 0;
    Object.freeze(this);
  }
  // Only the retained same-binding owner may resize. Recreate/move/generation
  // replacement must start with an empty page root, even at equal cardinality.
  resize(member: GpuDrivenBatchMember): CandidatePages {
    const count = member.instanceCount;
    if (count === this.length) return this;
    if (count === 0) return new CandidatePages(undefined);
    let root = count < this.length ? prefix(this.root, 0, Math.ceil(count / WIDTH)) : this.root;
    const firstPage = Math.floor(Math.min(count, this.length) / WIDTH);
    const lastPage = Math.ceil(count / WIDTH);
    for (let key = firstPage; key < lastPage; key++) {
      const start = key * WIDTH;
      const length = Math.min(WIDTH, count - start);
      const previous = pageAt(root, key);
      root = put(root, resizedPage(member, start, length, previous), 0, key, length);
    }
    return new CandidatePages(root);
  }
  at(index: number): GpuDrivenCandidate | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    return pageAt(this.root, Math.floor(index / WIDTH))?.[index % WIDTH];
  }
  *[Symbol.iterator](): Generator<GpuDrivenCandidate> {
    for (const page of nodes(this.root))
      for (let lane = 0; lane < page.value.length; lane++)
        yield page.value[lane] as GpuDrivenCandidate;
  }
}

export interface BatchMemberEntry {
  readonly member: GpuDrivenBatchMember;
  readonly candidates: Candidates;
}

/** One candidate is its own extent; only larger extents require containers. */
function resizeCandidates(member: GpuDrivenBatchMember, previous: Candidates = EMPTY): Candidates {
  const count = member.instanceCount;
  if (count === candidateCount(previous)) return previous;
  if (count === 0) return EMPTY;
  if (count === 1) return candidateAt(previous, 0) ?? candidate(member, 0);
  if (count <= WIDTH) return resizedPage(member, 0, count, previous);
  const seed = isSingle(previous) ? Object.freeze([previous]) : previous;
  const pages =
    seed instanceof CandidatePages
      ? seed
      : new CandidatePages(seed.length === 0 ? undefined : put(undefined, seed, 0, 0, seed.length));
  return pages.resize(member);
}

/** Candidate order shares the member root; reading never allocates a candidate. */
export class MemberCandidates extends FrameListBase<GpuDrivenCandidate> {
  #root: Node<BatchMemberEntry> | undefined;
  constructor() {
    super();
    // biome-ignore lint/complexity/noArguments: reject JS root injection without allocating a rest array.
    if (arguments.length !== 0)
      throw new TypeError('MemberCandidates owns its root; admit numeric members');
    Object.freeze(this);
  }
  get root(): Node<BatchMemberEntry> | undefined {
    return this.#root;
  }
  get length(): number {
    return this.#root?.count ?? 0;
  }
  get memberCount(): number {
    return this.#root?.size ?? 0;
  }
  static #from(root: Node<BatchMemberEntry> | undefined): MemberCandidates {
    const value = new MemberCandidates();
    value.#root = sealPath(root);
    return value;
  }
  static is(value: unknown): value is MemberCandidates {
    return (
      typeof value === 'object' &&
      value !== null &&
      #root in value &&
      Object.getPrototypeOf(value) === MemberCandidates.prototype
    );
  }
  get(slot: number): BatchMemberEntry | undefined {
    let node = this.#root;
    while (node !== undefined) {
      if (node.key === slot) return node.value;
      node = slot < node.key ? node.left : node.right;
    }
    return undefined;
  }
  with(member: GpuDrivenBatchMember): MemberCandidates {
    const captured = Object.freeze({
      primitiveIndex: numeric(member.primitiveIndex),
      generation: numeric(member.generation),
      entityKey: numeric(member.entityKey),
      drawItemIndex: numeric(member.drawItemIndex),
      instanceCount: numeric(member.instanceCount),
    });
    const previous = this.get(captured.primitiveIndex);
    const sameBinding =
      previous !== undefined &&
      previous.member.primitiveIndex === captured.primitiveIndex &&
      previous.member.generation === captured.generation &&
      previous.member.drawItemIndex === captured.drawItemIndex &&
      previous.member.entityKey === captured.entityKey;
    if (sameBinding && previous.member.instanceCount === captured.instanceCount) return this;
    const entry = Object.freeze({
      member: captured,
      candidates: resizeCandidates(captured, sameBinding ? previous.candidates : EMPTY),
    });
    return MemberCandidates.#from(
      put(this.#root, entry, 0, captured.primitiveIndex, captured.instanceCount),
    );
  }
  without(slot: number): MemberCandidates {
    return this.get(slot) === undefined
      ? this
      : MemberCandidates.#from(remove(this.#root, 0, slot));
  }
  membersFrame(): FrameList<GpuDrivenBatchMember> {
    const entries = Object.freeze(new TreeFrame(this.#root));
    return Object.freeze(new FrameProjection(entries, (entry) => entry.member));
  }
  /** Native member identity lookup, independent of its instance cardinality. */
  containsSlot(slot: number, generation: number): boolean {
    let node = this.root;
    while (node !== undefined) {
      if (node.key === slot) return node.weight > 0 && node.value.member.generation === generation;
      node = slot < node.key ? node.left : node.right;
    }
    return false;
  }
  at(index: number): GpuDrivenCandidate | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let node = this.root;
    while (node !== undefined) {
      const before = node.left?.count ?? 0;
      if (index < before) node = node.left;
      else if (index < before + node.weight)
        return candidateAt(node.value.candidates, index - before);
      else {
        index -= before + node.weight;
        node = node.right;
      }
    }
    return undefined;
  }
  *[Symbol.iterator](): Generator<GpuDrivenCandidate> {
    // One reusable page stack per real consumer, not one generator per member.
    const pages: Node<Page>[] = [];
    for (const member of nodes(this.root)) {
      const candidates = member.value.candidates;
      if (isSingle(candidates)) {
        yield candidates;
        continue;
      }
      if (!(candidates instanceof CandidatePages)) {
        for (let lane = 0; lane < candidates.length; lane++)
          yield candidates[lane] as GpuDrivenCandidate;
        continue;
      }
      let page = candidates.root;
      while (page !== undefined || pages.length > 0) {
        while (page !== undefined) {
          pages.push(page);
          page = page.left;
        }
        const current = pages.pop();
        if (current === undefined) break;
        for (let lane = 0; lane < current.value.length; lane++)
          yield current.value[lane] as GpuDrivenCandidate;
        page = current.right;
      }
    }
  }
}

/** The existing published source roster; its numeric candidate facts are sealed at admission. */
export class BatchSources extends FrameListBase<GpuDrivenBatch> {
  #root: Node<GpuDrivenBatch> | undefined;
  constructor() {
    super();
    // biome-ignore lint/complexity/noArguments: reject JS root injection without allocating a rest array.
    if (arguments.length !== 0) throw new TypeError('BatchSources owns its publication root');
    Object.freeze(this);
  }
  get root(): Node<GpuDrivenBatch> | undefined {
    return this.#root;
  }
  get length(): number {
    return this.#root?.size ?? 0;
  }
  get weight(): number {
    return this.#root?.count ?? 0;
  }
  static isFixed(value: unknown): value is BatchSources {
    return (
      typeof value === 'object' &&
      value !== null &&
      #root in value &&
      Object.getPrototypeOf(value) === BatchSources.prototype
    );
  }
  static #from(root: Node<GpuDrivenBatch> | undefined): BatchSources {
    const value = new BatchSources();
    value.#root = sealPath(root);
    return value;
  }
  get(batchId: number): GpuDrivenBatch | undefined {
    let node = this.#root;
    while (node !== undefined) {
      if (node.key === batchId) return node.value;
      node = batchId < node.key ? node.left : node.right;
    }
    return undefined;
  }
  /** Membership edits retain this owner's already captured shared source facts. */
  withMembers(batchId: number, candidates: MemberCandidates, contentEpoch: number): BatchSources {
    const previous = this.get(batchId);
    if (previous === undefined || !MemberCandidates.is(candidates))
      throw new TypeError(
        'Membership update requires an admitted source and owned numeric members',
      );
    const captured = Object.freeze({
      ...previous,
      candidates,
      members: candidates.membersFrame(),
      visibleCapacity: candidates.length,
      contentEpoch: numeric(contentEpoch),
    });
    return BatchSources.#from(put(this.#root, captured, 0, batchId, candidates.length));
  }
  with(batch: GpuDrivenBatch): BatchSources {
    const admitted = { ...batch };
    const candidates = admitted.candidates;
    if (!MemberCandidates.is(candidates))
      throw new TypeError('Source publication requires owned numeric members');
    const lod = captureBatchLod(admitted);
    const captured = Object.freeze({
      ...admitted,
      candidates,
      key: Object.freeze({ ...admitted.key }),
      ...(admitted.binding === undefined ? {} : { binding: captureBinding(admitted.binding) }),
      ...(lod === undefined ? {} : { lod }),
      members: candidates.membersFrame(),
    });
    return BatchSources.#from(
      put(this.#root, captured, 0, numeric(captured.batchId), candidates.length),
    );
  }
  without(batchId: number): BatchSources {
    return BatchSources.#from(remove(this.#root, 0, batchId));
  }
  changesSince(
    before: BatchSources,
    visit: (before: GpuDrivenBatch | undefined, after: GpuDrivenBatch | undefined) => void,
  ): void {
    changes(before.#root, this.#root, visit);
  }
  at(index: number): GpuDrivenBatch | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let node = this.#root;
    while (node !== undefined) {
      const before = node.left?.size ?? 0;
      if (index < before) node = node.left;
      else if (index === before) return node.value;
      else {
        index -= before + 1;
        node = node.right;
      }
    }
    return undefined;
  }
  *[Symbol.iterator](): Generator<GpuDrivenBatch> {
    for (const node of nodes(this.#root)) yield node.value;
  }
}

/** Capture only execution inputs; MaterialResource and asset identities remain borrowed identities. */
function captureBinding(raw: GpuDrivenBatchBinding): GpuDrivenBatchBinding {
  const binding = { ...raw };
  const source = binding.source === undefined ? undefined : { ...binding.source };
  const capturedSource: MeshBatchSource | undefined =
    source === undefined
      ? undefined
      : Object.freeze({
          draws: Object.freeze(
            source.draws.map((raw): EligibleGpuDrivenDraw => {
              const draw = { ...raw };
              const lod = draw.lod === undefined ? undefined : captureBatchLod({ lod: draw.lod });
              return Object.freeze({
                sourceDrawIndex: draw.sourceDrawIndex,
                key: Object.freeze({ ...draw.key }),
                // Authored draw descriptors do not carry another source group.
                binding: captureLeafBinding(draw.binding),
                ...(lod === undefined ? {} : { lod }),
              });
            }),
          ),
          material: source.material,
          materials: Object.freeze([...source.materials]),
          materialBindingSources: Object.freeze([...source.materialBindingSources]),
          ...(source.materialOverrides === undefined
            ? {}
            : {
                materialOverrides: captureMaterialOverrides(source.materialOverrides),
              }),
        });
  return Object.freeze({
    ...captureLeafBinding(binding),
    ...(capturedSource === undefined ? {} : { source: capturedSource }),
  });
}
function captureLeafBinding(raw: GpuDrivenBatchBinding): GpuDrivenBatchBinding {
  const binding = { ...raw };
  return Object.freeze({
    worldId: binding.worldId,
    assetHandle: binding.assetHandle,
    drawItemIndex: binding.drawItemIndex,
    material: binding.material,
    geometry: captureBatchGeometry(binding.geometry),
    ...(binding.lods === undefined ? {} : { lods: Object.freeze([...binding.lods]) }),
  });
}
