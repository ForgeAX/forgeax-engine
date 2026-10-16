import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RhiError } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { terrainHarness } from './harness.mjs';

let reject = false;
const h = await terrainHarness({ backendArgs: ['backend=metal'], appOptions: { rhiInstrumentation: { beforeSubmit() {
  if (!reject) return undefined; reject = false;
  return new RhiError({ code: 'webgpu-runtime-error', expected: 'one-shot terrain shadow rejection', hint: 'retry the candidate' });
} } } });
const dir = resolve(import.meta.dirname, '../.forgeax-debug/shadow');
mkdirSync(dir, { recursive: true });
const report = { status: 'RUNNING', cases: [] };
const observe = (name) => {
  const shadow = h.app.renderer.inspect().shadowRaster;
  report.cases.push({ name, shadow }); return shadow;
};
try {
  // Warm every grid first; residency changes cannot explain a later fractional miss.
  for (const forcedLod of [0, 1, 2, 3, 4, 0.5]) {
    h.app.world.set(h.subjects.terrain, Terrain, { forcedLod }).unwrap(); await h.frame();
  }
  for (let i = 0; i < 60; i++) await h.frame();
  const stable = observe('stable-cache-hit');
  assert.equal(stable.passCount, 0); assert(stable.views.every((view) => view.cache === 'hit'));
  h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0.75 }).unwrap();
  await h.frame();
  const fractional = observe('same-grid-fractional-lod-changed');
  assert(fractional.passCount > 0 && fractional.drawCount > 0, 'fractional geometry change must raster shadows');
  await h.frame(); assert.equal(observe('fractional-stable-cache-hit').passCount, 0);
  h.app.world.set(h.subjects.terrain, Transform, { pos: [0, 2, 0] }).unwrap();
  await h.frame();
  assert(observe('pose-only-shadow-update').passCount > 0);
  await h.frame(); assert.equal(observe('pose-stable-cache-hit').passCount, 0);
  h.app.world.set(h.subjects.terrain, Terrain, { forcedLod: 0.9 }).unwrap();
  h.app.world.update(1 / 60).unwrap(); reject = true;
  const failed = h.draw();
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'frame-submit-rejected');
  observe('rejected-candidate');
  h.errors.length = 0;
  await h.frame(); assert(observe('retry-still-rasters-candidate').passCount > 0);
  await h.frame(); assert.equal(observe('retry-committed-cache-hit').passCount, 0);
  assert.deepEqual(h.errors, []);
  report.status = 'PASS';
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await h.dispose(); }
process.exit(0);
