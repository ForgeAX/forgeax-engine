import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildDependencyReport,
  DEFAULT_REQUIRED_ANCESTORS,
  FALLBACK_CHECK_NAMES,
  FORMAT_STAGE_NAMES,
  IDENTITY_FIELDS,
  run,
  sameIdentity,
  validateIdentity,
} from '../collect-ssr-dependency-report.mjs';
import {
  createSsrSquashFixture,
  SSR_SOURCE_LINEAGE,
} from './fixtures/ssr-source-lineage.fixture.mjs';

const identity = Object.freeze({
  sourceHead: 'head',
  sourceTree: 'tree',
  lockSha256: 'lock',
  buildSha256: 'build',
});

test('requires the actual M0 squash landing while retaining all live receipt guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-ssr-lineage-'));
  try {
    const fixture = await createSsrSquashFixture(root);
    const requirement = DEFAULT_REQUIRED_ANCESTORS.find(
      (entry) => entry.label === 'parentSsrM0Revision',
    );
    assert.equal(requirement?.revision, SSR_SOURCE_LINEAGE.landingM0);
    assert.notEqual(requirement?.revision, SSR_SOURCE_LINEAGE.developmentM0);
    const current = {
      sourceHead: fixture.head,
      sourceTree: fixture.tree,
      lockSha256: 'fixture-lock',
      buildSha256: 'fixture-build',
    };
    const dependencies = {
      status: 'admitted',
      identity: current,
      admission: { status: 'admitted' },
      reflectionFallback: {
        identity: current,
        source: 'probe',
        state: 'active',
        sourceGeneration: 1,
        projectionGeneration: 1,
        deviceGeneration: 1,
        candidateVisible: false,
      },
      format: {
        identity: current,
        profile: 'r32float-mip-sampled-storage',
        verdict: 'admitted',
        evidence: 'real',
        readback: { byteLength: 4, values: [1] },
        stages: FORMAT_STAGE_NAMES.map((stage) => ({ stage, verdict: 'admitted' })),
      },
      temporal: { identity: current, successfulSubmit: true },
    };
    const requirements = DEFAULT_REQUIRED_ANCESTORS.map((entry) => ({
      label: entry.label,
      revision: entry.label === 'parentSsrM0Revision' ? fixture.landing : fixture.base,
    }));
    const report = (input = {}) =>
      buildDependencyReport({
        root,
        identity: current,
        inputIdentity: current,
        dependencies,
        requiredAncestors: requirements,
        ...input,
      });
    assert.equal(report().status, 'admitted');
    assert.equal(report({ dependencies: undefined }).status, 'fallback-only');
    assert.equal(
      report({ inputIdentity: { ...current, buildSha256: 'stale' } }).status,
      'fallback-only',
    );
    assert.equal(
      report({
        dependencies: {
          ...dependencies,
          temporal: {
            ...dependencies.temporal,
            identity: { ...current, sourceTree: 'stale' },
          },
        },
      }).status,
      'fallback-only',
    );
    assert.equal(
      report({
        dependencies: {
          ...dependencies,
          format: {
            ...dependencies.format,
            stages: dependencies.format.stages.slice(1),
          },
        },
      }).status,
      'fallback-only',
    );
    for (const revision of [fixture.development, '0000000000000000000000000000000000000000']) {
      const blocked = report({ requiredAncestors: [{ label: requirement.label, revision }] });
      assert.equal(blocked.status, 'fallback-only');
      assert.ok(blocked.failures.some((failure) => failure.code === 'required-ancestor-missing'));
    }
    assert.deepEqual(JSON.parse(fixture.git('show', `${fixture.landing}:owner.json`)).contracts, [
      'identity-bound-live-receipts',
      'format-eight-stages',
      'successful-submit',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('defines the exact four-field integration identity contract', () => {
  assert.deepEqual(IDENTITY_FIELDS, ['sourceHead', 'sourceTree', 'lockSha256', 'buildSha256']);
  assert.deepEqual(validateIdentity(identity), { valid: true, missing: [] });
  assert.equal(sameIdentity(identity, { ...identity }), true);
  assert.equal(sameIdentity(identity, { ...identity, buildSha256: 'other' }), false);
});

test('keeps missing live receipts fallback-only with zero SSR work', () => {
  const report = buildDependencyReport({ root: process.cwd(), identity, requiredAncestors: [] });
  assert.equal(report.status, 'fallback-only');
  assert.equal(report.parentGuard.status, 'blocked');
  assert.deepEqual(Object.keys(report.reflectionFallback.checks), FALLBACK_CHECK_NAMES);
  assert.deepEqual(report.zeroWork, {
    attachmentCount: 0,
    passCount: 0,
    bindingCount: 0,
    historyCount: 0,
    temporalDemand: 0,
  });
});

test('reports every missing receipt as a structured failed stage', () => {
  const report = buildDependencyReport({ root: process.cwd(), identity, requiredAncestors: [] });
  assert.deepEqual(
    report.failures.map((failure) => failure.stage),
    ['ssrDependencies', 'reflectionFallback', 'capabilityFormat', 'temporal'],
  );
});

test('rejects each cross-revision identity field', () => {
  for (const field of IDENTITY_FIELDS) {
    const report = buildDependencyReport({
      root: process.cwd(),
      identity,
      inputIdentity: { ...identity, [field]: `old-${field}` },
      requiredAncestors: [],
    });
    assert.equal(report.status, 'fallback-only', field);
    assert.equal(report.failures[0].code, 'identity-mismatch');
    assert.equal(report.failures[0].field, field);
  }
});

test('rejects missing ancestry and stale receipt identity', () => {
  const report = buildDependencyReport({
    root: process.cwd(),
    identity,
    dependencies: {
      identity,
      status: 'fallback-only',
      temporal: { identity: { ...identity, sourceTree: 'old-tree' }, successfulSubmit: true },
    },
    requiredAncestors: [
      { label: 'unmerged', revision: '0000000000000000000000000000000000000000' },
    ],
  });
  assert.equal(report.status, 'fallback-only');
  assert.equal(
    report.failures.some((failure) => failure.stage === 'ancestry'),
    true,
  );
  assert.equal(
    report.failures.some((failure) => failure.code === 'receipt-identity-mismatch'),
    true,
  );
});

test('does not trust an authored admitted boolean or historical digest', () => {
  const report = buildDependencyReport({
    root: process.cwd(),
    identity,
    inputIdentity: { ...identity, buildSha256: 'historical-build' },
    receipts: {
      reflectionFallback: { admitted: true },
      capabilityFormat: { admitted: true },
      temporal: { admitted: true },
    },
    requiredAncestors: [],
  });
  assert.equal(report.status, 'fallback-only');
  assert.equal(report.parentGuard.status, 'blocked');
  assert.equal(report.reflectionFallback.status, 'unavailable');
  assert.equal(report.capabilityFormat.status, 'unavailable');
  assert.equal(report.temporal.status, 'unavailable');
});

test('real command keeps the parent M1 guard blocked without live receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-ssr-report-'));
  const output = join(directory, 'ssr-dependency-report.json');
  try {
    const result = await run(['--root', process.cwd(), '--output', output]);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.exitCode, 0);
    assert.equal(written.status, 'fallback-only');
    assert.deepEqual(written.parentGuard, {
      status: 'blocked',
      milestone: 'M1',
      reason: 'm0-guard-admitted-dependency',
    });
    assert.equal(typeof written.identity.sourceHead, 'string');
    assert.equal(typeof written.identity.sourceTree, 'string');
    assert.ok('lockSha256' in written.identity);
    assert.ok('buildSha256' in written.identity);
    assert.ok(Array.isArray(written.identity.ancestry.required));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('complete same-identity receipts are the only future M4 admission input', () => {
  const completeIdentity = {
    sourceHead: 'current-head',
    sourceTree: 'current-tree',
    lockSha256: 'current-lock',
    buildSha256: 'current-build',
  };
  const report = buildDependencyReport({
    root: process.cwd(),
    identity: completeIdentity,
    inputIdentity: { ...completeIdentity },
    dependencies: {
      status: 'admitted',
      requested: true,
      identity: completeIdentity,
      admission: { status: 'admitted' },
      work: {
        attachmentCount: 1,
        passCount: 1,
        bindingCount: 1,
        resourceCount: 1,
        historyCount: 0,
        temporalDemand: 0,
      },
      budget: { probeExecutions: 1, resetCount: 0, rebuildCount: 0 },
      reflectionFallback: {
        identity: { ...completeIdentity },
        source: 'probe',
        sourceGeneration: 1,
        projectionGeneration: 1,
        deviceGeneration: 1,
        state: 'active',
        candidateVisible: false,
        brdfSignature: 'standard-pbr-ibl-v1',
      },
      format: {
        identity: { ...completeIdentity },
        profile: 'r32float-mip-sampled-storage',
        verdict: 'admitted',
        evidence: 'real',
        deviceGeneration: 1,
        stages: FORMAT_STAGE_NAMES.map((stage) => ({
          stage,
          verdict: 'admitted',
          evidence: 'real',
        })),
        sampleType: 'unfilterable-float',
        usages: ['texture-binding', 'storage-binding', 'copy-src'],
        readback: { byteLength: 4, values: [1] },
        probeExecutions: 1,
      },
      temporal: { identity: { ...completeIdentity }, successfulSubmit: true, generation: 1 },
    },
    requiredAncestors: [],
  });
  assert.equal(report.status, 'admitted');
  assert.deepEqual(report.parentGuard, { status: 'admitted', milestone: 'M1', reason: null });
});

test('command rejects an input receipt from an older digest without flipping status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-ssr-stale-'));
  const input = join(directory, 'input.json');
  const output = join(directory, 'report.json');
  try {
    await writeFile(input, JSON.stringify({ identity: { ...identity, buildSha256: 'old-build' } }));
    const result = await run([
      '--root',
      process.cwd(),
      '--input',
      input,
      '--output',
      output,
      '--required-ancestor',
      '0000000000000000000000000000000000000000',
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.status, 'fallback-only');
    assert.equal(result.report.parentGuard.status, 'blocked');
    assert.equal(result.report.failures[0].code, 'identity-mismatch');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
