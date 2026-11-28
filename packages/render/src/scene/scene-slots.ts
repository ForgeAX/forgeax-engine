import { shouldShrinkCapacity } from '../dynamic-capacity';
import { FrameKeyRoster } from '../frame-key-roster';
import {
  CapturedSceneTransform,
  COMPACT_SCENE_POSE_ROWS,
  copyScenePose,
  type RecordingScenePose,
  ScenePoseWriter,
} from './captured-transform';
import { EMPTY_FRAME_ROWS, type FrameList, FrameListBase, type SparseRowKind } from './frame-list';
import { FrameSet, popcount } from './frame-set';
import { type Node, nodes, put, remove, replaceOrdered } from './frame-tree';
import { IdentityMap, IdentityMapEditor } from './identity-map';
import { SceneDrawSlot, SceneMeshDrawShapes } from './mesh-draw';
import type { MeshFrame } from './mesh-frame';
import { hasRasterDemand } from './raster-demand';
import type { RenderSceneSlot } from './render-scene-types';
import { type RowChange, RowChangeLog } from './row-change-log';
import type { RowContent } from './row-contents';
import type { WorldTransformSpan } from './scene-rows';

const emptySourceCounts = () => ({ terrain: 0, glyph: 0, tilemap: 0, waterMeshSource: 0 });
export type SceneGeneratedSource = keyof ReturnType<typeof emptySourceCounts>;

const PAGE_SHIFT = 6;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;
const POSE = 16;
const TRANSLATION = 12;
const validSlot = (slot: number) =>
  Number.isSafeInteger(slot) && slot >= 0 && slot < Number.MAX_SAFE_INTEGER;

export function reflectedPose(pose: ArrayLike<number>, offset: number): boolean {
  const a = pose[offset] ?? 0,
    b = pose[offset + 1] ?? 0,
    c = pose[offset + 2] ?? 0;
  const d = pose[offset + 4] ?? 0,
    e = pose[offset + 5] ?? 0,
    f = pose[offset + 6] ?? 0;
  const g = pose[offset + 8] ?? 0,
    h = pose[offset + 9] ?? 0,
    i = pose[offset + 10] ?? 0;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) < 0;
}

function compareRowPose(
  poses: Float32Array,
  base: number,
  source: ArrayLike<number>,
  offset: number,
): 'unchanged' | 'pose' | 'parity' {
  for (let index = 0; index < POSE; index++) {
    if (poses[base + index] === (source[offset + index] ?? 0)) continue;
    // The 3x3 linear part ends at lane 10. Translation cannot reverse winding.
    return index <= 10 && reflectedPose(poses, base) !== reflectedPose(source, offset)
      ? 'parity'
      : 'pose';
  }
  return 'unchanged';
}

/** Matrix coordinates identify one immutable row revision, even across copied slot pages. */
class PoseVersions {
  private readonly facts: number[] = [];
  private views: (SceneDrawSlot | undefined)[] | undefined;

  constructor(readonly column: Float32Array) {}

  write(offset: number, generation: number, version: number): void {
    const start = (offset / POSE) * 2;
    this.facts[start] = generation;
    this.facts[start + 1] = version;
  }

  generation(offset: number): number {
    return this.facts[(offset / POSE) * 2] as number;
  }

  version(offset: number): number {
    return this.facts[(offset / POSE) * 2 + 1] as number;
  }

  read(
    slot: number,
    offset: number,
    entity: number,
    content: RowContent,
    shapes: SceneMeshDrawShapes,
  ): SceneDrawSlot {
    const index = offset / POSE;
    this.views ??= [];
    const views = this.views;
    views[index] ??= new SceneDrawSlot(
      slot,
      this.generation(offset),
      this.version(offset),
      entity,
      content,
      this.column,
      offset,
      shapes,
    );
    return views[index] as SceneDrawSlot;
  }
}

type Page = SceneSlotPage;
type PoseVisitor = (
  slot: number,
  version: number,
  content: RowContent,
  column: Float32Array,
  offset: number,
  ordinal: number,
  entity: number,
  generation: number,
) => void;

function findWordContent<T>(
  page: Page,
  first: number,
  half: number,
  bits: number,
  visit: (content: RowContent, entity: number, slot: number) => T | undefined,
): T | undefined {
  while (bits !== 0) {
    const lane = half + 31 - Math.clz32(bits & -bits);
    const result = visit(
      page.contents[lane] as RowContent,
      page.entities[lane] as number,
      first + lane,
    );
    if (result !== undefined) return result;
    bits &= bits - 1;
  }
  return undefined;
}

/** Captured pages keep their exact pose coordinates when a live slot is replaced. */
export class SceneSlotPage {
  readonly replacesCaptured: boolean;
  /** First bank holds row views or pose groups. The next bank holds group offsets. */
  private readonly rows: (SceneDrawSlot | PoseVersions | number | undefined)[];
  private packed: number;
  contents: (RowContent | undefined)[];
  entities: Float64Array;
  private ownsContent: boolean;
  private touchedLow = 0;
  private touchedHigh = 0;
  lowMask: number;
  highMask: number;
  count: number;

  constructor(
    private readonly shapes: SceneMeshDrawShapes,
    private readonly firstSlot: number,
    before?: SceneSlotPage,
  ) {
    this.replacesCaptured = before !== undefined;
    this.rows = before?.rows.slice() ?? new Array(PAGE_SIZE);
    this.packed = before?.packed ?? 0;
    this.ownsContent = before === undefined;
    this.contents =
      before === undefined ? new Array(PAGE_SIZE) : (before.contents as (RowContent | undefined)[]);
    this.entities = before?.entities ?? new Float64Array(PAGE_SIZE);
    this.lowMask = before?.lowMask ?? 0;
    this.highMask = before?.highMask ?? 0;
    this.count = before?.count ?? 0;
  }

  /** First writes define the adjacent publication's order in the journal. */
  noteWrite(slot: number): boolean {
    const lane = slot & PAGE_MASK;
    const bit = 1 << (lane & 31);
    if (lane < 32) {
      if ((this.touchedLow & bit) !== 0) return false;
      this.touchedLow |= bit;
    } else {
      if ((this.touchedHigh & bit) !== 0) return false;
      this.touchedHigh |= bit;
    }
    return true;
  }

  /** Material and feature scans read adjacent content and entity columns. Poses
   * leave both intact. Only a changed structural value needs private columns. */
  setContent(lane: number, content: RowContent | undefined, entity: number): number {
    if (this.contents[lane] === content && this.entities[lane] === entity) return 0;
    let copiedBytes = 0;
    if (!this.ownsContent) {
      this.contents = this.contents.slice();
      this.entities = this.entities.slice();
      this.ownsContent = true;
      copiedBytes = PAGE_SIZE * (8 + Float64Array.BYTES_PER_ELEMENT);
    }
    this.contents[lane] = content;
    this.entities[lane] = entity;
    return copiedBytes;
  }

  read(slot: number): SceneDrawSlot | undefined {
    const lane = slot & PAGE_MASK;
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    if (!(row instanceof PoseVersions)) return row;
    const observed = row.read(
      this.firstSlot + lane,
      this.poseOffset(lane),
      this.entities[lane] as number,
      this.contents[lane] as RowContent,
      this.shapes,
    );
    this.setRow(lane, observed);
    return observed;
  }

  versionAt(lane: number): number {
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    return row instanceof PoseVersions ? row.version(this.poseOffset(lane)) : (row?.version ?? 0);
  }

