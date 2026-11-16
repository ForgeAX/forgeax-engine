import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeMemoryModel, encodeMemoryModel } from '../memory_codec.mjs';
import {
  allocationMemoryModel,
  defaultMemoryNode,
  inspectMemory,
  rankMemory,
  snapshotMemoryModel,
} from '../memory_model.mjs';
import { memoryHtml, memorySvg, memoryTreemapRects, memoryTreemapSvg } from '../memory_view.mjs';

const frame = (name) => ({
  functionName: name,
  url: 'file:///workload.mjs',
  lineNumber: 1,
  columnNumber: 0,
});
const allocation = () => ({
  head: {
    id: 1,
    callFrame: frame('(root)'),
    selfSize: 0,
    children: [
      {
        id: 2,
        callFrame: frame('loadScene'),
        selfSize: 100,
        children: [{ id: 3, callFrame: frame('allocateMesh'), selfSize: 300, children: [] }],
      },
    ],
  },
  samples: [
    { nodeId: 2, size: 111, ordinal: 1 },
    { nodeId: 3, size: 222, ordinal: 2 },
    { nodeId: 99, size: 40, ordinal: 3 },
  ],
});
const snapshot = () => ({
  snapshot: {
    node_count: 3,
    meta: {
      node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
      node_types: [['synthetic', 'object', 'string'], 'string', 'number', 'number', 'number'],
      edge_fields: ['type', 'name_or_index', 'to_node'],
      edge_types: [['property', 'weak'], 'string_or_number', 'node'],
    },
  },
  strings: ['root', 'Box', 'SECRET_STRING_VALUE', 'child', 'weakChild'],
  nodes: [0, 0, 1, 0, 1, 1, 1, 2, 40, 1, 2, 2, 3, 80, 0],
  edges: [0, 3, 5, 1, 4, 10],
});

test('allocation hierarchy conserves node bytes and keeps orphan/sample accounting separate', () => {
  const model = allocationMemoryModel(allocation());
  assert.equal(model.summary.totalBytes, 400);
  assert.equal(model.summary.sampleSizeBytes, 373);
  assert.equal(model.summary.orphanSampleBytes, 40);
  assert.equal(model.summary.totalCount, 3);
  const detail = inspectMemory(model, 'allocation:3');
  assert.deepEqual(
    detail.path.map((n) => n.label),
    ['(root)', 'loadScene', 'allocateMesh'],
  );
  assert.equal(detail.records.rows[0].ordinal, 2);
  assert.equal(inspectMemory(model, 'allocation:2').node.totalBytes, 400);
  assert.equal(inspectMemory(model, 'unresolved').records.total, 1);
  assert.throws(() => inspectMemory(model, 'missing'));
});
test('snapshot grouping preserves every node and exposes references without inventing dominator retention', () => {
  const model = snapshotMemoryModel(snapshot());
  assert.equal(model.summary.totalBytes, 120);
  assert.equal(model.summary.totalCount, 3);
  assert.equal(model.references.length, 2);
  const box = inspectMemory(model, 'object:2');
  assert.equal(box.incoming.rows[0][3], 'child');
  assert.equal(box.outgoing.rows[0][2], 'weak');
  assert(!JSON.stringify(model).includes('SECRET_STRING_VALUE'));
  assert(!('retainedBytes' in box.node));
  const broken = snapshot();
  broken.edges[2] = 6;
  assert.throws(() => snapshotMemoryModel(broken));
});
test('treemap partitions byte area without overlap and keeps zero-byte nodes out of geometry', () => {
  const cells = memoryTreemapRects(
    [
      { id: 'a', weight: 6 },
      { id: 'b', weight: 3 },
      { id: 'c', weight: 1 },
      { id: 'z', weight: 0 },
    ],
    100,
    80,
  );
  assert.equal(cells.length, 3);
  assert(Math.abs(cells.reduce((n, r) => n + r.width * r.height, 0) - 8000) < 1e-7);
  for (const r of cells) {
    assert(r.x >= 0 && r.y >= 0 && r.x + r.width <= 100 + 1e-8 && r.y + r.height <= 80 + 1e-8);
    assert(Math.abs((r.width * r.height) / 8000 - r.weight / 10) < 1e-8);
  }
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i],
        b = cells[j];
      assert(
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) < 1e-8 ||
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) < 1e-8,
      );
    }
  assert.throws(() => memoryTreemapRects([{ weight: -1 }], 100, 100));
});
test('treemap and embedded data escape captured names', () => {
  const raw = allocation();
  raw.head.children[0].callFrame.functionName = '</script><script>alert(1)</script>';
  const model = allocationMemoryModel(raw);
  assert(!memoryTreemapSvg(model).includes('<script>'));
  const html = memoryHtml(model, inspectMemory.toString());
  assert(
    !html.includes(
      'mountMemoryExplorer({"schemaVersion":1,"kind":"memory-explorer","mode":"sampled-allocation-stack","label":"</script>',
    ),
  );
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert(html.includes('function memoryTreemapRects'));
  assert(html.includes('function inspectMemory'));
});

