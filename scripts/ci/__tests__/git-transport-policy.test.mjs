import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { parse } from 'yaml';
import { runBrowserCommand } from '../run-browser-gate-with-retry.mjs';

const isCheckout = (step) =>
  step.uses?.startsWith('actions/checkout@') ||
  step.uses === './.github/actions/prepare-source-checkouts';

const workflows = readdirSync('.github/workflows')
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, value: parse(readFileSync(`.github/workflows/${name}`, 'utf8')) }));

test('all checkout workflows bound Git HTTP before preparation and retain checkout windows', () => {
  for (const { name, value } of workflows) {
    const jobs = Object.values(value.jobs ?? {}).filter((job) => job.steps?.some(isCheckout));
    if (jobs.length === 0) continue;
    assert.equal(value.env?.GIT_HTTP_LOW_SPEED_LIMIT, '65536', name);
    assert.equal(value.env?.GIT_HTTP_LOW_SPEED_TIME, '60', name);
    for (const job of jobs)
      for (const step of job.steps) {
        if (!isCheckout(step)) continue;
        assert.equal(step['timeout-minutes'], 5, `${name}: ${step.name ?? step.uses}`);
        for (const key of ['GIT_HTTP_LOW_SPEED_LIMIT', 'GIT_HTTP_LOW_SPEED_TIME']) {
          assert.ok(!Object.hasOwn(job.env ?? {}, key), `${name}: job overrides ${key}`);
          assert.ok(!Object.hasOwn(step.env ?? {}, key), `${name}: step overrides ${key}`);
        }
      }
  }
});

test('native Git retires a stalled HTTP connection and accepts a healthy next connection', {
  timeout: 12_000,
}, async () => {
  const policy = workflows.find((row) => row.name === 'ci.yml').value.env ?? {};
  const oid = 'a'.repeat(40);
  const packet = (text) => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
  const advertisement =
    packet('# service=git-upload-pack\n') +
    '0000' +
    packet(`${oid} HEAD\0symref=HEAD:refs/heads/main\n`) +
    packet(`${oid} refs/heads/main\n`) +
    '0000';
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/x-git-upload-pack-advertisement',
      'Content-Length': request.url.startsWith('/stalled')
        ? 10000
        : Buffer.byteLength(advertisement),
    });
    if (request.url.startsWith('/stalled')) {
      response.flushHeaders();
      return;
    }
    response.end(advertisement);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      NO_PROXY: '127.0.0.1',
      GIT_HTTP_LOW_SPEED_LIMIT: policy.GIT_HTTP_LOW_SPEED_LIMIT,
      GIT_HTTP_LOW_SPEED_TIME: '1',
    };
    // Accelerate only the fixture's clock; the workflow contract above locks 60 seconds.
    const address = `http://127.0.0.1:${server.address().port}`;
    const stalled = await runBrowserCommand(['git', 'ls-remote', `${address}/stalled.git`], {
      env,
      timeoutMs: 4000,
      label: 'native Git stalled HTTP fixture',
    });
    assert.equal(stalled.timedOut, false, 'Git must own its transport deadline');
    assert.notEqual(stalled.status, 0);
    assert.match(stalled.output, /too slow|curl 28|Operation timed out/i);
    const recovered = await runBrowserCommand(['git', 'ls-remote', `${address}/healthy.git`], {
      env,
      timeoutMs: 4000,
      label: 'native Git healthy HTTP control',
    });
    assert.equal(recovered.status, 0, recovered.output);
    assert.match(recovered.output, new RegExp(`${oid}\\s+refs/heads/main`));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
