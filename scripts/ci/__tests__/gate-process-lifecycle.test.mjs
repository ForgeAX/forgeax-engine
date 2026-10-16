import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  isRetryableOutput,
  runBrowserCommand as runCommand,
} from '../run-browser-gate-with-retry.mjs';

// Expected fixture failures must not annotate the enclosing CI job.
const runBrowserCommand = (command, options = {}) =>
  runCommand(command, {
    env: { ...process.env, GITHUB_ACTIONS: 'false' },
    ...options,
  });

const descendantScript = `
  process.on('SIGTERM', () => {});
  process.send(process.pid);
  setInterval(() => {}, 1000);
`;

function fixture({ exitLeader = true } = {}) {
  return `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.once('message', pid => {
      console.log('leader=' + process.pid + ' descendant=' + pid);
      ${exitLeader ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}
    });
  `;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertGone(pid) {
  for (let n = 0; n < 50 && alive(pid); n++) await sleep(20);
  assert.equal(alive(pid), false, `owned descendant ${pid} survived the gate`);
}

function cleanup(pid) {
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
}

test('normal leader exit reclaims a TERM-resistant descendant before returning', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  const result = await runBrowserCommand([process.execPath, '-e', fixture()], {
    timeoutMs: 2000,
    timeoutGraceMs: 100,
  });
  const pid = Number(result.output.match(/descendant=(\d+)/)?.[1]);
  try {
    assert.ok(pid > 1);
    await assertGone(pid);
    assert.equal(result.status, 0);
  } finally {
    cleanup(pid);
  }
});

test('timeout escalates even after the leader exits and closes its pipes', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  const result = await runBrowserCommand([process.execPath, '-e', fixture({ exitLeader: false })], {
    timeoutMs: 1500,
    timeoutGraceMs: 100,
  });
  const pid = Number(result.output.match(/descendant=(\d+)/)?.[1]);
  try {
    assert.ok(pid > 1);
    await assertGone(pid);
    assert.equal(result.status, 124);
    assert.equal(result.timedOut, true);
  } finally {
    cleanup(pid);
  }
});

test('shell smoke command has the same bounded group cleanup', {
  skip: process.platform === 'win32',
  timeout: 6000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-gate-process-'));
  const script = join(directory, 'smoke.cjs');
  writeFileSync(script, fixture({ exitLeader: false }));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  let pid;
  try {
    const result = await runBrowserCommand(`${quote(process.execPath)} ${quote(script)}`, {
      timeoutMs: 1500,
      timeoutGraceMs: 100,
      label: 'smoke-shell-contract',
    });
    pid = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    assert.ok(pid > 1);
    await assertGone(pid);
    assert.equal(result.status, 124);
    assert.equal(result.cleanup.kind, 'sigkill');
  } finally {
    cleanup(pid);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('exit evidence preserves final output, failure status, and process signals', async () => {
  const result = await runBrowserCommand([
    process.execPath,
    '-e',
    `
    process.stdout.write('final-receipt\\n');
    process.stderr.write('assertion failed\\n');
    process.exitCode = 7;
  `,
  ]);
  assert.equal(result.status, 7);
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.match(result.output, /final-receipt/);
  assert.match(result.output, /assertion failed/);
  assert.match(result.output, /process-result/);
  const missing = await runBrowserCommand(['/forgeax-no-such-executable']);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /failed to start/);
  assert.match(missing.failure, /start failed: ENOENT/);
  assert.match(missing.failure, /No child stdout\/stderr was captured/);
  if (process.platform !== 'win32') {
    const crash = await runBrowserCommand([
      process.execPath,
      '-e',
      "process.kill(process.pid, 'SIGKILL')",
    ]);
    assert.equal(crash.status, 1);
    assert.equal(crash.signal, 'SIGKILL');
    assert.match(crash.failure, /terminated by SIGKILL; signal alone does not establish the cause/);
  }
});

test('cancelling the supervisor reclaims its private process group', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  const moduleUrl = new URL('../run-browser-gate-with-retry.mjs', import.meta.url).href;
  const supervisor = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runBrowserCommand } from ${JSON.stringify(moduleUrl)};
    const result = await runBrowserCommand([process.execPath, '-e', ${JSON.stringify(fixture({ exitLeader: false }))}], { timeoutGraceMs: 100, env: { ...process.env, GITHUB_ACTIONS: 'false' } });
    process.exitCode = result.status;
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  supervisor.stdout.on('data', (chunk) => {
    output += chunk;
  });
  let stderr = '';
  supervisor.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(supervisor, 'close');
  let pid;
  try {
    for (let n = 0; n < 100 && !output.includes('descendant='); n++) await sleep(20);
    pid = Number(output.match(/descendant=(\d+)/)?.[1]);
    assert.ok(
      pid > 1,
      `supervisor did not report descendant readiness; stdout=${output}; stderr=${stderr}`,
    );
    supervisor.kill('SIGTERM');
    const [status, signal] = await closed;
    await assertGone(pid);
    assert.equal(status, 143);
    assert.equal(signal, null);
  } finally {
    supervisor.kill('SIGKILL');
    cleanup(pid);
    const leader = Number(output.match(/leader=(\d+)/)?.[1]);
    if (leader > 1) {
      try {
        process.kill(-leader, 'SIGKILL');
      } catch {}
    }
  }
});

