import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { Tape } from '../protocol/types';
import { openReplay, type ReplayBackend, type ReplayBenchmarkOptions } from '../replay/session';
import { matchPasses } from '../replay/timing-compare';

function computePass(id: string, label: string): Tape['events'] {
  return [
    { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: id, desc: { label } },
    { kind: 'dispatchWorkgroups', passHandleId: id, x: 1, y: 1, z: 1 },
    { kind: 'endComputePass', passHandleId: id },
  ];
}

const events: Tape['events'] = [
  { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 16, usage: 8 } },
  { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1', desc: {} },
  { kind: 'pushDebugGroup', cmdHandleId: 'cmd:1', groupLabel: 'frame' },
  ...computePass('pass:0', 'shadow'),
  ...computePass('pass:1', 'main'),
  { kind: 'popDebugGroup', cmdHandleId: 'cmd:1' },
  { kind: 'finish', cmdHandleId: 'cmd:1' },
  { kind: 'writeBuffer', handleId: 'buf:1', bufferOffset: 0, dataHash: 'payload', size: 4 },
  { kind: 'submit', cmdHandleIds: ['cmd:1'] },
  { kind: 'frameMark', frameIdx: 0 },
];
const tape: Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 1 },
  bootstrap: [],
  events,
  blobs: [{ hash: 'payload', bytes: new Uint8Array([1, 2, 3, 4]), compression: 'none' }],
};

/** Fills a mapped timestamp readback; the default leaves every query unwritten (zero). */
type TickFill = (ticks: BigUint64Array) => void;

/** A null device that claims timestamps; mapped readbacks hold `fill`'s ticks. */
async function timestampBackend(
  onCreateBuffer?: (desc: { readonly usage?: number | undefined }) => void,
  fill?: TickFill,
): Promise<ReplayBackend> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(device.error.hint);
  const gpu = device.value;
  vi.spyOn(gpu, 'caps', 'get').mockReturnValue({
    ...gpu.caps,
    timestampQuery: true,
    timestampPeriodNanoseconds: 1,
  });
  const createQuerySet = gpu.createQuerySet.bind(gpu);
  vi.spyOn(gpu, 'createQuerySet').mockImplementation((desc) =>
    createQuerySet({ ...desc, type: 'occlusion' }),
  );
  const createBuffer = gpu.createBuffer.bind(gpu);
  vi.spyOn(gpu, 'createBuffer').mockImplementation((desc) => {
    onCreateBuffer?.(desc);
    const created = createBuffer(desc);
    if (created.ok) mapToTicks(created.value, desc.size ?? 0, fill);
    return created;
  });
  return { device: gpu, createShaderModule };
}

/** The null device cannot map; each map of a readback buffer gets freshly filled ticks. */
function mapToTicks(buffer: object, size: number, fill: TickFill | undefined): void {
  Object.defineProperty(buffer, 'mapAsync', {
    value: async () => {
      const range = new ArrayBuffer(size);
      fill?.(new BigUint64Array(range, 0, Math.floor(size / 8)));
      return ok({ getMappedRange: () => ok(range), unmap: () => undefined });
    },
  });
}

/** Every begin/end query pair gets an interval of `duration()` ticks, passes back to back. */
function sequentialTicks(duration: (pair: number) => number): TickFill {
  return (ticks) => {
    let clock = 1000n;
    for (let pair = 0; pair * 2 + 1 < ticks.length; pair++) {
      ticks[pair * 2] = clock;
      clock += BigInt(duration(pair));
      ticks[pair * 2 + 1] = clock;
    }
  };
}

interface TraceOptions extends ReplayBenchmarkOptions {
  readonly skipLabel?: string;
  readonly fill?: TickFill;
}

