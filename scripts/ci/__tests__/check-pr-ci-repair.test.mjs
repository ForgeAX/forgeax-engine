import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkPrCiRepair, publishRepairStatus } from '../check-pr-ci-repair.mjs';

const repository = 'ForgeAX/forgeax-engine';
const prior = {
  id: 11,
  run_number: 101,
  event: 'pull_request',
  status: 'completed',
  path: '.github/workflows/ci.yml',
  head_sha: 'a'.repeat(40),
  head_branch: 'fix/ci',
  head_repository: { full_name: repository },
  pull_requests: [{ number: 42 }],
  created_at: '2026-11-16T01:00:00Z',
};
const current = { ...prior, id: 12, run_number: 102, head_sha: 'b'.repeat(40) };
function fixture(body = 'CI-Repair-From: 11', history = [current, prior]) {
  const input = {
    eventName: 'pull_request',
    repository,
    currentRunId: 12,
    pr: {
      number: 42,
      body,
      created_at: '2026-11-16T00:00:00Z',
      head: { sha: current.head_sha, ref: 'fix/ci', repo: { full_name: repository } },
    },
  };
  const calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.endsWith('/actions/runs/12')) return current;
    if (endpoint.includes('/actions/workflows/ci.yml/runs?'))
      return { workflow_runs: history, total_count: history.length };
    if (endpoint.endsWith('/actions/runs/11')) return prior;
    if (endpoint.endsWith('/actions/runs/9')) return { ...prior, id: 9, run_number: 99 };
    if (endpoint.includes('/compare/')) return { status: 'ahead' };
    throw new Error(`unexpected fixture endpoint: ${endpoint}`);
  };
  return { input, api, calls };
}

test('only the initial PR revision may omit the repair declaration', async () => {
  for (const [history, ok, reason] of [
    [[current], true, 'initial-baseline'],
    [[current, prior], false, 'repair-declaration-required'],
  ]) {
    const f = fixture('', history);
    const result = await checkPrCiRepair(f.input, f.api);
    assert.equal(result.ok, ok);
    assert.equal(result.reason, reason);
  }
});

test('all update types require the immediately preceding completed same-PR run', async () => {
  const f = fixture();
  assert.deepEqual(await checkPrCiRepair(f.input, f.api), {
    ok: true,
    reason: 'repair-declared',
    sourceRunId: 11,
  });
  for (const body of [
    '',
    'CI-Repair-From: 9',
    'CI-Repair-From: invalid',
    'CI-Repair-From: 11\nCI-Repair-From: 11',
  ]) {
    const invalid = fixture(body);
    assert.equal((await checkPrCiRepair(invalid.input, invalid.api)).ok, false, body);
  }
  const pending = fixture('', [current, { ...prior, status: 'in_progress' }]);
  assert.equal(
    (await checkPrCiRepair(pending.input, pending.api)).reason,
    'preceding-run-incomplete',
  );
});

test('run retries and reopening the same revision retain its original baseline', async () => {
  const f = fixture('', [current, { ...current, id: 10, run_number: 100 }]);
  assert.equal((await checkPrCiRepair(f.input, f.api)).reason, 'initial-baseline');
  const repair = fixture('CI-Repair-From: 11', [
    current,
    { ...current, id: 13, run_number: 103 },
    prior,
  ]);
  assert.equal((await checkPrCiRepair(repair.input, repair.api)).ok, true);
});

test('foreign PRs and an old reuse of the branch cannot create a baseline', async () => {
  const f = fixture('', [
    current,
    { ...prior, pull_requests: [{ number: 99 }] },
    { ...prior, pull_requests: [], created_at: '2026-11-15T00:00:00Z' },
  ]);
  assert.equal((await checkPrCiRepair(f.input, f.api)).reason, 'initial-baseline');
});

test('history failures are fatal rather than a full-CI fallback', async () => {
  const f = fixture();
  await assert.rejects(
    checkPrCiRepair(f.input, async () => {
      throw new Error('offline');
    }),
  );
  const unqualified = fixture();
  const result = await checkPrCiRepair(unqualified.input, async (endpoint) =>
    endpoint.includes('/compare/') ? { status: 'diverged' } : unqualified.api(endpoint),
  );
  assert.equal(result.ok, false);
});

