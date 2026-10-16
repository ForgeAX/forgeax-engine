import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeChromiumGpuDecoder, decoderMarkWindow } from '../analyze_chromium_gpu_decoder.mjs';

const begin = (ts, overrides = {}) => ({
  cat: 'disabled-by-default-gpu.service',
  ph: 'b',
  pid: 1,
  tid: 2,
  name: 'kDrawElementsInstancedANGLE',
  id2: { local: '0x19' },
  ts,
  args: { gl_category: 'disabled-by-default-gpu.decoder' },
  ...overrides,
});
const end = (ts, overrides = {}) => ({ ...begin(ts, overrides), ph: 'e', args: {} });
const analyze = (traceEvents, options) => analyzeChromiumGpuDecoder({ traceEvents }, options);

test('pairs reused and nested IDs without losing an outer scope or merging threads', () => {
  const result = analyze([
    begin(0),
    begin(10),
    end(20),
    end(40),
    begin(50),
    end(60),
    begin(70, { tid: 3 }),
    end(80, { tid: 3 }),
  ]);
  assert.equal(result.status, 'complete');
  assert.equal(result.coverage.completeSpans, 4);
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].count, 3);
  assert.ok(Math.abs(result.commands[0].clippedWallMs - 0.06) < 1e-12);
  assert.equal(result.commands[1].tid, 3);
});

test('clips boundary durations and retains only whole spans in percentiles, including zero', () => {
  const result = analyze([begin(0), end(20), begin(30), end(30), begin(40), end(60)], {
    windowUs: [10, 50],
  });
  assert.equal(result.commands[0].count, 3);
  assert.equal(result.commands[0].clippedWallMs, 0.02);
  assert.deepEqual(result.commands[0].containedDurationMs, { count: 1, p50: 0, p95: 0, max: 0 });
});

test('missing decoder category is unavailable; truncated/malformed ranges stay partial', () => {
  assert.equal(
    analyze([begin(0, { args: { gl_category: 'gpu_toplevel' } }), end(20)]).status,
    'unavailable',
  );
  const result = analyze([end(0), begin(10), end(5), begin(20), end(25), begin(30)]);
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.unmatchedServiceEnds, 1);
  assert.equal(result.coverage.invalidServiceEvents, 1);
  assert.equal(result.coverage.unclosedDecoderBegins, 1);
  assert.equal(result.commands[0].count, 1);
  assert.throws(() => analyze([], { windowUs: [20, 10] }), /increasing/);
});

test('named windows reject duplicate marks and unrelated renderer clocks', () => {
  const m = (name, ts, pid = 1) => ({ name, ts, pid, tid: 2, ph: 'I', cat: 'blink.user_timing' });
  assert.deepEqual(
    decoderMarkWindow({ traceEvents: [m('start', 10), m('end', 20)] }, 'start', 'end'),
    [10, 20],
  );
  assert.throws(
    () =>
      decoderMarkWindow(
        { traceEvents: [m('start', 10), m('start', 11), m('end', 20)] },
        'start',
        'end',
      ),
    /found 2/,
  );
  assert.throws(
    () => decoderMarkWindow({ traceEvents: [m('start', 10), m('end', 20, 3)] }, 'start', 'end'),
    /same renderer/,
  );
});
