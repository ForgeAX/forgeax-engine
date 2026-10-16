import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeHeapProfile } from '../analyze_heap_profile.mjs';
import { digest } from '../lib.mjs';
import { symbolizeNodes } from '../source_maps.mjs';
import { summarizeNativeGc } from '../summarize_native_gc.mjs';

const frame = (functionName, url = '') => ({ functionName, url, lineNumber: 0, columnNumber: 0 });
const node = (id, selfSize, callFrame, children = []) => ({ id, selfSize, callFrame, children });
const heap = () => ({
  head: node(1, 0, frame('(root)'), [
    node(2, 10, frame('producer', 'https://fixture.test/assets/a.js'), [
      node(3, 30, frame('join')),
      node(4, 20, frame('unmapped helper', 'https://fixture.test/assets/a.js')),
    ]),
    node(5, 40, frame('unknown')),
  ]),
  samples: [
    { nodeId: 2, size: 11 },
    { nodeId: 3, size: 30 },
  ],
});
const source = { file: 'engine/owner.ts', line: 1, column: 1, name: null };

test('CLI rejects symbols for a foreign profile or modified raw input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-gc-symbols-'));
  try {
    const bytes = JSON.stringify({ heap: heap() });
    await writeFile(join(root, 'input.json'), bytes);
    const symbols = {
      kind: 'heap-source-symbols',
      inputSha256: digest(bytes),
      profilePointer: '/heap',
      symbols: [{ nodeId: 2, source }],
    };
    const cli = fileURLToPath(new URL('../analyze_heap_profile.mjs', import.meta.url));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          cli,
          join(root, 'input.json'),
          '--profile-pointer',
          '/heap',
          '--symbols',
          join(root, 'symbols.json'),
        ],
        { encoding: 'utf8' },
      );
    await writeFile(join(root, 'symbols.json'), JSON.stringify(symbols));
    assert.equal(run().status, 0);
    symbols.profilePointer = '';
    await writeFile(join(root, 'symbols.json'), JSON.stringify(symbols));
    assert.equal(run().status, 1);
    symbols.profilePointer = '/heap';
    symbols.inputSha256 = digest('different');
    await writeFile(join(root, 'symbols.json'), JSON.stringify(symbols));
    assert.equal(run().status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('heap partitions conserve bytes without counting native/script ancestors twice', () => {
  const result = analyzeHeapProfile(heap(), new Map([[2, source]]));
  assert.equal(result.totalBytes, 100);
  assert.equal(result.totalSampleBytes, 41);
  assert.deepEqual(result.coverage, {
    directBytes: 10,
    ancestorBytes: 50,
    unresolvedBytes: 40,
    directFraction: 0.1,
    locatedAncestorFraction: 0.6,
  });
  assert.equal(result.nearestOwnerFiles[0].bytes, 60);
  assert.equal(result.topNearestCallers[0].descendantBytes, 50);
  assert.equal(result.topNearestCallers[0].descendants.length, 2);
  assert.equal(result.topUnresolved[0].bytes, 40);
});

test('heap malformed trees/samples and foreign symbols fail closed', () => {
  for (const change of [
    (h) => h.head.children.push(h.head),
    (h) => h.head.children.push(h.head.children[0]),
    (h) => (h.head.children[0].selfSize = -1),
    (h) => (h.head.children[0].selfSize = Infinity),
    (h) => h.samples.push({ nodeId: 999, size: 1 }),
    (h) => (h.samples[0].size = NaN),
    (h) => (h.head.children[0].callFrame.lineNumber = -2),
  ]) {
    const h = heap();
    change(h);
    assert.throws(() => analyzeHeapProfile(h));
  }
  assert.throws(() => analyzeHeapProfile(heap(), new Map([[999, source]])));
  assert.throws(() => analyzeHeapProfile(heap(), new Map([[2, { ...source, line: 0 }]])));
});

test('without source maps heap analyzer reports uncertainty rather than guessing ownership', () => {
  const result = analyzeHeapProfile(heap());
  assert.equal(result.coverage.unresolvedBytes, 100);
  assert.equal(result.topNearestCallers.length, 0);
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-gc-analysis-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('source symbolization authenticates script bytes, missing maps and deployment prefixes', async () =>
  fixture(async (root) => {
    const bytes = 'const result = 1;';
    await writeFile(join(root, 'a.js'), bytes);
    const input = {
      nodes: [{ id: 2, callFrame: frame('producer', 'https://fixture.test/game/a.js') }],
      scriptDigests: [{ url: 'https://fixture.test/game/a.js', sha256: digest(bytes) }],
      baseUrl: 'https://fixture.test/game/',
      distDirectory: root,
    };
    assert.equal((await symbolizeNodes(input)).symbols.size, 0);
    await writeFile(
      join(root, 'a.js.map'),
      JSON.stringify({
        version: 3,
        file: 'a.js',
        sources: ['owner.ts'],
        names: [],
        mappings: 'AAAA',
        sourcesContent: ['const result = 1;'],
      }),
    );
    assert.equal((await symbolizeNodes(input)).symbols.get(2).file, 'owner.ts');
    await assert.rejects(
      symbolizeNodes({
        ...input,
        scriptDigests: [{ url: input.scriptDigests[0].url, sha256: digest('changed') }],
      }),
      /digest mismatch/,
    );
    await assert.rejects(
      symbolizeNodes({
        ...input,
        scriptDigests: [
          ...input.scriptDigests,
          { ...input.scriptDigests[0], sha256: digest('other') },
        ],
      }),
      /Conflicting/,
    );
  }));

test('source map identity and path escape are rejected', async () =>
  fixture(async (root) => {
    await writeFile(join(root, 'a.js'), 'x');
    const input = {
      nodes: [{ id: 2, callFrame: frame('producer', 'https://fixture.test/a.js') }],
      scriptDigests: [{ url: 'https://fixture.test/a.js', sha256: digest('x') }],
      baseUrl: 'https://fixture.test/',
      distDirectory: root,
    };
    await writeFile(
      join(root, 'a.js.map'),
      JSON.stringify({
        version: 3,
        file: 'wrong.js',
        sources: ['a.ts'],
        names: [],
        mappings: 'AAAA',
      }),
    );
    await assert.rejects(symbolizeNodes(input), /identity mismatch/);
    await assert.rejects(
      symbolizeNodes({
        ...input,
        nodes: [
          { id: 2, callFrame: frame('producer', 'https://fixture.test/%2e%2e%2foutside.js') },
        ],
      }),
      /escapes/,
    );
  }));

test('chained Engine maps require each bundle embedded intermediate to match frozen output', async () =>
  fixture(async (root) => {
    const engine = join(root, 'engine');
    await mkdir(engine);
    const compiled = 'export const result = 1;',
      served = 'const result = 1;';
    await writeFile(join(root, 'a.js'), served);
    await writeFile(join(engine, 'a.mjs'), compiled);
    await writeFile(
      join(engine, 'a.mjs.map'),
      JSON.stringify({
        version: 3,
        file: 'a.mjs',
        sources: ['owner.ts'],
        names: [],
        mappings: 'AAAA',
      }),
    );
    const payload = {
      version: 3,
      file: 'a.js',
      sources: ['engine/a.mjs'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: [compiled],
    };
    await writeFile(join(root, 'a.js.map'), JSON.stringify(payload));
    const input = {
      nodes: [{ id: 2, callFrame: frame('producer', 'https://fixture.test/a.js') }],
      scriptDigests: [{ url: 'https://fixture.test/a.js', sha256: digest(served) }],
      baseUrl: 'https://fixture.test/',
      distDirectory: root,
      engineDirectory: engine,
    };
    const mapped = await symbolizeNodes(input);
    assert.equal(mapped.symbols.get(2).file, 'engine/owner.ts');
    assert.equal(mapped.authenticatedFiles.length, 4);
    payload.sourcesContent[0] = 'stale';
    await writeFile(join(root, 'a.js.map'), JSON.stringify(payload));
    await assert.rejects(symbolizeNodes(input), /differs/);
  }));

const marker = { name: 'gc-owned:engine', targetId: 'target-engine', realm: 'Engine Worker' };
const event = (name, ts, dur, extra = {}) => ({ pid: 1, tid: 2, name, ts, dur, ph: 'X', ...extra });
const trace = () => ({
  traceEvents: [
    event(marker.name, 1, 0, { cat: 'blink.user_timing' }),
    event('V8.GCTraceGCNVP', 10, 0, {
      args: { value: JSON.stringify({ allocated: 999, promoted: 99 }) },
    }),
    event('MinorGC', 20, 10),
    event('MajorGC', 50, 20, { tdur: 5 }),
    event('V8.GCTraceGCNVP', 1000010, 0, {
      args: { value: JSON.stringify({ allocated: 1048576, promoted: 8 }) },
    }),
    event('MajorGC', 2000000, 500, { tdur: 100 }),
    event('MinorGC', 3000000, 200, { tid: 7 }),
  ],
});

test('native GC counts only owned threads and observed counter boundaries', () => {
  const p = summarizeNativeGc(trace(), [marker]).profiles[0];
  assert.equal(p.minor.count, 1);
  assert.equal(p.minor.cpuMs, null);
  assert.equal(p.major.wallMs, 0.52);
  assert(Math.abs(p.major.cpuMs - 0.105) < 1e-12);
  assert.equal(p.boundaryCounters.allocatedBytes, 1048576);
  assert.equal(p.boundaryCounters.allocatedMiBPerSecond, 1);
  assert.equal(p.boundaryCounters.excludesFirstCounter, true);
});

test('natural observation excludes terminal/crossing events and retains whole trace', () => {
  const t = trace();
  t.traceEvents.push(event('MinorGC', 999999, 30));
  const result = summarizeNativeGc(t, [marker], { startTime: 15, endTime: 1000015 });
  assert.equal(result.profiles[0].major.count, 1);
  assert.equal(result.profiles[0].minor.count, 1);
  assert.equal(result.wholeTrace.profiles[0].major.count, 2);
  assert.equal(result.wholeTrace.profiles[0].minor.count, 2);
  assert.equal(result.profiles[0].boundaryCounters.allocatedBytes, null);
});

test('native GC ambiguous ownership and malformed clocks stay invalid', () => {
  for (const change of [
    (t) => t.traceEvents.push(t.traceEvents[0]),
    (t) => (t.traceEvents[2].ph = 'B'),
    (t) => (t.traceEvents[2].dur = -1),
    (t) => (t.traceEvents[3].tdur = NaN),
    (t) => (t.traceEvents[1].args.value = '{}'),
    (t) => (t.traceEvents[1].ts = NaN),
  ]) {
    const t = trace();
    change(t);
    assert.throws(() => summarizeNativeGc(t, [marker]));
  }
  assert.throws(() => summarizeNativeGc(trace(), [marker], { startTime: 0, endTime: 100 }));
});
