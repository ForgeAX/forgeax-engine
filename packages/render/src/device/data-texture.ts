import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { StableRangeAllocator } from '../stable-range-allocator';
import { type ResidencyLease, ResidencyLifetime } from './residency-lifetime';

interface Generation {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly capacity: number;
  readonly life: ResidencyLifetime;
}
type Work =
  | { kind: 'grow'; before: Generation; after: Generation; lease: ResidencyLease }
  | { kind: 'write'; generation: Generation; start: number; bytes: Uint8Array; width?: number }
  | {
      kind: 'rectangle';
      generation: Generation;
      from: number;
      to: number;
      width: number;
      height: number;
    };

/** Native RGBA8 source pages with immutable captures and ordered narrow uploads. */
export class DataTexture {
  private readonly ranges = new StableRangeAllocator();
  private generation: Generation | undefined;
  private readonly work: Work[] = [];
  private readonly sampler: Sampler;
  private liveCells = 0;
  constructor(
    private readonly device: RhiDevice,
    private readonly maxBytes: number,
    private readonly label: string,
    private readonly width: number,
    private readonly onPending: () => void,
  ) {
    this.sampler = device
      .createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'nearest',
      })
      .unwrap();
  }

  allocate(count: number, alignment = 1): number {
    if ((this.liveCells + count) * 4 > this.maxBytes) this.exceeded();
    const start = this.ranges.allocate(count, alignment);
    if ((start + count) * 4 > this.maxBytes) {
      this.ranges.release(start, count);
      this.exceeded();
    }
    try {
      this.ensure(start + count);
    } catch (cause) {
      this.ranges.release(start, count);
      throw cause;
    }
    this.liveCells += count;
    return start;
  }
  release(start: number, count: number): void {
    this.ranges.release(start, count);
    this.liveCells -= count;
  }
  write(start: number, bytes: Uint8Array): void {
    const generation = this.generation;
    if (
      generation === undefined ||
      bytes.byteLength % 4 !== 0 ||
      start + bytes.byteLength / 4 > generation.capacity
    )
      throw new RangeError('data texture write outside allocated cells');
    this.work.push({ kind: 'write', generation, start, bytes });
    this.onPending();
  }
  writeRows(start: number, width: number, bytes: Uint8Array): void {
    const generation = this.generation;
    if (generation === undefined || bytes.byteLength % (width * 4) !== 0)
      throw new Error('invalid texture row upload');
    this.work.push({ kind: 'write', generation, start, bytes, width });
    this.onPending();
  }
  copyRectangle(from: number, to: number, width: number, height: number): void {
    const generation = this.generation;
    if (generation === undefined) throw new Error('missing data texture generation');
    this.work.push({ kind: 'rectangle', generation, from, to, width, height });
    this.onPending();
  }
  capture(): {
    textureView: TextureView;
    sampler: Sampler;
    release(completed?: Promise<unknown>): void;
  } {
    this.ensure(1);
    const generation = this.generation;
    if (generation === undefined) throw new Error('missing data texture generation');
    const lease = generation.life.retain(() => {});
    return {
      textureView: generation.view,
      sampler: this.sampler,
      release(completed) {
        if (completed !== undefined) lease.track(completed);
        void lease.release(false);
      },
    };
  }
  get pending(): boolean {
    return this.work.length > 0;
  }
  get allocatedBytes(): number {
    return (this.generation?.capacity ?? 0) * 4;
  }
  get retainedBytes(): number {
    return this.liveCells * 4;
  }

  /** Records into the existing texture-upload command buffer, before frame draws. */
  encode(encoder: RhiCommandEncoder): { complete(submitted: boolean): void } {
    const WIDTH = this.width,
      PAGE = WIDTH * WIDTH;
    const work = this.work.slice();
    const buffers: Buffer[] = [];
    const scratchBytes = work.reduce(
      (max, item) =>
        item.kind === 'rectangle'
          ? Math.max(max, Math.ceil((item.width * 4) / 256) * 256 * item.height)
          : max,
      0,
    );
    let scratch: Buffer | undefined;
    const copy = (
      source: Generation,
      destination: Generation,
      from: number,
      to: number,
      count: number,
    ) => {
      while (count > 0) {
        const cells = Math.min(count, PAGE - (from % PAGE), PAGE - (to % PAGE));
        const rows = cells / WIDTH;
        encoder.copyTextureToTexture(
          {
            texture: source.texture,
            origin: { x: 0, y: Math.floor((from % PAGE) / WIDTH), z: Math.floor(from / PAGE) },
          },
          {
            texture: destination.texture,
            origin: { x: 0, y: Math.floor((to % PAGE) / WIDTH), z: Math.floor(to / PAGE) },
          },
          { width: WIDTH, height: rows, depthOrArrayLayers: 1 },
        );
        from += cells;
        to += cells;
        count -= cells;
      }
    };
    try {
      for (const item of work) {
        if (item.kind === 'grow') {
          copy(item.before, item.after, 0, 0, item.before.capacity);
          continue;
        }
        if (item.kind === 'rectangle') {
          const { width, height } = item;
          scratch ??= this.device.createBuffer({ size: scratchBytes, usage: 0x04 | 0x08 }).unwrap();
          const buffer = {
            buffer: scratch,
            bytesPerRow: Math.ceil((width * 4) / 256) * 256,
            rowsPerImage: height,
          };
          const location = (start: number) => ({
            texture: item.generation.texture,
            origin: {
              x: start % WIDTH,
              y: Math.floor((start % PAGE) / WIDTH),
              z: Math.floor(start / PAGE),
            },
          });
          const size = { width, height, depthOrArrayLayers: 1 };
          encoder.copyTextureToBuffer(location(item.from), buffer, size);
          encoder.copyBufferToTexture(buffer, location(item.to), size);
          continue;
        }
        if (item.kind !== 'write') continue;
        let start = item.start,
          offset = 0;
        const cells = item.bytes.byteLength / 4;
        while (offset < cells) {
          const x = start % WIDTH;
          const pageRemaining = PAGE - (start % PAGE);
          const width = item.width ?? Math.min(WIDTH - x, cells - offset);
          const height =
            item.width === undefined
              ? x === 0 && width === WIDTH
                ? Math.max(1, Math.floor(Math.min(cells - offset, pageRemaining) / WIDTH))
                : 1
              : (cells - offset) / width;
          const sourceBytes = width * height * 4;
          const rowBytes = Math.ceil((width * 4) / 256) * 256;
          const buffer = this.device
            .createBuffer({ size: rowBytes * height, usage: 0x04 | 0x08 })
            .unwrap();
          buffers.push(buffer);
          const source = item.bytes.subarray(offset * 4, offset * 4 + sourceBytes);
          let staged = source;
          if (height > 1 && rowBytes !== width * 4) {
            staged = new Uint8Array(rowBytes * height);
            for (let row = 0; row < height; row++)
              staged.set(source.subarray(row * width * 4, (row + 1) * width * 4), row * rowBytes);
          }
          this.device.queue.writeBuffer(buffer, 0, staged).unwrap();
          encoder.copyBufferToTexture(
            { buffer: buffer, bytesPerRow: rowBytes, rowsPerImage: height },
            {
              texture: item.generation.texture,
              origin: {
                x,
                y: Math.floor((start % PAGE) / WIDTH),
                z: Math.floor(start / PAGE),
              },
            },
            { width, height, depthOrArrayLayers: 1 },
          );
          start += item.width === undefined ? width * height : WIDTH * height;
          offset += width * height;
        }
      }
    } catch (cause) {
      for (const buffer of buffers) this.device.destroyBuffer(buffer);
      if (scratch !== undefined) this.device.destroyBuffer(scratch);
      throw cause;
    }
    if (scratch !== undefined) buffers.push(scratch);
    let completed = false;
    return {
      complete: (submitted) => {
        if (completed) return;
        completed = true;
        const done = submitted ? this.device.queue.onSubmittedWorkDone() : undefined;
        const cleanup = () => {
          for (const buffer of buffers) this.device.destroyBuffer(buffer);
        };
        if (done === undefined) cleanup();
        else void done.then(cleanup, cleanup);
        if (!submitted) return;
        this.work.splice(0, work.length);
        for (const item of work)
          if (item.kind === 'grow') {
            if (done !== undefined) item.lease.track(done);
            void item.lease.release(false);
          }
      },
    };
  }

  dispose(): void {
    for (const item of this.work) {
      if (item.kind === 'grow') void item.lease.release(false);
    }
    this.work.length = 0;
    this.generation?.life.retire();
    this.generation = undefined;
    this.ranges.reset();
    this.liveCells = 0;
  }
  private ensure(cells: number): void {
    if ((this.generation?.capacity ?? 0) >= cells) return;
    const WIDTH = this.width,
      PAGE = WIDTH * WIDTH;
    const quantum = WIDTH * 4;
    const capacity = Math.min(
      this.maxBytes / 4,
      quantum * 2 ** Math.ceil(Math.log2(Math.max(1, cells / quantum))),
    );
    const texture = this.device
      .createTexture({
        label: this.label,
        size: {
          width: WIDTH,
          height: Math.min(WIDTH, capacity / WIDTH),
          depthOrArrayLayers: Math.ceil(capacity / PAGE),
        },
        textureBindingViewDimension: '2d-array',
        format: 'rgba8unorm',
        usage: 0x01 | 0x02 | 0x04,
      })
      .unwrap();
    const madeView = this.device.createTextureView(texture, {
      dimension: '2d-array',
    });
    if (!madeView.ok) {
      this.device.destroyTexture(texture);
      throw madeView.error;
    }
    const view = madeView.value;
    const next = {
      texture,
      view,
      capacity,
      life: new ResidencyLifetime(() => this.device.destroyTexture(texture)),
    };
    const before = this.generation;
    if (before !== undefined) {
      this.work.push({ kind: 'grow', before, after: next, lease: before.life.retain(() => {}) });
      this.onPending();
      before.life.retire();
    }
    this.generation = next;
  }
  private exceeded(): never {
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: `${this.label} within ${this.maxBytes} retained GPU bytes`,
      hint: 'release completed or abandoned frame captures before admitting more versions',
    });
  }
}