test('indexed snapshot storage preserves all objects, sorted children and reference kinds', () => {
  const original = snapshotMemoryModel(snapshot());
  const wire = encodeMemoryModel(original);
  assert.equal(wire.encoding, 'indexed-rows-v1');
  assert.deepEqual(decodeMemoryModel(structuredClone(wire)), original);
  assert.deepEqual(decodeMemoryModel(structuredClone(original)), original);
  const malformed = structuredClone(wire);
  malformed.references[0][0] = wire.nodes.length;
  assert.throws(() => decodeMemoryModel(malformed), /reference/);
  const cycle = structuredClone(wire);
  cycle.nodes[1][1] = 1;
  assert.throws(() => decodeMemoryModel(cycle), /parent/);
});

test('indexed storage avoids repeating graph object ids and names without dropping edges', () => {
  const original = snapshotMemoryModel(snapshot());
  original.references = Array.from({ length: 10000 }, () => [
    'object:2',
    'object:3',
    'weak',
    'same-reference-name',
  ]);
  const encoded = encodeMemoryModel(original);
  assert(JSON.stringify(encoded).length < JSON.stringify(original).length * 0.5);
  assert.deepEqual(decodeMemoryModel(structuredClone(encoded)), original);
  const consumed = structuredClone(original);
  assert.equal(encodeMemoryModel(consumed, { consume: true }), consumed);
  assert.deepEqual(decodeMemoryModel(consumed), original);
});

test('AI details pages bound record/reference output and do not leak full child lists', () => {
  const raw = allocation();
  raw.samples = Array.from({ length: 151 }, (_, i) => ({ nodeId: 2, size: 32, ordinal: i + 1 }));
  const model = allocationMemoryModel(raw),
    page = inspectMemory(model, 'allocation:2', { offset: 100, limit: 25 });
  assert.equal(page.records.total, 151);
  assert.equal(page.records.rows.length, 25);
  assert.equal(page.records.rows[0].ordinal, 101);
  assert.deepEqual(page.node.children, []);
  const many = allocation();
  many.head.children[0].children = Array.from({ length: 151 }, (_, i) => ({
    id: 10 + i,
    callFrame: frame('child' + i),
    selfSize: 1,
    children: [],
  }));
  many.samples = [];
  const parentPage = inspectMemory(allocationMemoryModel(many), 'root', { limit: 1 });
  assert.equal(parentPage.children[0].childCount, 151);
  assert.equal(parentPage.children[0].children, undefined);
  const data = snapshot();
  data.nodes[4] = 0;
  data.nodes[9] = 151;
  data.edges = Array.from({ length: 151 }, () => [1, 4, 10]).flat();
  const refs = inspectMemory(snapshotMemoryModel(data), 'object:3', { offset: 100, limit: 25 });
  assert.equal(refs.incoming.total, 151);
  assert.equal(refs.incoming.rows.length, 25);
});

test('failed owned capture preserves a failed partial profile and can render its diagnostic status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-failure-'));
  try {
    const modulePath = join(directory, 'work.mjs'),
      out = join(directory, 'capture');
    await writeFile(
      modulePath,
      "export default function work(){const x=Array.from({length:3000},(_,i)=>({i}));if(x.length)throw Error('intentional witness');}",
    );
    const script = fileURLToPath(new URL('../memory.mjs', import.meta.url));
    const child = spawnSync(
      process.execPath,
      [script, 'capture', '--module', modulePath, '--out-dir', out],
      { encoding: 'utf8' },
    );
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(await readFile(join(out, 'capture-report.json'), 'utf8')).ok, false);
    const partial = join(out, 'allocation.partial.json');
    assert.equal(JSON.parse(await readFile(partial, 'utf8')).ok, false);
    const view = join(directory, 'view'),
      rendered = spawnSync(process.execPath, [script, 'report', partial, '--out-dir', view], {
        encoding: 'utf8',
      });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(JSON.parse(await readFile(join(view, 'memory.json'), 'utf8')).producerOk, false);
    assert.equal(
      spawnSync(process.execPath, [script, 'report', partial, '--out-dir', view], {
        encoding: 'utf8',
      }).status,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aggregated treemap tails carry a concrete folder-page offset', () => {
  const raw = allocation();
  raw.head.children = Array.from({ length: 55 }, (_, i) => ({
    id: i + 2,
    callFrame: frame('allocation' + i),
    selfSize: i + 1,
    children: [],
  }));
  raw.samples = [];
  const svg = memoryTreemapSvg(allocationMemoryModel(raw));
  assert(svg.includes('data-memory-offset="39"'));
  assert(!svg.includes('data-memory-offset="undefined"'));
});

