import { AssetGuid } from '@forgeax/engine-pack/guid';

export interface StreamingBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface StreamingCell {
  readonly key: string;
  readonly scene: string;
  readonly bounds: StreamingBounds;
  readonly role: 'visual' | 'collision' | 'combined';
  readonly layer?: string;
  readonly replacement?: {
    readonly group: string;
    readonly role: 'proxy' | 'detail';
  };
}

export interface StreamingGrid {
  readonly cellSize: number;
  readonly pageSize: number;
  readonly originX?: number;
  readonly originZ?: number;
}

export type WorldStreamingErrorCode = 'invalid-index' | 'invalid-source' | 'level-failed';

export class WorldStreamingError extends Error {
  constructor(
    readonly code: WorldStreamingErrorCode,
    readonly detail: { readonly subject: string; readonly reason: string },
    cause?: unknown,
  ) {
    super(`World streaming: ${detail.subject}: ${detail.reason}`, { cause });
    this.name = 'WorldStreamingError';
  }
}

interface GridRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface ReplacementGroup {
  readonly proxy: StreamingCell[];
  readonly detail: StreamingCell[];
  readonly layer: string | undefined;
}

type IndexPage = Map<string, StreamingCell[]>;

const gridKey = (x: number, z: number) => `${x}/${z}`;

export const squaredDistance = (x: number, z: number, bounds: StreamingBounds): number => {
  const dx = Math.max(bounds.minX - x, x - bounds.maxX, 0);
  const dz = Math.max(bounds.minZ - z, z - bounds.maxZ, 0);
  return dx * dx + dz * dz;
};

function validation(subject: string, reason: string): WorldStreamingError {
  return new WorldStreamingError('invalid-index', { subject, reason });
}

