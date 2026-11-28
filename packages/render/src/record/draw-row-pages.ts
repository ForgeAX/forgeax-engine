import type { RenderableSnapshot } from '../render-system-extract';
import {
  CapturedSceneTransform,
  RecordingScenePose,
  type ScenePoseStorage,
} from '../scene/captured-transform';
import { FrameListBase, type FrameRange, JoinedFrameRows } from '../scene/frame-list';
import { drawPoseStorage, SceneDrawSlot } from '../scene/mesh-draw';
import type { SceneSlotFrame } from '../scene/scene-slots';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';

const WIDTH = 64;

interface Page {
  readonly writer: symbol;
  values: (Page | ValidatedRenderable)[];
  sharesValues?: boolean;
  capacity: number;
  stable: boolean;
  keepsNativeAddresses?: boolean;
  /** Leaves name the rows whose pose comes from the table's accepted Scene root. */
  sceneLow?: number | undefined;
  sceneHigh?: number | undefined;
}

function writable(page: Page | undefined, writer: symbol): Page {
  return page?.writer === writer
    ? page
    : {
        writer,
        values: page?.values ?? [],
        sharesValues: page !== undefined,
        capacity: page?.capacity ?? 0,
        stable: page?.stable ?? false,
        keepsNativeAddresses: page?.stable ?? false,
        sceneLow: page?.sceneLow,
        sceneHigh: page?.sceneHigh,
      };
}

function writeValue(page: Page, lane: number, value: Page | ValidatedRenderable): void {
  if (page.values[lane] === value) return;
  if (page.sharesValues) {
    page.values = page.values.slice();
    page.sharesValues = false;
  }
  page.values[lane] = value;
}

function stableAddress(row: ValidatedRenderable): boolean {
  const slot = row.sceneSlot;
  return (
    slot instanceof SceneDrawSlot &&
    slot.ownsSnapshot(row.source) &&
    row.source.nativeDraw === undefined &&
    row.source.terrainSection === undefined
  );
}

function sameGeometry(before: ValidatedRenderable, row: ValidatedRenderable): boolean {
  return (
    before.sceneSlot?.slot === row.sceneSlot?.slot &&
    before.sceneSlot?.generation === row.sceneSlot?.generation &&
    before.renderableIndex === row.renderableIndex &&
    before.meshSlot === row.meshSlot &&
    before.mesh === row.mesh &&
    before.world === row.world &&
    before.submeshIndices === row.submeshIndices &&
    before.renderState === row.renderState &&
    before.stencilReference === row.stencilReference &&
    before.variantSet === row.variantSet &&
    before.cpuInstanceLods === row.cpuInstanceLods &&
    before.foldedMeshSlot === row.foldedMeshSlot
  );
}

function readsScene(page: Page, lane: number): boolean {
  return (((lane < 32 ? page.sceneLow : page.sceneHigh) ?? 0) & (1 << (lane & 31))) !== 0;
}

function markScene(page: Page, lane: number, on: boolean): void {
  const half = lane < 32 ? 'sceneLow' : 'sceneHigh';
  const bit = 1 << (lane & 31);
  const before = page[half] ?? 0;
  page[half] = on ? before | bit : before & ~bit;
}

function ownsDraw(
  scene: SceneSlotFrame | undefined,
  row: ValidatedRenderable,
  linkedPose: boolean | undefined,
): boolean {
  const slot = row.sceneSlot;
  return (
    scene !== undefined &&
    slot instanceof SceneDrawSlot &&
    slot.ownsAuthoredSnapshot(row.source) &&
    row.source.nativeDraw === undefined &&
    row.source.terrainSection === undefined &&
    (linkedPose === true || scene.slotAt(slot.slot) === slot)
  );
}

function pageAt(root: Page, stride: number, index: number): Page {
  let page = root;
  for (let span = stride; span > 1; span /= WIDTH)
    page = page.values[Math.floor(index / span) % WIDTH] as Page;
  return page;
}

type MutableDrawRow = { -readonly [K in keyof ValidatedRenderable]: ValidatedRenderable[K] };

/** The active recorder owns these borrowed rows until its synchronous reader returns. */
export class RecordingDrawRow {
  private borrowedPose: RecordingScenePose | undefined;
  private row: MutableDrawRow | undefined;

