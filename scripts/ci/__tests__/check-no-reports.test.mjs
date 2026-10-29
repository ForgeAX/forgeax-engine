import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  hasReportsComponent,
  resolvedUploadViolations,
  trackedReportViolations,
  uploadInputViolations,
  workflowReportViolations,
} from '../check-no-reports.mjs';

test('rejects the reports path component at every repository depth without filename guessing', () => {
  assert.deepEqual(
    trackedReportViolations(['reports/a.md', 'packages/math/reports/case/raw.json']).map(
      (entry) => entry.path,
    ),
    ['reports/a.md', 'packages/math/reports/case/raw.json'],
  );
  for (const path of [
    'collect-reports.mjs',
    'artifacts/report.json',
    '.forgeax-harness/docs/math.md',
    'shard-reports/report',
  ])
    assert.equal(hasReportsComponent(path), false);
  assert.equal(hasReportsComponent('packages\\math\\reports\\case.md'), true);
});

test('rejects report artifact names and upload sources, retaining legitimate evidence paths', () => {
  for (const name of ['reports', 'ci-reports-1'])
    assert.equal(uploadInputViolations({ name, path: 'artifacts/evidence' }).length, 1);
  for (const path of [
    'reports/**',
    'packages/math/reports/data.json',
    `\${{ runner.temp }}/reports/**`,
    `\${{ inputs.flag && 'reports/**' || 'artifacts/**' }}`,
  ])
    assert.equal(uploadInputViolations({ name: 'evidence', path }).length, 1);
  assert.deepEqual(
    uploadInputViolations({
      name: 'gpu-evidence',
      path: 'artifacts/frame.rhitape\n!artifacts/**/reports/**',
    }),
    [],
  );
});

test('checks direct and wrapper actions through YAML flow syntax, aliases and folded scalars', async () => {
  const text = `jobs:
  test:
    steps:
      - uses: actions/upload-artifact@v4
        with: &source
          name: evidence
          path: >-
            packages/math/reports/**
      - { uses: './.github/actions/upload-artifact-with-retry', with: *source }
`;
  assert.equal(
    (await workflowReportViolations(text)).filter((entry) => entry.code === 'reports-upload-path')
      .length,
    2,
  );
  assert.deepEqual(
    await workflowReportViolations(
      'jobs: { test: { steps: [{ uses: actions/download-artifact@v4, with: { path: reports/ } }] } }',
    ),
    [],
  );
});

test('rejects unchecked dynamic direct paths and malformed YAML', async () => {
  assert.equal(
    (
      await workflowReportViolations(
        `steps: [{ uses: actions/upload-artifact@v4, with: { path: "\${{ env.SOURCE }}" } }]`,
      )
    )[0]?.code,
    'unchecked-upload-selection',
  );
  await assert.rejects(workflowReportViolations('steps: [broken'), /<workflow>/u);
});

test('runtime admission checks resolved selections and nested reports without dropping evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-report-policy-'));
  try {
    mkdirSync(join(root, 'artifacts/reports'), { recursive: true });
    writeFileSync(join(root, 'artifacts/reports/case.json'), '{}');
    writeFileSync(join(root, 'artifacts/receipt.json'), '{}');
    assert.ok(
      (await resolvedUploadViolations({ name: 'evidence', path: 'artifacts/' }, root)).some(
        (entry) => entry.path.includes('reports'),
      ),
    );
    assert.deepEqual(
      await resolvedUploadViolations({ name: 'evidence', path: 'artifacts/receipt.json' }, root),
      [],
    );
    assert.deepEqual(
      await resolvedUploadViolations(
        { name: 'evidence', path: 'artifacts/**\n!artifacts/reports\n!artifacts/reports/**' },
        root,
      ),
      [],
    );
    assert.equal(
      (await resolvedUploadViolations({ path: `\${{ inputs.path }}` }, root))[0]?.code,
      'unresolved-upload-path',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dynamic direct uploads require the real preceding checker with matching inputs', async () => {
  const guarded = `steps:
  - run: node scripts/ci/check-no-reports.mjs --upload-inputs
    env:
      FORGEAX_ARTIFACT_NAME: evidence
      FORGEAX_ARTIFACT_PATH: "\${{ inputs.path }}"
  - uses: actions/upload-artifact@v4
    with: { name: evidence, path: "\${{ inputs.path }}" }
`;
  assert.deepEqual(await workflowReportViolations(guarded), []);
  assert.deepEqual(
    await workflowReportViolations(
      guarded.replace('  - run:', '  - continue-on-error: false\n    run:'),
    ),
    [],
  );
  for (const ignored of ['true', `"\${{ inputs.ignoreGuardFailure }}"`])
    assert.equal(
      (
        await workflowReportViolations(
          guarded.replace('  - run:', `  - continue-on-error: ${ignored}\n    run:`),
        )
      )[0]?.code,
      'unchecked-upload-selection',
    );
  for (const condition of ['always()', 'failure()', '!cancelled()', '!success()'])
    assert.equal(
      (
        await workflowReportViolations(
          guarded.replace('  - uses:', `  - if: ${JSON.stringify(condition)}\n    uses:`),
        )
      )[0]?.code,
      'unchecked-upload-selection',
    );
  assert.deepEqual(
    await workflowReportViolations(guarded.replace('  - uses:', '  - if: success()\n    uses:')),
    [],
  );
  assert.equal(
    (await workflowReportViolations(guarded.replace('name: evidence,', 'name: changed,')))[0]?.code,
    'unchecked-upload-selection',
  );
  assert.equal(
    (await workflowReportViolations(guarded.replace('  - run:', '  - if: false\n    run:')))[0]
      ?.code,
    'unchecked-upload-selection',
  );
});

test('official upload selection preserves include-hidden-files rather than silently filtering it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-report-hidden-'));
  try {
    mkdirSync(join(root, 'artifacts/.private/reports'), { recursive: true });
    writeFileSync(join(root, 'artifacts/.private/reports/raw.json'), '{}');
    assert.deepEqual(
      await resolvedUploadViolations({ name: 'evidence', path: 'artifacts/**' }, root),
      [],
    );
    assert.equal(
      (
        await resolvedUploadViolations(
          { name: 'evidence', path: 'artifacts/**', includeHiddenFiles: 'true' },
          root,
        )
      )[0]?.code,
      'reports-upload-file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing runtime selector fails clearly and leaves original failure evidence intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-report-missing-deps-'));
  try {
    const checker = join(root, 'check-no-reports.mjs');
    copyFileSync(new URL('../check-no-reports.mjs', import.meta.url), checker);
    writeFileSync(join(root, 'receipt.json'), '{"originalFailure":true}');
    const result = spawnSync(process.execPath, [checker, '--upload-inputs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGEAX_ARTIFACT_NAME: 'failure-evidence',
        FORGEAX_ARTIFACT_PATH: 'receipt.json',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /declared @actions\/glob dependency is unavailable/u);
    assert.match(result.stderr, /original evidence files remain unchanged/u);
    assert.equal(readFileSync(join(root, 'receipt.json'), 'utf8'), '{"originalFailure":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
