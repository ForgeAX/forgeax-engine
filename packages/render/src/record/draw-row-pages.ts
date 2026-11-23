import { FrameListBase } from '../scene/frame-list';
import { SceneDrawSlot } from '../scene/mesh-draw';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';

const WIDTH = 64;

interface Page {
  readonly writer: symbol;
  readonly values: (Page | ValidatedRenderable)[];
  capacity: number;
  stable: boolean;
}

function writable(page: Page | undefined, writer: symbol): Page {
  return page?.writer === writer
    ? page
    : { writer, values: page?.values.slice() ?? [], capacity: 0, stable: false };
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

function seal(page: Page, stride: number, writer: symbol): void {
  if (page.writer !== writer) return;
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

  constructor(
    readonly length: number,
    readonly stride: number,
    readonly root: Page,
  ) {
    super();
  }

  private pageAt(index: number): Page {
    const key = Math.floor(index / WIDTH);
    if (key === this.readKey && this.readPage !== undefined) return this.readPage;
    let page = this.root;
    for (let stride = this.stride; stride > 1; stride /= WIDTH)
      page = page.values[Math.floor(index / stride) % WIDTH] as Page;
    this.readKey = key;
    this.readPage = page;
    return page;
  }

  at(index: number): ValidatedRenderable | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    return this.pageAt(index).values[index % WIDTH] as ValidatedRenderable;
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
        if (lane === 0) page = frame.pageAt(index);
        step.value = (page as Page).values[lane] as ValidatedRenderable;
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

type FillDrawRows = (write: (index: number, row: ValidatedRenderable) => void) => void;

/** Complete publications write directly into final leaves, then reduce only the directory. */
function issueCompleteRows(length: number, fill: FillDrawRows): DrawRowPages {
  const writer = Symbol();
  const leaves: Page[] = new Array(Math.ceil(length / WIDTH));
  for (let index = 0; index < leaves.length; index++)
    leaves[index] = {
      writer,
      values: new Array(Math.min(WIDTH, length - index * WIDTH)),
      capacity: 0,
      stable: true,
    };
  fill((index, row) => {
    const page = leaves[Math.floor(index / WIDTH)] as Page;
    page.values[index % WIDTH] = row;
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
  return new DrawRowPages(length, stride, level[0] as Page);
}

/** An emit either starts a new order or replaces named addresses of a fixed order. */
export function issueDrawRows(
  length: number,
  previous: DrawRows | undefined,
  fill: FillDrawRows,
): DrawRows {
  if (length <= WIDTH) {
    const rows = previous?.slice() ?? new Array<ValidatedRenderable>(length);
    fill((index, row) => {
      rows[index] = row;
    });
    return rows;
  }
  if (previous === undefined) return issueCompleteRows(length, fill);
  const base =
    previous instanceof DrawRowPages
      ? previous
      : issueCompleteRows(length, (write) =>
          previous.forEach((row, index) => {
            write(index, row);
          }),
        );
  const writer = Symbol();
  const root = writable(base.root, writer);
  const stride = base.stride;
  let last = -1;
  let leaf = root;
  fill((index, row) => {
    const key = Math.floor(index / WIDTH);
    if (key !== last) {
      leaf = root;
      for (let span = stride; span > 1; span /= WIDTH) {
        const lane = Math.floor(index / span) % WIDTH;
        const next = writable(leaf.values[lane] as Page | undefined, writer);
        leaf.values[lane] = next;
        leaf = next;
      }
      last = key;
    }
    leaf.values[index % WIDTH] = row;
  });
  seal(root, stride, writer);
  return new DrawRowPages(length, stride, root);
}

interface DrawRange {
  readonly start: number;
  readonly rows: DrawRows;
}

/** Joined pass ranges hold one reference per actual phase and preserve its address space. */
export class JoinedDrawRows extends FrameListBase<ValidatedRenderable> {
  readonly length: number;
  constructor(readonly ranges: readonly DrawRange[]) {
    super();
    const last = ranges.at(-1);
    this.length = last === undefined ? 0 : last.start + last.rows.length;
  }

  at(index: number): ValidatedRenderable | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const range = this.containing(index);
    return range?.rows.at(index - range.start);
  }

  /** Use the physical subtable after addressing when the pass owns this exact interval. */
  exactRange(start: number, length: number): DrawRows | undefined {
    const range = this.containing(start);
    return range?.start === start && range.rows.length === length ? range.rows : undefined;
  }

  private containing(index: number) {
    let low = 0;
    let high = this.ranges.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (index < (this.ranges[mid] as DrawRange).start) high = mid - 1;
      else low = mid;
    }
    return this.ranges[low];
  }

  *[Symbol.iterator](): IterableIterator<ValidatedRenderable> {
    for (const range of this.ranges) yield* range.rows;
  }
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

/** An unchanged immutable native page still owns its actual addresses in this allocator revision. */
function addressPage(
  page: Page,
  before: Page | undefined,
  placed: Page | undefined,
  stride: number,
  address: AddressDraw,
): Page {
  if (page === before && placed !== undefined && page.stable) return placed;
  let values: Page['values'] | undefined;
  let capacity = 0;
  for (let lane = 0; lane < page.values.length; lane++) {
    let next: ValidatedRenderable | Page;
    if (stride === 1) {
      const row = page.values[lane] as ValidatedRenderable;
      const old = before?.values[lane] as ValidatedRenderable | undefined;
      const physical = placed?.values[lane] as ValidatedRenderable | undefined;
      // The allocator owns the source address by Scene slot and generation.
      // A pose replacement may have a new snapshot at that same physical address.
      if (old !== undefined && physical !== undefined && (page.stable || stableAddress(row))) {
        if (row === old) next = physical;
        else if (
          row.foldedMeshSlot === undefined &&
          row.meshSlot === physical.meshSlot &&
          before?.stable &&
          row.sceneSlot?.slot === old.sceneSlot?.slot &&
          row.sceneSlot?.generation === old.sceneSlot?.generation
        )
          next = row;
        else next = address(row, old, physical);
      } else next = address(row, old, physical);
      capacity = Math.max(capacity, next.meshSlot + 1);
    } else {
      next = addressPage(
        page.values[lane] as Page,
        before?.values[lane] as Page | undefined,
        placed?.values[lane] as Page | undefined,
        stride / WIDTH,
        address,
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
    : { writer: ADDRESSED, values: values ?? page.values, capacity, stable: page.stable };
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
    );
    return {
      rows: root === inputs.root ? inputs : new DrawRowPages(inputs.length, inputs.stride, root),
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