async function traceReplay(options: TraceOptions) {
  const trace: string[] = [];
  const { skipLabel, fill, ...benchmark } = options;
  const backend = await timestampBackend(() => trace.push('buffer'), fill);
  const queue = backend.device.queue;
  const submit = queue.submit.bind(queue);
  vi.spyOn(queue, 'submit').mockImplementation((buffers) => {
    trace.push(`submit:${buffers.length}`);
    return submit(buffers);
  });
  const done = queue.onSubmittedWorkDone.bind(queue);
  vi.spyOn(queue, 'onSubmittedWorkDone').mockImplementation(() => {
    trace.push('wait');
    return done();
  });
  const write = queue.writeBuffer.bind(queue);
  vi.spyOn(queue, 'writeBuffer').mockImplementation((...args) => {
    trace.push('write');
    return write(...args);
  });
  const replay = (await openReplay(tape, backend)).unwrap();
  try {
    const result = (
      await replay.benchmarkPasses({
        warmup: 0,
        repeat: 1,
        ...benchmark,
        ...(skipLabel === undefined ? {} : { skip: { passLabel: skipLabel } }),
      })
    ).unwrap();
    return { trace, result };
  } finally {
    (await replay.dispose()).unwrap();
  }
}

/** Tape-replay submissions only: from the recorded queue write up to the timestamp resolve buffer. */
function frameSubmissions(trace: readonly string[]): string[] {
  const tail = trace.slice(trace.indexOf('write'));
  return tail.slice(0, tail.indexOf('buffer'));
}

/** Steps after the first recorded queue write, up to the next write, wait or buffer creation. */
function replaySubmissions(trace: readonly string[]): string[] {
  const tail = trace.slice(trace.indexOf('write'));
  const end = tail.findIndex(
    (step, i) => i > 0 && (step === 'write' || step === 'wait' || step === 'buffer'),
  );
  return end < 0 ? tail : tail.slice(0, end);
}

