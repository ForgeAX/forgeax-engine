import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cpuTimelineCallTrees,
  cpuTimelineFunctionRows,
  cpuTimelineSampleDensity,
  cpuTimelineSvg,
} from '../cpu_timeline_view.mjs';
import { buildCpuTimeline, cpuTimelineHtml, cpuTimelineTrace } from '../render_cpu_timeline.mjs';

const callFrame = (functionName) => ({
  functionName,
  url: 'file:///owner.mjs',
  lineNumber: 0,
  columnNumber: 0,
});
const profile = () => ({
  startTime: 1000,
  endTime: 11000,
  nodes: [
    { id: 1, callFrame: callFrame('(root)'), children: [2, 5] },
    { id: 2, callFrame: callFrame('update'), children: [3, 4] },
    { id: 3, callFrame: callFrame('update') }, // Recursive symbol, distinct stack level.
    { id: 4, callFrame: callFrame('draw') },
    { id: 5, callFrame: callFrame('(idle)') },
  ],
  samples: [2, 3, 4, 5],
  timeDeltas: [1000, 2000, 3000, 2000],
});

test('sample density counts observed endpoints and retains their full intervals after zooming', () => {
  const track = buildCpuTimeline(profile()).tracks[0];
  assert.deepEqual(cpuTimelineSampleDensity(track, 2, 6), {
    samples: 2,
    activeSamples: 2,
    intervalP50Ms: 2,
    intervalP95Ms: 3,
  });
  assert.deepEqual(cpuTimelineSampleDensity(track, 9, 10), {
    samples: 0,
    activeSamples: 0,
    intervalP50Ms: null,
    intervalP95Ms: null,
  });
});

function capture() {
  const raw = {
    failures: [],
    profiles: ['page', 'worker'].map((type, index) => ({
      target: { targetId: `target-${index}`, type },
      profile: profile(),
      scriptDigests: [],
    })),
  };
  const anchor = { offsetLowerMs: 1, offsetUpperMs: 1, timeOriginMs: 10000 };
  const report = {
    cpu: { commonWindow: { startTime: 1000, endTime: 11000 }, failures: [] },
    coldFirelineCpu: { anchorsBefore: [anchor], anchorsAfter: [anchor] },
    windows: { sampled: { submissionGaps: { worstCompletedGaps: [] } } },
  };
  const frames = {
    timeOrigin: 10000,
    firstLiveAt: 0,
    end: 10,
    frames: [0, 4, 10].map((at, index) => ({
      at,
      frameId: index + 1,
      worldIdentity: 'world',
      deviceGeneration: 0,
    })),
  };
  return { raw, options: { report, frames } };
}

test('merges only adjacent equal stack prefixes; preserves recursion and unknown startup/tail', () => {
  const model = buildCpuTimeline(profile());
  const track = model.tracks[0];
  assert.equal(track.summary.sampledMs, 7);
  assert.equal(track.summary.unobservedMs, 3);
  assert.deepEqual(track.slices, [
    { nodeId: 2, depth: 0, startMs: 1, endMs: 6 },
    { nodeId: 3, depth: 1, startMs: 1, endMs: 3 },
    { nodeId: 4, depth: 1, startMs: 3, endMs: 6 },
    { nodeId: 5, depth: 0, startMs: 6, endMs: 8 },
  ]);
  assert.equal(model.clock, null);
  assert.equal(model.frameIntervals.length, 0);
});

test('joins all completion intervals to separate targets without summing thread estimates', () => {
  const { raw, options } = capture();
  const model = buildCpuTimeline(raw, options);
  assert.equal(model.clock.offsetMs, 1);
  assert.equal(model.frameIntervals.length, 2);
  const [a, b] = model.frameIntervals;
  assert.equal(a.completionGapMs, 4);
  assert.equal(a.threads[0].sampledMs, 3);
  assert.equal(a.threads[0].categories.script, 3);
  assert.equal(a.threads[0].unobservedMs, 1);
  assert.equal(b.threads[0].sampledMs, 4);
  assert.equal(b.threads[0].categories.idle, 2);
  assert.equal(b.threads[0].unobservedMs, 2);
  assert.equal(Object.hasOwn(a, 'totalCpuMs'), false);
  assert.equal(a.threads.length, 2);
  assert.equal(a.threads[0].sampledMs + b.threads[0].sampledMs, model.tracks[0].summary.sampledMs);
});