  get pose(): RecordingScenePose {
    this.borrowedPose ??= new RecordingScenePose();
    return this.borrowedPose;
  }

  borrow(
    row: ValidatedRenderable,
    source: RenderableSnapshot,
    slot: SceneDrawSlot,
    numericPose: boolean,
  ): ValidatedRenderable {
    this.row ??= { ...row };
    const out = this.row;
    writeRecordingRow(out, row, source, slot);
    out.recordingPose = numericPose ? this.pose : row.recordingPose;
    return out;
  }

  clear(): void {
    this.borrowedPose?.clear();
    const row = this.row;
    if (row !== undefined) {
      // Keep the object shape but release all borrowed identities on pass exit.
      Object.assign(row, EMPTY_RECORDING_REFERENCES);
    }
  }
}

const EMPTY_RECORDING_REFERENCES = {
  source: undefined,
  sceneSlot: undefined,
  mesh: undefined,
  renderState: undefined,
  world: undefined,
  submeshIndices: undefined,
  cpuInstanceLods: undefined,
  variantSet: undefined,
  recordingPose: undefined,
};

function seal(page: Page, stride: number, writer: symbol): void {
  if (page.writer !== writer || (stride === 1 && page.keepsNativeAddresses)) return;
  let capacity = 0;
  let stable = true;
  if (stride === 1) {
    for (const row of page.values as ValidatedRenderable[]) {
      capacity = Math.max(capacity, row.meshSlot + 1);
      stable &&= stableAddress(row);
    }
  } else {
    for (const child of page.values as Page[]) {
      seal(child, stride / WIDTH, writer);
      if (child.writer === writer && !child.keepsNativeAddresses) page.keepsNativeAddresses = false;
      capacity = Math.max(capacity, child.capacity);
      stable &&= child.stable;
    }
  }
  page.capacity = capacity;
  page.stable = stable;
}

/** Fixed pass addresses. Each published root owns its changed paths and shares untouched pages. */
class DrawRowPages extends FrameListBase<ValidatedRenderable> {
  private readKey = -1;
  private readPage: Page | undefined;
  private observed: (ValidatedRenderable | undefined)[] | undefined;

  constructor(
    readonly length: number,
    readonly stride: number,
    readonly root: Page,
    readonly previousWriter?: symbol,
    readonly scene?: SceneSlotFrame,
  ) {
    super();
  }

  private leafAt(index: number): Page {
    const key = Math.floor(index / WIDTH);
    if (key === this.readKey && this.readPage !== undefined) return this.readPage;
    const page = pageAt(this.root, this.stride, index);
    this.readKey = key;
    this.readPage = page;
    return page;
  }

  bindsScenePose(index: number): boolean {
    return index >= 0 && index < this.length && readsScene(this.leafAt(index), index % WIDTH);
  }

  private movedSlot(page: Page, lane: number, row: ValidatedRenderable): SceneDrawSlot | undefined {
    const scene = this.scene;
    if (scene === undefined || !readsScene(page, lane)) return undefined;
    const placed = row.sceneSlot as SceneDrawSlot;
    const slot = scene.slotAt(placed.slot);
    return slot instanceof SceneDrawSlot && slot.retainsContentOf(placed) ? slot : undefined;
  }

  private observe(page: Page, index: number): ValidatedRenderable {
    const lane = index % WIDTH;
    const row = page.values[lane] as ValidatedRenderable;
    const slot = this.movedSlot(page, lane, row);
    if (slot === undefined) return row;
    this.observed ??= [];
    this.observed[index] ??= {
      ...row,
      source: slot.authoredSnapshot(),
      sceneSlot: slot,
    };
    return this.observed[index] as ValidatedRenderable;
  }

