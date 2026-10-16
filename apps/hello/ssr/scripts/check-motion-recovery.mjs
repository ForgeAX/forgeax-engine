import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readReferencePng } from '../../../shared/png-codec.mjs';

// Same terminal pose and eight-phase jitter, measured in display RGB code values.
// The settled production image is a recovery reference, not a physical oracle.
export function measureMotionRecovery(manifest, load = readReferencePng) {
  assert.equal(manifest.mode, 'display-only-actual-rendered-frames');
  assert.equal(manifest.objectMotion, true);
  const region = [620, 745, 658, 837];
  const results = [];
  for (const frame of manifest.journey.filter(f => f.stage === 'recovery' && f.path)) {
    const matching = manifest.frames.find(f => f.after.frameIndex % 8 === frame.after.frameIndex % 8);
    assert.ok(matching, 'Missing settled reference at the same jitter phase');
    const image = load(frame.path), reference = load(matching.path);
    assert.equal(image.width, 1024); assert.equal(image.height, 1024);
    assert.equal(reference.width, image.width); assert.equal(reference.height, image.height);
    const errors = [];
    for (let y = region[1]; y < region[3]; y++) for (let x = region[0]; x < region[2]; x++) {
      const p = (y * image.width + x) * 4;
      errors.push(Math.max(...[0, 1, 2].map(c => Math.abs(image.pixels[p+c] - reference.pixels[p+c]))));
    }
    errors.sort((a,b) => a-b);
    results.push({ heldFrames: frame.heldFrames, frameIndex: frame.after.frameIndex,
      referenceFrameIndex: matching.after.frameIndex, pixels: errors.length,
      mean: errors.reduce((a,b) => a+b,0)/errors.length,
      p95: errors[Math.ceil(0.95 * (errors.length-1))], maximum: errors.at(-1),
      above4: errors.filter(e => e>4).length });
  }
  assert.deepEqual(results.map(r => r.heldFrames), [8,32,64,128]);
  // Predeclared target: match the previous 32-frame recovery by frame eight.
  // Preserve the local p95 and bright outliers instead of hiding them in a mean.
  const budget = { atFrame: 8, mean: 2, p95: 4, maximum: 24, above4Fraction: 0.05 };
  const r = results[0];
  const passed = r.mean <= budget.mean && r.p95 <= budget.p95
    && r.maximum <= budget.maximum && r.above4/r.pixels <= budget.above4Fraction;
  return { domain: 'display-rgb-max-channel-code-difference', region, budget, passed, results,
    reference: 'Settled same terminal pose and jitter phase; not independent reflection truth' };
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const manifestPath = resolve(process.argv[2]);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const report = measureMotionRecovery(manifest, path => readReferencePng(resolve(dirname(manifestPath), path)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed && !process.argv.includes('--measure-only')) process.exitCode = 1;
}
