#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureAllocations } from '../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
import {
  ECS_BYTES_PER_ADDED_ROW_LIMIT,
  ECS_FIXED_GROWTH_MARGIN,
  ecsAllocationFailure,
  MATH_BYTES_PER_CALL_LIMIT,
  mathAllocationFailure,
} from './foundation-allocation-policy.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
let sink = 0;
const controlRing = new Array(32);
function allocationControl(index) {
  const value = new Array(32).fill(index);
  controlRing[index & 31] = value;
  sink = value[0];
}

async function sample(name, target, output, calls, report, warmup = 512) {
  const result = await measureAllocations(target, {
    calls,
    warmup,
    samplingWarmup: 256,
    samplingInterval: 128,
    includeProfile: true,
    targetFrame: { url: import.meta.url, functionName: target.name },
  });
  const { profile, ...allocation } = result;
  writeFileSync(resolve(output, `${name}.heap-profile.json`), `${JSON.stringify(profile)}\n`);
  report.measurements.push({ name, ...allocation });
  return allocation;
}

function close(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++)
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${i}: ${actual[i]} != ${expected[i]}`,
    );
}

function mathCases({ vec3, mat4, quat }) {
  const a = vec3.create(1, 2, 3),
    b = vec3.create(4, 5, 6),
    vector = vec3.create();
  const first = mat4.create(),
    second = mat4.create(),
    product = mat4.create(),
    inverse = mat4.create();
  mat4.identity(first);
  mat4.identity(second);
  first[12] = 4;
  first[13] = 6;
  first[14] = 8;
  second[0] = 2;
  second[5] = 3;
  second[10] = 4;
  const qa = quat.create(),
    qb = quat.create(),
    rotation = quat.create();
  quat.identity(qa);
  qb[1] = Math.SQRT1_2;
  qb[3] = Math.SQRT1_2;
  const cases = [
    {
      name: 'vec3-add',
      output: vector,
      run: function vec3AddTarget(index) {
        a[0] = 1 + (index & 1);
        vec3.add(vector, a, b);
        sink = vector[0];
      },
      verify() {
        close(vector, [5, 7, 9]);
      },
    },
    {
      name: 'mat4-multiply',
      output: product,
      run: function mat4MultiplyTarget(index) {
        first[12] = 4 + (index & 1);
        mat4.multiply(product, first, second);
        sink = product[12];
      },
      verify() {
        close(product, [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 4, 6, 8, 1]);
      },
    },
    {
      name: 'mat4-invert',
      output: inverse,
      run: function mat4InvertTarget(index) {
        first[12] = 4 + (index & 1);
        mat4.invert(inverse, first);
        sink = inverse[12];
      },
      verify() {
        close(inverse, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, -6, -8, 1]);
      },
    },
    {
      name: 'quat-slerp',
      output: rotation,
      run: function quatSlerpTarget(index) {
        quat.slerp(rotation, qa, qb, 0.5 + (index & 1) * 0.125);
        sink = (rotation[1] * 1048576) | 0;
      },
      verify() {
        close(rotation, [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
      },
    },
  ];
  return cases;
}

async function measureMath(output, report) {
  const math = await import('../../packages/math/dist/index.mjs');
  for (const fixture of mathCases(math)) {
    const original = fixture.output;
    fixture.run(0);
    fixture.verify();
    const allocation = await sample(fixture.name, fixture.run, output, 32768, report, 8192);
    fixture.run(0);
    fixture.verify();
    assert.equal(fixture.output, original);
    assert.equal(mathAllocationFailure(allocation), undefined, fixture.name);
  }
}

// Scalar checksum kernels keep per-row benchmark bookkeeping in local registers.
// The reusable result buffer is written once per batch, outside each numeric loop.
function accumulateRange(x, alpha, entities, start, end, observed) {
  let value = 0,
    identity = 0;
  for (let row = start; row < end; row++) {
    value += x[row] * (alpha === undefined ? 1 : alpha[row]);
    identity += entities[row];
  }
  observed[0] += value;
  observed[1] += identity;
  observed[2] += end - start;
}
function accumulateIndexed(x, alpha, entities, selection, count, observed) {
  let value = 0,
    identity = 0;
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const row = selection[ordinal];
    value += x[row] * (alpha === undefined ? 1 : alpha[row]);
    identity += entities[row];
  }
  observed[0] += value;
  observed[1] += identity;
  observed[2] += count;
}

async function createEcsFixture({ count, fragments, sparse, optional }) {
  const { World, defineComponent } = await import('../../packages/ecs/dist/index.mjs');
  const Position = defineComponent('FoundationPosition', { x: 'f32' });
  const Tint = defineComponent('FoundationTint', { alpha: 'f32' });
  const Active = defineComponent('FoundationActive', {}, { storage: 'sparse' });
  const shards = Array.from({ length: 4 }, (_, index) =>
    defineComponent(`FoundationShard${index}`, {}),
  );
  const world = new World();
  let expected = 0,
    expectedIdentity = 0,
    selectedRows = 0;
  for (let index = 0; index < count; index++) {
    const selected = !sparse || index % 2 === 0;
    const tinted = optional && index % 3 === 0;
    const alpha = index % 5 === 0 ? 0 : 0.5;
    const entries = [{ component: Position, data: { x: index } }];
    if (tinted) entries.push({ component: Tint, data: { alpha } });
    if (sparse && selected) entries.push({ component: Active, data: {} });
    if (fragments > 1)
      for (let bit = 0; bit < shards.length; bit++)
        if ((index & (1 << bit)) !== 0) entries.push({ component: shards[bit], data: {} });
    const entity = world.spawn(...entries).unwrap();
    if (selected) {
      expected += index * (tinted ? alpha : 1);
      expectedIdentity += entity;
      selectedRows++;
    }
  }
  const query = world
    .query({
      read: [Position],
      ...(optional ? { optional: [Tint] } : {}),
      ...(sparse ? { with: [Active] } : {}),
    })
    .unwrap();
  const batches = query.batches().unwrap();
  const observed = new Float64Array(5);
  function ecsTraversal() {
    observed.fill(0);
    for (const batch of batches) {
      const x = batch.read(Position, 'x'),
        entities = batch.entities;
      const alpha = optional ? batch.read(Tint, 'alpha') : undefined;
      if (batch.kind === 'range')
        accumulateRange(x, alpha, entities, batch.start, batch.end, observed);
      else {
        accumulateIndexed(x, alpha, entities, batch.rows, batch.count, observed);
        observed[4]++;
      }
      observed[3]++;
    }
    sink = observed[0] | 0;
  }
  function verify() {
    assert.equal(observed[0], expected);
    assert.equal(observed[1], expectedIdentity);
    assert.equal(observed[2], selectedRows);
    assert.equal(observed[3], optional ? 2 : fragments);
    assert.equal(observed[4], sparse ? observed[3] : 0);
  }
  ecsTraversal();
  verify();
  const batchMetadata = {
    batchCount: observed[3],
    selectedRows,
    kind: observed[4] ? 'indexed' : 'range',
    count,
    fragments,
    sparse,
    optional,
  };
  function ecsSnapshotControl(index) {
    let total = 0;
    for (const row of query) {
      const snapshot = row.get(Position);
      controlRing[index & 31] = snapshot;
      total += snapshot.x;
    }
    sink = total;
  }
  return {
    ecsTraversal,
    ecsSnapshotControl,
    verify,
    ...batchMetadata,
    checksums: { value: expected, entity: expectedIdentity },
  };
}

async function measureEcs(output, report) {
  const scenarios = [
    { name: 'dense', fragments: 1, sparse: false, optional: false },
    { name: 'optional-indexed', fragments: 1, sparse: true, optional: true },
    { name: 'fragmented', fragments: 16, sparse: false, optional: false },
  ];
  for (const scenario of scenarios) {
    const pair = [];
    for (const count of [256, 4096]) {
      const fixture = await createEcsFixture({ ...scenario, count });
      const allocation = await sample(
        `ecs-${scenario.name}-${count}`,
        fixture.ecsTraversal,
        output,
        512,
        report,
        4096,
      );
      fixture.verify();
      pair.push({
        count,
        batchCount: fixture.batchCount,
        selectedRows: fixture.selectedRows,
        kind: fixture.kind,
        checksums: fixture.checksums,
        allocation,
      });
      if (scenario.name === 'dense' && count === 256) {
        const control = await sample(
          'ecs-snapshot-control',
          fixture.ecsSnapshotControl,
          output,
          128,
          report,
        );
        assert.ok(
          control.bytesPerCall > allocation.bytesPerCall + count * 8,
          'ECS control must expose escaped per-entity snapshots',
        );
      }
    }
    report.ecsComparisons.push({ scenario, small: pair[0], large: pair[1] });
    assert.equal(ecsAllocationFailure(pair[0], pair[1]), undefined, scenario.name);
  }
}

export async function runFoundationAllocations({
  select = 'all',
  output = resolve(root, 'artifacts/foundation-allocation'),
} = {}) {
  if (!['all', 'math', 'ecs'].includes(select))
    throw new Error(`unknown foundation allocation selector: ${select}`);
  mkdirSync(output, { recursive: true });
  const digest = (name) =>
    createHash('sha256')
      .update(readFileSync(resolve(root, `packages/${name}/dist/index.mjs`)))
      .digest('hex');
  const report = {
    kind: 'foundation-allocation-regression',
    runtime: process.version,
    select,
    source: {},
    measurements: [],
    ecsComparisons: [],
    status: 'failed',
    budgets: {
      mathBytesPerCall: MATH_BYTES_PER_CALL_LIMIT,
      ecsFixedGrowthMargin: ECS_FIXED_GROWTH_MARGIN,
      ecsBytesPerAddedRow: ECS_BYTES_PER_ADDED_ROW_LIMIT,
    },
    boundary:
      'Warmed Node sampled allocations at fixed work. Includes collected objects and conservative orphan attribution. No wall-time, retained-size, browser Worker or whole-game claim.',
  };
  try {
    for (const owner of select === 'math' ? ['math'] : ['math', 'ecs'])
      report.source[owner] = digest(owner);
    const control = await sample('allocation-control', allocationControl, output, 8192, report);
    assert.ok(control.bytesPerCall > 64, 'sampler must observe an escaping allocation control');
    assert.ok(
      mathAllocationFailure(control),
      'escaping allocation control must fail the Math budget',
    );
    if (select !== 'ecs') await measureMath(output, report);
    if (select !== 'math') await measureEcs(output, report);
    report.status = 'passed';
    report.sink = sink;
    return report;
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    writeFileSync(resolve(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index < 0 ? fallback : args[index + 1];
  };
  const report = await runFoundationAllocations({
    select: value('--select', 'all'),
    output: resolve(value('--output', resolve(root, 'artifacts/foundation-allocation'))),
  });
  process.stdout.write(
    `Foundation allocation PASS (${report.measurements.length} sampled controls/operations); raw results retained\n`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`FOUNDATION_ALLOCATION ${error.message}\n`);
    process.exitCode = 1;
  });