  at(index: number): ValidatedRenderable | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    return this.observe(this.leafAt(index), index);
  }

  sourceAt(index: number): RenderableSnapshot | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const page = this.leafAt(index);
    const lane = index % WIDTH;
    const row = page.values[lane] as ValidatedRenderable;
    const slot = this.movedSlot(page, lane, row);
    return slot === undefined ? row.source : slot.authoredSnapshot();
  }

  geometryAt(index: number): ValidatedRenderable | undefined {
    if (index < 0 || index >= this.length) return undefined;
    return this.leafAt(index).values[index % WIDTH] as ValidatedRenderable;
  }

  /** The row is valid only for the duration of consume. The packed values are immutable. */
  visitRecording(
    consume: (row: ValidatedRenderable, index: number) => void,
    start: number,
    numericPose: boolean,
    scratch?: RecordingDrawRow,
  ): void {
    const scene = this.scene;
    for (let first = 0; first < this.length; first += WIDTH) {
      const page = this.leafAt(first);
      for (let lane = 0; lane < page.values.length; lane++) {
        const row = page.values[lane] as ValidatedRenderable;
        const index = start + first + lane;
        if (scene === undefined || !readsScene(page, lane)) {
          consume(row, index);
          continue;
        }
        scratch ??= new RecordingDrawRow();
        consume(this.borrowLinkedRow(page, lane, row, scene, scratch, numericPose), index);
      }
    }
  }

  recordAt(
    index: number,
    scratch: RecordingDrawRow,
    numericPose: boolean,
  ): ValidatedRenderable | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const page = this.leafAt(index);
    const lane = index % WIDTH;
    const row = page.values[lane] as ValidatedRenderable;
    const scene = this.scene;
    if (scene === undefined || !readsScene(page, lane)) return row;
    return this.borrowLinkedRow(page, lane, row, scene, scratch, numericPose);
  }

  private borrowLinkedRow(
    page: Page,
    lane: number,
    row: ValidatedRenderable,
    scene: SceneSlotFrame,
    scratch: RecordingDrawRow,
    numericPose: boolean,
  ): ValidatedRenderable {
    if (numericPose) {
      const placed = row.sceneSlot as SceneDrawSlot;
      return scene.borrowReplacementPose(placed, scratch.pose)
        ? scratch.borrow(row, row.source, placed, true)
        : row;
    }
    const slot = this.movedSlot(page, lane, row);
    return slot === undefined ? row : scratch.borrow(row, slot.authoredSnapshot(), slot, false);
  }

  visitPositions(consume: (source: number, position: number) => void, start: number): void {
    for (let first = 0; first < this.length; first += WIDTH) {
      const page = this.leafAt(first);
      for (let lane = 0; lane < page.values.length; lane++)
        consume((page.values[lane] as ValidatedRenderable).renderableIndex, start + first + lane);
    }
  }

  override forEach(consume: (row: ValidatedRenderable, index: number) => void): void {
    for (let first = 0; first < this.length; first += WIDTH) {
      const page = this.leafAt(first);
      for (let lane = 0; lane < page.values.length; lane++)
        consume(this.observe(page, first + lane), first + lane);
    }
  }

  [Symbol.iterator](): IterableIterator<ValidatedRenderable> {
    let frame: DrawRowPages | undefined = this;
    let index = 0;
    let page: Page | undefined;
    const step: { value: ValidatedRenderable | undefined; done: boolean } = {
      value: undefined,
      done: false,
    };
    const close = (): IteratorResult<ValidatedRenderable> => {
      frame = undefined;
      page = undefined;
      step.done = true;
      step.value = undefined;
      return step as IteratorResult<ValidatedRenderable>;
    };
    return {
      next() {
        if (frame === undefined || index === frame.length) return close();
        const lane = index % WIDTH;
        if (lane === 0) page = frame.leafAt(index);
        step.value = frame.observe(page as Page, index);
        index++;
        return step as IteratorResult<ValidatedRenderable>;
      },
      return: close,
      [Symbol.iterator]() {
        return this;
      },
    };
  }
}

function writeRecordingRow(
  out: MutableDrawRow,
  row: ValidatedRenderable,
  source: RenderableSnapshot,
  slot: SceneDrawSlot,
): void {
  out.source = source;
  out.sceneSlot = slot;
  out.mesh = row.mesh;
  out.meshSlot = row.meshSlot;
  out.renderableIndex = row.renderableIndex;
  out.renderState = row.renderState;
  out.stencilReference = row.stencilReference;
  out.world = row.world;
  out.submeshIndices = row.submeshIndices;
  out.foldedMeshSlot = row.foldedMeshSlot;
  out.cpuInstanceLods = row.cpuInstanceLods;
  out.variantSet = row.variantSet;
}