test('targeted capture preserves unsampled target coverage in normalized data and image', () => {
  const { raw, options } = capture();
  const excluded = raw.profiles.pop().target;
  options.report.cpu.unsampledTargets = [{ ...excluded, title: 'other-worker' }];
  const model = buildCpuTimeline(raw, options);
  assert.deepEqual(model.captureScope.unsampledTargets, options.report.cpu.unsampledTargets);
  assert.match(cpuTimelineSvg(model), /not sampled: other-worker/);
});

test('does not bridge world/device replacement; marks dropped receipts and partial boundaries', () => {
  const { raw, options } = capture();
  options.frames.frames[0].at = -1;
  options.frames.frames[1].frameId = 8;
  options.frames.frames[2].worldIdentity = 'replacement';
  const model = buildCpuTimeline(raw, options);
  assert.equal(model.frameIntervals.length, 1);
  assert.equal(model.frameIntervals[0].coverage, 'partial');
  assert.equal(model.frameIntervals[0].missingIntermediateReceipts, 6);
});

test('rejects unanchored target merging, inconsistent clocks, lost targets and unordered receipts', () => {
  assert.throws(() => buildCpuTimeline(capture().raw), /clock anchors/);
  for (const mutate of [
    (x) => x.raw.failures.push({ targetId: 'lost' }),
    (x) => {
      x.options.report.coldFirelineCpu.anchorsAfter[0] = {
        offsetLowerMs: 3,
        offsetUpperMs: 3,
        timeOriginMs: 10000,
      };
    },
    (x) => x.options.frames.frames.reverse(),
    (x) => {
      x.raw.profiles[0].profile.samples[0] = 999;
    },
    (x) => {
      x.options.frames.frames[1].frameId = 1;
    },
    (x) => {
      delete x.options.frames;
    },
  ]) {
    const x = capture();
    mutate(x);
    assert.throws(() => buildCpuTimeline(x.raw, x.options));
  }
});

test('SVG/HTML escape source names and trace preserves estimated slice durations and target lanes', () => {
  const input = profile();
  input.nodes[1].callFrame.functionName = '</script><script>unsafe()</script>';
  const model = buildCpuTimeline(input),
    svg = cpuTimelineSvg(model, { width: 1200 });
  assert(svg.includes('&lt;/script&gt;'));
  assert(svg.startsWith('<svg '));
  assert(svg.endsWith('</svg>'));
  assert(!svg.includes('<script>'));
  const html = cpuTimelineHtml(model, 'export function mountCpuTimeline() {}');
  assert(!html.includes('</script><script>unsafe'));
  assert(html.includes('\\u003c/script>'));
  const trace = cpuTimelineTrace(model);
  assert.deepEqual(
    trace.traceEvents.filter((event) => event.cat === 'capture-boundary').map((event) => event.ts),
    [0, 10000],
  );
  const slices = trace.traceEvents.filter((event) => event.ph === 'X');
  assert.deepEqual(
    slices.map((s) => s.dur),
    [5000, 2000, 3000, 2000],
  );
  assert(slices.every((s) => s.cat === 'sampled-stack-estimate' && s.tid === 2));
  assert.throws(() => cpuTimelineSvg(model, { fromMs: -1 }));
  assert.throws(() => cpuTimelineSvg(model, { width: 100000 }));
});

test('negative deltas reorder paired ids/timestamps before producing nonnegative slice estimates', () => {
  const input = profile();
  input.timeDeltas = [1000, 3000, -1000, 2000];
  const track = buildCpuTimeline(input).tracks[0];
  assert(track.audit.attributionSensitive);
  assert(track.slices.every((s) => s.endMs > s.startMs));
  assert.equal(track.summary.sampledMs, 4);
});

test('function detail clips leaf and inclusive estimates independently and preserves recursive caller contexts', () => {
  const model = buildCpuTimeline(profile());
  const rows = cpuTimelineFunctionRows(model, 2, 4)[0].rows;
  const parent = rows.find((row) => row.nodeId === 2);
  const recursive = rows.find((row) => row.nodeId === 3);
  const draw = rows.find((row) => row.nodeId === 4);
  assert.equal(parent.inclusiveMs, 2);
  assert.equal(parent.selfMs, 0);
  assert.equal(recursive.selfMs, 1);
  assert.equal(recursive.inclusiveMs, 1);
  assert.equal(recursive.parentNodeId, 2);
  assert.equal(draw.selfMs, 1);
  assert.equal(draw.samples, 1);
  assert.equal(
    rows.reduce((sum, row) => sum + row.selfMs, 0),
    2,
  );
});

