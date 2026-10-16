import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCapturedTaaPose, readCapturedTaaReference } from './taa-reference.mjs';

// Compare motion-stop recovery with a separately settled view of the same
// authored final pose. Never call a smaller frame delta a ghosting oracle.
const settle = process.argv.includes('--settle');
const cycleReference = process.argv.includes('--cycle-reference');
const reportPrefix = process.argv.find(arg => arg.startsWith('--report-prefix='))?.slice(16);
const regionArgs = process.argv.filter(arg => arg.startsWith('--region='));
const regionsToInspect = regionArgs.length === 0
  ? [['wall', 0.15, 0.2, 0.85, 0.5], ['reflection', 0.15, 0.52, 0.85, 0.78]]
  : regionArgs.map(arg => {
    const [name, ...values] = arg.slice(9).split(',');
    const bounds = values.map(Number);
    assert.ok(/^[a-z0-9-]+$/.test(name) && bounds.length === 4 && bounds.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3]);
    return [name, ...bounds];
  });
const [journeyPrefix, heldPrefix, ...variants] = process.argv.slice(2).filter(arg => !['--settle', '--cycle-reference'].includes(arg) && !arg.startsWith('--report-prefix=') && !arg.startsWith('--region='));
assert.ok(journeyPrefix && heldPrefix && variants.length > 0);
const finalPose = readCapturedTaaPose(journeyPrefix, 5);
assert.deepEqual(finalPose, readCapturedTaaPose(heldPrefix, 0), 'Reference does not share the captured final scene pose');
const reference = cycleReference ? undefined : JSON.parse(readFileSync(`${heldPrefix}-feedback-production.json`));
const readOutput = row => {
  const bytes = readFileSync(row.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.digest);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const integrated = cycleReference ? readCapturedTaaReference(heldPrefix) : undefined;
const held = integrated
  ? Array.from({ length: 8 }, (_, phase) => ({
    inputFrameIndex: JSON.parse(readFileSync(`${heldPrefix}-${phase}/taa-feedback-inputs.json`)).frameIndex,
    values: integrated.values,
  }))
  : reference.results[0].outputFrames.map(row => ({ ...row, values: readOutput(row) }));
assert.equal(held.length, 8);
const input = JSON.parse(readFileSync(`${heldPrefix}-0/taa-feedback-inputs.json`));
const { width, height } = input.color;
const results = [];
for (const name of variants) {
  const report = JSON.parse(readFileSync(`${reportPrefix ?? `${journeyPrefix}${settle ? '-settle' : ''}`}-feedback-${name}.json`));
  assert.equal(report.mode, settle ? 'spliced-same-pose-settle-gpu-feedback' : 'recorded-journey-gpu-feedback');
  if (settle) assert.equal(report.settlePrefix, resolve(heldPrefix));
  const candidate = report.results[0];
  const frames = [];
  // The carrier moved through frame 5, then held its terminal pose.
  for (let phase = 5; phase < candidate.outputFrames.length; phase++) {
    const row = candidate.outputFrames[phase];
    const matching = held.find(other => other.inputFrameIndex % 8 === row.inputFrameIndex % 8);
    assert.ok(matching, 'Missing matching jitter phase');
    const values = readOutput(row);
    assert.equal(values.length, width * height * 4);
    const regions = {};
    for (const [region, left, top, right, bottom] of regionsToInspect) {
      const errors = [];
      let sum = 0, worst;
      for (let y = Math.floor(height * top); y < height * bottom; y++) {
        for (let x = Math.floor(width * left); x < width * right; x++) {
          const p = (y * width + x) * 4;
          const error = Math.max(...[0, 1, 2].map(c => Math.abs(values[p + c] - matching.values[p + c])));
          errors.push(error);
          sum += error;
          if (!worst || error > worst.error) worst = { x, y, error,
            current: [...values.slice(p, p + 3)], settled: [...matching.values.slice(p, p + 3)] };
        }
      }
      errors.sort((a, b) => a - b);
      regions[region] = { mean: sum / errors.length, p99: errors[Math.floor(errors.length * 0.99)],
        above01: errors.filter(error => error > 0.1).length, worst };
    }
    frames.push({ phase, inputFrameIndex: row.inputFrameIndex, referenceFrameIndex: matching.inputFrameIndex, regions });
  }
  results.push({ name, shaderDigest: candidate.shaderDigest, frames });
}
console.log(JSON.stringify({ mode: 'motion-stop-versus-settled-same-pose',
  ...(settle ? { caveat: 'Spliced settled inputs; isolated TAA recovery, not full SSR temporal recovery' } : {}),
  journeyPrefix: resolve(journeyPrefix), heldPrefix: resolve(heldPrefix),
  finalPose,
  regionsToInspect,
  referenceKind: cycleReference ? 'equal-weight-luminance-compressed-input-cycle' : 'settled-production-output',
  ...(integrated ? { referenceInputDigests: integrated.inputDigests }
    : { referenceShaderDigest: reference.results[0].shaderDigest }), results }, null, 2));
