import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { trajectory } from './field-oracle.mjs';

// Run outside device admission after the real probes finish. The manifest maps
// every frozen case key to its retained output directory; missing data fails.
const manifestPath = resolve(process.argv[2]);
const directories = JSON.parse(readFileSync(manifestPath, 'utf8'));
const matrixContract = JSON.parse(readFileSync(resolve(import.meta.dirname, 'field-matrix-cases.json'), 'utf8'));
const required = matrixContract.coreCases;
const supplemental = matrixContract.supplementalCases;
assert.equal(required.length, 22, 'frozen core matrix case count');
assert.deepEqual(supplemental, ['affine-spatial'], 'frozen supplemental spatial case');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = new Map();
const report = { manifestPath, manifestSha256: sha256(readFileSync(manifestPath)),
  effectMatrix: { coreCaseCount: required.length, supplementalCases: supplemental,
    totalCaseCount: required.length + supplemental.length },
  thresholds: { oracle: 2e-4, pixel: .05, changedPixels: 20, disabledPosition: .05 },
  cases: [], supplementalCases: [], resolutions: [], falsifiers: [], verdict: 'incomplete' };
try {
  for (const key of [...required, ...supplemental]) {
    assert.equal(typeof directories[key], 'string', `missing retained case ${key}`);
    const directory = resolve(dirname(manifestPath), directories[key]);
    const resultBytes = readFileSync(resolve(directory, 'result.json'));
    const result = JSON.parse(resultBytes);
    const pixels = readFileSync(resolve(directory, 'live.rgba'));
    const retired = JSON.parse(readFileSync(resolve(directory, 'resources-retired.json'), 'utf8'));
    assert.equal(result.key, key);
    assert.equal(result.completedFrames, 60);
    assert.equal(result.oracle.records.length, 256);
    assert.equal(pixels.length, 512 * 512 * 4);
    assert(result.oracle.maxError <= report.thresholds.oracle);
    assert(result.oracle.beforeUpdate.maxError <= report.thresholds.oracle);
    assert(result.pixels.liveReplay.maxError <= report.thresholds.pixel);
    assert.equal(result.capture.freshDevice, true);
    assert.equal(result.capture.lineage.coreStride, 112);
    assert.equal(retired.fieldLiveAfterDispose, 0);
    assert.equal(retired.fieldUploads, key === 'off' ? 0 : key === 'shared' ? 2 : 1);
    const epoch = { ...result.source, shaderManifestSha256: result.shaderManifestSha256 };
    if (report.epoch === undefined) report.epoch = epoch;
    else assert.deepEqual(epoch, report.epoch, 'matrix cannot combine different source/shader epochs');
    const ticks = key === 'shared' ? 62 : 60;
    assert.equal(result.oracle.updates, ticks);
    cases.set(key, { result, pixels });
    const row = { key, directory, resultSha256: sha256(resultBytes),
      pixelsSha256: sha256(pixels), ticks, maxError: result.oracle.maxError,
      replayError: result.pixels.liveReplay.maxError, adapter: result.adapter,
      software: result.software, resources: retired };
    if (key === 'affine-spatial') {
      const support = result.oracle.affineSpatialSupport;
      assert(support, 'affine spatial readback must retain support records');
      assert(support.centreVelocity <= report.thresholds.oracle, 'affine field centre remains force-free');
      assert.equal(support.inside.length, 2);
      assert(support.inside.every(seed => Math.hypot(...seed.velocity) > .01), 'affine field affects both inside seeds');
      assert.equal(support.outside.length, 2);
      assert(support.outside.every(seed => Math.hypot(...seed.velocity) <= report.thresholds.oracle), 'affine field leaves both outside seeds unchanged');
      row.affineSpatialSupport = support;
      report.supplementalCases.push(row);
    } else {
      report.cases.push(row);
    }
  }
  const comparePixels = (left, right) => {
    const a = cases.get(left).pixels, b = cases.get(right).pixels;
    let changedPixels = 0, maxError = 0;
    for (let offset = 0; offset < a.length; offset += 4) {
      let pixelError = 0;
      for (let channel = 0; channel < 4; channel++) {
        pixelError = Math.max(pixelError, Math.abs(a[offset + channel] - b[offset + channel]) / 255);
      }
      maxError = Math.max(maxError, pixelError);
      if (pixelError > report.thresholds.pixel) changedPixels++;
    }
    return { left, right, changedPixels, maxError };
  };
  const recordFalsifier = (name, data, passed) => {
    report.falsifiers.push({ name, ...data, passed });
  };
  for (const kind of ['radial', 'vortex']) for (const size of [8, 16, 32]) {
    const halfSpacing = 1 / (size - 1);
    let positionBound = 0, velocityBound = 0;
    for (let tick = 0; tick < 60; tick++) {
      velocityBound += (positionBound + halfSpacing) / 60;
      positionBound += velocityBound / 60;
    }
    for (const sampling of ['nearest', 'trilinear']) {
      const key = `${kind}/${size}/${sampling}`;
      const records = cases.get(key).result.oracle.records;
      let oracleSupportHigh = 0;
      for (const row of records) for (let tick = 0; tick <= 60; tick++) {
        for (const oracleKey of [key, `${kind}/${size}/trilinear`]) {
          oracleSupportHigh = Math.max(oracleSupportHigh,
            ...trajectory(oracleKey, row.id, tick).position.map(Math.abs));
        }
      }
      const errors = {};
      for (const name of ['position', 'velocity']) {
        const samples = records.flatMap(row => {
          // The linear ideal is independent of the saved nearest node choice.
          const ideal = trajectory(`${kind}/${size}/trilinear`, row.id, 60)[name];
          return row[name].map((value, lane) => Math.abs(value - ideal[lane]));
        });
        errors[name] = {
          max: Math.max(...samples),
          rms: Math.sqrt(samples.reduce((sum, error) => sum + error * error, 0) / samples.length),
          bound: report.thresholds.oracle + (sampling === 'nearest'
            ? name === 'position' ? positionBound : velocityBound : 0),
        };
      }
      const row = { key, halfSpacing, oracleSupportHigh, againstDeclaredSamplerMax: cases.get(key).result.oracle.maxError,
        againstLinearIdeal: errors, boundDerivation: 'f64 semi-implicit error recurrence; 60 steps, dt 1/60, unit Lipschitz field while within support' };
      report.resolutions.push(row);
      recordFalsifier(`${key} stays within the frozen interpolation/quantization bound`, row,
        oracleSupportHigh <= 1 && Object.values(errors).every(error => error.max <= error.bound));
    }
  }
  const enabledPixels = comparePixels('off', 'constant');
  recordFalsifier('enabled field visibly differs from disabled field', enabledPixels,
    enabledPixels.changedPixels >= report.thresholds.changedPixels);
  for (const key of ['zero', 'zero-vector']) {
    const pixels = comparePixels('off', key);
    recordFalsifier(`${key} matches disabled pixels`, pixels, pixels.maxError <= report.thresholds.pixel);
  }
  const disabledPositionError = Math.max(...cases.get('off').result.oracle.records.flatMap(row =>
    row.position.map((value, lane) => Math.abs(value - trajectory('constant', row.id, 60).position[lane]))));
  recordFalsifier('disabled field rejects enabled trajectory', { disabledPositionError },
    disabledPositionError > report.thresholds.disabledPosition);
  for (const [key, wrongSupport] of [['sphere', 'box'], ['box', 'sphere']]) {
    const records = cases.get(key).result.oracle.records;
    const wrongOracleError = Math.max(...records.flatMap(row => ['position', 'velocity'].flatMap(name =>
      row[name].map((value, lane) => Math.abs(value - trajectory(wrongSupport, row.id, 60)[name][lane])))));
    // Boundary particles use authored support-test positions, unlike off's
    // regular lattice. Derive their intended stationary positions separately.
    const boundaryPositions = [[0, 0, 0], [1, 0, 0], [1.25, 0, 0]];
    const boundaryError = Math.max(...records.filter(row => row.id <= 2).flatMap(row =>
      row.position.map((value, lane) => Math.abs(value - boundaryPositions[row.id][lane]))
        .concat(row.velocity.map(Math.abs))));
    recordFalsifier(`${key} detects switched ${wrongSupport} support`, { wrongOracleError },
      wrongOracleError > report.thresholds.oracle);
    recordFalsifier(`${key} center/edge/outside stay finite and stationary`,
      { boundaryError }, boundaryError <= report.thresholds.oracle);
  }
  const normalCirculation = cases.get('vortex/16/trilinear').result.oracle.signedCirculation;
  const reversedCirculation = cases.get('vortex/16/reversed').result.oracle.signedCirculation;
  recordFalsifier('reversed vortex reverses circulation', { normalCirculation, reversedCirculation },
    normalCirculation > 0 && reversedCirculation < 0);
  report.verdict = report.falsifiers.every(row => row.passed) ? 'pass' : 'fail';
} catch (error) {
  report.verdict = 'fail';
  report.error = String(error);
} finally {
  const output = resolve(process.argv[3] ?? resolve(dirname(manifestPath), 'matrix-analysis.json'));
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.verdict, 'pass', JSON.stringify(report.falsifiers.filter(row => !row.passed)));
