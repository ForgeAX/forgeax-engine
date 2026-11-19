import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { carrierRepoRoot, runCarrier } from '../smoke-carrier.mjs';

const falsifierSource = readFileSync(new URL('../smoke-falsify.mjs', import.meta.url), 'utf8');

test('falsifier readbacks honor the inherited external evidence directory', () => {
  const expression = falsifierSource.match(/const EVIDENCE_DIR = (.+);/)[1];
  const appRoot = resolve(carrierRepoRoot, 'apps/hello/taa');
  const external = resolve(carrierRepoRoot, '..', '.tmp', 'taa readbacks');
  const evaluate = (env) => runInNewContext(expression, {
    APP_ROOT: appRoot,
    process: { env },
    resolve,
  });
  assert.equal(evaluate({ SMOKE_EVIDENCE_DIR: external }), external);
  assert.equal(evaluate({}), resolve(appRoot, 'evidence', 'readback'));
});

test('carrier failure preserves structured child stdout and launch context', () => {
  assert.throws(
    () => runCarrier('__tests__/fixtures/structured-unavailable.mjs', { SMOKE_CASE: 'static' }),
    (error) => {
      assert.match(error.message, /case=static/);
      assert.match(error.message, /status=1/);
      assert.match(error.message, /signal=none/);
      assert.match(error.message, /status.*unavailable/);
      assert.match(error.message, /acceptance.*fail-closed/);
      assert.match(error.message, /provider launch diagnostic/);
      return true;
    },
  );
});

test('carrier launches children from the worktree repository root', () => {
  assert.throws(
    () => runCarrier('__tests__/fixtures/structured-unavailable.mjs', { SMOKE_CASE: 'static' }),
    (error) => {
      const stdout = JSON.parse(error.message.match(/ stdout=(.+) stderr=/)[1]);
      assert.equal(JSON.parse(stdout.trim()).cwd, carrierRepoRoot);
      return true;
    },
  );
});

test('static Dawn falsifier isolates capture state and enforces depth controls', () => {
  assert.match(falsifierSource, /SMOKE_DAWN_CAPTURE_MODE/);
  assert.match(falsifierSource, /visualCase === 'static' \? runStaticDawnPair\(\)/);
  assert.match(falsifierSource, /if \(roiDelta > 0\.01\)/);
  assert.match(falsifierSource, /caseDawn\.motionBlurFalsifier\.roiDelta <= 0\.05/);
  assert.match(falsifierSource, /sameDepthPositiveControl/);
});

test('browser falsifier uses bounded parallel fresh carriers', () => {
  assert.match(falsifierSource, /runCarrierAsync/);
  assert.match(falsifierSource, /SMOKE_FALSIFY_CONCURRENCY/);
  assert.match(falsifierSource, /Promise\.allSettled/);
  assert.match(falsifierSource, /runInBatches\(/);
});

test('CI falsifier profile keeps a small live matrix while full evidence stays the default', () => {
  assert.match(falsifierSource, /FORGEAX_TAA_FALSIFIER_PROFILE/);
  assert.match(falsifierSource, /frames: 60/);
  assert.match(falsifierSource, /frames: 60/);
  assert.match(falsifierSource, /caseIds: Object\.freeze\(\['moving-rigid'\]\)/);
  assert.match(falsifierSource, /outputName: 'visual-cases\.json'/);
  assert.match(falsifierSource, /outputName: 'visual-cases-ci\.json'/);
  assert.match(falsifierSource, /\.filter\(\(\[id\]\) => CASE_IDS\.includes\(id\)\)/);
  assert.match(falsifierSource, /SMOKE_MIN_FRAMES: String\(REQUIRED_FRAMES\)/);
});
