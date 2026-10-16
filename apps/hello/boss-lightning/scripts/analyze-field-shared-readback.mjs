import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { trajectory } from './field-oracle.mjs';

// Analyze actual public CLI rhi.read JSON after its leased replay finishes.
// Input receipt binds this diagnostic to the retained producer tape and ticks.
assert(process.argv[2] && process.argv[3] && process.argv[4], 'pass CLI JSON, requests and request receipt');
const rawPath = resolve(process.argv[2]);
const rawBytes = readFileSync(rawPath);
const requests = JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8'));
const receipt = JSON.parse(readFileSync(resolve(process.argv[4]), 'utf8'));
const report = { rawPath, rawSha256: createHash('sha256').update(rawBytes).digest('hex'),
  producer: receipt, bound: 2e-4, cores: [], fields: [], verdict: 'incomplete',
  scope: 'both emitters at each of the three captured catch-up updates; not final-head or performance acceptance' };
try {
  const result = JSON.parse(rawBytes);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.value.artifact.digest, receipt.digest);
  assert.equal(requests.length, 8);
  assert.equal(result.value.reads.length, 8);
  assert.equal(receipt.expectedTicks.length, 6);
  const reads = result.value.reads.map((read, index) => {
    assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.equal(read.value.provenance.selectedWorkIndex, requests[index].workIndex);
    assert.equal(read.value.provenance.resourceId, read.value.resourceId);
    assert.equal(read.value.byteLength, requests[index].records.layout.stride * requests[index].records.count);
    assert.equal(read.value.records.length, requests[index].records.count);
    for (const [recordIndex, row] of read.value.records.entries()) {
      assert.equal(row.index, requests[index].records.first + recordIndex);
      for (const values of Object.values(row.fields)) assert(values.every(Number.isFinite), 'nonfinite GPU record');
    }
    return read.value;
  });
  for (let index = 0; index < 6; index++) {
    assert.equal(requests[index].binding.group, 0);
    assert.equal(requests[index].binding.binding, 0);
    assert.equal(requests[index].records.layout.stride, 112);
    assert.equal(reads[index].records.length, 256);
    const ticks = receipt.expectedTicks[index];
    const rows = reads[index].records.map(row => {
      const expected = trajectory('shared', row.index, ticks);
      const errors = Object.fromEntries(['position', 'velocity'].map(name => {
        assert.equal(row.fields[name].length, 3);
        return [name, row.fields[name].map((value, lane) => Math.abs(value - expected[name][lane]))];
      }));
      return { id: row.index, actual: row.fields, expected, errors };
    });
    const maxError = Math.max(...rows.flatMap(row => Object.values(row.errors).flat()));
    report.cores.push({ resourceId: reads[index].resourceId, workIndex: requests[index].workIndex,
      ticks, maxError, provenance: reads[index].provenance, rows });
    assert(maxError <= report.bound, `Core ${index} error ${maxError}`);
  }
  assert.equal(new Set(reads.slice(0, 3).map(read => read.resourceId)).size, 1);
  assert.equal(new Set(reads.slice(3, 6).map(read => read.resourceId)).size, 1);
  assert.notEqual(reads[0].resourceId, reads[3].resourceId, 'two distinct Core resources');
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const header = [[1, 0, 0, 0], ...identity, ...identity, [2, 1, 0, 1], [8, 8, 8, 11]];
  for (let index = 6; index < 8; index++) {
    assert.equal(requests[index].binding.group, 0);
    assert.equal(requests[index].binding.binding, 17);
    assert.equal(requests[index].records.layout.stride, 16);
    assert.equal(reads[index].records.length, 523);
    const rows = reads[index].records;
    for (let row = 0; row < header.length; row++) assert.deepEqual(rows[row].fields.vector, header[row]);
    for (const row of rows.slice(11)) assert.deepEqual(row.fields.vector, [.5, .25, -.125, 0]);
    report.fields.push({ resourceId: reads[index].resourceId, workIndex: requests[index].workIndex,
      provenance: reads[index].provenance, header: rows.slice(0, 11), voxelsChecked: 512, digest: reads[index].digest });
  }
  assert.notEqual(reads[6].resourceId, reads[7].resourceId, 'two distinct managed field resources');
  report.verdict = 'pass';
} catch (error) {
  report.verdict = 'fail';
  report.error = String(error);
} finally {
  const output = resolve(process.argv[5] ?? resolve(dirname(rawPath), 'all-core-readback-analysis.json'));
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.verdict, 'pass', report.error);
