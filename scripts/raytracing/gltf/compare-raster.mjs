import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { halfToFloat } from '../../../packages/rhi-debug/dist/index.mjs';

const directory = resolve(process.argv[2] ?? 'artifacts/sponza-raster/controls-384');
const names = ['baseline', 'light-off', 'shadows-off', 'restored', 'side'];
const rows = [];
for (const name of names) {
  const capture = JSON.parse(await readFile(resolve(directory, `${name}.json`), 'utf8'));
  const metadata = capture.observations.find((o) => o.domain === 'linear-hdr').metadata;
  const bytes = await readFile(resolve(directory, `${name}-live-linear-hdr.bin`));
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  let energy = 0,
    lit = 0;
  for (let y = 0; y < metadata.height; y++)
    for (let x = 0; x < metadata.width; x++) {
      let pixel = 0;
      for (let c = 0; c < 3; c++) {
        const v = halfToFloat(words[(y * metadata.bytesPerRow) / 2 + x * 4 + c]);
        assert(Number.isFinite(v) && v >= 0);
        pixel += v;
      }
      energy += pixel;
      lit += Number(pixel > 0);
    }
  rows.push({ name, energy, lit, bytes, tape: capture.artifact.digest });
}
assert(rows[0].energy > 0, 'Baseline must contain direct light');
assert.equal(rows[1].energy, 0, 'No sun or emissive/indirect source means zero RGB radiance');
assert(
  rows[2].energy > rows[0].energy,
  'Removing raster shadow visibility must restore blocked direct light',
);
assert.deepEqual(
  rows[3].bytes,
  rows[0].bytes,
  'Restoring inputs must exactly restore the captured HDR',
);
assert.notDeepEqual(rows[4].bytes, rows[0].bytes, 'Camera movement must change the visible scene');
if (process.argv.includes('--stages')) {
  for (const suffix of [
    'depth',
    'normal-roughness',
    'albedo-metallic',
    'f0-occlusion',
    'emission',
  ]) {
    const baseline = await readFile(resolve(directory, `baseline-${suffix}.bin`));
    const noShadow = await readFile(resolve(directory, `shadows-off-${suffix}.bin`));
    assert.deepEqual(baseline, noShadow, `Shadow control must preserve G-buffer ${suffix}`);
  }
}
const report = {
  status: 'passed',
  gbufferInvariantChecked: process.argv.includes('--stages'),
  rows: rows.map(({ bytes, ...row }) => row),
};
const baselineOption = process.argv.indexOf('--baseline-directory');
if (baselineOption !== -1) {
  assert(process.argv[baselineOption + 1], '--baseline-directory requires an evidence directory');
  const baselineDirectory = resolve(process.argv[baselineOption + 1]);
  const attachments = [];
  for (const suffix of ['.rgba', '-live-linear-hdr.bin', '-live-visible-surface.bin']) {
    const before = await readFile(resolve(baselineDirectory, `baseline${suffix}`));
    const after = await readFile(resolve(directory, `baseline${suffix}`));
    let differentBytes = Math.abs(before.length - after.length);
    for (let i = 0; i < Math.min(before.length, after.length); i++)
      differentBytes += Number(before[i] !== after[i]);
    attachments.push({
      suffix,
      beforeBytes: before.length,
      afterBytes: after.length,
      differentBytes,
    });
  }
  report.sourceComparison = { baselineDirectory, attachments };
  if (attachments.some((attachment) => attachment.differentBytes !== 0)) report.status = 'failed';
}
await writeFile(resolve(directory, 'controls.json'), JSON.stringify(report, null, 2));
if (report.sourceComparison)
  for (const attachment of report.sourceComparison.attachments)
    assert.equal(attachment.differentBytes, 0, `Source change altered ${attachment.suffix}`);
console.log(JSON.stringify(report, null, 2));