  visitPose(slot: number, ordinal: number, visit: PoseVisitor): void {
    const lane = slot & PAGE_MASK;
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    if (row instanceof PoseVersions) {
      const offset = this.poseOffset(lane);
      visit(
        slot,
        row.version(offset),
        this.contents[lane] as RowContent,
        row.column,
        offset,
        ordinal,
        this.entities[lane] as number,
        row.generation(offset),
      );
    } else if (row !== undefined) visitRowPose(row, ordinal, visit);
  }

  borrowReplacementPose(before: SceneDrawSlot, into: RecordingScenePose): boolean {
    const lane = before.slot & PAGE_MASK;
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    if (
      row === undefined ||
      row === before ||
      this.shapes.uploadOwner !== before.uploadOwner ||
      this.contents[lane] !== before.content ||
      this.entities[lane] !== before.entityKey
    )
      return false;
    const packed = row instanceof PoseVersions;
    const offset = packed ? this.poseOffset(lane) : row.poseOffset;
    const version = packed ? row.version(offset) : row.version;
    const generation = packed ? row.generation(offset) : row.generation;
    if (generation !== before.generation || version === before.version) return false;
    into.borrow(packed ? row.column : row.poseColumn, offset, before.uploadOwner, version);
    return true;
  }

  writeTranslation(
    lane: number,
    into: Float32Array | Float64Array,
    at: number,
    entity?: number,
  ): number | undefined {
    if (entity !== undefined && this.entities[lane] !== entity) return undefined;
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    if (row === undefined) return undefined;
    const packed = row instanceof PoseVersions;
    const offset = packed ? this.poseOffset(lane) : row.poseOffset;
    const column = packed ? row.column : row.poseColumn;
    into[at] = column[offset + TRANSLATION] as number;
    into[at + 1] = column[offset + TRANSLATION + 1] as number;
    into[at + 2] = column[offset + TRANSLATION + 2] as number;
    return packed ? row.generation(offset) : row.generation;
  }

  generationAt(lane: number): number | undefined {
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    return row instanceof PoseVersions ? row.generation(this.poseOffset(lane)) : row?.generation;
  }

  hasPose(lane: number, column: Float32Array, offset: number): boolean {
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    return row instanceof PoseVersions
      ? row.column === column && this.poseOffset(lane) === offset
      : row?.poseColumn === column && row.poseOffset === offset;
  }

  comparePose(
    lane: number,
    source: ArrayLike<number>,
    offset: number,
  ): 'absent' | 'unchanged' | 'pose' | 'parity' {
    const row = this.rows[lane] as SceneDrawSlot | PoseVersions | undefined;
    if (row === undefined) return 'absent';
    return row instanceof PoseVersions
      ? compareRowPose(row.column, this.poseOffset(lane), source, offset)
      : compareRowPose(row.poseColumn, row.poseOffset, source, offset);
  }

  setRow(lane: number, row: SceneDrawSlot | undefined): void {
    if (this.rows[lane] instanceof PoseVersions && --this.packed === 0)
      this.rows.length = PAGE_SIZE;
    this.rows[lane] = row;
  }

  setPose(lane: number, group: PoseVersions, offset: number): void {
    if (!(this.rows[lane] instanceof PoseVersions)) this.packed++;
    this.rows[lane] = group;
    this.rows[PAGE_SIZE + lane] = offset;
  }

  private poseOffset(lane: number): number {
    return this.rows[PAGE_SIZE + lane] as number;
  }
}

function visitRowPose(row: SceneDrawSlot, ordinal: number, visit: PoseVisitor): void {
  visit(
    row.slot,
    row.version,
    row.content,
    row.poseColumn,
    row.poseOffset,
    ordinal,
    row.entityKey,
    row.generation,
  );
}

const rowPageWeight = (page: Page): number => page.count;

function laneAtRank(page: Page, rank: number): number {
  if (page.count === PAGE_SIZE) return rank;
  const lowCount = popcount(page.lowMask);
  let word = page.lowMask;
  let base = 0;
  if (rank >= lowCount) {
    rank -= lowCount;
    base = 32;
    word = page.highMask;
  }
  while (rank-- > 0) word &= word - 1;
  return base + 31 - Math.clz32(word & -word);
}

/** A fixed scene root. Rank is derived at consumption; physical slot addresses never move. */
export class SceneSlotFrame extends FrameListBase<RenderSceneSlot> {
  readonly #nativeLength: number;
  readonly length: number;
  private cachedPageIndex = -1;
  private cachedPage: Page | undefined;
  /** Current occupied page for rank and physical-slot readers on this immutable frame. */
  private rankNode: Node<Page> | undefined;
  private rankStart = 0;
  constructor(
    readonly root: Node<Page> | undefined,
    readonly capacity: number,
    readonly identities: IdentityMap = IdentityMap.EMPTY,
    private readonly shapes: SceneMeshDrawShapes = new SceneMeshDrawShapes(),
    private readonly log?: RowChangeLog,
    /** This frame's cursor in its owner's row-change log. */
    readonly position = 0,
    private readonly sparse?: Readonly<Record<SparseRowKind, FrameSet>>,
    /**
     * Identity of every row's shared content and entity identity. Frames of one
     * owner keep the token across pose-only writes; ownerless frames have none.
     */
    readonly contentEpoch?: object,
    /** Whether this exact row root can contribute authored or generated Water draws. */
    readonly mayHaveWaterSources = true,
    /** Captured from live membership; ownerless frames have no default-layer proof. */
    readonly allDefaultRenderLayers = false,
    private readonly previousPosition?: number,
    /** First row event of this publication, excluding earlier GPU evidence. */
    private readonly publicationStart = position,
    /** Exact version sequence when each logged row was written once. */
    private readonly linearVersionBase?: number,
  ) {
    super();
    this.length = root?.count ?? 0;
    this.#nativeLength = this.length;
  }

  /** Sparse membership captured with this row root; ownerless frames may have no index proof. */
  indexedSlots(kind: SparseRowKind): FrameSet | undefined {
    return this.sparse?.[kind];
  }

  identitySlot(entity: number): number | undefined {
    return this.identities.get(entity);
  }

  readonly lookup = (entity: number): RenderSceneSlot | undefined => {
    const slot = this.identitySlot(entity);
    return slot === undefined ? undefined : this.slotAt(slot);
  };

  pageAt(page: number): Page | undefined {
    // Both hits and misses belong to this captured, immutable root.
    if (page === this.cachedPageIndex) return this.cachedPage;
    let node = this.root;
    while (node !== undefined) {
      if (page === node.key) break;
      node = page < node.key ? node.left : node.right;
    }
    this.cachedPageIndex = page;
    this.cachedPage = node?.value;
    return this.cachedPage;
  }

  readonly slotAt = (slot: number): RenderSceneSlot | undefined => {
    if (!validSlot(slot)) return undefined;
    const page = this.pageAt(Math.floor(slot / PAGE_SIZE));
    return page?.read(slot);
  };

  /** The row's version in this frame (0 when absent), without materializing it. */
  versionAt(slot: number): number {
    return validSlot(slot)
      ? (this.pageAt(Math.floor(slot / PAGE_SIZE))?.versionAt(slot & PAGE_MASK) ?? 0)
      : 0;
  }

  contentAt(slot: number): RowContent | undefined {
    if (!validSlot(slot)) return undefined;
    return this.pageAt(Math.floor(slot / PAGE_SIZE))?.contents[slot & PAGE_MASK];
  }

  entityAt(slot: number): number | undefined {
    if (!validSlot(slot)) return undefined;
    const page = this.pageAt(Math.floor(slot / PAGE_SIZE));
    const lane = slot & PAGE_MASK;
    return page?.contents[lane] === undefined ? undefined : page.entities[lane];
  }

