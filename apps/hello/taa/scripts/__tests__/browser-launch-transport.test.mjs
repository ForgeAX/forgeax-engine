import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { pnpmCommand } from '../../../../../scripts/lib/pnpm-command.mjs';

test('TAA Vite uses the inherited package manager and preserves its arguments and host inputs', {
  timeout: 10000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-taa-manager-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = join(directory, 'pnpm.mjs');
  writeFileSync(manager, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),debug:process.env.FORGEAX_ENGINE_RHI_DEBUG}));');
  const script = readFileSync(fileURLToPath(new URL('../smoke-browser.mjs', import.meta.url)), 'utf8');
  const start = script.includes('const [pnpm, ...pnpmArgs]')
    ? script.indexOf('const [pnpm, ...pnpmArgs]')
    : script.indexOf('const vite = spawn(');
  const launch = script.slice(start, script.indexOf('\nlet viteClosed', start));
  const env = { ...process.env, npm_execpath: manager, FORGEAX_ENGINE_RHI_DEBUG: '1' };
  const sandbox = {
    spawn,
    pnpmCommand: () => pnpmCommand(env),
    process: { env, platform: process.platform },
    REPO_ROOT: resolve(directory),
    serverPort: '0',
  };
  const child = runInNewContext(`${launch}; vite;`, sandbox);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(output), {
    args: ['--filter', '@forgeax/hello-taa', 'exec', 'vite', '--host', '127.0.0.1', '--port', '0'],
    cwd: resolve(directory),
    debug: '0',
  });
});
