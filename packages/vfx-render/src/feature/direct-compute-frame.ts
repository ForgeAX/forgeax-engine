import type { RenderFeatureWork } from '@forgeax/engine-render';
import type { VfxArenaRange } from './instance-arena';

type Resource = RenderFeatureWork['resources'][number];
type Pass = RenderFeatureWork['passes'][number];
type Copy = Extract<Pass, { kind: 'copy' }>['copies'][number];
type Dispatch = Extract<Pass, { kind: 'compute' }>['dispatches'][number];

interface Bucket {
  readonly program: string;
  readonly ranges: readonly VfxArenaRange[];
  readonly entries: readonly string[];
  readonly bytes: Uint8Array;
  count: number;
}
interface Wave {
  readonly resets: Copy[];
  readonly buckets: Map<string, Bucket>;
}
/** Each frame transfers current runtime bytes into independent jobs. Arena
 * buffers remain owned by their emitter; only command packets are combined. */
export function createVfxDirectComputeFrame() {
  const waves = new Map<number, Wave>();
  const views = new Map<string, Map<string, Bucket>>();
  let nextPacket = 0;
  const append = (
    buckets: Map<string, Bucket>,
    input: {
      program: string;
      ranges: readonly VfxArenaRange[];
      entries: readonly string[];
      runtime: ArrayBufferView;
      customStride: number;
    },
  ) => {
    if (input.entries.length === 0) return;
    const key =
      input.program +
      '|' +
      input.ranges.map((range) => range.name).join('|') +
      '|' +
      input.entries.join(',');
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        program: input.program,
        ranges: input.ranges,
        entries: input.entries,
        bytes: new Uint8Array(16 * 336),
        count: 0,
      };
      buckets.set(key, bucket);
    }
    if (bucket.count >= 16) throw new RangeError('Direct VFX packet exceeds its arena slab');
    const at = bucket.count++ * 336;
    bucket.bytes.set(
      new Uint8Array(input.runtime.buffer, input.runtime.byteOffset, input.runtime.byteLength),
      at,
    );
    const r = input.ranges,
      strides = [112, 4, 24, 20, 4, 4, input.customStride];
    if (r.length !== strides.length) throw new RangeError('Unaligned direct VFX range');
    const offsets = new Uint32Array(bucket.bytes.buffer, at + 304, 8);
    for (let i = 0; i < strides.length; i++) {
      const range = r[i],
        stride = strides[i];
      if (
        range === undefined ||
        stride === undefined ||
        !Number.isSafeInteger(range.offset / stride)
      )
        throw new RangeError('Unaligned direct VFX range');
      offsets[i] = range.offset / stride;
    }
    offsets[7] = 1;
  };
  const control = 'vfx.batch-job-control';
  const emit = (
    buckets: Map<string, Bucket>,
    resources: Resource[],
    pending: Map<string, Dispatch[]>,
  ) => {
    for (const bucket of buckets.values()) {
      const name = `vfx.batch-job-${nextPacket++}`,
        table = `${name}.table`,
        bindings = `${name}.bindings`;
      resources.push(
        {
          kind: 'buffer',
          name: table,
          size: bucket.bytes.byteLength,
          usage: ['storage'],
          data: bucket.bytes.subarray(0, bucket.count * 336),
        },
        {
          kind: 'compute-bindings',
          name: bindings,
          program: bucket.program,
          entries: [
            ...[0, 2, 3, 4, 5, 6, 11].map((binding, i) => {
              const range = bucket.ranges[i];
              if (range === undefined) throw new RangeError('Missing direct VFX range');
              return { binding, resource: range.name };
            }),
            { binding: 1, resource: table },
            { binding: 12, resource: control },
          ],
        },
      );
      let dispatches = pending.get(bucket.program);
      if (dispatches === undefined) {
        dispatches = [];
        pending.set(bucket.program, dispatches);
      }
      for (const entryPoint of bucket.entries)
        dispatches.push({ kind: 'direct', entryPoint, bindings, workgroups: [1, bucket.count] });
    }
  };
  const flush = (pending: Map<string, Dispatch[]>, passes: Pass[], scope: string) => {
    for (const [program, dispatches] of pending) {
      const bindings = dispatches[0]?.bindings;
      if (bindings === undefined) throw new Error('Missing direct VFX dispatch binding');
      passes.push({
        kind: 'compute',
        name: `vfx.batch-${scope}-${nextPacket++}`,
        program,
        bindings,
        dispatches,
      });
    }
    pending.clear();
  };
  return {
    simulation(input: {
      program: string;
      tick: number;
      reset: readonly Copy[];
      ranges: readonly VfxArenaRange[];
      entries: readonly string[];
      runtime: ArrayBufferView;
      customStride: number;
    }) {
      let wave = waves.get(input.tick);
      if (wave === undefined) {
        wave = { resets: [], buckets: new Map() };
        waves.set(input.tick, wave);
      }
      wave.resets.push(...input.reset);
      append(wave.buckets, input);
    },
    projection(
      view: string,
      input: {
        program: string;
        ranges: readonly VfxArenaRange[];
        entries: readonly string[];
        runtime: ArrayBufferView;
        customStride: number;
      },
    ) {
      let buckets = views.get(view);
      if (buckets === undefined) {
        buckets = new Map();
        views.set(view, buckets);
      }
      append(buckets, input);
    },
    finishFrame(resources: Resource[], passes: Pass[]) {
      if (waves.size === 0 && views.size === 0) return;
      resources.push({
        kind: 'buffer',
        name: control,
        size: 16,
        usage: ['uniform'],
        data: new Uint32Array(4),
      });
      const pending = new Map<string, Dispatch[]>();
      for (const [tick, wave] of [...waves].sort((a, b) => a[0] - b[0])) {
        if (wave.resets.length) {
          flush(pending, passes, 'frame');
          passes.push({ kind: 'copy', name: `vfx.batch-reset-${tick}`, copies: wave.resets });
        }
        emit(wave.buckets, resources, pending);
      }
      flush(pending, passes, 'frame');
    },
    finishView(view: string, resources: Resource[], passes: Pass[]) {
      const buckets = views.get(view);
      if (buckets === undefined) return;
      const pending = new Map<string, Dispatch[]>();
      emit(buckets, resources, pending);
      flush(pending, passes, 'view');
    },
  };
}