  generationAt(slot: number): number | undefined {
    if (!validSlot(slot)) return undefined;
    return this.pageAt(Math.floor(slot / PAGE_SIZE))?.generationAt(slot & PAGE_MASK);
  }

  visitPose(slot: number, ordinal: number, visit: PoseVisitor): void {
    this.pageAt(Math.floor(slot / PAGE_SIZE))?.visitPose(slot, ordinal, visit);
  }

  /** A stable placed draw may borrow its current pose without issuing a row view. */
  borrowReplacementPose(before: SceneDrawSlot, into: RecordingScenePose): boolean {
    return (
      this.pageAt(Math.floor(before.slot / PAGE_SIZE))?.borrowReplacementPose(before, into) === true
    );
  }

  /** Copy into synchronous caller storage; an optional identity guards a reused address. */
  writeTranslation(
    slot: number,
    into: Float32Array | Float64Array,
    at = 0,
    entity?: number,
  ): number | undefined {
    if (!validSlot(slot)) return undefined;
    return this.pageAt(Math.floor(slot / PAGE_SIZE))?.writeTranslation(
      slot & PAGE_MASK,
      into,
      at,
      entity,
    );
  }

  /** Synchronous traversal in captured rank order. No row view or matrix slice is opened. */
  visitPoses(visit: PoseVisitor): void {
    let ordinal = 0;
    for (const node of nodes(this.root)) {
      const page = node.value;
      const first = node.key * PAGE_SIZE;
      if (page.count === PAGE_SIZE) {
        for (let lane = 0; lane < PAGE_SIZE; lane++) page.visitPose(first + lane, ordinal++, visit);
      } else {
        for (let half = 0; half < PAGE_SIZE; half += 32) {
          for (let bits = half === 0 ? page.lowMask : page.highMask; bits !== 0; bits &= bits - 1) {
            const lane = half + 31 - Math.clz32(bits & -bits);
            page.visitPose(first + lane, ordinal++, visit);
          }
        }
      }
    }
  }

