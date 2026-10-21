import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeHeapEvidence } from '../write-heap.mjs';

const realm = { role: 'Engine Worker', target: { type: 'worker', url: 'http://fixture/engine-worker.js' }, before: { usedSize: 12 }, after: { usedSize: 14 }, scriptDigests: [{ url: 'http://fixture/engine-worker.js', sha256: 'frozen' }] };

test('natural GC evidence retains owned windows without inventing allocation or aggregate pauses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-gc-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'heap.json');
  const nativeGc = { profiles: [{ realm: 'Engine Worker', minor: { count: 1, wallMs: 2 } }] };
  const result = await writeHeapEvidence(path, { mode: 'native-gc', boundary: 'native interval', samplingInterval: null, traceComplete: { dataLossOccurred: false }, trace: [{ ph: 'X', name: 'MinorGC', dur: 2000 }], nativeGc, realms: [realm] });
  assert.deepEqual(result.nativeGc, nativeGc);
  assert.equal(result.mode, 'native-gc');
  assert.equal(result.samplingInterval, null);
  assert(!Object.hasOwn(result, 'gc'));
  assert(!Object.hasOwn(result.realms[0], 'allocationBytes'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
  assert.equal((await readFile(path + '.trace.ndjson', 'utf8')).trim(), '{"ph":"X","name":"MinorGC","dur":2000}');
});

test('allocation evidence conserves streamed samples and bounded completed-frame denominators', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-allocation-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'heap.json');
  function* samples() { yield { size: 32, nodeId: 2 }; yield { size: 64, nodeId: 1 }; }
  const allocation = { head: { id: 1, children: [{ id: 2, children: [] }] }, samples: samples() };
  const result = await writeHeapEvidence(path, { mode: 'allocation', boundary: 'sampler', trace: [], completedFrameBounds: { minimum: 300, maximum: 320 }, realms: [{ ...realm, allocation }] });
  assert.equal(result.realms[0].allocationBytes, 96);
  assert.deepEqual(result.realms[0].allocationBytesPerCompletedFrameBounds, { minimum: 96 / 320, maximum: 96 / 300 });
  assert.deepEqual(result.realms[0].scriptDigests, realm.scriptDigests);
  const saved = (await readFile(path + '.realm0.samples.ndjson', 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(saved.reduce((sum, row) => sum + row.size, 0), 96);
  const nodes = (await readFile(path + '.realm0.nodes.ndjson', 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(nodes.map(node => node.id), [1, 2]);
});
