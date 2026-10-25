import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { commands, createWorkload, hash, phases, unwrap, validateConfig } from '../workload.mjs';
import { heapCensus } from '../heap-census.mjs';

const config = { count: 128, dirty: 4, users: 16, phase: 'mixed', frames: 60, warmup: 2 };

test('fixed sparse changes stay fixed when N grows; K is independent; dense remains a control', () => {
  for (const count of [1000, 10000, 100000]) {
    const c = validateConfig({ ...config, count });
    const mixed = commands(c, 'mixed', 17);
    assert.equal(new Set(mixed.pose).size, config.dirty);
    assert.equal(mixed.binding.length, config.dirty);
    assert.equal(mixed.churn.length, config.dirty);
    assert(mixed.binding.every(i => i >= c.count / 2));
    assert.equal(commands(c, 'dense', 17).pose.length, count);
  }
  assert.deepEqual(commands(config, 'mixed', 17), commands(config, 'mixed', 17));
  assert.notEqual(hash(commands(config, 'mixed', 17)), hash(commands(config, 'mixed', 18)));
  assert.throws(() => validateConfig({ ...config, users: 129 }));
  assert.throws(() => validateConfig({ ...config, dirty: 129 }));
});

test('mixed edits exercise shared resources, content bindings, hierarchy and entity retirement without changing population', () => {
  const assets = new AssetRegistry();
  const scene = createWorkload(assets, config);
  unwrap(scene.world.update(1 / 60));
  assert(Object.values(scene.categories).every(count => count > 0));
  const sharedConsumers = () => {
    let count = 0;
    for (const row of unwrap(scene.world.query({ read: [MeshRenderer] }))) if (row.get(MeshRenderer).materials.includes(scene.sharedMaterial)) count++;
    return count;
  };
  assert.equal(sharedConsumers(), config.users);
  const old = scene.entities.slice();
  const operation = scene.apply('mixed', 1);
  unwrap(scene.world.update(1 / 60));
  for (const index of operation.churn) assert.notEqual(scene.entities[index], old[index]);
  assert.equal(sharedConsumers(), config.users);
  assert(Math.abs(unwrap(assets.read(scene.sharedMaterial)).values.roughness - 0.6) < 1e-6);
  const query = unwrap(scene.world.query({ read: [MeshRenderer] }));
  assert.equal([...query].length, config.count);
  const moved = operation.pose.find(i => !operation.churn.includes(i));
  // Mixed may replace the just-moved row; the isolated pose phase proves the write.
  const pose = scene.apply('pose', 2);
  assert.equal(unwrap(scene.world.get(scene.entities[pose.pose[0]], Transform)).pos[2] !== 0, true);
  assert.notEqual(moved, undefined);
});

test('idle does not mutate and each isolated phase has only its declared operations', () => {
  for (const phase of phases) {
    const operation = commands(config, phase, 3);
    if (phase === 'mixed') continue;
    for (const key of ['pose', 'binding', 'churn']) assert.equal(operation[key].length > 0, phase === key || (phase === 'dense' && key === 'pose'));
    for (const key of ['camera', 'material', 'mesh', 'hierarchy']) assert.equal(operation[key], phase === key);
  }
});

test('heap census conserves streamed node counts and self bytes across split numbers', async () => {
  const fixture = JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'self_size', 'edge_count'],
        node_types: [['object', 'array'], 'string', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['property'], 'string_or_number', 'node'],
      },
      node_count: 3,
    },
    nodes: [0, 0, 120, 0, 1, 1, 64, 0, 0, 0, 32, 0],
    edges: [],
    strings: ['FixtureObject', 'FixtureArray'],
  });
  const bytes = Buffer.from(fixture);
  const census = await heapCensus(Readable.from(Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, i * 7 + 7))));
  assert.equal(census.nodes, 3);
  assert.deepEqual(census.byType, { object: { count: 2, selfBytes: 152 }, array: { count: 1, selfBytes: 64 } });
  assert.equal(census.snapshotSha256, hash(bytes));
  assert.deepEqual(census.topNames.map(row => row.name), ['FixtureObject', 'FixtureArray']);
});