  at(index: number): RenderSceneSlot | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    let node = this.root;
    while (node !== undefined) {
      const left = node.left?.count ?? 0;
      if (index < left) node = node.left;
      else if (index >= left + node.weight) {
        index -= left + node.weight;
        node = node.right;
      } else {
        return node.value.read(laneAtRank(node.value, index - left));
      }
    }
    return undefined;
  }

  /** A native captured root with no overridden indexed reader; never invokes an at getter. */
  static hasNativeAt(frame: FrameList<RenderSceneSlot>): frame is SceneSlotFrame {
    return (
      #nativeLength in frame &&
      Object.getPrototypeOf(frame) === SceneSlotFrame.prototype &&
      Object.getOwnPropertyDescriptor(frame, 'at') === undefined &&
      Object.getOwnPropertyDescriptor(frame, 'length')?.value === frame.#nativeLength &&
      Object.getOwnPropertyDescriptor(SceneSlotFrame.prototype, 'at')?.value === sceneSlotFrameAt
    );
  }

  /** Custom rank readers have observable order. A dense native roster additionally
   * admits direct addressing over its full length; a sparse one resolves each slot. */
  static directRankLimit(frame: SceneSlotFrame): number | undefined {
    if (
      !(#nativeLength in frame) ||
      Object.getPrototypeOf(frame) !== SceneSlotFrame.prototype ||
      Object.hasOwn(frame, 'indexOfSlot') ||
      Object.getOwnPropertyDescriptor(SceneSlotFrame.prototype, 'indexOfSlot')?.value !==
        sceneSlotFrameRank
    )
      return undefined;
    return Object.getOwnPropertyDescriptor(frame, 'capacity')?.value === frame.#nativeLength
      ? frame.#nativeLength
      : 0;
  }

  /** Find the first consumer result in the immutable page and occupied-lane order.
   * Returning a result stops before the next row or Mesh is observed. */
  findContent<T>(
    visit: (content: RowContent, entity: number, slot: number) => T | undefined,
    members?: FrameSet,
  ): T | undefined {
    if (members !== undefined)
      return members.findWord((word, bits) => this.findContentWord(word, bits, visit));
    for (const node of nodes(this.root)) {
      const page = node.value;
      const first = node.key * PAGE_SIZE;
      if (page.count === PAGE_SIZE) {
        for (let lane = 0; lane < PAGE_SIZE; lane++) {
          const result = visit(
            page.contents[lane] as RowContent,
            page.entities[lane] as number,
            first + lane,
          );
          if (result !== undefined) return result;
        }
        continue;
      }
      for (let half = 0; half < PAGE_SIZE; half += 32) {
        const result = findWordContent(
          page,
          first,
          half,
          half === 0 ? page.lowMask : page.highMask,
          visit,
        );
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }

  /** Resolve one scene page for every selected lane in a physical word. */
  private findContentWord<T>(
    word: number,
    bits: number,
    visit: (content: RowContent, entity: number, slot: number) => T | undefined,
  ): T | undefined {
    const page = this.pageAt(Math.floor(word / 2));
    if (page === undefined) return undefined;
    const half = (word % 2) * 32;
    return findWordContent(
      page,
      word * 32 - half,
      half,
      bits & (half === 0 ? page.lowMask : page.highMask),
      visit,
    );
  }

  /** Build a display subset in physical order. Ranks belong to the view being filtered. */
  selectContent(
    admits: (row: RowContent, rank: number) => boolean,
    view?: FrameSet,
    indexed?: FrameSet,
  ): FrameSet {
    if (
      view === undefined &&
      indexed !== undefined &&
      SceneSlotFrame.directRankLimit(this) === undefined
    ) {
      // A custom rank reader may remap or omit individual addresses.
      return indexed.filter((slot) => {
        const rank = this.indexOfSlot(slot);
        return (
          rank !== undefined && this.readContentSlot(slot, (row) => admits(row, rank)) === true
        );
      });
    }
    let rank = 0;
    const evaluate = (
      page: Page,
      half: number,
      candidates: number,
      domain: number,
      baseRank: number,
    ) => {
      let accepted = 0;
      for (let bits = candidates; bits !== 0; bits &= bits - 1) {
        const bit = bits & -bits;
        const row = page.contents[half + 31 - Math.clz32(bit)] as RowContent;
        if (admits(row, baseRank + popcount(domain & (bit - 1)))) accepted |= bit;
      }
      return accepted;
    };
    const byFact = indexed !== undefined && (view === undefined || indexed.size < view.size);
    const roster = byFact ? indexed : view;
    if (roster !== undefined) {
      return roster.filterWords((word, bits) => {
        const page = this.pageAt(Math.floor(word / 2));
        const half = (word % 2) * 32;
        const occupied = (half === 0 ? page?.lowMask : page?.highMask) ?? 0;
        const domain = byFact ? (view?.wordAt(word) ?? occupied) : bits;
        const candidates = occupied & domain & bits & (byFact ? -1 : (indexed?.wordAt(word) ?? -1));
        const prior = rank;
        if (!byFact) rank += popcount(domain);
        if (page === undefined || candidates === 0) return 0;
        let baseRank = prior;
        if (byFact) {
          const first = word * 32 + 31 - Math.clz32(domain & -domain);
          baseRank = (view === undefined ? this.indexOfSlot(first) : view.indexOf(first)) as number;
        }
        return evaluate(page, half, candidates, domain, baseRank);
      });
    }
    return FrameSet.fromOrderedWords((write) => {
      for (const node of nodes(this.root)) {
        const page = node.value;
        for (let half = 0; half < PAGE_SIZE; half += 32) {
          const occupied = half === 0 ? page.lowMask : page.highMask;
          if (occupied === 0) continue;
          const kept = evaluate(page, half, occupied, occupied, rank);
          if (kept !== 0) write(node.key * 2 + half / 32, kept);
          rank += popcount(occupied);
        }
      }
    });
  }

  drawMaterials(content: RowContent, meshes: MeshFrame) {
    return this.shapes.materials(content, meshes);
  }

  /** Resolve the exact same Mesh and appended water materials as the public draw row. */
  drawContent(content: RowContent, meshes: MeshFrame): RowContent {
    return this.shapes.resolve(content, meshes);
  }

  static hasNativeIteration(frame: SceneSlotFrame): boolean {
    return (
      Object.getPrototypeOf(frame) === SceneSlotFrame.prototype &&
      Object.getOwnPropertyDescriptor(frame, Symbol.iterator) === undefined &&
      Object.getOwnPropertyDescriptor(SceneSlotFrame.prototype, Symbol.iterator)?.value ===
        sceneSlotIterator
    );
  }

  /** Read shared row content by physical slot without deriving a rank or draw snapshot. */
  readContentSlot<T>(
    slot: number,
    read: (content: RowContent, entityKey: number, slot: number) => T,
  ): T | undefined {
    if (!validSlot(slot)) return undefined;
    const page = this.pageAt(Math.floor(slot / PAGE_SIZE));
    const lane = slot & PAGE_MASK;
    const content = page?.contents[lane];
    return page === undefined || content === undefined
      ? undefined
      : read(content, page.entities[lane] as number, slot);
  }

  /** Read shared row content at a frame rank without opening a public pose window. */
  readContentAt<T>(
    index: number,
    read: (content: RowContent, entityKey: number, slot: number) => T,
  ): T | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    // The current page and its base rank belong to this immutable frame.
    let node = this.rankNode;
    let start = this.rankStart;
    let target: number;
    if (node !== undefined && index >= start && index < start + node.weight) {
      target = index - start;
    } else {
      node = this.root;
      let rest = index;
      let left = 0;
      while (node !== undefined) {
        left = node.left?.count ?? 0;
        if (rest < left) node = node.left;
        else if (rest >= left + node.weight) {
          rest -= left + node.weight;
          node = node.right;
        } else break;
      }
      if (node === undefined) return undefined;
      target = rest - left;
      start = index - target;
    }
    this.rankNode = node;
    this.rankStart = start;
    const lane = laneAtRank(node.value, target);
    return read(
      node.value.contents[lane] as RowContent,
      node.value.entities[lane] as number,
      node.key * PAGE_SIZE + lane,
    );
  }

  /**
   * Visit the row changes logged between `previous` and this frame of the
   * same owner, in O(changes). `false` (nothing visited) when the frames have
   * different owners or the log no longer holds `previous`'s cursor.
   */
  /** The owner's row journal; `undefined` for an ownerless frame. */
  get journal(): RowChangeLog | undefined {
    return this.log;
  }

  changesSince(
    previous: SceneSlotFrame,
    visit: (slot: number, kind: RowChange, generation: number) => void,
  ): boolean {
    if (this.log === undefined || previous.log !== this.log) return false;
    return this.log.visit(previous.position, this.position, visit);
  }

  /** Visit final values for draw/cull consumers. Older cursors can replay the retained journal. */
  visitChangedVersions(previous: SceneSlotFrame, visit: (slot: number, version: number) => void) {
    if (this.log === undefined || this.log !== previous.log) return false;
    if (previous === this) return true;
    if (previous.position !== this.previousPosition)
      return this.changesSince(previous, (slot) => visit(slot, this.versionAt(slot)));
    const base = this.linearVersionBase;
    return this.log.visitPublication(
      this.publicationStart,
      this.position,
      base ?? 0,
      visit,
      base === undefined ? (slot) => this.versionAt(slot) : undefined,
    );
  }

  /** Resolve only one known slot when assembling its actual dispatch entry. */
  indexOfSlot(slot: number): number | undefined {
    if (!validSlot(slot)) return undefined;
    // Capacity is the exclusive physical high-water address. A full domain has rank equal to slot.
    if (this.#nativeLength === this.capacity) return slot < this.capacity ? slot : undefined;
    const page = Math.floor(slot / PAGE_SIZE);
    let node = this.rankNode;
    if (node === undefined || node.key !== page) {
      node = this.root;
      let start = 0;
      while (node !== undefined && node.key !== page) {
        if (page < node.key) node = node.left;
        else {
          start += (node.left?.count ?? 0) + node.weight;
          node = node.right;
        }
      }
      if (node === undefined) return undefined;
      this.rankNode = node;
      this.rankStart = start + (node.left?.count ?? 0);
    }
    const lane = slot & PAGE_MASK;
    if (node.weight === PAGE_SIZE) return this.rankStart + lane;
    const mask = lane < 32 ? node.value.lowMask : node.value.highMask;
    const bit = 1 << (lane & 31);
    if ((mask & bit) === 0) return undefined;
    return (
      this.rankStart + (lane < 32 ? 0 : popcount(node.value.lowMask)) + popcount(mask & (bit - 1))
    );
  }

  [Symbol.iterator](): IterableIterator<RenderSceneSlot> {
    return new SceneSlotIterator(this.root);
  }
}

/** Each walk pins its own immutable pages and visits occupied lanes with one result cell. */
class SceneSlotIterator implements IterableIterator<RenderSceneSlot> {
  private pages: IterableIterator<Node<Page>> | undefined;
  private page: Page | undefined;
  private base = 0;
  private word = 0;
  private high = 0;
  private readonly result: { value: RenderSceneSlot | undefined; done: boolean } = {
    value: undefined,
    done: false,
  };

  constructor(root: Node<Page> | undefined) {
    this.pages = nodes(root);
  }

  next(): IteratorResult<RenderSceneSlot> {
    while (this.word === 0) {
      if (this.high !== 0) {
        this.base += 32;
        this.word = this.high;
        this.high = 0;
      } else {
        const next = this.pages?.next();
        if (next === undefined || next.done) return this.return();
        this.page = next.value.value;
        this.base = 0;
        this.word = this.page.lowMask;
        this.high = this.page.highMask;
      }
    }
    const lane = 31 - Math.clz32(this.word & -this.word);
    this.word &= this.word - 1;
    this.result.value = (this.page as Page).read(this.base + lane);
    return this.result as IteratorResult<RenderSceneSlot>;
  }

  return(): IteratorResult<RenderSceneSlot> {
    this.pages = undefined;
    this.page = undefined;
    this.word = this.high = 0;
    this.result.value = undefined;
    this.result.done = true;
    return this.result as IteratorResult<RenderSceneSlot>;
  }

  [Symbol.iterator](): IterableIterator<RenderSceneSlot> {
    return this;
  }
}

type MeshLodState = 'absent' | 'lods' | 'plain';

interface LodBucket {
  instances: number;
  withSourceLods: number;
  mesh: MeshLodState;
}

/**
 * Candidate count of rows whose draw projection carries LOD levels: a row drawn
 * through its shared Mesh reads that Mesh's levels, every other row its own.
 * Maintained from slot writes and Mesh changes, so a frame reads it in O(1).
 */
const sceneSlotFrameRank = SceneSlotFrame.prototype.indexOfSlot;
const sceneSlotFrameAt = SceneSlotFrame.prototype.at;
const sceneSlotIterator = SceneSlotFrame.prototype[Symbol.iterator];

class LodCandidates {
  total = 0;
  private readonly buckets = new Map<number, LodBucket>();
  private static contribution(bucket: LodBucket): number {
    return bucket.mesh === 'absent'
      ? bucket.withSourceLods
      : bucket.mesh === 'lods'
        ? bucket.instances
        : 0;
  }

  slot(snapshot: RowContent, sign: 1 | -1): void {
    const hasLods = (snapshot.lods?.length ?? 0) > 0 ? 1 : 0;
    if (
      snapshot.terrain !== undefined ||
      snapshot.materialOverrides === undefined ||
      snapshot.assetHandle === undefined
    ) {
      this.total += sign * hasLods;
      return;
    }
    const key = snapshot.assetHandle;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { instances: 0, withSourceLods: 0, mesh: 'absent' };
      this.buckets.set(key, bucket);
    }
    const before = LodCandidates.contribution(bucket);
    bucket.instances += sign;
    bucket.withSourceLods += sign * hasLods;
    this.total += LodCandidates.contribution(bucket) - before;
    if (bucket.instances === 0 && bucket.mesh === 'absent') this.buckets.delete(key);
  }

  mesh(handle: number, lods: boolean | undefined): void {
    const key = handle;
    const state: MeshLodState = lods === undefined ? 'absent' : lods ? 'lods' : 'plain';
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (state === 'absent') return;
      bucket = { instances: 0, withSourceLods: 0, mesh: 'absent' };
      this.buckets.set(key, bucket);
    }
    const before = LodCandidates.contribution(bucket);
    bucket.mesh = state;
    this.total += LodCandidates.contribution(bucket) - before;
    if (bucket.instances === 0 && state === 'absent') this.buckets.delete(key);
  }

  clearMeshes(): void {
    for (const [key, bucket] of this.buckets) {
      this.total -= LodCandidates.contribution(bucket);
      bucket.mesh = 'absent';
      this.total += LodCandidates.contribution(bucket);
      if (bucket.instances === 0) this.buckets.delete(key);
    }
  }
}

