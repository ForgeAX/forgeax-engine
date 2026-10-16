import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBudgetReport, validateBudgetReport } from '../render-core-budget.mjs';

const sourceSha = 'a'.repeat(40);

const validInventory = {
  productionFiles: 100,
  productionCodeLines: 30_000,
  rootExports: 50,
  authoringExports: 10,
  broadInternalExports: 0,
  constructRendererExports: 4,
  rendererGroups: 4,
  runtimeMaxScc: 1,
  publicRegistrationAuthorities: 1,
  deviceLifecycleRoots: 1,
  explicitAny: 0,
  highRiskCasts: 0,
  hostBackendDependencies: 0,
  staticForbiddenMatches: [],
  observations: [
    { id: 'legacy-urp', state: 'absent' },
    { id: 'legacy-hdrp', state: 'absent' },
    { id: 'standard-pipeline', state: 'target' },
    { id: 'device-scope', state: 'target' },
  ],
};

const validLedger = {
  deleted: [{ id: 'legacy-urp', source: 'packages/render/src/urp-pipeline.ts' }],
  derived: [{ id: 'scene-snapshot', source: 'extracted-frame', destination: 'render-scene' }],
  migrated: [{ id: 'asset-catalog', source: 'render-store', destination: 'assets-runtime' }],
  added: [{ id: 'budget-report', destination: 'scripts/forgeax/render-core-budget.mjs' }],
};

function validReport() {
  return buildBudgetReport({
    sourceSha,
    buildIdentity: 'render-build-1',
    inventory: validInventory,
    ledger: validLedger,
  });
}

test('accepts a source-bound fixture with explicit rules and ledger', () => {
  const report = validReport();
  const result = validateBudgetReport(report, { sourceSha, buildIdentity: 'render-build-1' });

  assert.equal(result.ok, true);
});

test('rejects a missing source identity', () => {
  const report = validReport();
  delete report.sourceSha;

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source SHA/i);
});

test('rejects a changed measurement rule', () => {
  const report = validReport();
  report.rules.lineMetric = 'all-lines';

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /rule|metric/i);
});

test('rejects a budget threshold violation', () => {
  const report = validReport();
  report.counts.productionCodeLines = report.thresholds.productionCodeLines + 1;

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /productionCodeLines|budget/i);
});

test('requires exactly one public registration and device lifecycle authority', () => {
  const report = validReport();
  report.counts.publicRegistrationAuthorities = 0;

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /exactly one publicRegistrationAuthorities/i);
});

test('requires explicit legacy absence and target authority observations', () => {
  const report = validReport();
  report.observations = report.observations.filter(
    (observation) => observation.id !== 'device-scope',
  );

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /device-scope|target authority/i);
});

test('keeps absent and target observations out of measured counts', () => {
  const report = validReport();
  report.observations[0].measuredCount = 1;

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /absent|target|observation/i);
});

test('rejects a ledger entry that calls a move a deletion', () => {
  const report = validReport();
  report.ledger.deleted.push({
    id: 'moved-helper',
    source: 'packages/render/src/old-helper.ts',
    destination: 'packages/render/src/new-helper.ts',
  });

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /ledger|move|migrat/i);
});

test('binds ledger classification to the measured source and build identity', () => {
  const report = validReport();

  assert.deepEqual(report.identity, {
    sourceSha,
    buildId: 'render-build-1',
  });
  assert.equal(report.ledger.deleted[0].source, 'packages/render/src/urp-pipeline.ts');
  assert.equal(report.ledger.migrated[0].destination, 'assets-runtime');
  assert.equal(
    validateBudgetReport(report, { sourceSha, buildIdentity: 'render-build-1' }).ok,
    true,
  );
});

test('rejects a ledger entry without source/build evidence', () => {
  const report = validReport();
  delete report.ledger.derived[0].source;
  report.ledger.added[0].buildId = 'other-build';

  const result = validateBudgetReport(report, { sourceSha, buildIdentity: 'render-build-1' });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source|build|identity/i);
});

test('rejects a static forbidden match', () => {
  const report = validReport();
  report.counts.staticForbiddenMatches = [
    {
      pattern: ['renderer', 'store'].join('.'),
      path: 'packages/render/src/render-contract.ts',
      line: 1,
    },
  ];

  const result = validateBudgetReport(report, { sourceSha });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /forbidden|static/i);
});

test('retains the complete owner-forbidden pattern set without source-token literals', async () => {
  const source = await import('../render-core-budget.mjs');
  const report = validReport();
  const expected = [
    ['renderer', 'store'].join('.'),
    ['renderer', 'device'].join('.'),
    ['renderer', 'registerPipeline'].join('.'),
    `${['renderer', 'postProcess'].join('.')}.register`,
  ];
  const sourceText = await (await import('node:fs/promises')).readFile(
    new URL('../render-core-budget.mjs', import.meta.url),
    'utf8',
  );
  for (const pattern of expected) {
    assert.equal(source.buildBudgetReport !== undefined, true);
    assert.equal(sourceText.includes(pattern), false);
  }
  report.counts.staticForbiddenMatches = expected.map((pattern) => ({
    pattern,
    path: 'packages/render/src/render-contract.ts',
    line: 1,
  }));
  const result = validateBudgetReport(report, { sourceSha });
  assert.equal(result.ok, false);
});

test('forbids the current builtin morph factory at the root declaration', async () => {
  const source = await import('../render-core-budget.mjs');
  const report = validReport();
  report.counts.staticForbiddenMatches = [
    {
      pattern: 'createBuiltinMorphFeature',
      path: 'packages/render/src/index.ts',
      line: 1,
    },
  ];
  assert.equal(source.validateBudgetReport(report, { sourceSha }).ok, false);
});