test('timeline labels prioritize names and keep source coordinates in hover details', () => {
  const model = buildCpuTimeline(profile());
  model.tracks[0].nodes.find((node) => node.nodeId === 2).source = {
    file: 'engine/long-owner-file.ts',
    line: 42,
    column: 3,
  };
  const svg = cpuTimelineSvg(model, { width: 1200 });
  assert(svg.includes('Source: engine/long-owner-file.ts:42:3'));
  const textOnly = [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((match) => match[1]);
  assert(textOnly.includes('update'));
  assert(!textOnly.some((text) => text.includes('long-owner-file.ts')));
});

test('CPU workbench writes integrated reusable artifacts to a new directory and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cpu-timeline-test-'));
  try {
    const input = join(directory, 'real.cpuprofile'),
      out = join(directory, 'view');
    await writeFile(input, JSON.stringify(profile()));
    const script = fileURLToPath(new URL('../cpu.mjs', import.meta.url));
    const args = [script, 'report', input, '--out-dir', out, '--width', '1200'];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    for (const file of [
      'timeline.json',
      'analysis.json',
      'timeline.html',
      'timeline.svg',
      'timeline.trace.json',
    ])
      assert((await readFile(join(out, file))).length > 100);
    assert.equal(spawnSync(process.execPath, args).status, 1);
    assert.equal(spawnSync(process.execPath, [script, '--help']).status, 0);
    assert.equal(JSON.parse(await readFile(input, 'utf8')).startTime, 1000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CPU workbench loads capture defaults and emits the same admitted totals and windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cpu-workbench-test-'));
  try {
    const x = capture();
    for (const [file, value] of [
      ['cpu-profiles.json', x.raw],
      ['capture-report.json', x.options.report],
      ['sampled-frames.json', x.options.frames],
    ])
      await writeFile(join(directory, file), JSON.stringify(value));
    const script = fileURLToPath(new URL('../cpu.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [script, 'report', directory], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const analysis = JSON.parse(await readFile(join(directory, 'view', 'analysis.json'), 'utf8'));
    const model = JSON.parse(await readFile(join(directory, 'view', 'timeline.json'), 'utf8'));
    assert.equal(analysis.targets.length, 2);
    assert.equal(analysis.targets[0].sampledMs, model.tracks[0].summary.sampledMs);
    assert.equal(analysis.targets[0].unsampledMs, model.tracks[0].summary.unobservedMs);
    assert.equal(analysis.windows.completeness, model.completeness);
    assert.equal(analysis.targets[0].topInclusive[0].inclusiveMs, 7);
    assert.match(model.initialView.criterion, /median non-idle/);
    assert.equal(
      spawnSync(process.execPath, [script, 'report', directory], { encoding: 'utf8' }).status,
      1,
    );
    assert.equal(
      spawnSync(process.execPath, [script, 'calibrate', '--intervals-us', '0'], {
        encoding: 'utf8',
      }).status,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('call trees aggregate scattered visits while retaining self costs and caller paths', () => {
  const raw = profile();
  raw.samples = [5, 4, 5, 4];
  const model = buildCpuTimeline(raw);
  const top = cpuTimelineCallTrees(model, 0, 10)[0];
  assert.equal(top.nodes[0].totalMs, 4);
  const draw = top.nodes.find((n) => n.label === 'draw');
  assert.equal(draw.totalMs, 4);
  assert.equal(draw.selfMs, 4);
  assert.equal(draw.samples, 2);
  const caller = top.nodes[draw.parentId];
  assert.equal(caller.label, 'update');
  assert.equal(caller.selfMs, 0);
  const bottom = cpuTimelineCallTrees(model, 0, 10, { direction: 'bottom-up' })[0];
  const leaf = bottom.nodes[bottom.nodes[0].children[0]];
  assert.equal(leaf.label, 'draw');
  assert.equal(leaf.selfMs, 4);
  assert.equal(bottom.nodes[leaf.children[0]].label, 'update');
  assert.equal(cpuTimelineCallTrees(model, 2, 7)[0].nodes[0].totalMs, 2);
  assert.throws(() => cpuTimelineCallTrees(model, 0, 10, { direction: 'calls' }));
});

test('call tree preserves root-only samples as unknown stack evidence', () => {
  const raw = profile();
  raw.samples = [5, 1, 5, 4];
  const model = buildCpuTimeline(raw);
  const tree = cpuTimelineCallTrees(model, 0, 10)[0];
  assert.equal(tree.nodes[0].totalMs, 4);
  assert.equal(tree.nodes.find((n) => n.label === '(unattributed stack)').selfMs, 2);
});
