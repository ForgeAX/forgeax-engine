import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ecsAllocationFailure, mathAllocationFailure } from '../foundation-allocation-policy.mjs';

const population = (selectedRows, bytesPerCall, batchCount = 1, kind = 'range') => ({
  selectedRows,
  batchCount,
  kind,
  allocation: { bytesPerCall },
});

test('Math budget permits tiny sampled noise and rejects one escaping output allocation per operation', () => {
  assert.equal(mathAllocationFailure({ bytesPerCall: 0 }), undefined);
  assert.equal(mathAllocationFailure({ bytesPerCall: 8 }), undefined);
  assert.match(mathAllocationFailure({ bytesPerCall: 24 }), /Math allocated/);
  assert.match(mathAllocationFailure({ bytesPerCall: Number.NaN }), /finite/);
});

test('ECS permits fixed traversal and fragmentation costs while rejecting allocation per selected row', () => {
  for (const [kind, batchCount] of [
    ['range', 1],
    ['indexed', 2],
    ['range', 16],
  ]) {
    const small = population(256, 200 * batchCount, batchCount, kind);
    assert.equal(
      ecsAllocationFailure(small, population(4096, 200 * batchCount + 300, batchCount, kind)),
      undefined,
    );
    assert.match(
      ecsAllocationFailure(small, population(4096, 200 * batchCount + 16 * 3840, batchCount, kind)),
      /grew/,
    );
  }
});

test('ECS scaling rejects incomparable populations and query shapes', () => {
  const small = population(256, 600);
  assert.match(ecsAllocationFailure(small, population(4096, Number.NaN)), /finite/);
  assert.match(ecsAllocationFailure(small, population(4096, 600, 2)), /same batch count/);
  assert.match(ecsAllocationFailure(small, population(4096, 600, 1, 'indexed')), /selection kind/);
  assert.match(ecsAllocationFailure(small, population(256, 600)), /larger selected population/);
});

test('CI samples built owners with warmup, explicit attribution and raw profiles in the existing job', () => {
  const runner = readFileSync('scripts/ci/run-foundation-allocations.mjs', 'utf8');
  assert.match(runner, /samplingWarmup: 256/);
  assert.match(runner, /targetFrame: \{ url: import.meta.url, functionName: target.name \}/);
  assert.match(runner, /includeProfile: true/);
  assert.match(runner, /heap-profile.json/);
  assert.match(runner, /fixture.verify\(\)/);
  assert.doesNotMatch(runner, /performance\.now|Date\.now|timeLimit|reports\//);
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.equal(ci.match(/pnpm check:foundation-allocations/g)?.length, 1);
  assert.match(ci, /path: artifacts\/foundation-allocation\//);
});