test('failed commands publish bounded actionable evidence without changing retry admission', async (context) => {
  const diagnostics = [];
  context.mock.method(process.stderr, 'write', (text) => {
    diagnostics.push(String(text));
    return true;
  });
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-ci-failure-'));
  const summary = join(directory, 'summary.md');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_STEP_SUMMARY: summary,
    PRIVATE_FIXTURE_VALUE: 'environment-must-not-be-dumped',
  };
  try {
    const passed = await runBrowserCommand([process.execPath, '-e', 'process.exit(0)'], { env });
    assert.equal(passed.failure, null);
    assert.equal(existsSync(summary), false);
    const failed = await runBrowserCommand(
      [
        process.execPath,
        '-e',
        `
      const unused = 'Browser connection was closed';
      process.stdout.write('x'.repeat(12000));
      process.stderr.write('\\nshader profile missing: point-ssao\\n');
      process.exitCode = 7;
    `,
      ],
      { env, label: 'shader preparation fixture' },
    );
    assert.equal(failed.status, 7);
    assert.match(failed.failure, /label=shader preparation fixture/);
    assert.match(failed.failure, /child exited with code 7/);
    assert.match(failed.failure, /lastOutputAgeMs=\d+/);
    assert.match(failed.failure, /shader profile missing: point-ssao/);
    assert.ok(failed.failure.length < 9000);
    // Command literals are metadata, not observed retry signatures.
    assert.equal(isRetryableOutput('vitest', failed.output), false);
    const markdown = readFileSync(summary, 'utf8');
    assert.match(markdown, /CI child attempt failed/);
    assert.match(markdown, /command=\[/);
    assert.match(markdown, /cwd=/);
    assert.match(markdown, /shader profile missing: point-ssao/);
    assert.doesNotMatch(markdown, /environment-must-not-be-dumped/);
    assert.ok(markdown.length < 10000);
    const warning = diagnostics.find((line) =>
      line.startsWith('::warning title=CI child attempt failed::'),
    );
    assert.match(warning, /child exited with code 7%0A/);
    assert.equal(warning.split('\n').length, 2);

    const unwritable = await runBrowserCommand([process.execPath, '-e', 'process.exit(3)'], {
      env: { ...env, GITHUB_STEP_SUMMARY: directory },
    });
    assert.equal(unwritable.status, 3);
    assert.match(unwritable.output, /could not write failure summary/);
    assert.match(unwritable.failure, /No child stdout\/stderr was captured/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
