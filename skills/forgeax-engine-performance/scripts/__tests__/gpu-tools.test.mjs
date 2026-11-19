import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGpuReport, gpuResourceTree, gpuGraph } from '../gpu_model.mjs';
import { gpuTimingReport, gpuTimingHtml, gpuTimingSvg } from '../gpu_timing.mjs';
import { gpuReportHtml } from '../gpu_view.mjs';
import { serveGpuReport, main } from '../gpu.mjs';
const identity = { tapeDigest: 'sha256:' + 'a'.repeat(64) };
const resource = (id, kind, bytes = null) => ({
  resourceId: id,
  kind,
  origin: 'bootstrap',
  createEventIndex: null,
  destroyEventIndex: null,
  descriptor: { desc: { label: 'scene/' + id } },
  consumers: [],
  lifecycle: {
    state: 'live',
    byteEstimate:
      bytes === null
        ? {
            status: 'unavailable',
            reason: kind === 'texture' ? 'unsupported-texture-dimension' : 'non-memory-resource',
          }
        : { status: 'known', bytes, basis: 'buffer-descriptor' },
  },
});
function fixture() {
  const texture = resource('t', 'texture', 128),
    view = resource('v', 'texture-view'),
    buffer = resource('b', 'buffer', 64),
    unknown = resource('u', 'texture');
  view.descriptor = { kind: 'createTextureView', sourceHandleId: 't', desc: {} };
  buffer.destroyEventIndex = 6;
  buffer.lifecycle.state = 'destroyed';
  return {
    resources: [texture, view, buffer, unknown, resource('query', 'query-set')],
    commands: [{ eventIndex: 0, params: { desc: { label: 'Lighting' } } }],
    passes: [
      {
        passIndex: 0,
        kind: 'compute',
        beginEventIndex: 0,
        workIndices: [0],
        colorAttachmentViewHandleIds: [],
      },
    ],
    works: [
      {
        workIndex: 0,
        passIndex: 0,
        kind: 'dispatchWorkgroups',
        pipeline: {
          status: 'available',
          descriptor: { desc: { label: 'Light shader' } },
          shaders: [{ stage: 'compute', moduleHandleId: 'shader', entryPoint: 'main' }],
        },
        bindings: [
          { resourceId: 'v', access: 'read', groupIndex: 0, binding: 0 },
          { resourceId: 'b', access: 'write', groupIndex: 0, binding: 1 },
        ],
      },
    ],
    resourceLifecycle: { scope: 'captured-tape-resource-closure' },
  };
}
test('captured storage is counted once; views resolve to backing IDs without inventing bytes or ownership', () => {
  const r = buildGpuReport(fixture(), identity);
  assert.equal(r.summary.observedObjects, 5);
  assert.equal(r.summary.storageObjects, 3);
  assert.equal(r.summary.knownDescriptorBytes, 192);
  assert.equal(r.summary.unknownStorageBytes, 1);
  assert.equal(gpuResourceTree(r).value, 192);
  assert.equal(gpuResourceTree(r, { metric: 'count' }).value, 5);
  assert.equal(gpuResourceTree(r, { metric: 'count', group: 'labels' }).value, 5);
  assert.equal(gpuResourceTree(r, { state: 'live' }).value, 128);
  assert.equal(r.uses[0].resourceId, 't');
  assert.equal(r.uses[0].viewResourceId, 'v');
  assert.equal(r.resources[1].label, 'scene/t · view');
  const graph = gpuGraph(r, { workIndex: 0 });
  assert.ok(graph.nodes.some((n) => n.data.resourceId === 't'));
  assert.ok(!graph.nodes.some((n) => n.data.resourceId === 'v'));
  assert.ok(graph.edges.some((e) => e.data.source === 'work/0' && e.data.target === 'resource/b'));
  assert.ok(graph.nodes.some((n) => n.data.kind === 'shader'));
});
test('empty passes retain attachments; graph bounds report omissions and unknown access remains undirected', () => {
  const f = fixture();
  f.passes.push({
    passIndex: 1,
    kind: 'render',
    beginEventIndex: 2,
    workIndices: [],
    colorAttachmentViewHandleIds: ['v'],
  });
  const r = buildGpuReport(f, identity),
    g = gpuGraph(r, { passIndex: 1 });
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges[0].data.unknown, true);
  assert.equal(gpuGraph(r, { workIndex: 0, maxNodes: 4 }).omittedNodes, 0);
  f.works[0].bindings.push(
    ...Array.from({ length: 20 }, (_, i) => ({
      resourceId: 'extra' + i,
      access: 'unknown',
      groupIndex: 0,
      binding: i + 3,
    })),
  );
  const bounded = gpuGraph(buildGpuReport(f, identity), { maxNodes: 4 });
  assert.ok(bounded.omittedNodes > 0);
  assert.equal(bounded.nodes.length, 4);
  assert.throws(() => gpuGraph(r, { workIndex: 999 }), /Unknown/);
});
const base = 9007199254740993000n;
function timingFrame() {
  const intervals = [
    [0, 4000000],
    [2000000, 6000000],
    [6000000, 6000000],
  ];
  const passes = intervals.map(([a, b], i) => ({
    status: 'measured',
    passName: 'pass' + i,
    passKind: 'raster',
    measurementSource: 'pass-boundary',
    executionIndex: i,
    beginningTick: String(base + BigInt(a)),
    endTick: String(base + BigInt(b)),
    durationNanoseconds: b - a,
  }));
  return {
    schemaVersion: '1.0',
    frameId: 9,
    deviceGeneration: 3,
    graphGeneration: 4,
    backendKind: 'webgpu',
    timestampPeriodNanoseconds: 1,
    passes,
    passCapacity: 5,
    executedPassCount: 3,
    measuredPassCount: 3,
    droppedPassCount: 0,
    measuredPassNanoseconds: 8000000,
  };
}
test('GPU trace retains exact bounded differences, overlapping independent lanes, equal ticks and unavailable whole-frame latency', () => {
  const r = gpuTimingReport(timingFrame(), { sourceSha256: 'a' }),
    slices = r.trace.traceEvents.filter((e) => e.ph === 'X');
  assert.equal(r.coverage.measuredIntervalUnionMs, 6);
  assert.equal(r.coverage.repeatedCoverageMs, 8);
  assert.equal(r.coverage.equalTickExecutions, 1);
  assert.equal(r.coverage.wholeFrameGpuDurationMs, null);
  assert.deepEqual(
    slices.map((e) => [e.ts, e.dur]),
    [
      [0, 4000],
      [2000, 4000],
      [6000, 0],
    ],
  );
  assert.equal(new Set(slices.map((e) => e.tid)).size, 3);
  assert.equal(slices[0].args.beginningTick, String(base));
  assert.match(gpuTimingSvg(r), /Union 6.000 ms/);
  const html = gpuTimingHtml(r);
  assert.match(html, /GPU pass timeline/);
  assert.doesNotMatch(html, /CPU sampled stack estimates|timeline-inspector/);
});
test('report HTML safely embeds labels and contains reusable framework-backed resource and pipeline viewers', () => {
  const f = fixture();
  f.resources[0].descriptor.desc.label = '</script><script>throw Error(1)</script>';
  const html = gpuReportHtml(buildGpuReport(f, identity), {
    scripts: [],
    notices: '<license>',
    manifest: {},
  });
  assert.ok(!html.includes('</script><script>throw'));
  assert.match(html, /\\u003c\/script/);
  assert.match(html, /&lt;license&gt;/);
  assert.match(html, /gpuResourceTree/);
  assert.match(html, /cytoscape\(/);
});
test('GPU server uses a fixed asset manifest and rejects foreign hosts and source-file requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-server-'));
  let server;
  try {
    await writeFile(join(dir, 'gpu.html'), 'gpu');
    await writeFile(join(dir, 'secret.txt'), 'secret');
    const served = await serveGpuReport(dir);
    server = served.server;
    assert.equal(await (await fetch(served.url)).text(), 'gpu');
    assert.equal((await fetch(served.url + 'secret.txt')).status, 404);
    assert.equal(
      await new Promise((done, reject) => {
        const req = request(served.url, { headers: { Host: 'example.com' } }, (res) => {
          res.resume();
          done(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      }),
      403,
    );
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});
test('GPU timing CLI emits machine data, static image and mature timeline without permitting output replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpu-cli-')),
    input = join(root, 'frame.json'),
    out = join(root, 'view');
  const original = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await writeFile(input, JSON.stringify({ observation: { frame: timingFrame() } }));
    await main(['timing', input, '--pointer', '/observation/frame', '--out-dir', out]);
    const r = JSON.parse(await readFile(join(out, 'timing.json'), 'utf8'));
    assert.equal(r.frame.frameId, 9);
    assert.match(await readFile(join(out, 'gpu-timing.svg'), 'utf8'), /<svg/);
    await assert.rejects(() => main(['timing', input, '--out-dir', out]), /already exists/);
  } finally {
    process.stdout.write = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('unmeasured GPU timing emits an honest unavailable page and image, without fabricated zero intervals', () => {
  const frame = timingFrame();
  frame.passes = frame.passes.map((p) => ({
    ...p,
    status: 'unmeasured',
    reason: { kind: 'timestamp-unavailable' },
  }));
  frame.measuredPassCount = 0;
  frame.measuredPassNanoseconds = 0;
  const report = gpuTimingReport(frame);
  assert.equal(report.coverage.timed, false);
  assert.equal(report.trace.traceEvents.filter((e) => e.ph === 'X').length, 0);
  assert.match(gpuTimingHtml(report), /GPU timing unavailable/);
  assert.doesNotMatch(gpuTimingHtml(report), /<iframe/);
  assert.match(gpuTimingSvg(report), /Envelope unavailable/);
});