/** Private recording reads the row synchronously. Retaining it requires the ordinary at API. */
export function visitRecordingDrawRows(
  rows: DrawRows,
  consume: (row: ValidatedRenderable, index: number) => void,
  mode: 'source' | 'pose' = 'source',
  start = 0,
  scratch?: RecordingDrawRow,
): void {
  if (rows instanceof DrawRowPages) rows.visitRecording(consume, start, mode === 'pose', scratch);
  else if (rows instanceof JoinedDrawRows) {
    for (const range of rows.ranges)
      visitRecordingDrawRows(range.rows, consume, mode, start + range.start, scratch);
  } else if (start === 0) visitSubmittedDrawRows(rows, consume);
  else visitSubmittedDrawRows(rows, (row, index) => consume(row, start + index));
}

/** Alternate camera order reads the same captured rows without observing detached snapshots. */
export function recordingDrawRowAt(
  rows: DrawRows,
  index: number,
  scratch: RecordingDrawRow,
  numericPose: boolean,
): ValidatedRenderable | undefined {
  if (rows instanceof DrawRowPages) return rows.recordAt(index, scratch, numericPose);
  if (rows instanceof JoinedDrawRows) return rows.recordAt(index, scratch, numericPose);
  return rows.at(index);
}

/** A recording reads the selected matrix directly; retained rows expose their owned transform. */
export function recordingDrawPose(
  row: Pick<ValidatedRenderable, 'recordingPose' | 'source'>,
): ScenePoseStorage {
  return row.recordingPose ?? drawPoseStorage(row.source);
}

export function recordingDrawReflected(
  row: Pick<ValidatedRenderable, 'recordingPose' | 'source'>,
): boolean {
  return CapturedSceneTransform.reflectedStorage(recordingDrawPose(row));
}

/** Index pass placement without observing any Scene snapshot. */
export function visitDrawPositions(
  rows: DrawRows,
  consume: (source: number, position: number) => void,
  start = 0,
): void {
  if (rows instanceof DrawRowPages) rows.visitPositions(consume, start);
  else if (rows instanceof JoinedDrawRows) {
    for (const range of rows.ranges) visitDrawPositions(range.rows, consume, start + range.start);
  } else {
    for (let index = 0; index < rows.length; index++) {
      const row = rows.at(index);
      if (row !== undefined) consume(row.renderableIndex, start + index);
    }
  }
}

/** A previously sealed placement may advance just its captured Scene input. */
export function canRebindDrawPose(rows: DrawRows, index: number): boolean {
  return rows instanceof DrawRowPages && rows.bindsScenePose(index);
}

export function rebindDrawPoses(rows: DrawRows, scene: SceneSlotFrame | undefined): DrawRows {
  if (!(rows instanceof DrawRowPages) || scene === undefined || rows.scene === scene) return rows;
  return new DrawRowPages(rows.length, rows.stride, rows.root, rows.root.writer, scene);
}

/** Sequential recording keeps the original material and fold address of every draw.
 * Borrowed providers retain indexed reads. Issued phase pages expose whole leaves. */
export function visitSubmittedDrawRows(
  rows: DrawRows,
  consume: (row: ValidatedRenderable, index: number) => void,
): void {
  if (rows instanceof DrawRowPages) rows.forEach(consume);
  else if (rows instanceof JoinedDrawRows) {
    for (const { rows: phase, start } of rows.ranges)
      visitSubmittedDrawRows(phase, (row, index) => consume(row, start + index));
  } else {
    for (let index = 0; index < rows.length; index++) {
      const row = rows.at(index);
      if (row !== undefined) consume(row, index);
    }
  }
}

/** Every row in this issued table belongs to an ordinary Scene slot. Terrain and
 * derived native draws have their own lifetime and need explicit roster admission. */
export function isOrdinarySceneDrawTable(rows: DrawRows): boolean {
  return (
    (rows instanceof DrawRowPages && rows.root.stable) ||
    (rows instanceof JoinedDrawRows &&
      rows.ranges.every((range) => isOrdinarySceneDrawTable(range.rows)))
  );
}

