import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Instances, MeshFilter, MeshRenderer, Visibility } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { cellConfig, cells, createWorkload, hash, scenarios, sparse, unwrap, validateConfig } from '../workload.mjs';
import { growth, markdown, summarize, worstCells } from '../matrix-summary.mjs';

const frame = { frames: 60, warmup: 2, phase: 'scenario' };
const config = (id, count) => validateConfig({ ...frame, ...cellConfig(id, count) });

test('sparse indexes are distinct, bounded by D and span, and rotate with the tick', () => {
  for (const [dirty, span] of [[8, 1000], [8, 5], [0, 100], [100, 100]]) {
    const indexes = sparse(dirty, 3, span, 7);
    assert.equal(indexes.length, Math.min(dirty, span));
    assert.equal(new Set(indexes).size, indexes.length);
    assert(indexes.every(i => i >= 7 && i < 7 + span));
  }
  assert.notDeepEqual(sparse(8, 1, 1000), sparse(8, 2, 1000));
  assert.deepEqual(sparse(8, 5, 1000), sparse(8, 5, 1000));
});

test('every cell names a real scenario and sizes D from N without exceeding it', () => {
  for (const [id, cell] of Object.entries(cells)) {
    assert(scenarios[cell.scenario], `${id} -> ${cell.scenario}`);
    for (const count of [10, 100, 1000, 100000, 1000000]) {
      const c = cellConfig(id, count);
      assert(c.dirty >= 0 && c.dirty <= count, `${id} N=${count}`);
      assert(c.users >= 1 && c.users <= count / 2);
      validateConfig({ ...frame, ...c });
    }
  }
  assert.equal(cellConfig('static', 1000).dirty, 0);
  assert.equal(cellConfig('move-d8', 100000).dirty, 8);
  assert.equal(cellConfig('move-1pct', 100000).dirty, 1000);
  assert.equal(cellConfig('move-10pct', 1000).dirty, 100);
  assert.equal(cellConfig('move-100pct', 1000).dirty, 1000);
  assert.equal(cellConfig('cameras-4', 1000).cameras, 4);
  assert.equal(cellConfig('shadow-lights-32-moving', 1000).params.moving, 1);
  assert.throws(() => cellConfig('nope', 10));
  assert.throws(() => validateConfig({ ...frame, ...cellConfig('move-d8', 100), scenario: 'nope' }));
});

test('population is exact per scenario and every step stays deterministic and population neutral', () => {
  for (const id of Object.keys(cells)) {
    const c = config(id, id === 'instancing' ? 64 * 8 : 64);
    const assets = new AssetRegistry();
    const scene = createWorkload(assets, c);
    unwrap(scene.world.update(1 / 60));
    const rows = [...unwrap(scene.world.query({ read: [MeshRenderer] }))].length;
    assert.equal(rows, scene.expectedProjectionRecords, `${id}: rows == expected records`);
    const first = scene.apply('scenario', 1);
    for (let tick = 2; tick < 6; tick++) { scene.apply('scenario', tick); unwrap(scene.world.update(1 / 60)); }
    assert.equal([...unwrap(scene.world.query({ read: [MeshRenderer] }))].length, rows, `${id}: population neutral`);
    const again = createWorkload(new AssetRegistry(), c).apply('scenario', 1);
    assert.equal(hash(first), hash(again), `${id}: step record is deterministic`);
  }
});

test('scenario steps touch exactly the declared rows', () => {
  const idle = createWorkload(new AssetRegistry(), config('static', 64));
  assert.deepEqual(idle.apply('scenario', 4), { tick: 4 });

  const move = createWorkload(new AssetRegistry(), config('move-10pct', 640));
  assert.equal(move.apply('scenario', 2).pose, 64);

  const churn = createWorkload(new AssetRegistry(), config('churn-d8', 64));
  const before = churn.entities.slice();
  const op = churn.apply('scenario', 1);
  assert.equal(op.churn, 8);
  assert.equal(churn.entities.filter((e, i) => e !== before[i]).length, 8);

  const swap = createWorkload(new AssetRegistry(), config('material-swap', 64));
  const materials = new Set();
  for (let t = 0; t < 4; t++) { swap.apply('scenario', t); for (const e of swap.entities) materials.add(unwrap(swap.world.get(e, MeshRenderer)).materials[0]); }
  assert(materials.size > 2, 'material pool is exercised');

  const mesh = createWorkload(new AssetRegistry(), config('mesh-swap', 64));
  const meshes = new Set();
  for (let t = 0; t < 4; t++) { mesh.apply('scenario', t); for (const e of mesh.entities) meshes.add(unwrap(mesh.world.get(e, MeshFilter)).assetHandle); }
  assert(meshes.size > 2, 'mesh pool is exercised');

  const visibility = createWorkload(new AssetRegistry(), config('visibility-toggle', 64));
  visibility.apply('scenario', 0);
  const hidden = () => visibility.entities.filter(e => unwrap(visibility.world.get(e, Visibility)).state === 'hidden' || unwrap(visibility.world.get(e, Visibility)).state === 1).length;
  assert.equal(hidden(), 8);
  visibility.apply('scenario', 1);
  assert.equal(hidden(), 0, 'the same rows are shown again on the odd tick');
});

