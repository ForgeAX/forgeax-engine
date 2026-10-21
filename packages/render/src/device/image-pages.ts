import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import type { AssetError, TerrainError, TextureAsset } from '@forgeax/engine-types';
import { srgbChannelToLinear } from '@forgeax/engine-types';
import { type Node, nodes, put } from '../scene/frame-tree';
import { DataTexture } from './data-texture';
import { type ImageRectangle, ImageRectangles } from './image-rectangles';
import { type GpuResourceNamespace, ScopedGpuResources } from './scoped-gpu-resources';

const LINEAR_VALUES = Float32Array.from({ length: 256 }, (_, i) => i / 255);
const SRGB_VALUES = LINEAR_VALUES.map(srgbChannelToLinear);
const BLOCK_BYTES = 4096;
const SIDE = 2048,
  PAGE = SIDE * SIDE;
export interface ImageVersion {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly srgb: boolean;
  readonly uniformCandidate: number;
  readonly blocks: Node<Uint8Array> | undefined;
  readonly previous?: WeakRef<ImageVersion>;
  readonly changes?: readonly { offset: number; bytes: Uint8Array }[];
}
interface Resident {
  readonly start: number;
  readonly rectangle: ImageRectangle;
  references: number;
}

/** Generic RGBA8 image projection owned by texture residency, independent of Terrain users. */
export class ImagePages {
  private pool: DataTexture | undefined;
  get texture(): DataTexture {
    if (this.pool === undefined) throw new Error('image pages require a configured device');
    return this.pool;
  }
  private current = 0;
  private readonly versions = new Map<number, ImageVersion>([
    [
      0,
      {
        id: 0,
        width: 1,
        height: 1,
        srgb: false,
        uniformCandidate: 0xffffffff,
        blocks: put(undefined, new Uint8Array([255, 255, 255, 255]), 0, 0, 0),
      },
    ],
  ]);
  private nextId = 1;
  private readonly revisions = new ScopedGpuResources<number>();
  private readonly sources = new ScopedGpuResources<number>();
  private readonly failures = new Map<number, AssetError>();
  private rectangles: ImageRectangles | undefined;
  private resident = new WeakMap<ImageVersion, Resident>();
  configure(device: RhiDevice, onPending: () => void): void {
    this.pool?.dispose();
    this.pool = new DataTexture(
      device,
      PAGE * 4 * device.limits.maxTextureArrayLayers,
      'shared-image-pages',
      SIDE,
      onPending,
    );
    this.resident = new WeakMap();
    this.rectangles = new ImageRectangles(this.pool);
  }
  encode(encoder: () => RhiCommandEncoder): { complete(submitted: boolean): void } | undefined {
    return this.pool?.pending ? this.pool.encode(encoder()) : undefined;
  }
  get revision(): number {
    return this.current;
  }
  get(id: number): ImageVersion | undefined {
    const failure = this.failures.get(id);
    if (failure !== undefined) throw failure;
    return this.versions.get(id);
  }
  has(key: string | number, namespace: GpuResourceNamespace = 0): boolean {
    return this.sources.has(key, namespace);
  }
  fail(key: string | number, error: AssetError, namespace: GpuResourceNamespace = 0): void {
    const id = this.sources.get(key, namespace);
    if (id === undefined) return;
    this.failures.set(id, error);
    this.current++;
  }
  ensure(key: string | number, source: TextureAsset, namespace: GpuResourceNamespace = 0): number {
    const existing = this.sources.get(key, namespace);
    if (existing !== undefined) return existing;
    const version = this.capture(this.nextId++, source);
    this.admit(key, version, namespace);
    return version.id;
  }
  adopt(
    key: string | number,
    change: AssetChange,
    source: TextureAsset | undefined,
    namespace: GpuResourceNamespace = 0,
  ): void {
    const id = this.sources.get(key, namespace);
    const before = id === undefined ? undefined : this.versions.get(id);
    if (before === undefined || this.revisions.get(key, namespace) === change.revision) return;
    if (change.removed || source === undefined) {
      this.sources.delete(key, namespace);
      this.versions.delete(before.id);
      this.current++;
      this.revisions.set(key, change.revision, namespace);
      return;
    }
    this.validate(source);
    const length = source.shape.extent.width * source.shape.extent.height * 4;
    if (
      change.fields.length !== 0 ||
      before.width !== source.shape.extent.width ||
      before.height !== source.shape.extent.height
    ) {
      this.admit(key, this.capture(before.id, source), namespace);
      this.revisions.set(key, change.revision, namespace);
      return;
    }
    let blocks = before.blocks;
    const touched = new Map<number, Uint8Array>();
    const changes: { offset: number; bytes: Uint8Array }[] = [];
    for (const range of change.ranges) {
      if (range.path.length !== 1 || range.path[0] !== 'data') {
        this.admit(key, this.capture(before.id, source), namespace);
        this.revisions.set(key, change.revision, namespace);
        return;
      }
      const rowBytes = range.rowBytes ?? range.byteLength;
      const stride = range.byteStride ?? rowBytes;
      const count = (range.byteLength - rowBytes) / stride + 1;
      for (let row = 0; row < count; row++) {
        const first = range.byteOffset + row * stride;
        let offset = Math.floor(first / 4) * 4;
        const end = Math.min(length, Math.ceil((first + rowBytes) / 4) * 4);
        if (offset >= end) continue;
        const bytes = source.data.slice(offset, end);
        changes.push({ offset, bytes });
        while (offset < end) {
          const index = Math.floor(offset / BLOCK_BYTES);
          let block = touched.get(index);
          if (block === undefined) {
            block = find(blocks, index)?.slice();
            if (block === undefined) throw new Error('resident image lost a source block');
            touched.set(index, block);
          }
          const count = Math.min(end - offset, block.byteLength - (offset % BLOCK_BYTES));
          block.set(source.data.subarray(offset, offset + count), offset % BLOCK_BYTES);
          offset += count;
        }
      }
    }
    if (changes.length === 0) {
      this.revisions.set(key, change.revision, namespace);
      return;
    }
    for (const [index, block] of touched)
      blocks = put(blocks, block, 0, index, uniformBlock(block, before.uniformCandidate) ? 0 : 1);
    this.admit(key, { ...before, blocks, previous: new WeakRef(before), changes }, namespace);
    this.revisions.set(key, change.revision, namespace);
  }
  /** The row owner pins the exact image allocation while a captured tree refers to it. */
  retain(version: ImageVersion): { values: Float32Array; release(): void } {
    const texture = this.texture,
      rectangles = this.rectangles;
    if (rectangles === undefined) throw new Error('missing configured image rectangles');
    let allocation = this.resident.get(version);
    if (allocation === undefined || allocation.references === 0) {
      const width = version.width + 2,
        height = version.height + 2;
      const rectangle = rectangles.allocate(width, height);
      allocation = { start: rectangle.start, rectangle, references: 0 };
      try {
        const previous =
          version.previous === undefined
            ? undefined
            : this.resident.get(version.previous.deref() as ImageVersion);
        if (previous !== undefined && previous.references > 0 && version.changes !== undefined) {
          texture.copyRectangle(previous.start, allocation.start, width, height);
          for (const change of version.changes)
            this.uploadSpan(texture, allocation.start, version, change.offset, change.bytes, true);
        } else {
          for (const block of nodes(version.blocks))
            this.uploadSpan(
              texture,
              allocation.start,
              version,
              block.key * BLOCK_BYTES,
              block.value,
              false,
            );
          this.uploadBorder(texture, allocation.start, version);
        }
        this.resident.set(version, allocation);
      } catch (cause) {
        rectangle.release();
        throw cause;
      }
    }
    const selected = allocation;
    selected.references++;
    let released = false;
    return {
      values:
        version.blocks?.count === 0
          ? uniformRow(version.uniformCandidate, version.srgb)
          : new Float32Array([
              version.width,
              version.height,
              (selected.start % PAGE) + SIDE + 1,
              Math.floor(selected.start / PAGE) + (version.srgb ? 0.5 : 0),
            ]),
      release: () => {
        if (released) return;
        released = true;
        if (--selected.references !== 0) return;
        selected.rectangle.release();
      },
    };
  }
  private uploadSpan(
    texture: DataTexture,
    start: number,
    version: ImageVersion,
    offset: number,
    bytes: Uint8Array,
    borders: boolean,
  ): void {
    const rowBytes = version.width * 4;
    if (!borders && offset % rowBytes === 0 && bytes.byteLength % rowBytes === 0) {
      texture.writeRows(start + (offset / rowBytes + 1) * SIDE + 1, version.width, bytes);
      return;
    }
    let cursor = 0;
    while (cursor < bytes.byteLength) {
      const pixel = (offset + cursor) / 4,
        x = pixel % version.width,
        y = Math.floor(pixel / version.width);
      const count = Math.min(version.width - x, (bytes.byteLength - cursor) / 4);
      const span = bytes.subarray(cursor, cursor + count * 4);
      texture.write(start + (y + 1) * SIDE + x + 1, span);
      if (borders) {
        const atLeft = x === 0,
          atRight = x + count === version.width;
        const left = span.subarray(0, 4),
          right = span.subarray(span.byteLength - 4);
        if (atLeft) texture.write(start + (y + 1) * SIDE + version.width + 1, left);
        if (atRight) texture.write(start + (y + 1) * SIDE, right);
        if (y === 0 || y === version.height - 1) {
          for (const row of [
            ...(y === 0 ? [version.height + 1] : []),
            ...(y === version.height - 1 ? [0] : []),
          ]) {
            texture.write(start + row * SIDE + x + 1, span);
            if (atLeft) texture.write(start + row * SIDE + version.width + 1, left);
            if (atRight) texture.write(start + row * SIDE, right);
          }
        }
      }
      cursor += count * 4;
    }
  }
  private uploadBorder(texture: DataTexture, start: number, version: ImageVersion): void {
    const read = (pixel: number, target: Uint8Array, offset: number) => {
      const byte = pixel * 4,
        block = find(version.blocks, Math.floor(byte / BLOCK_BYTES));
      if (block === undefined) throw new Error('image border lost its source block');
      target.set(block.subarray(byte % BLOCK_BYTES, (byte % BLOCK_BYTES) + 4), offset);
    };
    for (const [sourceRow, targetRow] of [
      [version.height - 1, 0],
      [0, version.height + 1],
    ] as const) {
      const bytes = new Uint8Array((version.width + 2) * 4);
      for (let x = 0; x < version.width + 2; x++)
        read(sourceRow * version.width + ((x + version.width - 1) % version.width), bytes, x * 4);
      texture.write(start + targetRow * SIDE, bytes);
    }
    for (const [sourceColumn, targetColumn] of [
      [version.width - 1, 0],
      [0, version.width + 1],
    ] as const) {
      const bytes = new Uint8Array(version.height * 4);
      for (let y = 0; y < version.height; y++) read(y * version.width + sourceColumn, bytes, y * 4);
      texture.writeRows(start + SIDE + targetColumn, 1, bytes);
    }
  }
  remove(key: string | number, namespace: GpuResourceNamespace = 0): void {
    const value = this.sources.get(key, namespace);
    if (value === undefined) return;
    this.sources.delete(key, namespace);
    this.revisions.delete(key, namespace);
    this.versions.delete(value);
    this.failures.delete(value);
    this.current++;
  }
  dispose(): void {
    this.sources.clear();
    this.revisions.clear();
    this.versions.clear();
    this.failures.clear();
    this.current++;
    this.pool?.dispose();
  }
  private admit(
    key: string | number,
    version: ImageVersion,
    namespace: GpuResourceNamespace,
  ): void {
    this.failures.delete(version.id);
    this.sources.set(key, version.id, namespace);
    this.versions.set(version.id, version);
    this.current++;
  }
  private capture(id: number, source: TextureAsset): ImageVersion {
    this.validate(source);
    const width = source.shape.extent.width,
      height = source.shape.extent.height;
    let blocks: Node<Uint8Array> | undefined;
    const first = source.data.slice(0, 4);
    const uniformCandidate = new Uint32Array(first.buffer)[0] ?? 0;
    for (let offset = 0; offset < width * height * 4; offset += BLOCK_BYTES) {
      const block = source.data.slice(offset, Math.min(width * height * 4, offset + BLOCK_BYTES));
      blocks = put(
        blocks,
        block,
        0,
        offset / BLOCK_BYTES,
        uniformBlock(block, uniformCandidate) ? 0 : 1,
      );
    }
    return { id, width, height, srgb: source.colorSpace === 'srgb', uniformCandidate, blocks };
  }
  private validate(source: TextureAsset): void {
    const { width, height } = source.shape.extent;
    if (
      ('encoding' in source && source.encoding !== undefined) ||
      !['rgba8unorm', 'rgba8unorm-srgb'].includes(source.format) ||
      source.shape.viewDimension !== '2d' ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024 ||
      source.data.byteLength < width * height * 4
    )
      throw {
        code: 'terrain-layer-invalid',
        expected: 'resident RGBA8 2D images, axes 1..1024 and complete mip0 bytes',
        hint: 'repair the source image',
        detail: { field: 'source image' },
      } satisfies TerrainError;
  }
}
function find<T>(root: Node<T> | undefined, key: number): T | undefined {
  while (root !== undefined) {
    if (key === root.key) return root.value;
    root = key < root.key ? root.left : root.right;
  }
  return undefined;
}

function uniformBlock(bytes: Uint8Array, candidate: number): boolean {
  for (const pixel of new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
    if (pixel !== candidate) return false;
  return true;
}
function uniformRow(pixel: number, srgb: boolean): Float32Array {
  const values = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    values[i] = (srgb && i < 3 ? SRGB_VALUES : LINEAR_VALUES)[(pixel >>> (i * 8)) & 255] ?? 0;
  }
  values[0] = -2 - (values[0] ?? 0);
  return values;
}
