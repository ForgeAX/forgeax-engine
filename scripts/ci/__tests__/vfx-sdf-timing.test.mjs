import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('../../../apps/hello/boss-lightning/scripts/smoke-sdf-dawn.mjs', import.meta.url),
  'utf8',
);
const begin = source.indexOf('function intervals(frame) {');
const end = source.indexOf('\n// Exact analytic', begin);
assert(begin > 0 && end > begin);
const intervals = runInNewContext(`(${source.slice(begin, end)})`);

test('native fused simulation and view raster retain distinct timing attribution', () => {
  // Pass names and kinds follow the captured managed VFX work roster. Tick
  // overlap is deliberate: phase sums must not be mistaken for elapsed time.
  const pass = (passName, passKind, beginningTick, endTick) => ({
    passName,
    passKind,
    beginningTick: String(beginningTick),
    endTick: String(endTick),
    durationNanoseconds: (endTick - beginningTick) * 1e6,
    status: 'measured',
  });
  const result = intervals({
    timestampPeriodNanoseconds: 1e6,
    passes: [
      pass('feature.scene-sdf.compose', 'compute', 100, 102),
      pass('vfx.42.tick-1.simulate', 'compute', 102, 112),
      pass('vfx.42.view.7.project', 'compute', 110, 115),
      pass('vfx.42.view.7.billboard', 'raster', 115, 125),
      pass('output-transform', 'raster', 125, 128),
      { passName: 'vfx.42.tick-2.simulate', status: 'unavailable' },
    ],
  });
  assert.equal(result.phases.field, 2);
  assert.equal(result.phases.simulation, 10);
  assert.equal(result.phases.projection, 5);
  assert.equal(result.phases.other, 13);
  assert.equal(result.sumMs, 30);
  assert.equal(result.unionMs, 28);
  assert.equal(result.duplicatedOverlapMs, 2);
  assert.equal(result.envelopeMs, 28);
  assert.equal(result.nativeOuter.status, 'unavailable');
});
