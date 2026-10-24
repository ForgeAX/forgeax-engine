import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyProjectIdentityReconcile } from '../sdk-project-identity.mjs';

test('consumer identity verification uses project policy inside a pnpm parent', {
  skip: process.platform === 'win32' ? 'project consumer lane runs on Linux' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-project-identity-'));
  try {
    await mkdir(join(root, 'cli'));
    await writeFile(
      join(root, 'cli/package.json'),
      JSON.stringify({
        name: 'identity-cli',
        version: '1.0.0',
        bin: { forgeax: 'cli.mjs' },
      }),
    );
    await writeFile(
      join(root, 'cli/cli.mjs'),
      '#!/usr/bin/env node\nconsole.log("{\\"ok\\":true}");\n',
      { mode: 0o755 },
    );
    const manifest = JSON.stringify({
      name: 'identity-fixture',
      version: '0.0.0',
      dependencies: { 'identity-cli': 'file:./cli' },
    });
    await writeFile(join(root, 'package.json'), manifest);
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      'trustLockfile: true\nverifyDepsBeforeRun: install\nfrozenLockfile: true\nenableGlobalVirtualStore: false\n',
    );
    execFileSync('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts', '--offline'], {
      cwd: root,
      stdio: 'pipe',
    });
    await verifyProjectIdentityReconcile(root, {
      ...process.env,
      npm_config_offline: 'true',
      pnpm_config_verify_deps_before_run: 'false',
    });
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
