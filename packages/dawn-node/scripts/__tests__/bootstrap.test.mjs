import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pnpmCommand } from '../../../../scripts/lib/pnpm-command.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const { packageManager } = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-dawn-bootstrap-'));
  try {
    for (const directory of ['scripts', 'src', 'patches']) {
      cpSync(join(packageRoot, directory), join(root, directory), { recursive: true });
    }
    // External prebuilt dependencies do not own this package's lifecycle. Keep
    // its real scripts and sources, and isolate the native-tool requirement.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ ...manifest, dependencies: {}, packageManager }),
    );
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const env = { ...process.env, PATH: dirname(process.execPath), CI: 'true' };
    delete env.FORGEAX_DAWN_NATIVE_SOURCE_DIR;
    delete env.FORGEAX_DAWN_NATIVE_BUILD_DIR;
    run(root, env);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

test('ordinary pnpm installation needs no Dawn native compiler or source fetch', () => {
  fixture((root, env) => {
    const command = pnpmCommand();
    const result = spawnSync(
      command[0],
      [...command.slice(1), 'install', '--offline', '--no-frozen-lockfile'],
      { cwd: root, env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(join(root, '.native-build')), false);
    assert.equal(existsSync(join(root, 'dist/native')), false);
  });
});

test('ordinary package build emits JavaScript without compiling Dawn', () => {
  fixture((root, env) => {
    const result = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], {
      cwd: root, env, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      readFileSync(join(root, 'dist/index.mjs'), 'utf8'),
      readFileSync(join(root, 'src/index.mjs'), 'utf8'),
    );
    assert.equal(existsSync(join(root, '.native-build')), false);
    assert.equal(existsSync(join(root, 'dist/native')), false);
  });
});
