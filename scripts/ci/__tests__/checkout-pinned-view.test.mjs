import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('parent-only checkout leaves stale View manifests that the exact Engine pin repairs', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'forgeax-pinned-view-install-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const root = join(folder, 'engine'),
    source = join(folder, 'view-source');
  const env = { ...process.env, CI: 'true', FORGEAX_SKIP_HARNESS_SYNC: '1' };
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const pnpm = (...args) => spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8' });
  for (const p of [root, source]) {
    mkdirSync(p);
    git(p, 'init', '-q');
    git(p, 'config', 'user.name', 'ROI15 regression');
    git(p, 'config', 'user.email', 'ci@example.invalid');
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'engine-fixture', version: '1.0.0', private: true }),
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - tools/view\n');
  for (const v of ['v1', 'v2']) {
    const p = join(root, 'inputs', v);
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, 'package.json'),
      JSON.stringify({ name: 'fixture-resource', version: '1.0.0' }),
    );
  }
  const manifest = (v) =>
    JSON.stringify({
      name: 'view-fixture',
      version: '1.0.0',
      private: true,
      dependencies: { 'fixture-resource': `link:../../inputs/${v}` },
    });
  writeFileSync(join(source, 'package.json'), manifest('v1'));
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'pinned manifest');
  const pin = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'package.json'), manifest('v2'));
  git(source, 'commit', '-qam', 'newer manifest');
  const stale = git(source, 'rev-parse', 'HEAD');
  mkdirSync(join(root, 'tools'));
  git(root, 'clone', '-q', source, 'tools/view');
  git(join(root, 'tools/view'), 'checkout', '--detach', pin);
  let result = pnpm('install', '--lockfile-only', '--offline', '--ignore-scripts');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Engine pinned manifest and lock');
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'));
  const digest = (b) => createHash('sha256').update(b).digest('hex');
  git(join(root, 'tools/view'), 'checkout', '--detach', stale);
  // The same parent-only checkout used by CI does not move an independently checked-out View.
  git(root, 'checkout', '--detach', git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(join(root, 'tools/view'), 'rev-parse', 'HEAD'), stale);
  result = pnpm('install', '--frozen-lockfile', '--offline', '--ignore-scripts');

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);
  // Existing pinned-View action resolves this gitlink and checks out precisely that source.
  const expected = git(root, 'rev-parse', 'HEAD:tools/view');
  assert.equal(expected, pin);
  git(join(root, 'tools/view'), 'checkout', '--detach', expected);
  result = pnpm('install', '--frozen-lockfile', '--offline', '--ignore-scripts');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(digest(readFileSync(join(root, 'pnpm-lock.yaml'))), digest(lock));
});

test('every full CI workspace install resolves and materializes the Engine View pin first', () => {
  const action = readFileSync(resolve('.github/actions/prepare-view-checkout/action.yml'), 'utf8');
  assert.match(action, /git rev-parse HEAD:tools\/view/);
  assert.match(action, /repository: ForgeaX-Games\/forgeax-view/);
  assert.match(action, /ref: \$\{\{ steps\.view-pin\.outputs\.sha \}\}/);
  assert.match(action, /git -C tools\/view rev-parse HEAD/);
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const sections = workflow.slice(workflow.indexOf('jobs:\n')).split(/\n(?= {2}[\w-]+:\n)/);
  let installs = 0;
  for (const section of sections) {
    for (const match of section.matchAll(
      /pnpm install --frozen-lockfile|node scripts\/ci\/prepare-pnpm-workspace\.mjs --install/g,
    )) {
      const before = section.slice(0, match.index);
      assert.ok(
        before.includes('uses: ./.github/actions/prepare-view-checkout') ||
          (before.includes('repository: ForgeaX-Games/forgeax-view') &&
            /ref: \$\{\{ steps\.view-pin\.outputs\.sha \}\}/.test(before)),
        `${section.trim().split('\n')[0]} must materialize its exact View gitlink before frozen install`,
      );
      installs++;
    }
  }
  assert.ok(installs > 0, 'full maintained workspace install roster must be inspected');
});