/** Fixed sparse membership; known row edits copy only touched numeric bitmap pages. */
class SlotIndex {
  private members = new FrameSet();
  private readonly pending = new Map<number, boolean>();

  set(slot: number, member: boolean): void {
    if (member === (this.pending.get(slot) ?? this.members.has(slot))) return;
    this.pending.set(slot, member);
  }

  slots(): FrameSet {
    if (this.pending.size > 0) {
      this.members = this.members.edit(this.pending);
      this.pending.clear();
    }
    return this.members;
  }
}

export type SceneRowPose = ArrayLike<number> | CapturedSceneTransform;

/** A borrowed pose is copied, while a captured pose retains its existing numeric backing. */
export interface SceneRowWrite {
  readonly entityKey: number;
  readonly generation: number;
  readonly content: RowContent;
  readonly pose: SceneRowPose;
  readonly poseOffset?: number;
}

/** An unpublished address from this owner; neither rows nor captured frames include it. */
export interface SceneSlotReservation {
  readonly slot: number;
  readonly generation: number;
  isCurrent(): boolean;
  publish(row: SceneRowWrite): RenderSceneSlot;
  release(): void;
}

/** A pose delta owns its captured root and addresses it through the existing journal.
 * Delayed readers can recover exact write order from the immutable versions if the ring laps. */
export class PublishedPoseRows extends FrameListBase<RenderSceneSlot> {
  readonly length: number;
  private recovered: readonly RenderSceneSlot[] | undefined;

  constructor(
    private frame: SceneSlotFrame | undefined,
    private journal: RowChangeLog | undefined,
    private readonly first: number,
    private readonly baseVersion: number,
    private readonly poseCount: number,
    private readonly prefix: readonly RenderSceneSlot[],
  ) {
    super();
    this.length = prefix.length + poseCount;
  }

  at(index: number): RenderSceneSlot | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    return index >= 0 && index < this.length ? this.writtenAt(index) : undefined;
  }

  override forEach(consume: (value: RenderSceneSlot, index: number) => void): void {
    for (let index = 0; index < this.length; index++) consume(this.writtenAt(index), index);
  }

  /** Structural writes lead in the same order. Synchronous pose readers need no row views. */
  visitWrites(
    visitRow: (row: RenderSceneSlot, index: number) => void,
    visitPose: PoseVisitor,
  ): void {
    this.prefix.forEach(visitRow);
    const start = this.prefix.length;
    for (let index = 0; index < this.poseCount; index++) {
      const slot = this.journal?.updateSlotAt(this.first + index);
      const ordinal = start + index;
      if (this.frame !== undefined && slot !== undefined)
        this.frame.visitPose(slot, ordinal, visitPose);
      else visitRowPose(this.writtenAt(ordinal) as SceneDrawSlot, ordinal, visitPose);
    }
  }

  *[Symbol.iterator](): IterableIterator<RenderSceneSlot> {
    for (let index = 0; index < this.length; index++) yield this.writtenAt(index);
  }

  private writtenAt(index: number): RenderSceneSlot {
    if (index < this.prefix.length) return this.prefix[index] as RenderSceneSlot;
    index -= this.prefix.length;
    const recovered = this.recovered;
    if (recovered !== undefined) return recovered[index] as RenderSceneSlot;
    const frame = this.frame as SceneSlotFrame;
    const slot = this.journal?.updateSlotAt(this.first + index);
    if (slot === undefined) return this.recover(frame)[index] as RenderSceneSlot;
    return frame.slotAt(slot) as RenderSceneSlot;
  }

  private recover(frame: SceneSlotFrame): readonly RenderSceneSlot[] {
    // A held delta can outlive the live journal, including after a full reload.
    const rows = new Array<RenderSceneSlot>(this.poseCount);
    let found = 0;
    for (const row of frame) {
      const index = row.version - this.baseVersion - 1;
      if (index < 0 || index >= rows.length) continue;
      rows[index] = row;
      found++;
    }
    if (found !== rows.length)
      throw new Error('A captured pose delta must own all its row versions');
    this.recovered = rows;
    this.frame = undefined;
    this.journal = undefined;
    return rows;
  }
}

/** One mutable owner; known writes coalesce per page before a frame is captured. */
export class SceneSlots {
  private readonly shapes = new SceneMeshDrawShapes();
  private readonly log = new RowChangeLog();
  /** The one row journal of this owner, shared by row and GPU content consumers. */
  get journal(): RowChangeLog {
    return this.log;
  }
  private contentEpoch: object | undefined = Object.freeze({});
  private frame = new SceneSlotFrame(
    undefined,
    0,
    IdentityMap.EMPTY,
    this.shapes,
    this.log,
    0,
    undefined,
    this.contentEpoch,
    false,
  );
  private readonly pending = new FrameKeyRoster<number, SceneSlotPage>((key) => key);
  private replacementKeys = new Float64Array(0);
  private replacementKeyAllocations = 0;
  private publicationStart: number | undefined;
  private publishedVersion = 0;
  private publicationVersions = 0;
  private poseVersions: PoseVersions | undefined;
  private repeatedWrites = false;
  private identities = new IdentityMapEditor();
  private highWater = 0;
  private live = 0;
  private versions = 0;
  private newPages = 0;
  private copiedPages = 0;
  private copiedBytes = 0;
  private sourceCounts = emptySourceCounts();
  private authoredWaterOwners = 0;
  private nonDefaultRenderLayers = 0;
  private lods = new LodCandidates();
  private terrainSlots = new SlotIndex();
  private viewSourceSlots = new SlotIndex();
  private capsuleSlots = new SlotIndex();
  private pointsLinesSlots = new SlotIndex();
  private skinSlots = new SlotIndex();
  private rasterSlots = new SlotIndex();
  /** Released addresses, reused last-in first-out; generations survive reuse. */
  private readonly freeSlots: number[] = [];
  private generations = new Uint32Array(64);
  private nextAddress = 0;
  private readonly reservations = new Map<number, SceneSlotReservation>();