function validBounds(bounds: StreamingBounds): boolean {
  return (
    [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(Number.isFinite) &&
    bounds.minX <= bounds.maxX &&
    bounds.minZ <= bounds.maxZ
  );
}

/** Scene metadata alone is enough to build the directory. The index owns no asset grants. */
export class RuntimeStreamingIndex {
  readonly groups = new Map<string, ReplacementGroup>();
  private readonly pages = new Map<string, IndexPage>();
  private readonly pendingPages = new Map<string, IndexPage>();
  private readonly build: Generator<void>;
  private directoryComplete = false;
  private indexedCells = 0;
  private extent: GridRect | undefined;

  constructor(
    cells: Iterable<StreamingCell | undefined>,
    private readonly grid: StreamingGrid,
  ) {
    if (
      !Number.isFinite(grid.cellSize) ||
      grid.cellSize <= 0 ||
      !Number.isSafeInteger(grid.pageSize) ||
      grid.pageSize <= 0 ||
      !Number.isFinite(grid.originX ?? 0) ||
      !Number.isFinite(grid.originZ ?? 0)
    )
      throw validation('grid', 'positive cell and page sizes and finite origin required');
    this.build = this.collect(cells);
  }

  advance(units: number): void {
    for (let remaining = units; remaining > 0; remaining--) {
      if (this.build.next().done) return;
    }
  }

  inspect() {
    return {
      cells: this.indexedCells,
      pages: this.pages.size,
      pendingPages: this.pendingPages.size,
      directoryComplete: this.directoryComplete,
    };
  }

  private rectangle(bounds: StreamingBounds): GridRect {
    const { cellSize, originX = 0, originZ = 0 } = this.grid;
    return {
      left: Math.floor((bounds.minX - originX) / cellSize),
      right: Math.floor((bounds.maxX - originX) / cellSize),
      top: Math.floor((bounds.minZ - originZ) / cellSize),
      bottom: Math.floor((bounds.maxZ - originZ) / cellSize),
    };
  }

  private pageKey(x: number, z: number): string {
    return gridKey(Math.floor(x / this.grid.pageSize), Math.floor(z / this.grid.pageSize));
  }

  private *collect(cells: Iterable<StreamingCell | undefined>): Generator<void> {
    const keys = new Set<string>();
    for (const value of cells) {
      if (value === undefined) {
        yield;
        continue;
      }
      const cell = this.addCell(value, keys);
      const rect = this.rectangle(cell.bounds);
      this.extend(rect, cell.key);
      for (let z = rect.top; z <= rect.bottom; z++) {
        for (let x = rect.left; x <= rect.right; x++) {
          this.addToBucket(x, z, cell);
          yield;
        }
      }
    }
    for (const [key, { proxy, detail }] of this.groups) {
      if (proxy.length !== 1 || detail.length === 0)
        throw validation(key, 'replacement group requires one proxy and at least one detail Cell');
      yield;
    }
    this.directoryComplete = true;
    for (const [key, page] of this.pendingPages) {
      this.pages.set(key, page);
      this.pendingPages.delete(key);
      yield;
    }
  }

  private addCell(value: StreamingCell, keys: Set<string>): StreamingCell {
    if (value.key.length === 0 || keys.has(value.key))
      throw validation(value.key, 'duplicate or empty Cell key');
    if (!validBounds(value.bounds)) throw validation(value.key, 'invalid bounds');
    if (!AssetGuid.parse(value.scene).ok) throw validation(value.key, 'invalid Scene GUID');
    const cell = { ...value, bounds: { ...value.bounds } };
    if (value.replacement !== undefined) {
      const { group, role } = value.replacement;
      if (cell.role !== 'visual' || group.length === 0)
        throw validation(cell.key, 'replacement groups contain visual Cells');
      let record = this.groups.get(group);
      if (record === undefined) {
        record = { proxy: [], detail: [], layer: cell.layer };
        this.groups.set(group, record);
      }
      if (record.layer !== cell.layer)
        throw validation(group, 'replacement members require the same semantic layer');
      record[role].push(cell);
    }
    keys.add(cell.key);
    this.indexedCells++;
    return cell;
  }

  private extend(rect: GridRect, key: string): void {
    const { left, right, top, bottom } = rect;
    if (![left, right, top, bottom].every(Number.isSafeInteger))
      throw validation(key, 'bounds exceed grid coordinates');
    if ((right - left + 1) * (bottom - top + 1) > 4096)
      throw validation(key, 'Cell spans over 4096 buckets, use a coarser grid');
    const previous = this.extent;
    this.extent =
      previous === undefined
        ? rect
        : {
            left: Math.min(previous.left, left),
            right: Math.max(previous.right, right),
            top: Math.min(previous.top, top),
            bottom: Math.max(previous.bottom, bottom),
          };
  }

  private addToBucket(x: number, z: number, cell: StreamingCell): void {
    const pageKey = this.pageKey(x, z);
    let page = this.pendingPages.get(pageKey);
    if (page === undefined) {
      page = new Map();
      this.pendingPages.set(pageKey, page);
    }
    const key = gridKey(x, z);
    const bucket = page.get(key);
    if (bucket === undefined) page.set(key, [cell]);
    else bucket.push(cell);
  }

  /** undefined means at least one required page is still unproven. */
  *query(
    x: number,
    z: number,
    radius: number,
  ): Generator<void, Map<string, StreamingCell> | undefined> {
    if (!this.directoryComplete) return undefined;
    const selected = new Map<string, StreamingCell>();
    const extent = this.extent;
    if (extent === undefined) return selected;
    const rect = this.rectangle({
      minX: x - radius,
      minZ: z - radius,
      maxX: x + radius,
      maxZ: z + radius,
    });
    for (
      let iz = Math.max(rect.top, extent.top);
      iz <= Math.min(rect.bottom, extent.bottom);
      iz++
    ) {
      for (
        let ix = Math.max(rect.left, extent.left);
        ix <= Math.min(rect.right, extent.right);
        ix++
      ) {
        const pageKey = this.pageKey(ix, iz);
        if (this.pendingPages.has(pageKey)) return undefined;
        const bucket = this.pages.get(pageKey)?.get(gridKey(ix, iz));
        for (const cell of bucket ?? []) {
          if (squaredDistance(x, z, cell.bounds) <= radius * radius) selected.set(cell.key, cell);
          yield;
        }
        yield;
      }
    }
    return selected;
  }
}