type FillDrawRows = (
  write: (
    index: number,
    row: ValidatedRenderable,
    poseDraft?: boolean,
    linkedPose?: boolean,
  ) => void,
) => void;

/** Complete publications write directly into final leaves, then reduce only the directory. */
function issueCompleteRows(
  length: number,
  fill: FillDrawRows,
  scene?: SceneSlotFrame,
): DrawRowPages {
  const writer = Symbol();
  const leaves: Page[] = new Array(Math.ceil(length / WIDTH));
  for (let index = 0; index < leaves.length; index++)
    leaves[index] = {
      writer,
      values: new Array(Math.min(WIDTH, length - index * WIDTH)),
      capacity: 0,
      stable: true,
    };
  fill((index, candidate, poseDraft, linkedPose) => {
    const row = poseDraft ? { ...candidate } : candidate;
    const page = leaves[Math.floor(index / WIDTH)] as Page;
    const lane = index % WIDTH;
    page.values[lane] = row;
    if (ownsDraw(scene, row, linkedPose)) markScene(page, lane, true);
    page.capacity = Math.max(page.capacity, row.meshSlot + 1);
    page.stable &&= stableAddress(row);
  });
  let level = leaves;
  let stride = 1;
  while (level.length > 1) {
    const parents: Page[] = [];
    for (let first = 0; first < level.length; first += WIDTH) {
      const children = level.length <= WIDTH ? level : level.slice(first, first + WIDTH);
      let capacity = 0;
      let stable = true;
      for (const child of children) {
        capacity = Math.max(capacity, child.capacity);
        stable &&= child.stable;
      }
      parents.push({ writer, values: children, capacity, stable });
    }
    level = parents;
    stride *= WIDTH;
  }
  return new DrawRowPages(length, stride, level[0] as Page, undefined, scene);
}

/** An emit either starts a new order or replaces named addresses of a fixed order. */
export function issueDrawRows(
  length: number,
  previous: DrawRows | undefined,
  fill: FillDrawRows,
  scene?: SceneSlotFrame,
): DrawRows {
  const sameWidth = previous?.length === length ? previous : undefined;
  if (length <= WIDTH) {
    const rows = sameWidth?.slice() ?? new Array<ValidatedRenderable>(length);
    fill((index, row, poseDraft, linkedPose) => {
      if (linkedPose === true) {
        const current = scene?.slotAt((row.sceneSlot as SceneDrawSlot).slot);
        if (!(current instanceof SceneDrawSlot))
          throw new Error('A linked draw requires its current Scene row');
        rows[index] = { ...row, sceneSlot: current, source: current.authoredSnapshot() };
      } else rows[index] = poseDraft ? { ...row } : row;
    });
    return rows;
  }
  if (sameWidth === undefined) return issueCompleteRows(length, fill, scene);
  const base =
    sameWidth instanceof DrawRowPages
      ? sameWidth
      : issueCompleteRows(length, (write) =>
          sameWidth.forEach((row, index) => {
            write(index, row);
          }),
        );
  let writer: symbol | undefined;
  let root = base.root;
  const stride = base.stride;
  let last = -1;
  let leaf = root;
  fill((index, row, poseDraft, linkedPose) => {
    const key = Math.floor(index / WIDTH);
    if (key !== last) {
      leaf = pageAt(root, stride, index);
      last = key;
    }
    const lane = index % WIDTH;
    const old = leaf.values[lane] as ValidatedRenderable;
    const alreadyScene = readsScene(leaf, lane);
    const fromScene = ownsDraw(scene, row, linkedPose);
    if (row === old && fromScene === alreadyScene) return;
    if (fromScene && alreadyScene && poseDraft && sameGeometry(old, row)) return;
    writer ??= Symbol();
    if (leaf.writer !== writer) {
      root = writable(root, writer);
      leaf = root;
      for (let span = stride; span > 1; span /= WIDTH) {
        const lane = Math.floor(index / span) % WIDTH;
        const next = writable(leaf.values[lane] as Page | undefined, writer);
        writeValue(leaf, lane, next);
        leaf = next;
      }
    }
    markScene(leaf, lane, fromScene);
    if (leaf.keepsNativeAddresses) {
      // Pose edits preserve the exact physical peak and ownership of the other lanes.
      leaf.keepsNativeAddresses =
        row === old ||
        (old !== undefined &&
          row.foldedMeshSlot === undefined &&
          row.meshSlot === old.meshSlot &&
          row.sceneSlot?.slot === old.sceneSlot?.slot &&
          row.sceneSlot?.generation === old.sceneSlot?.generation &&
          stableAddress(row));
    }
    writeValue(leaf, lane, poseDraft ? { ...row } : row);
  });
  if (writer === undefined && (scene === undefined || scene === base.scene)) return base;
  if (writer !== undefined) seal(root, stride, writer);
  return new DrawRowPages(length, stride, root, base.root.writer, scene ?? base.scene);
}

