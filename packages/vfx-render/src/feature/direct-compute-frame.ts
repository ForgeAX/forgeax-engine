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
  /** Job rows written so far; grows to at most one full slab table. */
  bytes: Uint8Array;
  /** Word view of `bytes`, replaced only when the table grows. */
  words: Uint32Array;
  count: number;
}
/** One job table holds at most sixteen 336-byte rows (one arena slab). */
const JOB_BYTES = 336;
const TABLE_BYTES = 16 * JOB_BYTES;
const JOB_STRIDES_PREFIX = [112, 4, 24, 20, 4, 4] as const;
/**
 * Bucket key parts of retained range/entry lists. Callers pass the same frozen
 * lists every frame, so their joined names are built once per list.
 */
const rangeKeys = new WeakMap<readonly VfxArenaRange[], string>();
const entryKeys = new WeakMap<readonly string[], string>();
function rangeKey(ranges: readonly VfxArenaRange[]): string {
  let key = rangeKeys.get(ranges);
  if (key === undefined) {
    key = ranges.map((range) => range.name).join('|');
    if (Object.isFrozen(ranges)) rangeKeys.set(ranges, key);
  }
  return key;
}
function entryKey(entries: readonly string[]): string {
  let key = entryKeys.get(entries);
  if (key === undefined) {
    key = entries.join(',');
    if (Object.isFrozen(entries)) entryKeys.set(entries, key);
  }
  return key;
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
    const key = `${input.program}|${rangeKey(input.ranges)}|${entryKey(input.entries)}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        program: input.program,
        ranges: input.ranges,
        entries: input.entries,
        bytes: new Uint8Array(JOB_BYTES),
        words: new Uint32Array(0),
        count: 0,
      };
      bucket.words = new Uint32Array(bucket.bytes.buffer);
      buckets.set(key, bucket);
    }
    if (bucket.count >= 16) throw new RangeError('Direct VFX packet exceeds its arena slab');
    const at = bucket.count++ * JOB_BYTES;
    if (at + JOB_BYTES > bucket.bytes.byteLength) {
      // Most tables carry one or two jobs; grow geometrically up to one slab.
      const grown = new Uint8Array(Math.min(TABLE_BYTES, bucket.bytes.byteLength * 2));
      grown.set(bucket.bytes);
      bucket.bytes = grown;
      bucket.words = new Uint32Array(grown.buffer);
    }
    const runtime = input.runtime;
    bucket.bytes.set(
      runtime instanceof Uint8Array
        ? runtime
        : new Uint8Array(runtime.buffer, runtime.byteOffset, runtime.byteLength),
      at,
    );
    const r = input.ranges;
    if (r.length !== JOB_STRIDES_PREFIX.length + 1)
      throw new RangeError('Unaligned direct VFX range');
    const words = bucket.words,
      offsets = (at + 304) >> 2;
    for (let i = 0; i < r.length; i++) {
      const range = r[i],
        stride = i < JOB_STRIDES_PREFIX.length ? JOB_STRIDES_PREFIX[i] : input.customStride;
      if (
        range === undefined ||
        stride === undefined ||
        !Number.isSafeInteger(range.offset / stride)
      )
        throw new RangeError('Unaligned direct VFX range');
      words[offsets + i] = range.offset / stride;
    }
    words[offsets + 7] = 1;
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
          size: TABLE_BYTES,
          usage: ['storage'],
          data: bucket.bytes.subarray(0, bucket.count * JOB_BYTES),
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
