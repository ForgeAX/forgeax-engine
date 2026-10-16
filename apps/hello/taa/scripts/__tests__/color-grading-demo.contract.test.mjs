import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const appRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const source = readFileSync(resolve(appRoot, 'src/main.ts'), 'utf8');
const index = readFileSync(resolve(appRoot, 'index.html'), 'utf8');
const captureScript = readFileSync(resolve(appRoot, 'scripts/capture-color-grading-demo.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'));
const lutPath = resolve(appRoot, 'assets/auto-exposure-positive-lut.cube');

function lutRows() {
  return readFileSync(lutPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.length > 0 && /^[-+]?\d/.test(line) && line.split(/\s+/).length === 3)
    .map((line) => line.split(/\s+/).map(Number));
}

test('color grading URLs are backed by a real HDR chart and renderer stages', () => {
  for (const id of [
    'exposure-adaptation-card',
    'exposure-manual-reference',
    'white-balance-card',
    'lut-output-card',
  ]) {
    assert.match(source, new RegExp(id));
  }
  for (const id of ['exposure-auto-dark', 'exposure-auto-bright', 'exposure-manual-dark', 'exposure-manual-bright']) {
    assert.match(captureScript, new RegExp(`id: '${id}'`));
  }
  assert.match(source, /taa-scene-scale/);
  assert.match(source, /TONEMAP_ACES_FILMIC/);
  assert.match(source, /linear-HDR/);
  assert.match(source, /maximumLinearValue: 8/);
  assert.match(source, /stageObservationEnabled/);
  assert.match(index, /id="color-grading-proof"/);
  assert.match(index, /id="legend-left"/);
});

test('the demo LUT is a real non-identity Catalog source', () => {
  const rows = lutRows();
  assert.equal(rows.length, 16 ** 3);
  assert.ok(rows.some(([red, green, blue], index) => {
    const r = (index % 16) / 15;
    const g = (Math.floor(index / 16) % 16) / 15;
    const b = Math.floor(index / 256) / 15;
    return Math.max(Math.abs(red - r), Math.abs(green - g), Math.abs(blue - b)) > 0.02;
  }));
  assert.ok(existsSync(resolve(appRoot, 'assets/auto-exposure-positive-lut.cube.meta.json')));
});

test('software-only demo capture is explicit and does not claim physical admission', () => {
  assert.equal(packageJson.scripts['demo:color-grading'], 'node scripts/capture-color-grading-demo.mjs');
  assert.equal(packageJson.scripts['demo:color-grading:validate'], 'node scripts/validate-color-grading-demo.mjs');
  assert.match(captureScript, /physicalGpu: false/);
  assert.match(captureScript, /software-demo-only/);
  assert.match(captureScript, /TAA_DEMO_FRAMES/);
  const validator = readFileSync(resolve(appRoot, 'scripts/validate-color-grading-demo.mjs'), 'utf8');
  assert.match(validator, /observation-pass/);
  assert.match(validator, /admission: 'not-acceptance'/);
  assert.match(validator, /autoExposureComparison/);
  assert.match(validator, /fixedExposureLuminanceRatio/);
  assert.match(validator, /linear-HDR/);
});
