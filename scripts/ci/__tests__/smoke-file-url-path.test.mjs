import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const source = (path) => readFileSync(resolve(root, path), 'utf8');
function evaluateFilePath(expression, modulePath) {
  return runInNewContext(expression.replaceAll('import.meta.url', 'moduleUrl'), {
    URL,
    fileURLToPath,
    resolve,
    moduleUrl: pathToFileURL(resolve(root, modulePath)).href,
  });
}

test('fog smoke reads its real app publication through a platform filesystem path', () => {
  const path = 'apps/hello/volumetric-fog/scripts/smoke-dawn.mjs';
  const expression = source(path).match(/useBuiltAssetSource\(assets, (.+)\);/)[1];
  assert.equal(evaluateFilePath(expression, path), resolve(root, 'apps/hello/volumetric-fog/dist'));
});

test('M7 lifecycle carrier selects the actual repository on the current platform', () => {
  const path = 'apps/hello/m7-backend-recovery/scripts/smoke.mjs';
  const expression = source(path).match(/const root = (.+);/)[1];
  assert.equal(resolve(evaluateFilePath(expression, path)), resolve(root));
});

test('authorized M7 wrapper preserves child cwd and the child exit verdict', {
  timeout: 10000,
}, () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax m7 url-'));
  try {
    const probe = resolve(directory, 'cwd-probe.mjs');
    writeFileSync(
      probe,
      'console.log(JSON.stringify({cwd:process.cwd()})); process.exitCode=Number(process.argv[2]);',
    );
    for (const exit of [0, 7]) {
      const artifact = resolve(directory, `artifacts-${exit}`);
      const result = spawnSync(
        process.execPath,
        [
          resolve(root, 'scripts/ci/run-authorized-m7-smoke.mjs'),
          '--',
          process.execPath,
          probe,
          String(exit),
        ],
        {
          cwd: directory,
          env: { ...process.env, FORGEAX_M7_ARTIFACT_DIR: artifact },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 8000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, exit, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).cwd, resolve(root));
      assert.ok(existsSync(resolve(artifact, 'm7-decision.json')));
      const decision = JSON.parse(readFileSync(resolve(artifact, 'm7-decision.json'), 'utf8'));
      assert.equal(decision.status, exit === 0 ? 'pass' : 'failed');
      assert.equal(decision.notPassed, exit !== 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('M7 lifecycle uses its inherited pnpm entry with the original argument closure', {
  timeout: 10000,
}, () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax m7 pnpm-'));
  try {
    const manager = resolve(directory, 'pnpm.mjs');
    writeFileSync(
      manager,
      'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));',
    );
    const text = source('apps/hello/m7-backend-recovery/scripts/smoke.mjs');
    const run = text.slice(text.indexOf('function run('), text.indexOf('\ntry {'));
    let stdout = '';
    const sandbox = {
      spawnSync,
      pnpmCommand,
      root: resolve(root),
      env: { ...process.env, npm_execpath: manager },
      console: { log() {} },
      process: {
        stdout: {
          write(chunk) {
            stdout += chunk;
          },
        },
        stderr: { write() {} },
      },
    };
    runInNewContext(
      `${run}; run('entry probe', ['--filter', '@forgeax/engine-runtime', 'exec', 'vitest']);`,
      sandbox,
    );
    assert.deepEqual(JSON.parse(stdout), {
      cwd: resolve(root),
      args: ['--filter', '@forgeax/engine-runtime', 'exec', 'vitest'],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
