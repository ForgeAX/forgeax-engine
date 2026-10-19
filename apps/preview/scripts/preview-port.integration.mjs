import { once } from 'node:events';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const appRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const active = new Set();

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function start(port, strictPort) {
  const output = { value: '' };
  const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
  const dnsOption = '--dns-result-order=ipv4first';
  const args = ['preview'];
  if (port !== undefined) {
    args.push('--port', `${port}`, strictPort ? '--strictPort' : '--no-strictPort');
  }
  const child = spawn(
    'pnpm',
    args,
    {
      cwd: appRoot,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        NODE_OPTIONS:
          inheritedNodeOptions === undefined || inheritedNodeOptions.length === 0
            ? dnsOption
            : `${inheritedNodeOptions} ${dnsOption}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.value += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.value += chunk;
  });
  const running = { child, output };
  active.add(running);
  return running;
}

function outputPort(output) {
  const matches = [...output.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)\//g)];
  const value = matches.at(-1)?.[1];
  return value === undefined ? undefined : Number(value);
}

async function canConnect(port) {
  return new Promise((resolveConnect) => {
    const socket = new Socket();
    const finish = (connected) => {
      socket.destroy();
      resolveConnect(connected);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1', () => finish(true));
  });
}

async function processRows() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command=']);
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), argv: match[3] }));
}

async function listenerPids(port) {
  const executable = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  const { stdout } = await execFileAsync(executable, [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-Fp',
  ]);
  const values = stdout
    .split('\n')
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number(line.slice(1)));
  if (values.length === 0) throw new Error(`listener PID unavailable for port ${port}`);
  return values;
}

async function processCwd(pid) {
  if (process.platform === 'linux') return realpath(`/proc/${pid}/cwd`);
  const { stdout } = await execFileAsync('/usr/sbin/lsof', [
    '-a',
    '-p',
    `${pid}`,
    '-d',
    'cwd',
    '-Fn',
  ]);
  const value = stdout
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  if (value === undefined) throw new Error(`cwd unavailable for pid ${pid}`);
  return realpath(value);
}

function isDescendant(rows, pid, ancestor) {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  for (let current = pid; current > 1; current = parents.get(current) ?? 0) {
    if (current === ancestor) return true;
  }
  return false;
}

async function waitForReady(running, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const port = outputPort(running.output.value);
    if (port !== undefined && (await canConnect(port))) {
      const rows = await processRows();
      assert.ok(running.child.pid, 'package script must have a PID');
      const pid = (await listenerPids(port)).find((candidate) =>
        isDescendant(rows, candidate, running.child.pid),
      );
      assert.ok(pid, `listener on ${port} must descend from package script`);
      const row = rows.find((candidate) => candidate.pid === pid);
      assert.ok(row, `listener process ${pid} must exist`);
      return {
        port,
        url: `http://127.0.0.1:${port}/`,
        pid,
        ppid: row.ppid,
        argv: row.argv,
        cwd: await processCwd(pid),
      };
    }
    if (running.child.exitCode !== null) {
      throw new Error(`preview exited ${running.child.exitCode}: ${running.output.value}`);
    }
    await delay(50);
  }
  throw new Error(`preview listener timed out: ${running.output.value}`);
}

async function waitForExit(running, timeoutMilliseconds = 10_000) {
  if (running.child.exitCode !== null) return running.child.exitCode;
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(undefined), timeoutMilliseconds);
    running.child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function stop(running, port) {
  if (running.child.exitCode === null) {
    if (process.platform === 'win32') running.child.kill('SIGTERM');
    else process.kill(-running.child.pid, 'SIGTERM');
    if ((await waitForExit(running, 3_000)) === undefined) {
      if (process.platform === 'win32') running.child.kill('SIGKILL');
      else process.kill(-running.child.pid, 'SIGKILL');
      await waitForExit(running, 3_000);
    }
  }
  active.delete(running);
  for (let attempt = 0; attempt < 20 && (await canConnect(port)); attempt++) await delay(25);
  assert.equal(await canConnect(port), false, `listener ${port} must be released`);
}

async function checkFixtureMarker(listener) {
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${listener.url}?fixture=gltf-transform`, {
      waitUntil: 'domcontentloaded',
    });
    assert.ok(response?.ok(), 'fixture marker page must load');
    assert.equal(await page.locator('body').getAttribute('data-preview-fixture'), 'gltf-transform');
  } finally {
    await page.close();
  }
}

async function availablePort() {
  const server = createServer();
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  assert.ok(port > 0 && port !== 5173);
  return port;
}

const evidence = [];
const browser = await chromium.launch({ headless: true, chromiumSandbox: true});
try {
  const defaultRunning = start();
  const defaultListener = await waitForReady(defaultRunning);
  assert.equal(defaultListener.port, 5173);
  assert.equal(defaultListener.cwd, appRoot);
  assert.match(defaultListener.argv, /vite(?:\.js)? preview/);
  await checkFixtureMarker(defaultListener);
  const defaultCollision = start();
  const defaultCollisionExit = await waitForExit(defaultCollision);
  assert.notEqual(defaultCollisionExit, undefined, `default collision process must exit: ${defaultCollision.output.value}`);
  assert.notEqual(defaultCollisionExit, 0);
  active.delete(defaultCollision);
  evidence.push({
    policy: { name: 'package-default', port: 5173, strictPort: true },
    listener: defaultListener,
    collisionExit: defaultCollisionExit,
    fixtureMarker: 'gltf-transform',
  });
  await stop(defaultRunning, defaultListener.port);

  for (const policy of [
    { name: 'explicit-positive', port: await availablePort(), strictPort: true },
    { name: 'explicit-zero', port: 0, strictPort: false },
  ]) {
    const running = start(policy.port, policy.strictPort);
    const listener = await waitForReady(running);
    assert.equal(listener.cwd, appRoot);
    assert.match(listener.argv, /vite(?:\.js)? preview .*--port/);
    if (policy.port === 0) assert.notEqual(listener.port, 5173);
    else assert.equal(listener.port, policy.port);
    const response = await browser.newPage().then(async (page) => {
      try {
        return await page.goto(listener.url, { waitUntil: 'domcontentloaded' });
      } finally {
        await page.close();
      }
    });
    assert.ok(response?.ok(), `browser must receive the standalone preview page at ${listener.url}`);
    evidence.push({ policy, listener, browserStatus: response.status() });
    await stop(running, listener.port);
  }

  const port = await availablePort();
  const first = start(port, true);
  const firstListener = await waitForReady(first);
  const second = start(port, true);
  const secondExit = await waitForExit(second);
  assert.notEqual(secondExit, undefined, `collision process must exit: ${second.output.value}`);
  assert.notEqual(secondExit, 0);
  active.delete(second);
  await stop(first, firstListener.port);
  const released = start(port, true);
  const releasedListener = await waitForReady(released);
  assert.equal(releasedListener.port, port);
  evidence.push({
    policy: { name: 'strict-collision-release', port, strictPort: true },
    listener: firstListener,
    collisionExit: secondExit,
    reboundListener: releasedListener,
  });
  await stop(released, releasedListener.port);
} finally {
  await Promise.all(
    [...active].map(async (running) => {
      const port = outputPort(running.output.value);
      if (port !== undefined) await stop(running, port);
    }),
  );
  await browser.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, appRoot, evidence }, null, 2)}\n`);
