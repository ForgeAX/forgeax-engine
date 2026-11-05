import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { artifactUploadPaths } from '../artifact-upload-paths.mjs';
import { resolvedUploadViolations } from '../check-no-reports.mjs';

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