test('manual recovery anchors retain independent association and ancestry checks', async () => {
  for (const associated of [true, false]) {
    const f = fixture('CI-Repair-From: 15');
    const anchor = {
      ...prior,
      id: 15,
      run_number: 101,
      event: 'workflow_dispatch',
      repository: { full_name: repository },
      pull_requests: [],
    };
    const previous = { ...prior, run_number: 100 };
    const api = async (endpoint) => {
      if (endpoint.endsWith('/actions/runs/15')) return anchor;
      if (endpoint.includes('/actions/workflows/ci.yml/runs?'))
        return { workflow_runs: [current, previous] };
      if (endpoint.endsWith('/pulls')) return associated ? [f.input.pr] : [];
      return f.api(endpoint);
    };
    assert.equal((await checkPrCiRepair(f.input, api)).ok, associated);
  }
});

test('history pagination does not mistake unrelated recent runs for the first revision', async () => {
  const f = fixture('');
  const api = async (endpoint) => {
    if (endpoint.includes('&page=1'))
      return {
        workflow_runs: Array.from({ length: 100 }, () => ({
          ...prior,
          pull_requests: [{ number: 99 }],
        })),
      };
    if (endpoint.includes('&page=2')) return { workflow_runs: [prior] };
    return f.api(endpoint);
  };
  assert.equal((await checkPrCiRepair(f.input, api)).ok, false);
  await assert.rejects(
    checkPrCiRepair(f.input, async (endpoint) =>
      endpoint.includes('/actions/workflows/')
        ? {
            workflow_runs: Array.from({ length: 100 }, () => ({
              ...prior,
              pull_requests: [{ number: 99 }],
            })),
          }
        : f.api(endpoint),
    ),
    /exceeds qualification bound/,
  );
});

test('non-PR events do not require a repair declaration or GitHub history', async () => {
  assert.equal((await checkPrCiRepair({ eventName: 'push' }, () => assert.fail())).ok, true);
});

test('the CLI exits nonzero for unreadable PR metadata without leaking credentials', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('../check-pr-ci-repair.mjs', import.meta.url).pathname],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: '/nonexistent/ci-repair-event.json',
        GH_TOKEN: 'fixture-secret',
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /repair-history-unavailable/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
});

test('the same Core execution publishes a head-bound required status for both outcomes', async () => {
  const { input } = fixture();
  for (const ok of [true, false]) {
    let calls = 0;
    await publishRepairStatus(
      input,
      { ok, reason: ok ? 'repair-declared' : 'repair-declaration-required' },
      'fixture-token',
      async (url, options) => {
        calls++;
        assert.equal(
          url,
          `https://api.github.com/repos/${repository}/statuses/${current.head_sha}`,
        );
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['content-type'], 'application/json');
        const body = JSON.parse(options.body);
        assert.equal(body.context, 'ci-repair-policy');
        assert.equal(body.state, ok ? 'success' : 'failure');
        assert.equal(body.target_url, `https://github.com/${repository}/actions/runs/12`);
        return new Response('{}', { status: 201 });
      },
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(publishRepairStatus(input, { ok: true }, undefined), /token unavailable/);
  await assert.rejects(
    publishRepairStatus(
      input,
      { ok: true },
      'fixture-token',
      async () => new Response('{}', { status: 403 }),
    ),
    /HTTP/,
  );
});

test('the existing required Core checks repair policy before expensive preparation', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const core = workflow.slice(
    workflow.indexOf('    name: ci-core'),
    workflow.indexOf('    name: shared-inputs-browser'),
  );
  const gate = core.indexOf('node scripts/ci/check-pr-ci-repair.mjs');
  assert.ok(gate > 0);
  assert.ok(gate < core.indexOf('- name: Materialize pinned View workspace'));
  assert.ok(gate < core.indexOf('- name: Install (frozen)'));
  assert.match(core, /statuses: write/);
  assert.match(core, /CI_REPAIR_STATUS_TOKEN: \$\{\{ github.token \}\}/);
});
