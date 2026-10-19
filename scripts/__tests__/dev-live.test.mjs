import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('dev-live shutdown closes the app descendant and its inherited output', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-dev-live-'));
  const worker = `
    const net = require('node:net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ port: server.address().port, pid: process.pid }));
    });
  `;
  await writeFile(
    join(directory, 'pnpm'),
    `#!${process.execPath}
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `,
    { mode: 0o755 },
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../dev-live.mjs', import.meta.url)), '@forgeax/fixture'],
    {
      env: {
        ...process.env,
        PATH: directory + delimiter + process.env.PATH,
        FORGEAX_ENGINE_BRIDGE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let descendant;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const closed = once(child, 'close');
  try {
    descendant = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/\{"port":\d+,"pid":\d+\}/);
        if (match) {
          clearTimeout(timer);
          resolve(JSON.parse(match[0]));
        }
      });
      child.once('error', reject);
    });
    child.kill('SIGTERM');
    await Promise.race([
      closed.then(([code]) => assert.equal(code, 0, output)),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`descendant still holds output: ${output}`)),
          6000,
        );
        timer.unref();
      }),
    ]);
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(descendant.port, '127.0.0.1', resolve);
      });
    } finally {
      server.close();
    }
  } finally {
    if (descendant) {
      try {
        process.kill(descendant.pid, 'SIGKILL');
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