describe('replay GPU benchmark', () => {
  it('submits the frame once without isolation and waits for each readback when reloading', async () => {
    const { trace, result } = await traceReplay({ restore: 'reload' });
    expect(frameSubmissions(trace)).toEqual(['write', 'submit:1']);
    expect(result).toMatchObject({ warmup: 0, repeat: 1, isolate: false });
    expect(result.restore).toEqual({ mode: 'reload', pipelineDepth: 0 });
    expect(result.passes.map((pass) => pass.label)).toEqual(['shadow', 'main']);
    expect(result.base.samples).toHaveLength(1);
  });

  it('keeps resources and pipelines replays without waiting in steady mode', async () => {
    const { trace, result } = await traceReplay({ repeat: 6 });
    expect(result.restore).toMatchObject({ mode: 'steady', pipelineDepth: 4 });
    expect(result.base.samples).toHaveLength(6);
    // frame submit, then its timestamp resolve; no wait sits between replays.
    expect(replaySubmissions(trace)).toEqual(['write', 'submit:1', 'submit:1']);
    expect(trace.includes('wait')).toBe(false);
    // two timestamp banks and their staging buffers once, plus the tape's own
    // per-frame buffer (created by an event, not bootstrap) once per replay.
    expect(trace.filter((step) => step === 'buffer')).toHaveLength(4 + 6);
  });

  it('isolates every pass in its own submission and drains the queue after each', async () => {
    const { trace, result } = await traceReplay({ isolate: true });
    // before pass 0 | pass 0 | between | pass 1 | after pass 1, each followed by a wait;
    // the recorded queue write still precedes all of them.
    expect(frameSubmissions(trace)).toEqual([
      'write',
      ...Array.from({ length: 5 }, () => ['submit:1', 'wait']).flat(),
    ]);
    expect(result.isolate).toBe(true);
    expect(result.restore.pipelineDepth).toBe(0);
  });

  it('names executed passes whose timestamps are unwritten instead of dropping them', async () => {
    const { result } = await traceReplay({ repeat: 2 });
    expect(result.timestampCoverage.complete).toBe(false);
    expect(result.timestampCoverage.missingPasses).toEqual([
      {
        passIndex: 0,
        label: 'shadow',
        kind: 'compute',
        variant: 'base',
        reason: 'unwritten',
        replays: 2,
      },
      {
        passIndex: 1,
        label: 'main',
        kind: 'compute',
        variant: 'base',
        reason: 'unwritten',
        replays: 2,
      },
    ]);
  });

  it('reports complete coverage, a median interval and a stable drift check for steady ticks', async () => {
    const { result } = await traceReplay({ repeat: 8, fill: sequentialTicks(() => 100) });
    expect(result.timestampCoverage).toEqual({ complete: true, missingPasses: [] });
    expect(result.base.frame.union.p50).toBe(200);
    expect(result.base.unionP50Interval).toMatchObject({ low: 200, high: 200 });
    expect(result.base.drift.stable).toBe(true);
  });

  it('extends repeat until the union interval meets the target, up to maxRepeat', async () => {
    let n = 0;
    const noisy = sequentialTicks(() => 100 + ((n++ * 37) % 41));
    const loose = await traceReplay({ repeat: 6, ciTargetNanoseconds: 1e6, fill: noisy });
    expect(loose.result.repeat).toBe(6);
    expect(loose.result.convergence).toMatchObject({ metric: 'base-union-p50', met: true });
    const tight = await traceReplay({
      repeat: 6,
      maxRepeat: 26,
      ciTargetNanoseconds: 0.5,
      fill: noisy,
    });
    expect(tight.result.repeat).toBe(26);
    expect(tight.result.convergence?.met).toBe(false);
  });

  it('gives the paired delta a bootstrap interval and verdict', async () => {
    const { result } = await traceReplay({
      repeat: 8,
      skipLabel: '^shadow$',
      fill: sequentialTicks(() => 100),
    });
    // skipping shadow removes its 100 ticks from the union every round.
    expect(result.ablated?.delta.union.p50).toBe(100);
    expect(result.ablated?.unionVerdict).toMatchObject({ significant: true, ci: { low: 100 } });
  });

  it('interleaves base and ablated replays and marks skipped passes', async () => {
    const { result } = await traceReplay({ skipLabel: '^shadow$' });
    expect(result.ablated?.passIndices).toEqual([0]);
    expect(result.passes.map((pass) => pass.skipped)).toEqual([true, false]);
    expect(result.ablated?.samples).toHaveLength(1);
    expect(result.ablated?.delta.union.count).toBe(1);
  });

  it('restores mutable bootstrap bytes with GPU copies and creates them once', async () => {
    const seeded: Tape = {
      ...tape,
      bootstrap: [
        {
          handleId: 'buf:seed',
          kind: 'buffer',
          create: { kind: 'createBuffer', handleId: 'buf:seed', desc: { size: 16, usage: 0x80 } },
          initialData: [{ hash: 'payload', byteOffset: 0, byteLength: 4 }],
        },
      ],
    };
    const usages: number[] = [];
    const backend = await timestampBackend((desc) => usages.push(desc.usage ?? 0));
    const copies = vi.fn();
    const createEncoder = backend.device.createCommandEncoder.bind(backend.device);
    vi.spyOn(backend.device, 'createCommandEncoder').mockImplementation((desc) => {
      const encoder = createEncoder(desc);
      if (encoder.ok && desc?.label === 'rhi-debug:steady-restore')
        vi.spyOn(encoder.value, 'copyBufferToBuffer').mockImplementation(copies);
      return encoder;
    });
    const replay = (await openReplay(seeded, backend)).unwrap();
    const result = (await replay.benchmarkPasses({ warmup: 1, repeat: 3 })).unwrap();
    expect(result.restore).toMatchObject({
      mode: 'steady',
      steady: { buffers: 1, textures: 0, bytes: 16, unrestored: [] },
    });
    expect(copies).toHaveBeenCalledTimes(4);
    // the seeded buffer gains COPY_SRC | COPY_DST once and is never re-created per replay.
    expect(usages.filter((usage) => usage === (0x80 | 0x4 | 0x8))).toHaveLength(1);
    (await replay.dispose()).unwrap();
  });

  it('falls back to reloading when an event destroys a bootstrap resource', async () => {
    const destroying: Tape = {
      ...tape,
      bootstrap: [
        {
          handleId: 'buf:boot',
          kind: 'buffer',
          create: { kind: 'createBuffer', handleId: 'buf:boot', desc: { size: 16, usage: 0x80 } },
          initialData: [],
        },
      ],
      events: [
        ...events.slice(0, -1),
        { kind: 'destroyBuffer', handleId: 'buf:boot' },
        events.at(-1) as Tape['events'][number],
      ],
    };
    const replay = (await openReplay(destroying, await timestampBackend())).unwrap();
    const result = (await replay.benchmarkPasses({ warmup: 0, repeat: 1 })).unwrap();
    expect(result.restore).toMatchObject({ mode: 'reload', pipelineDepth: 0 });
    expect(result.restore.fallbackReason).toMatch(/destroys bootstrap resource buf:boot/);
    (await replay.dispose()).unwrap();
  });

  it('rejects a benchmark without measured replays', async () => {
    const backend = await timestampBackend();
    const replay = (await openReplay(tape, backend)).unwrap();
    const result = await replay.benchmarkPasses({ repeat: 0 });
    expect(result.ok).toBe(false);
    (await replay.dispose()).unwrap();
  });
});