  constructor(private readonly poses = new ScenePoseWriter(COMPACT_SCENE_POSE_ROWS)) {}

  /**
   * The GPU row address for a new row: the most recently released slot with
   * its next generation, or a fresh address past the high-water mark.
   */
  allocate(): { readonly slot: number; readonly generation: number } {
    const reused = this.freeSlots.pop();
    if (reused === undefined) return { slot: this.nextAddress++, generation: 0 };
    const generation = (this.generations[reused] as number) + 1;
    this.generations[reused] = generation;
    return { slot: reused, generation };
  }

  reserve(): SceneSlotReservation {
    const { slot, generation } = this.allocate();
    let owner: SceneSlots | undefined = this;
    const current = () => owner?.reservations.get(slot) === api;
    const api: SceneSlotReservation = Object.freeze({
      slot,
      generation,
      isCurrent: current,
      publish: (row: SceneRowWrite) => {
        const target = owner;
        if (target === undefined || !current() || row.generation !== generation)
          throw new Error('Scene slot reservation is not current');
        const record = target.writeRow(slot, row);
        target.reservations.delete(slot);
        owner = undefined;
        return record;
      },
      release: () => {
        const target = owner;
        if (target !== undefined && current()) {
          if (target.content(slot) !== undefined)
            throw new Error('A partially published Scene slot retains its cleanup responsibility');
          target.reservations.delete(slot);
          target.ensureGeneration(slot);
          target.generations[slot] = generation;
          target.freeSlots.push(slot);
        }
        owner = undefined;
      },
    });
    this.reservations.set(slot, api);
    return api;
  }

  get freeCount(): number {
    return this.freeSlots.length;
  }

  /** Ascending addresses of rows carrying Terrain, a requested capsule shadow, a Skin Binding, or Points/Lines. */
  indexedSlots(kind: SparseRowKind): FrameSet {
    switch (kind) {
      case 'terrain':
        return this.terrainSlots.slots();
      case 'viewSource':
        return this.viewSourceSlots.slots();
      case 'capsule':
        return this.capsuleSlots.slots();
      case 'skin':
        return this.skinSlots.slots();
      case 'raster':
        return this.rasterSlots.slots();
      case 'pointsLines':
        return this.pointsLinesSlots.slots();
    }
  }

  /** Rows whose draw projection has LOD levels, given the Meshes reported by `setMeshLods`. */
  get lodCandidateCount(): number {
    return this.lods.total;
  }

  /** `undefined` reports the shared Mesh as not resident in the draw frame. */
  setMeshLods(handle: number, lods: boolean | undefined): void {
    this.lods.mesh(handle, lods);
  }

  clearMeshLods(): void {
    this.lods.clearMeshes();
  }

  hasSource(kind: SceneGeneratedSource): boolean {
    return this.sourceCounts[kind] > 0;
  }

  get capacity(): number {
    return this.highWater;
  }
  get size(): number {
    return this.live;
  }

  lookup(entity: number): RenderSceneSlot | undefined {
    const slot = this.identities.get(entity);
    return slot === undefined ? undefined : this.get(slot);
  }

  slotOf(entity: number): number | undefined {
    return this.identities.get(entity);
  }

  private page(slot: number): Page | undefined {
    const key = Math.floor(slot / PAGE_SIZE);
    return this.pending.get(key) ?? this.frame.pageAt(key);
  }

  get(slot: number): RenderSceneSlot | undefined {
    if (!validSlot(slot)) return undefined;
    const page = this.page(slot);
    return page?.read(slot);
  }

  /** The current row's version (0 when absent): a write always changes it. */
  version(slot: number): number {
    return validSlot(slot) ? (this.page(slot)?.versionAt(slot & PAGE_MASK) ?? 0) : 0;
  }

  /** Compare a synchronous source window without creating a row, snapshot or matrix view. */
  comparePose(
    slot: number,
    source: ArrayLike<number>,
    offset = 0,
  ): 'absent' | 'unchanged' | 'pose' | 'parity' {
    const page = validSlot(slot) ? this.page(slot) : undefined;
    return page?.comparePose(slot & PAGE_MASK, source, offset) ?? 'absent';
  }

  /** The current row's shared content, without materializing a read view. */
  content(slot: number): RowContent | undefined {
    return validSlot(slot) ? this.page(slot)?.contents[slot & PAGE_MASK] : undefined;
  }

  private writable(slot: number): SceneSlotPage {
    const key = Math.floor(slot / PAGE_SIZE);
    let page = this.pending.get(key);
    if (page === undefined) {
      const before = this.frame.pageAt(key);
      page = new SceneSlotPage(this.shapes, key * PAGE_SIZE, before);
      this.pending.add(key, page);
      if (before === undefined) this.newPages++;
      else {
        this.copiedPages++;
        this.copiedBytes += PAGE_SIZE * 8;
      }
    }
    return page;
  }

  private copyPose(
    slot: number,
    generation: number,
    entity: number,
    content: RowContent,
    pose: ArrayLike<number>,
    offset: number,
    groupRows?: number,
  ): SceneDrawSlot {
    const { column, offset: start } = this.poses.reserve(groupRows);
    copyScenePose(column, start, pose, offset);
    return this.issue(slot, generation, entity, content, column, start);
  }

  private issue(
    slot: number,
    generation: number,
    entity: number,
    content: RowContent,
    column: Float32Array,
    offset: number,
  ): SceneDrawSlot {
    return new SceneDrawSlot(
      slot,
      generation,
      this.nextVersion(),
      entity,
      content,
      column,
      offset,
      this.shapes,
    );
  }

  /**
   * History covers about two full-scene rewrites before old cursors lapse;
   * GPU content entries (up to three per changed row) share the ring.
   */
  private logChange(page: SceneSlotPage, slot: number, kind: RowChange, generation: number): void {
    this.publicationStart ??= this.log.position;
    const followup = !page.noteWrite(slot);
    if (followup) this.repeatedWrites = true;
    if (kind !== 'leave') this.publicationVersions++;
    this.log.append(slot, kind, generation, 8 * this.live, followup);
  }

  private nextVersion(): number {
    this.versions++;
    return this.versions;
  }

  private account(slot: number, content: RowContent | undefined, sign: 1 | -1): void {
    if (content === undefined) return;
    if (content.terrain !== undefined) this.sourceCounts.terrain += sign;
    if (content.glyph !== undefined) this.sourceCounts.glyph += sign;
    if (content.tilemap !== undefined) this.sourceCounts.tilemap += sign;
    if (content.waterMeshSource !== undefined) this.sourceCounts.waterMeshSource += sign;
    if (content.waterOwner !== undefined) this.authoredWaterOwners += sign;
    if ((content.renderLayers ?? 1) !== 1) this.nonDefaultRenderLayers += sign;
    this.lods.slot(content, sign);
    if (sign === 1) {
      this.terrainSlots.set(slot, content.terrain !== undefined);
      this.viewSourceSlots.set(
        slot,
        content.glyph !== undefined ||
          content.tilemap !== undefined ||
          content.terrain !== undefined ||
          content.terrainSection !== undefined ||
          content.generatedMesh !== undefined,
      );
      this.capsuleSlots.set(slot, content.capsuleShadowRequested === true);
      this.pointsLinesSlots.set(slot, content.pointsLines !== undefined);
      this.skinSlots.set(slot, content.skinBinding !== undefined);
      this.rasterSlots.set(slot, hasRasterDemand(content));
    }
  }