type DrawRange = FrameRange<ValidatedRenderable>;
export class JoinedDrawRows extends JoinedFrameRows<ValidatedRenderable> {
  recordAt(
    index: number,
    scratch: RecordingDrawRow,
    numericPose: boolean,
  ): ValidatedRenderable | undefined {
    const range = this.containing(index);
    return range === undefined
      ? undefined
      : recordingDrawRowAt(range.rows, index - range.start, scratch, numericPose);
  }

  sourceAt(index: number): RenderableSnapshot | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const range = this.containing(index);
    return range === undefined ? undefined : drawSourceAt(range.rows, index - range.start);
  }

  geometryAt(index: number): ValidatedRenderable | undefined {
    const range = this.containing(index);
    return range === undefined ? undefined : drawGeometryAt(range.rows, index - range.start);
  }
}

export function drawSourceAt(rows: DrawRows, index: number): RenderableSnapshot | undefined {
  return rows instanceof DrawRowPages || rows instanceof JoinedDrawRows
    ? rows.sourceAt(index)
    : rows.at(index)?.source;
}

export function drawPositionAt(rows: DrawRows, index: number): number | undefined {
  return drawGeometryAt(rows, index)?.renderableIndex;
}

export function drawMeshAt(rows: DrawRows, index: number): ValidatedRenderable['mesh'] | undefined {
  return drawGeometryAt(rows, index)?.mesh;
}

function drawGeometryAt(rows: DrawRows, index: number): ValidatedRenderable | undefined {
  return rows instanceof DrawRowPages || rows instanceof JoinedDrawRows
    ? rows.geometryAt(index)
    : rows.at(index);
}

/** Bindings depend on the placement owner and entity, independent of its current pose. */
export function drawBindingReaderAt(
  rows: DrawRows,
  index: number,
):
  | (Pick<ValidatedRenderable, 'world'> & {
      readonly source: Pick<RenderableSnapshot, 'entityKey'>;
    })
  | undefined {
  return drawGeometryAt(rows, index);
}

interface AddressedDrawRows {
  readonly rows: DrawRows;
  readonly capacity: number;
}

type AddressDraw = (
  row: ValidatedRenderable,
  before?: ValidatedRenderable,
  placed?: ValidatedRenderable,
) => ValidatedRenderable;
const ADDRESSED = Symbol();

function addressLeafRow(
  row: ValidatedRenderable,
  before: Page | undefined,
  placed: Page | undefined,
  lane: number,
  stable: boolean,
  address: AddressDraw,
): ValidatedRenderable {
  const old = before?.values[lane] as ValidatedRenderable | undefined;
  const physical = placed?.values[lane] as ValidatedRenderable | undefined;
  if (old === undefined || physical === undefined || !(stable || stableAddress(row)))
    return address(row, old, physical);
  if (row === old) return physical;
  // Pose writes at the same Scene generation keep the physical address.
  if (
    row.foldedMeshSlot === undefined &&
    row.meshSlot === physical.meshSlot &&
    before?.stable &&
    row.sceneSlot?.slot === old.sceneSlot?.slot &&
    row.sceneSlot?.generation === old.sceneSlot?.generation
  )
    return row;
  return address(row, old, physical);
}

