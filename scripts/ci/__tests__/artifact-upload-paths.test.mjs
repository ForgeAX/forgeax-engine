import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { artifactUploadPaths } from '../artifact-upload-paths.mjs';
import { resolvedUploadViolations } from '../check-no-reports.mjs';

test('View failures upload Modeling pictures and journey without the generated project', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const upload = workflow.jobs['view-integration-shards'].steps.find((step) =>
    step.with?.name?.startsWith('failure-view-integration-evidence-'),
  );
  assert.ok(upload, 'the maintained View failure upload must exist');
  const root = mkdtempSync(join(tmpdir(), 'forgeax-modeling-evidence-'));
  try {
    const files = ['failure.png', 'journey.json', 'failure.html', 'project/package.json'];
    for (const file of files) {
      const target = join(root, 'artifacts/modeling-view', file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'evidence');
    }
    const { create } = await import('@actions/glob');
    const selected = await (
      await create(
        upload.with.path
          .split('\n')
          .filter(Boolean)
          .map((path) => join(root, path))
          .join('\n'),
      )
    ).glob();
    for (const file of files.slice(0, 3))
      assert.ok(selected.includes(join(root, 'artifacts/modeling-view', file)), file);
    assert.ok(!selected.includes(join(root, 'artifacts/modeling-view/project/package.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary uploads preserve their original path without requiring a Git checkout', () => {
  const path = 'artifacts/native/\nartifacts/reports/raw.json\n';
  assert.equal(artifactUploadPaths({ path }), path);
  assert.equal(artifactUploadPaths({ path, includeBrowserScreenshots: 'false' }), path);
});

test('tracked source owners produce literal screenshot roots including glob characters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-screenshot-roots-'));
  try {
    const tracked = [
      'packages/probe [native]/src/__tests__/first.browser.test.ts',
      'packages/probe [native]/src/__tests__/second.browser-no-webgpu.test.ts',
      'apps/hello/probe/src/__tests__/probe.browser.test.ts',
      'packages/runtime/node_modules/dependency/index.js',
    ];
    const pictures = [
      ...new Set(
        tracked
          .filter((file) => file.endsWith('.test.ts'))
          .map((file) => `${dirname(file)}/__screenshots__/failure.png`),
      ),
    ];
    const excluded = 'packages/runtime/node_modules/dependency/reports/__screenshots__/failure.png';
    for (const file of [...pictures, excluded, 'artifacts/native/reports/raw.json']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'evidence');
    }
    const path = artifactUploadPaths(
      { path: 'artifacts/native/', includeBrowserScreenshots: true },
      tracked,
    );
    const { create } = await import('@actions/glob');
    const selected = await (
      await create(
        path
          .split('\n')
          .map((pattern) => join(root, pattern))
          .join('\n'),
      )
    ).glob();
    for (const file of pictures) assert.ok(selected.includes(join(root, file)), file);
    assert.ok(!selected.includes(join(root, excluded)));
    assert.equal(path.split('\n').length, 3, 'one root per source directory');
    assert.equal(
      (await resolvedUploadViolations({ name: 'evidence', path }, root))[0]?.code,
      'reports-upload-file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI emits one multiline path value for both the report guard and upload', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax upload % '));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const source = 'apps/hello/probe/src/__tests__/probe.browser.test.ts';
    mkdirSync(join(root, source, '..'), { recursive: true });
    writeFileSync(join(root, source), '');
    execFileSync('git', ['add', '--', source], { cwd: root });
    const output = join(root, 'outputs');
    const result = spawnSync(process.execPath, [resolve('scripts/ci/artifact-upload-paths.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        FORGEAX_ARTIFACT_PATH: 'artifacts/native/',
        FORGEAX_INCLUDE_BROWSER_SCREENSHOTS: 'true',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(output, 'utf8').trimEnd().split('\n');
    assert.ok(lines[0].startsWith('paths<<'));
    assert.equal(lines.at(-1), lines[0].slice('paths<<'.length));
    assert.deepEqual(lines.slice(1, -1), [
      'artifacts/native/',
      'apps/hello/probe/src/**/__screenshots__/**/*.png',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('optional artifact guards provision pinned Node even in aggregate jobs', async () => {
  const { parse } = await import('yaml');
  const action = parse(
    readFileSync(
      new URL('../../../.github/actions/upload-optional-artifact/action.yml', import.meta.url),
      'utf8',
    ),
  );
  const steps = action.runs.steps;
  const setup = steps.findIndex((step) => step.uses === 'actions/setup-node@v5');
  const guard = steps.findIndex((step) => step.name === 'Resolve owned artifact paths');
  assert.ok(setup >= 0 && setup < guard);
  assert.equal(steps[setup].with['node-version-file'], '.nvmrc');
  assert.equal(steps[setup].with['package-manager-cache'], false);
});

test('required artifact transport has three same-name attempts with bounded staggered recovery', async () => {
  const { parse } = await import('yaml');
  const action = parse(
    readFileSync('.github/actions/upload-artifact-with-retry/action.yml', 'utf8'),
  );
  const uploads = action.runs.steps.filter((step) => step.uses === 'actions/upload-artifact@v6');
  assert.deepEqual(
    uploads.map((step) => step.id),
    ['upload', 'retry_1', 'retry_2'],
  );
  for (const [index, step] of uploads.entries()) {
    assert.equal(step.with.name, uploads[0].with.name);
    assert.equal(step.with.path, uploads[0].with.path);
    assert.equal(step.with['include-hidden-files'], uploads[0].with['include-hidden-files']);
    assert.equal(step.with['compression-level'], uploads[0].with['compression-level']);
    assert.equal(step.env.ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS, '60000');
    if (index > 0) assert.equal(step.with.overwrite, true);
  }
  assert.equal(uploads[2].if, "inputs.required == 'true' && steps.retry_1.outcome == 'failure'");
  const waits = action.runs.steps.filter((step) => step.name?.startsWith('Back off before retry'));
  assert.deepEqual(
    waits.map((step) => step.run.trim()),
    ['sleep $((15 + RANDOM % 6))', 'sleep $((30 + RANDOM % 11))'],
  );
  assert.ok(action.outputs['artifact-id'].value.includes('steps.retry_2.outputs.artifact-id'));
  const failed = action.runs.steps.find(
    (step) => step.name === 'Fail after exhausted artifact transfer',
  );
  for (const step of uploads)
    assert.ok(failed.if.includes(`steps.${step.id}.outcome != 'success'`));
});

test('artifact observation records the actual recovered attempt, including two RPC resets', {
  skip: process.platform !== 'linux',
}, async () => {
  const { parse } = await import('yaml');
  const action = parse(
    readFileSync('.github/actions/upload-artifact-with-retry/action.yml', 'utf8'),
  );
  const finish = action.runs.steps.find((step) => step.id === 'upload-observation');
  assert.ok(finish.if.includes("steps.retry_2.outcome == 'success'"));
  const root = mkdtempSync(join(tmpdir(), 'forgeax-upload-observation-'));
  try {
    for (const attempt of [1, 2, 3]) {
      const output = join(root, `attempt-${attempt}`);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', finish.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          STARTED_AT: new Date(Date.now() - 1000).toISOString(),
          STARTED_MILLIS: String(Date.now() - 1000),
          UPLOAD_OUTCOME: attempt === 1 ? 'success' : 'failure',
          RETRY_1_OUTCOME: attempt === 2 ? 'success' : 'failure',
          RETRY_2_OUTCOME: attempt === 3 ? 'success' : 'skipped',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const facts = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      );
      assert.equal(facts.transfer_attempt, String(attempt));
      assert.ok(Number(facts.elapsed_seconds) >= 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
