import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (
  process.platform === 'win32' &&
  (!root.includes(' ') || !root.includes('%') || !/[\u3400-\u9fff]/u.test(root))
) {
  throw new Error('run from an Engine worktree path containing Chinese, spaces, and %');
}

const [outputArgument] = process.argv.slice(2);
if (outputArgument === undefined) {
  throw new Error(
    'usage: node scripts/forgeax/sdk-process-launch.regression.mjs <output-directory>',
  );
}
const outputRoot = resolve(root, outputArgument);
const outputRelative = relative(root, outputRoot);
assert.ok(
  outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative),
  'SDK regression output must be outside the Engine worktree',
);
await assert.rejects(
  access(outputRoot),
  { code: 'ENOENT' },
  'choose a new SDK regression output directory',
);

const child = spawn(
  process.execPath,
  [resolve(root, 'scripts/forgeax/build-sdk.mjs'), '--output', outputRoot],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
const result = await new Promise((accept, reject) => {
  let stdoutTail = '';
  let stderrTail = '';
  const appendTail = (tail, chunk) => `${tail}${chunk}`.slice(-1024 * 1024);
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    process.stdout.write(chunk);
    stdoutTail = appendTail(stdoutTail, chunk);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    process.stderr.write(chunk);
    stderrTail = appendTail(stderrTail, chunk);
  });
  child.once('error', reject);
  child.once('close', (code, signal) => accept({ code, signal, stdoutTail, stderrTail }));
});
assert.equal(result.signal, null, 'SDK builder should exit without a signal');
const licenseStage = `[sdk] complete corepack ${packageJson.packageManager} licenses list --json --no-optional`;
assert.ok(
  result.stderrTail.includes(licenseStage),
  'the real Corepack license command must complete',
);

const pnpmBuildCompleted = result.stderrTail.includes('[sdk] complete pnpm build:engine');
const pnpmBuildFailedAfterLaunch =
  /\[sdk\] failed pnpm build:engine[^\r\n]*code=(?!ENOENT\b)[^\s]+/u.test(result.stderrTail) &&
  `${result.stdoutTail}${result.stderrTail}`.includes('[build-packages]');
assert.ok(
  pnpmBuildCompleted || pnpmBuildFailedAfterLaunch,
  'the real pnpm build caller must launch through the SDK process seam',
);

if (result.code === 0) {
  const files = await readdir(outputRoot);
  assert.ok(
    files.some((file) => /^forgeax-sdk-v.+\.zip$/u.test(file)),
    'SDK build must produce a real ZIP',
  );
  console.log(
    `sdk-process-launch-regression-ok: real SDK ZIP written to ${outputRoot}; sdk:verify remains separate`,
  );
} else {
  // Keep a later SDK gate visible without calling the process-boundary check an SDK pass.
  console.log(
    `sdk-process-launch-regression-ok: Corepack license and pnpm process boundaries passed; sdk:build later exited ${result.code}; inspect the retained build log for its owner`,
  );
}