function countWitness() {
  const raw = allocation();
  raw.head.children = [
    { id: 2, callFrame: frame('fewLarge'), selfSize: 10000, children: [] },
    { id: 3, callFrame: frame('manySmall'), selfSize: 8, children: [] },
  ];
  raw.samples = [
    { nodeId: 2, size: 10000, ordinal: 1 },
    ...Array.from({ length: 20 }, (_, i) => ({ nodeId: 3, size: 8, ordinal: i + 2 })),
    ...Array.from({ length: 3 }, (_, i) => ({ nodeId: 99, size: 8, ordinal: i + 22 })),
  ];
  return allocationMemoryModel(raw);
}

test('count inspection sorts before pagination without mutating byte order or losing unresolved samples', () => {
  const model = countWitness(),
    before = structuredClone(model);
  const page = inspectMemory(model, 'root', { metric: 'count', limit: 2 });
  assert.equal(page.metric, 'count');
  assert.equal(page.metricLabel, 'recorded allocation samples');
  assert.deepEqual(
    page.children.map((n) => n.id),
    ['allocation:3', 'unresolved'],
  );
  assert.equal(page.node.totalCount, 24);
  assert.equal(
    inspectMemory(model, 'root', { metric: 'count', offset: 2, limit: 2 }).children[0].id,
    'allocation:2',
  );
  assert.deepEqual(model, before);
  assert.equal(inspectMemory(model).children[0].id, 'allocation:2');
  assert.throws(() => inspectMemory(model, 'root', { metric: 'estimated-objects' }), /metric/);
});

test('count treemap gives zero-byte recorded samples positive area and conserves selected count', () => {
  const model = countWitness();
  const svg = memoryTreemapSvg(model, 'root', { metric: 'count', depth: 1 });
  assert(svg.includes('area = recorded allocation samples'));
  assert(svg.includes('data-memory-node="unresolved"'));
  assert(svg.includes('manySmall'));
  assert(
    svg.indexOf('data-memory-node="allocation:3"') < svg.indexOf('data-memory-node="allocation:2"'),
  );
  assert(!memoryTreemapSvg(model, 'root', { depth: 1 }).includes('data-memory-node="unresolved"'));
  const folders = memorySvg(model, 'root', { metric: 'count' });
  assert(folders.includes('83.3%'));
  assert(folders.includes('Unresolved sample owners'));
  assert(!folders.includes('SUBTREE BYTES /'));
  const snapshotModel = snapshotMemoryModel(snapshot());
  assert(memoryTreemapSvg(snapshotModel, 'root', { metric: 'count' }).includes('object:1'));
});

test('count defaults retain count-only branches and compact snapshot reload preserves the selected metric', () => {
  const model = allocationMemoryModel(allocation());
  assert.notEqual(defaultMemoryNode(model), 'root');
  assert.equal(defaultMemoryNode(model, { metric: 'count' }), 'root');
  model.metric = 'count';
  assert.equal(inspectMemory(model).metric, 'count');
  const snapshotModel = snapshotMemoryModel(snapshot());
  snapshotModel.metric = 'count';
  const decoded = decodeMemoryModel(encodeMemoryModel(snapshotModel));
  assert.equal(inspectMemory(decoded).metric, 'count');
  assert.equal(inspectMemory(decoded).node.totalCount, 3);
});

test('report and inspect CLI preserve count selection and raw count conservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-count-'));
  try {
    const input = join(directory, 'memory.json'),
      out = join(directory, 'report');
    await writeFile(input, JSON.stringify(countWitness()));
    const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
    const report = spawnSync(
      process.execPath,
      [cli, 'report', input, '--out-dir', out, '--metric', 'count'],
      { encoding: 'utf8' },
    );
    assert.equal(report.status, 0, report.stderr);
    const saved = JSON.parse(await readFile(join(out, 'memory.json'), 'utf8'));
    assert.equal(saved.metric, 'count');
    assert.equal(saved.summary.totalCount, 24);
    assert.equal(saved.summary.totalBytes, 10008);
    assert(
      (await readFile(join(out, 'memory.svg'), 'utf8')).includes(
        'area = recorded allocation samples',
      ),
    );
    const inspect = spawnSync(
      process.execPath,
      [cli, 'inspect', join(out, 'memory.json'), '--metric', 'bytes', '--limit', '1'],
      { encoding: 'utf8' },
    );
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).children[0].id, 'allocation:2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('global count hotspots provide bounded AI rows and distinguish self from overlapping totals', () => {
  const model = countWitness();
  const ranked = rankMemory(model, { metric: 'count', limit: 2 });
  assert.deepEqual(
    ranked.rows.map((n) => n.id),
    ['allocation:3', 'unresolved'],
  );
  assert.equal(ranked.total, 3);
  assert(ranked.rows.every((n) => n.children === undefined));
  const match = rankMemory(model, { metric: 'count', query: 'fewLarge', by: 'total' });
  assert.equal(match.rows.length, 1);
  assert.equal(match.rows[0].totalCount, 1);
  assert.throws(() => rankMemory(model, { by: 'frequency' }), /self or total/);
  assert.throws(() => rankMemory(model, { limit: 1001 }), /bounds/);
});