/** An unchanged immutable native page still owns its actual addresses in this allocator revision. */
function addressPage(
  page: Page,
  before: Page | undefined,
  placed: Page | undefined,
  stride: number,
  address: AddressDraw,
  currentWriter: symbol | undefined,
): Page {
  if (page === before && placed !== undefined && page.stable) return placed;
  if (
    page.writer === currentWriter &&
    page.keepsNativeAddresses &&
    before !== undefined &&
    placed === before
  )
    return page;
  let values: Page['values'] | undefined;
  let capacity = 0;
  let sceneLow = page.sceneLow;
  let sceneHigh = page.sceneHigh;
  for (let lane = 0; lane < page.values.length; lane++) {
    let next: ValidatedRenderable | Page;
    if (stride === 1) {
      const row = page.values[lane] as ValidatedRenderable;
      next = addressLeafRow(row, before, placed, lane, page.stable, address);
      if (next.sceneSlot !== row.sceneSlot || next.source !== row.source) {
        const bit = ~(1 << (lane & 31));
        if (lane < 32 && sceneLow !== undefined) sceneLow &= bit;
        if (lane >= 32 && sceneHigh !== undefined) sceneHigh &= bit;
      }
      capacity = Math.max(capacity, next.meshSlot + 1);
    } else {
      next = addressPage(
        page.values[lane] as Page,
        before?.values[lane] as Page | undefined,
        placed?.values[lane] as Page | undefined,
        stride / WIDTH,
        address,
        currentWriter,
      );
      capacity = Math.max(capacity, next.capacity);
    }
    if (next !== page.values[lane]) {
      values ??= page.values.slice();
      values[lane] = next;
    }
  }
  return values === undefined && capacity === page.capacity
    ? page
    : {
        writer: ADDRESSED,
        values: values ?? page.values,
        capacity,
        stable: page.stable,
        sceneLow,
        sceneHigh,
      };
}

/** Resolve addresses and their exact peak from the physical owner, including cold and borrowed rows. */
export function addressDrawRows(
  inputs: DrawRows,
  before: DrawRows | undefined,
  placed: DrawRows | undefined,
  address: AddressDraw,
): AddressedDrawRows {
  if (inputs instanceof DrawRowPages) {
    const aligned =
      before instanceof DrawRowPages &&
      placed instanceof DrawRowPages &&
      before.stride === inputs.stride &&
      placed.stride === inputs.stride;
    const root = addressPage(
      inputs.root,
      aligned ? before.root : undefined,
      aligned ? placed.root : undefined,
      inputs.stride,
      address,
      aligned &&
        inputs.previousWriter === before.root.writer &&
        inputs.previousWriter !== ADDRESSED &&
        before.length === inputs.length &&
        placed.length === inputs.length
        ? inputs.root.writer
        : undefined,
    );
    return {
      rows:
        root === inputs.root
          ? inputs
          : new DrawRowPages(inputs.length, inputs.stride, root, undefined, inputs.scene),
      capacity: root.capacity,
    };
  }
  if (inputs instanceof JoinedDrawRows) {
    let ranges: DrawRange[] | undefined;
    let capacity = 0;
    for (let index = 0; index < inputs.ranges.length; index++) {
      const range = inputs.ranges[index] as DrawRange;
      const old = before instanceof JoinedDrawRows ? before.ranges[index]?.rows : undefined;
      const physical = placed instanceof JoinedDrawRows ? placed.ranges[index]?.rows : undefined;
      const result = addressDrawRows(range.rows, old, physical, address);
      if (result.rows !== range.rows) {
        ranges ??= inputs.ranges.slice();
        ranges[index] = { start: range.start, rows: result.rows };
      }
      capacity = Math.max(capacity, result.capacity);
    }
    return { rows: ranges === undefined ? inputs : new JoinedDrawRows(ranges), capacity };
  }
  let capacity = 0;
  let rows: ValidatedRenderable[] | undefined;
  for (let index = 0; index < inputs.length; index++) {
    const row = inputs.at(index) as ValidatedRenderable;
    const resolved = address(row, before?.at(index), placed?.at(index));
    capacity = Math.max(capacity, resolved.meshSlot + 1);
    if (resolved !== row) {
      rows ??= inputs.slice();
      rows[index] = resolved;
    }
  }
  return { rows: rows ?? inputs, capacity };
}
