import assert from 'node:assert/strict';
import { Terrain } from '@forgeax/engine-terrain';
import { materialTerrainGuid } from '../src/identity.ts';
import { terrainHarness } from './harness.mjs';
import { smokeFrameBudget, emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
import { querySubmittedTerrainHeight } from '@forgeax/engine-render';
const harness = await terrainHarness();
let foundationFrames = 0;
try {
  let receipt;
  for (let i = 0; i < smokeFrameBudget(); i++) ({ receipt } = await harness.frame());
  const report = await harness.verify(receipt);
  assert.equal(
    (
      await querySubmittedTerrainHeight(harness.firstReceipt, {
        worldId: 0,
        entity: harness.subjects.terrain,
        x: 62,
        z: 62,
      })
    ).ok,
    false,
    'expired receipt must not silently use current terrain',
  );
  console.log(JSON.stringify({ gate: 'hello-terrain/dawn', status: 'PASS', ...report }));
  foundationFrames = harness.completed;
} finally {
  await harness.dispose();
}

const compact = await terrainHarness({ rootGuid: materialTerrainGuid('ids') });
try {
  let receipt;
  for (let i = 0; i < smokeFrameBudget(); i++) ({ receipt } = await compact.frame());
  const report = await compact.verify(receipt);
  const root = compact.app.world.sharedRefs
    .resolve(compact.app.world.get(compact.subjects.terrain, Terrain).unwrap().asset)
    .unwrap();
  assert.equal(
    root.materialEncoding.kind,
    'ids',
    'CI must execute the selected production Cook specialization',
  );
  assert(
    root.sections.every((s) => compact.app.assets.lookup(s.weightTexture).mips.kind === 'none'),
  );
  console.log(
    JSON.stringify({
      gate: 'hello-terrain/material-ids/dawn',
      status: 'PASS',
      ...report,
      encoding: root.materialEncoding,
    }),
  );
  emitSmokeReceipt('hello-terrain/smoke', Math.min(foundationFrames, compact.completed));
} finally {
  await compact.dispose();
}

// Dawn owns native polling threads; terminate only after successful evidence and awaited cleanup.
process.exit(0);
