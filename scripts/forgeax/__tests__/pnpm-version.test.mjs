import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPnpmVersion } from '../pnpm-version.mjs';

const projectRoot = resolve(fileURLToPath(new URL('../../../package.json', import.meta.url)), '..');
const packageManager = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
).packageManager;

test('uses a literal Windows Corepack invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'pnpm version \u7279\u6b8a & 50% '));
  try {
    const nodeDirectory = join(root, 'node directory \u7a7a\u683c & 50%');
    const corepackRoot = join(nodeDirectory, 'node_modules', 'corepack');
    const corepackEntrypoint = join(corepackRoot, 'dist', 'corepack.js');
    const execPath = join(nodeDirectory, 'node executable.exe');
    const cwd = join(root, 'project cwd \u7279\u6b8a \u7a7a\u683c 50%');
    const env = { PATH: '' };
    mkdirSync(dirname(corepackEntrypoint), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(corepackRoot, 'package.json'),
      JSON.stringify({ name: 'corepack', bin: { corepack: 'dist/corepack.js' } }),
    );
    writeFileSync(corepackEntrypoint, '');

    let invocation;
    const version = readPnpmVersion(packageManager, {
      platform: 'win32',
      execPath,
      env,
      cwd,
      execFileSyncImpl(command, args, options) {
        invocation = { command, args, options };
        return '11.7.0\n';
      },
    });

    assert.equal(version, '11.7.0');
    assert.deepEqual(invocation, {
      command: execPath,
      args: [corepackEntrypoint, packageManager, '--version'],
      options: { cwd, encoding: 'utf8', shell: false, env },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps POSIX pnpm selection and returns null for process failures', () => {
  const cwd = resolve(tmpdir(), 'pnpm version cwd');
  const env = { PATH: 'fixture path' };
  let invocation;
  assert.equal(
    readPnpmVersion(packageManager, {
      platform: 'linux',
      cwd,
      env,
      execFileSyncImpl(command, args, options) {
        invocation = { command, args, options };
        return '11.7.0\n';
      },
    }),
    '11.7.0',
  );
  assert.deepEqual(invocation, {
    command: 'pnpm',
    args: ['--version'],
    options: { cwd, encoding: 'utf8', shell: false, env },
  });

  for (const error of [
    Object.assign(new Error('process launch failed'), { code: 'ENOENT' }),
    Object.assign(new Error('process exited unsuccessfully'), { status: 1 }),
  ]) {
    assert.equal(
      readPnpmVersion(packageManager, {
        platform: 'linux',
        execFileSyncImpl() {
          throw error;
        },
      }),
      null,
    );
  }
});

test('reads the pinned pnpm version through a private Windows Corepack shim directory', {
  timeout: 120_000,
}, (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows Corepack integration is Windows-only');
    return;
  }

  const corepackRoot = join(dirname(process.execPath), 'node_modules', 'corepack');
  const corepackManifest = JSON.parse(readFileSync(join(corepackRoot, 'package.json'), 'utf8'));
  const corepackBin =
    typeof corepackManifest.bin === 'string' ? corepackManifest.bin : corepackManifest.bin.corepack;
  const corepackEntrypoint = resolve(corepackRoot, corepackBin);
  assert.equal(corepackManifest.name, 'corepack');
  assert.equal(existsSync(corepackEntrypoint), true);

  const root = mkdtempSync(join(tmpdir(), 'pnpm Corepack integration \u7279\u6b8a & 50% '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDirectory = join(root, 'private shim directory \u7a7a\u683c & 50%');
  const corepackHome = join(root, 'private Corepack home \u7a7a\u683c 50%');
  const cwd = join(root, 'project directory \u7279\u6b8a \u7a7a\u683c 50%');
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'pnpm-version-fixture', packageManager }),
  );
  const env = {
    ...process.env,
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    PATH: [binDirectory, dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  };

  execFileSync(
    process.execPath,
    [corepackEntrypoint, 'enable', '--install-directory', binDirectory],
    { cwd, env, encoding: 'utf8', shell: false },
  );
  assert.equal(existsSync(join(binDirectory, 'pnpm.cmd')), true);

  let legacyVersion = null;
  let legacyErrorCode = null;
  try {
    legacyVersion = execFileSync('pnpm', ['--version'], {
      cwd,
      env,
      encoding: 'utf8',
      shell: false,
    }).trim();
  } catch (error) {
    legacyErrorCode = error.code;
  }
  assert.equal(legacyVersion, null);
  assert.ok(legacyErrorCode);

  const actualVersion = readPnpmVersion(packageManager, { cwd, env });
  const pinMatch = /^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(packageManager);
  assert.ok(pinMatch, 'The root packageManager must pin an exact pnpm semver version');
  assert.equal(actualVersion, pinMatch[1]);
  t.diagnostic(`legacy execFileSync error code: ${legacyErrorCode}`);
  t.diagnostic(`pinned Corepack version: ${actualVersion}`);

  const missingNode = join(root, 'missing node.exe');
  assert.equal(
    readPnpmVersion(packageManager, {
      cwd,
      env,
      platform: 'win32',
      execPath: missingNode,
    }),
    null,
  );
});