  /** Write one complete row; returns its new read view. */
  write(slot: number, row: SceneRowWrite, groupRows?: number): RenderSceneSlot {
    if (this.reservations.has(slot))
      throw new Error('An unpublished Scene slot belongs to its reservation');
    return this.writeRow(slot, row, groupRows);
  }

  private writeRow(slot: number, row: SceneRowWrite, groupRows?: number): RenderSceneSlot {
    if (!validSlot(slot)) throw new RangeError('Scene write requires a non-negative slot address');
    const { pose, entityKey, generation, content } = row;
    const column = CapturedSceneTransform.column(pose);
    const offset = CapturedSceneTransform.offset(pose) + (row.poseOffset ?? 0);
    const lane = slot & PAGE_MASK;
    const issued =
      column instanceof Float32Array &&
      (pose instanceof CapturedSceneTransform || this.page(slot)?.hasPose(lane, column, offset))
        ? this.issue(slot, generation, entityKey, content, column, offset)
        : this.copyPose(slot, generation, entityKey, content, column, offset, groupRows);
    const page = this.writable(slot);
    const previous = page.contents[lane];
    const previousGeneration = page.generationAt(lane);
    let change: RowChange = 'enter';
    if (previous !== undefined && previousGeneration !== undefined) {
      const entityKey = page.entities[lane] as number;
      this.account(slot, previous, -1);
      if (entityKey !== row.entityKey) {
        if (this.identities.get(entityKey) === slot) this.identities.delete(entityKey);
        this.identities.set(row.entityKey, slot);
        this.logChange(page, slot, 'leave', previousGeneration);
      } else change = 'update';
    } else {
      if (lane < 32) page.lowMask |= 1 << lane;
      else page.highMask |= 1 << (lane - 32);
      page.count++;
      this.live++;
      this.identities.set(row.entityKey, slot);
    }
    this.logChange(page, slot, change, row.generation);
    if (change !== 'update' || previous !== row.content || previousGeneration !== row.generation)
      this.contentEpoch = undefined;
    page.setRow(lane, issued);
    this.copiedBytes += page.setContent(lane, row.content, row.entityKey);
    this.account(slot, row.content, 1);
    this.highWater = Math.max(this.highWater, slot + 1);
    this.nextAddress = Math.max(this.nextAddress, slot + 1);
    this.ensureGeneration(slot);
    this.generations[slot] = row.generation;
    return issued;
  }

  private ensureGeneration(slot: number): void {
    if (slot >= this.generations.length) {
      let capacity = this.generations.length;
      while (capacity <= slot) capacity *= 2;
      const grown = new Uint32Array(capacity);
      grown.set(this.generations);
      this.generations = grown;
    }
  }

  /** Replace only the live row's pose; returns its new read view. */
  writePose(slot: number, pose: SceneRowPose, offset = 0, groupRows?: number): RenderSceneSlot {
    const page = validSlot(slot) ? this.page(slot) : undefined;
    const lane = slot & PAGE_MASK;
    const content = page?.contents[lane];
    const generation = page?.generationAt(lane);
    if (page === undefined || content === undefined || generation === undefined)
      throw new RangeError('A pose write requires a live Scene row');
    const entity = page.entities[lane] as number;
    const issued =
      pose instanceof CapturedSceneTransform
        ? this.issue(slot, generation, entity, content, pose.poseColumn, pose.poseOffset + offset)
        : this.copyPose(slot, generation, entity, content, pose, offset, groupRows);
    const pending = this.writable(slot);
    pending.setRow(lane, issued);
    this.logChange(pending, slot, 'update', generation);
    return issued;
  }

  /** Native numeric publication stages a version without constructing its read view. */
  writePreparedPose(
    slot: number,
    pose: Readonly<Float32Array>,
    offset: number,
    groupRows: number,
  ): void {
    const page = this.writable(slot);
    const lane = slot & PAGE_MASK;
    const generation = page.generationAt(lane);
    if (generation === undefined) throw new RangeError('A pose write requires a live Scene row');
    const { column, offset: start } = this.poses.reserve(groupRows);
    copyScenePose(column, start, pose, offset);
    let group = this.poseVersions;
    if (group?.column !== column) group = this.poseVersions = new PoseVersions(column);
    group.write(start, generation, this.nextVersion());
    page.setPose(lane, group, start);
    this.logChange(page, slot, 'update', generation);
  }

  /** The journal suffix contains uniquely written poses after any named structural rows. */
  capturePoseChanges(
    from: number,
    prefix: readonly RenderSceneSlot[] = EMPTY_FRAME_ROWS,
  ): FrameList<RenderSceneSlot> {
    const count = this.log.position - from;
    return count === 0
      ? prefix
      : new PublishedPoseRows(this.capture(), this.log, from, this.versions - count, count, prefix);
  }

  /** ECS presentation and validated publications supply disjoint numeric rows. */
  writeDistinctPoseSpans(spans: readonly WorldTransformSpan[], content: RenderSceneSlot[]): number {
    let ignored = 0;
    for (const { entities, worlds, rows } of spans) {
      const count = rows?.length ?? entities.length;
      for (let cursor = 0; cursor < count; cursor++) {
        const index = rows?.[cursor] ?? cursor;
        const slot = this.identities.get(entities[index] as number);
        const offset = index * POSE;
        const change = slot === undefined ? 'absent' : this.comparePose(slot, worlds, offset);
        if (slot === undefined || change === 'absent') {
          ignored++;
          continue;
        }
        if (change === 'unchanged') continue;
        if (change === 'parity') content.push(this.writePose(slot, worlds, offset, count - cursor));
        else this.writePreparedPose(slot, worlds, offset, count - cursor);
      }
    }
    return ignored;
  }

  /** Remove the live row and release its address for reuse. */
  remove(slot: number): void {
    if (!validSlot(slot))
      throw new RangeError('Scene removal requires a non-negative slot address');
    const lane = slot & PAGE_MASK;
    const before = this.page(slot);
    const content = before?.contents[lane];
    const generation = before?.generationAt(lane);
    if (before === undefined || content === undefined || generation === undefined) return;
    this.freeSlots.push(slot);
    const page = this.writable(slot);
    const entityKey = before.entities[lane] as number;
    this.account(slot, content, -1);
    this.terrainSlots.set(slot, false);
    this.viewSourceSlots.set(slot, false);
    this.capsuleSlots.set(slot, false);
    this.pointsLinesSlots.set(slot, false);
    this.skinSlots.set(slot, false);
    this.rasterSlots.set(slot, false);
    if (this.identities.get(entityKey) === slot) this.identities.delete(entityKey);
    this.logChange(page, slot, 'leave', generation);
    this.contentEpoch = undefined;
    page.setRow(lane, undefined);
    this.copiedBytes += page.setContent(lane, undefined, 0);
    if (lane < 32) page.lowMask &= ~(1 << lane);
    else page.highMask &= ~(1 << (lane - 32));
    page.count--;
    this.live--;
  }

