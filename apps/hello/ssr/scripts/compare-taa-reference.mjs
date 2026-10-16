import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCapturedTaaReference, measureTaaReferenceRegions } from './taa-reference.mjs';

// Static convergence uses an independent integration of the captured inputs,
// not another TAA output. A low frame delta alone can hide a biased fixed point.
const referencePrefix = resolve(process.argv[2]);
const reference = readCapturedTaaReference(referencePrefix);
const results = [];
for (const path of process.argv.slice(3)) {
  const report = JSON.parse(readFileSync(path));
  assert.equal(report.mode, 'recorded-input-gpu-feedback');
  assert.deepEqual([...report.inputDigests].sort(), [...reference.inputDigests].sort());
  for (const variant of report.results) {
    assert.equal(variant.outputFrames.length, 8, 'Export a complete measured cycle');
    const phases = [];
    for (const row of variant.outputFrames) {
      const bytes = readFileSync(row.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), row.digest);
      const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      phases.push({ frameIndex: row.inputFrameIndex, regions: measureTaaReferenceRegions(values, reference) });
    }
    results.push({ reportPath: resolve(path), name: variant.name, shaderDigest: variant.shaderDigest,
      historyFormat: report.historyFormat, warmupFrames: report.warmupFrames, phases });
  }
}
console.log(JSON.stringify({ referencePrefix, referenceKind: 'equal-weight-luminance-compressed-input-cycle',
  caveat: 'A captured-input integration target, not exact geometric supersampling or full SSR ground truth',
  inputDigests: reference.inputDigests, results }));