test('scenario-specific populations: instancing counts instances, lights and cameras follow params', () => {
  const instancing = createWorkload(new AssetRegistry(), config('instancing', 2048));
  assert.equal(instancing.entities.length, 256);
  assert.equal(unwrap(instancing.world.get(instancing.entities[0], Instances)).transforms.length, 8 * 16);

  const cameras = createWorkload(new AssetRegistry(), config('cameras-4', 64));
  assert.equal(cameras.categories.rigid, 64);

  const rt = createWorkload(new AssetRegistry(), config('rt-camera', 64));
  assert.equal(rt.targetOwner.snapshot().length, 1);

  const skinned = createWorkload(new AssetRegistry(), config('skinned', 64));
  assert.equal(skinned.categories.skin, 64 - 32);
  const many = createWorkload(new AssetRegistry(), config('materials-many', 64));
  const used = new Set(many.entities.map(e => unwrap(many.world.get(e, MeshRenderer)).materials[0]));
  assert(used.size >= 32, 'unique materials grow with N');
  const few = createWorkload(new AssetRegistry(), config('materials-few', 64));
  assert.equal(new Set(few.entities.slice(32).map(e => unwrap(few.world.get(e, MeshRenderer)).materials[0])).size, 4);
});

test('legacy phases are unchanged by the scenario hooks', () => {
  const scene = createWorkload(new AssetRegistry(), { count: 128, dirty: 4, users: 16, phase: 'mixed', frames: 60, warmup: 2 });
  assert(Object.values(scene.categories).every(count => count > 0));
  const pose = scene.apply('pose', 2);
  assert.equal(pose.pose.length, 4);
  assert.equal(unwrap(scene.world.get(scene.entities[pose.pose[0]], Transform)).pos[2] !== 0, true);
});

const report = (count, total, alloc, overrides = {}) => ({ status: 'complete', config: { cell: 'x', count, dirty: 8 }, raw: Array(10).fill({ counts: { transferBytes: 100, logicalColumnBytes: 10 } }),
  statistics: Object.fromEntries(['sourceThreadCpuMs', 'renderThreadCpuMs', 'totalThreadCpuMs', 'endToEndMs'].map(k => [k, { p50: total, p95: total * 1.1, max: total * 2 }])),
  sourceMetrics: { allocatedHeapBytes: alloc * 10, gc: { count: 1, durationMs: 2 }, peakHeapUsed: 1 }, renderMetrics: { allocatedHeapBytes: alloc * 10, gc: { count: 1, durationMs: 2 }, peakHeapUsed: 1, peakProcessRss: 1 },
  startupMs: 100, ...overrides });

test('matrix summary derives growth, worst cells and Markdown from reports; failures stay visible', () => {
  const rows = [summarize(report(1000, 2, 1000), { cell: 'a' }), summarize(report(10000, 2.1, 1000), { cell: 'a' }), summarize(report(100000, 9, 1000), { cell: 'a' }),
    summarize(report(100, 1, 5 * 1048576), { cell: 'b' }), summarize({ status: 'failed', config: { count: 1000000, dirty: 8 }, failure: { message: 'startup did not settle' } }, { cell: 'a' })];
  assert.equal(rows[0].allocPerFrame.render, 1000);
  assert.equal(rows[0].transferBytesPerFrame, 100);
  const worst = worstCells(rows);
  assert(worst.some(w => w.kind === 'cpu-grows-with-N' && w.cell === 'a' && w.to === 100000));
  assert(!worst.some(w => w.kind === 'cpu-grows-with-N' && w.to === 10000), 'flat growth is not flagged');
  assert(worst.some(w => w.kind === 'alloc-at-small-N' && w.cell === 'b'));
  assert.equal(growth(rows).length, 2);
  const md = markdown(rows, { title: 't' });
  assert(md.includes('FAILED: startup did not settle') && md.includes('## Worst cells'));
});