describe('replay comparison', () => {
  it('times two tapes in alternating chunks and pairs the candidate-minus-baseline delta', async () => {
    const order: string[] = [];
    const tagged = (tag: string, ticks: number): TickFill => {
      const fill = sequentialTicks(() => ticks);
      return (range) => {
        order.push(tag);
        fill(range);
      };
    };
    const baseline = (
      await openReplay(tape, await timestampBackend(undefined, tagged('A', 100)))
    ).unwrap();
    const candidate = (
      await openReplay(tape, await timestampBackend(undefined, tagged('B', 150)))
    ).unwrap();
    const result = (
      await baseline.compareWith(candidate, { warmup: 0, repeat: 8, pipelineDepth: 1 })
    ).unwrap();
    // depth 1 maps once per replay; chunks of 2 replays run A B, B A, A B, B A.
    expect(order.join('')).toBe('AABBBBAAAABBBBAA');
    expect(result).toMatchObject({ repeat: 8, chunk: 2, isolate: false });
    expect(result.baseline.restore.mode).toBe('steady');
    expect(result.baseline.benchmark.frame.union.p50).toBe(200);
    expect(result.candidate.benchmark.frame.union.p50).toBe(300);
    expect(result.delta.union.p50).toBe(100);
    expect(result.unionVerdict).toMatchObject({ significant: true, ci: { low: 100, high: 100 } });
    expect(result.passes.map((pass) => [pass.label, pass.deltaP50])).toEqual([
      ['shadow', 50],
      ['main', 50],
    ]);
    (await baseline.dispose()).unwrap();
    (await candidate.dispose()).unwrap();
  });

  it('refuses to compare a session with itself', async () => {
    const replay = (await openReplay(tape, await timestampBackend())).unwrap();
    expect((await replay.compareWith(replay)).ok).toBe(false);
    (await replay.dispose()).unwrap();
  });

  it('matches passes by label and occurrence and lists the rest', () => {
    const pass = (passIndex: number, label: string, p50: number) => ({
      passIndex,
      kind: 'render' as const,
      label,
      workIndices: [],
      gpu: { count: 1, min: p50, p50, p95: p50, max: p50, mean: p50, stddev: 0 },
      skipped: false,
    });
    const matched = matchPasses(
      [pass(0, 'blur', 10), pass(1, 'blur', 20), pass(2, 'fxaa', 5)],
      [pass(0, 'blur', 12), pass(1, 'bloom', 7)],
    );
    expect(matched.passes).toEqual([
      expect.objectContaining({ label: 'blur', occurrence: 0, deltaP50: 2 }),
    ]);
    expect(matched.unmatchedPasses).toEqual({ baseline: ['blur', 'fxaa'], candidate: ['bloom'] });
  });
});