  capture(): SceneSlotFrame {
    const identities = this.identities.capture();
    if (this.pending.size === 0 && identities === this.frame.identities) return this.frame;
    const root = this.commitPages();
    const fewerRows = this.live < this.frame.length;
    const pageCount = root?.size ?? 0;
    if (fewerRows) {
      this.log.trim(8 * this.live);
      if (pageCount === 0 || shouldShrinkCapacity(pageCount, this.replacementKeys.length))
        this.replacementKeys = new Float64Array(0);
    }
    if (this.live === 0) this.clearPoses();
    const linearVersionBase =
      !this.repeatedWrites && this.versions - this.publishedVersion === this.publicationVersions
        ? this.publishedVersion
        : undefined;
    if (fewerRows && (pageCount === 0 || shouldShrinkCapacity(pageCount, this.pending.capacity)))
      this.pending.reset();
    else this.pending.clear();
    this.contentEpoch ??= Object.freeze({});
    this.frame = new SceneSlotFrame(
      root,
      this.highWater,
      identities,
      this.shapes,
      this.log,
      this.log.position,
      {
        terrain: this.indexedSlots('terrain'),
        viewSource: this.indexedSlots('viewSource'),
        capsule: this.indexedSlots('capsule'),
        skin: this.indexedSlots('skin'),
        raster: this.indexedSlots('raster'),
        pointsLines: this.indexedSlots('pointsLines'),
      },
      this.contentEpoch,
      this.authoredWaterOwners > 0 || this.hasSource('waterMeshSource'),
      this.nonDefaultRenderLayers === 0,
      this.frame.position,
      this.publicationStart,
      linearVersionBase,
    );
    this.resetPublication();
    return this.frame;
  }

  private commitPages(): Node<Page> | undefined {
    let root = this.frame.root;
    if (this.pending.size < 2) {
      if (this.pending.size === 1) {
        const key = this.pending.keyAt(0);
        const page = this.pending.versionAt(0);
        root = page.count === 0 ? remove(root, 0, key) : put(root, page, 0, key, page.count);
      }
      return root;
    }
    let keys = this.replacementKeys;
    let count = 0;
    let ordered = true;
    for (let index = 0; index < this.pending.size; index++) {
      const key = this.pending.keyAt(index);
      const page = this.pending.versionAt(index);
      if (page.count === 0) root = remove(root, 0, key);
      else if (!page.replacesCaptured) root = put(root, page, 0, key, page.count);
      else {
        if (count === keys.length) {
          const grown = new Float64Array(Math.max(8, this.pending.size, keys.length * 2));
          grown.set(keys);
          keys = this.replacementKeys = grown;
          this.replacementKeyAllocations++;
        }
        if (count > 0 && key < (keys[count - 1] as number)) ordered = false;
        keys[count++] = key;
      }
    }
    if (!ordered) keys.subarray(0, count).sort();
    return replaceOrdered(root, keys, 0, count, this.pending, rowPageWeight);
  }

  private clearPoses(): void {
    this.poses.clear();
    this.poseVersions = undefined;
  }

  clear(): void {
    this.pending.reset();
    this.resetPublication();
    this.replacementKeys = new Float64Array(0);
    this.identities.clear();
    this.clearPoses();
    this.log.reset();
    this.contentEpoch = Object.freeze({});
    this.frame = new SceneSlotFrame(
      undefined,
      0,
      IdentityMap.EMPTY,
      this.shapes,
      this.log,
      this.log.position,
      undefined,
      this.contentEpoch,
      false,
    );
    this.highWater = 0;
    this.nextAddress = 0;
    this.reservations.clear();
    this.live = 0;
    this.freeSlots.length = 0;
    this.generations = new Uint32Array(64);
    this.sourceCounts = emptySourceCounts();
    this.authoredWaterOwners = 0;
    this.nonDefaultRenderLayers = 0;
    this.lods = new LodCandidates();
    this.terrainSlots = new SlotIndex();
    this.viewSourceSlots = new SlotIndex();
    this.capsuleSlots = new SlotIndex();
    this.pointsLinesSlots = new SlotIndex();
    this.skinSlots = new SlotIndex();
    this.rasterSlots = new SlotIndex();
  }

  private resetPublication(): void {
    this.publicationStart = undefined;
    this.publishedVersion = this.versions;
    this.publicationVersions = 0;
    this.repeatedWrites = false;
  }

  inspect(): {
    newPages: number;
    copiedPages: number;
    estimatedCopiedPagePointerBytes: number;
    changeJournalBackingBytes: number;
    posePageAllocations: number;
    posePageAllocatedBytes: number;
    replacementKeyAllocations: number;
    replacementKeyBackingBytes: number;
    pendingPageCapacity: number;
    pendingPageGrowths: number;
    live: number;
    capacity: number;
  } {
    return {
      newPages: this.newPages,
      copiedPages: this.copiedPages,
      estimatedCopiedPagePointerBytes: this.copiedBytes,
      changeJournalBackingBytes: this.log.backingBytes,
      posePageAllocations: this.poses.pageAllocations,
      posePageAllocatedBytes: this.poses.pageAllocatedBytes,
      replacementKeyAllocations: this.replacementKeyAllocations,
      replacementKeyBackingBytes: this.replacementKeys.byteLength,
      pendingPageCapacity: this.pending.capacity,
      pendingPageGrowths: this.pending.bucketGrowths,
      live: this.live,
      capacity: this.highWater,
    };
  }
}
function entityOf(_content: RowContent, entity: number): number {
  return entity;
}

/** The identities admitted by this view's fixed Scene rows. Physical membership,
 * source iteration order and entity lookup all refer to the same captured frame. */
export class SlotIdentityKeys implements ReadonlySet<number> {
  constructor(
    private readonly roster: SceneSlotFrame,
    private readonly members?: FrameSet,
    private readonly sourceOrder = false,
  ) {}
  get size(): number {
    return this.members?.size ?? this.roster.identities.size;
  }
  usesSlotsOf(frame: SceneSlotFrame): boolean {
    return this.roster.journal !== undefined && this.roster.journal === frame.journal;
  }
  /** Visit physical slots whose admitted identity may have changed. The journal
   * covers reuse at one address. The view bitmap covers motion across its frustum. */
  changesSince(previous: SlotIdentityKeys, visit: (slot: number) => void): boolean {
    if (!this.usesSlotsOf(previous.roster)) return false;
    const before = previous.members;
    const after = this.members;
    if (
      this.roster.identities !== previous.roster.identities &&
      !this.roster.changesSince(previous.roster, (slot, kind) => {
        if (kind !== 'update' && (before?.has(slot) !== false || after?.has(slot) !== false))
          visit(slot);
      })
    )
      return false;
    if (before === after) return true;
    if (before !== undefined && after !== undefined) {
      after.changesSince(before, visit);
    } else {
      // Only a full/subset transition needs to enumerate the full frame's addresses.
      const partial = after ?? before;
      const full = after === undefined ? this.roster : previous.roster;
      full.findContent((_content, _entity, slot) => {
        if (!partial?.has(slot)) visit(slot);
        return undefined;
      });
    }
    return true;
  }
  has(entity: number): boolean {
    const slot = this.roster.identitySlot(entity);
    return slot !== undefined && this.members?.has(slot) !== false;
  }
  *values(): SetIterator<number> {
    if (this.members !== undefined) {
      for (const slot of this.members.borrowKeys()) {
        const entity = this.roster.readContentSlot(slot, entityOf);
        if (entity !== undefined) yield entity;
      }
    } else if (this.sourceOrder) {
      for (let rank = 0; rank < this.roster.length; rank++) {
        const entity = this.roster.readContentAt(rank, entityOf);
        if (entity !== undefined) yield entity;
      }
    } else {
      for (const [entity] of this.roster.identities.entries()) yield entity;
    }
  }
  keys(): SetIterator<number> {
    return this.values();
  }
  *entries(): SetIterator<[number, number]> {
    for (const key of this.values()) yield [key, key];
  }
  [Symbol.iterator](): SetIterator<number> {
    return this.values();
  }
  forEach(visit: (value: number, key: number, set: ReadonlySet<number>) => void): void {
    for (const key of this.values()) visit(key, key, this);
  }
}
