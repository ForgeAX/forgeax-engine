import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { createAssetAdapter } from '../adapter-current.mjs';
import { cases } from '../cases.mjs';
import { createWorkload } from '../workload.mjs';

for (const config of cases.filter(value => value.kind === 'transform')) {
  test(`${config.id}: actual source writes, table population and final state`, () => {
    const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
    const world = new World({ assets });
    registerPropagateTransforms(world);
    try {
      const workload = createWorkload(world, createAssetAdapter(world, assets), config);
      const query = world.query({ read: [Transform, MeshFilter] }).unwrap();
      const before = new Map();
      for (const row of query) before.set(row.entity, [...row.get(Transform).pos]);
      const ordered = [...before.keys()].sort((a, b) => a - b);
      const expected = new Set(Array.from({ length: config.writes }, (_, index) => ordered[(Math.floor(config.count / 2) + index) % config.count]));
      for (const step of [1, 0, 1]) {
        workload.write(step, true);
        world.update(1 / 60).unwrap();
        const changed = new Set();
        for (const row of query) {
          const previous = before.get(row.entity), position = row.get(Transform).pos;
          if (position[0] === previous[0] && position[2] === previous[2]) continue;
          changed.add(row.entity);
          const sign = step ? 1 : -1;
          assert.ok(Math.abs(position[0] - previous[0] - sign * .08) < 1e-6);
          assert.ok(Math.abs(position[2] - previous[2] - sign * .12) < 1e-6);
          assert.equal(position[1], previous[1]);
        }
        assert.deepEqual(changed, expected);
      }
      const state = workload.state();
      assert.equal(state.authoredWrites, config.writes * 3);
      assert.equal(state.liveEntities, config.count);
      assert.deepEqual(state.sourceLayout, { meshTables: config.tables ?? 1, meshRows: config.count });
    } finally {
      world.despawnAll().unwrap();
      assets.dispose();
    }
  });
}
