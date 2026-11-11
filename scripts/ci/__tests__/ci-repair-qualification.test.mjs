import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  ciRepairQualification,
  repairArtifactSuites,
  repairComparison,
  repairDeclaration,
  repairReusableJobs,
  requestGitHub,
} from '../ci-repair-qualification.mjs';

const repository = 'ForgeAX/forgeax-engine';
const oldSha = 'a'.repeat(40),
  newSha = 'b'.repeat(40),
  originalSha = 'c'.repeat(40);
const root = fileURLToPath(new URL('../../../', import.meta.url));
function fixture() {
  const pr = {
    number: 4960,
    body: 'CI repair\nCI-Repair-From: 11',
    created_at: '2026-11-01T00:00:00Z',
    head: { sha: newSha, ref: 'fix/ci', repo: { full_name: repository } },
  };
  const run = {
    id: 11,
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'failure',
    event: 'pull_request',
    head_sha: oldSha,
    head_branch: 'fix/ci',
    head_repository: { full_name: repository },
    pull_requests: [{ number: 4960 }],
    created_at: '2026-11-02T00:00:00Z',
  };
  const job = {
    id: 22,
    run_id: 11,
    name: 'vitest-browser-shard-3',
    status: 'completed',
    conclusion: 'success',
    steps: [],
  };
  const jobs = [job];
  const comparison = {
    status: 'ahead',
    files: [{ filename: 'scripts/test/ready-render-frame.mjs' }],
  };
  const input = {
    eventName: 'pull_request',
    pr,
    repository,
    targetSha: newSha,
    workflow: 'ci.yml',
    jobKey: 'vitest-browser-shard',
    checkName: job.name,
    currentRunId: 99,
    dependencyResults: 'success,success,skipped',
  };
  const extra = new Map(),
    calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    if (extra.has(endpoint)) return extra.get(endpoint);
    if (endpoint === `repos/${repository}/actions/runs/11`) return run;
    if (endpoint === `repos/${repository}/compare/${oldSha}...${newSha}`) return comparison;
    if (endpoint.startsWith(`repos/${repository}/actions/runs/11/jobs?`))
      return { total_count: jobs.length, jobs };
    throw new Error(`unexpected fixture endpoint: ${endpoint}`);
  };
  return { input, pr, run, job, jobs, comparison, extra, calls, api };
}

function blockedHistoryFixture() {
  const f = fixture();
  f.jobs.splice(0, f.jobs.length, {
    ...f.job,
    id: 23,
    name: 'ci-core',
    conclusion: 'failure',
  });
  const prior = { ...f.run, id: 10, head_sha: originalSha, created_at: '2026-11-01T12:00:00Z' };
  const priorJob = { ...f.job, id: 21, run_id: prior.id };
  const priorJobs = [priorJob];
  const history = { total_count: 1, workflow_runs: [prior] };
  f.extra.set(
    `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&branch=fix%2Fci&per_page=100&page=1`,
    history,
  );
  f.extra.set(`repos/${repository}/actions/runs/10/jobs?filter=latest&per_page=100&page=1`, {
    total_count: priorJobs.length,
    jobs: priorJobs,
  });
  f.extra.set(`repos/${repository}/compare/${originalSha}...${oldSha}`, { status: 'ahead' });
  f.extra.set(`repos/${repository}/compare/${originalSha}...${newSha}`, { status: 'ahead' });
  return { ...f, prior, priorJob, priorJobs, history };
}

test('a verified core-blocked missing or skipped check preserves its earlier actual success', async () => {
  for (const skipped of [false, true]) {
    const f = blockedHistoryFixture();
    if (skipped) f.jobs.push({ ...f.job, conclusion: 'skipped' });
    const result = await ciRepairQualification(f.input, f.api);
    assert.equal(result.reused, true);
    assert.equal(result.sourceRunId, f.prior.id);
    assert.equal(result.sourceJobId, f.priorJob.id);
    assert.equal(result.sourceSha, originalSha);
    assert.deepEqual(result.blockedRunIds, [11]);
  }
});

test('historical actual failures and cancellations are barriers, not permission to seek an older pass', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const f = blockedHistoryFixture();
    f.priorJob.conclusion = conclusion;
    f.history.workflow_runs.push({ ...f.prior, id: 9 });
    f.history.total_count = 2;
    const result = await ciRepairQualification(f.input, f.api);
    assert.equal(result.reused, false);
    assert.equal(
      f.calls.some((call) => call.includes('/runs/9/jobs')),
      false,
    );
  }
});

test('core-blocked history probes at most the existing eight-generation provenance bound', async () => {
  const f = blockedHistoryFixture();
  f.history.workflow_runs = [];
  f.history.total_count = 9;
  for (let id = 10; id >= 2; id--) {
    f.history.workflow_runs.push({ ...f.prior, id });
    const job =
      id === 2
        ? { ...f.priorJob, run_id: id }
        : { ...f.priorJob, run_id: id, name: 'ci-core', conclusion: 'failure' };
    f.extra.set(`repos/${repository}/actions/runs/${id}/jobs?filter=latest&per_page=100&page=1`, {
      total_count: 1,
      jobs: [job],
    });
  }
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, false);
  assert.equal(
    f.calls.some((call) => call.includes('/runs/2/jobs')),
    false,
  );
});

test('unverified core blocks, foreign or divergent history and incomplete runs execute fresh', async () => {
  for (const outcome of ['core-success', 'foreign', 'divergent', 'incomplete', 'unknown-job']) {
    const f = blockedHistoryFixture();
    if (outcome === 'core-success') f.jobs[0].conclusion = 'success';
    if (outcome === 'foreign') f.prior.head_repository = { full_name: 'another/engine' };
    if (outcome === 'divergent')
      f.extra.set(`repos/${repository}/compare/${originalSha}...${oldSha}`, { status: 'diverged' });
    if (outcome === 'incomplete') f.prior.status = 'in_progress';
    if (outcome === 'unknown-job') f.priorJob.status = 'in_progress';
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, false, outcome);
  }
  const f = blockedHistoryFixture();
  await assert.rejects(
    ciRepairQualification(f.input, async (endpoint) => {
      if (endpoint.includes('/workflows/ci.yml/runs')) throw new Error('history unavailable');
      return f.api(endpoint);
    }),
    /history unavailable/,
  );
});

function blockedCoverageFixture() {
  const f = blockedHistoryFixture();
  const captured = JSON.parse(
    readFileSync(
      join(root, 'scripts/ci/__tests__/fixtures/coverage-upstream-blocked-42711557372.json'),
      'utf8',
    ),
  );
  f.input.jobKey = 'coverage-pnpm';
  f.input.checkName = 'coverage-pnpm';
  f.jobs.splice(
    0,
    f.jobs.length,
    ...[captured.core, captured.aggregate, captured.placeholder].map((job) => ({
      ...job,
      run_id: f.run.id,
    })),
  );
  f.priorJob.name = 'coverage-pnpm';
  const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  for (const shard of ci.jobs['coverage-pnpm-shard'].strategy.matrix.shard)
    f.priorJobs.push({ ...f.priorJob, id: 30 + shard, name: `coverage-pnpm-shard-${shard}` });
  f.extra.get(
    `repos/${repository}/actions/runs/10/jobs?filter=latest&per_page=100&page=1`,
  ).total_count = f.priorJobs.length;
  return f;
}

test('the captured upstream-only coverage failure inherits one complete historical artifact suite', async () => {
  for (const [jobKey, checkName] of [
    ['coverage-pnpm', 'coverage-pnpm'],
    ['coverage-pnpm-shard', 'coverage-pnpm-shard-1'],
  ]) {
    const f = blockedCoverageFixture();
    f.input.jobKey = jobKey;
    f.input.checkName = checkName;
    const result = await ciRepairQualification(f.input, f.api);
    assert.equal(result.reused, true);
    assert.equal(result.selectedSuiteRunId, f.prior.id);
    assert.equal(result.sourceJobId, f.priorJobs.find((job) => job.name === checkName).id);
  }
});

test('coverage checkout or merge execution and missing historical suite members cannot become reuse', async () => {
  for (const outcome of ['checkout', 'merge', 'missing-member', 'actual-child-failure']) {
    const f = blockedCoverageFixture();
    const aggregate = f.jobs.find((job) => job.name === 'coverage-pnpm');
    if (outcome === 'checkout')
      aggregate.steps.find((step) => step.name === 'Checkout').conclusion = 'success';
    if (outcome === 'merge')
      aggregate.steps.find(
        (step) => step.name === 'Merge coverage shards and enforce aggregate thresholds',
      ).conclusion = 'failure';
    if (outcome === 'missing-member') {
      f.priorJobs.pop();
      f.extra.get(
        `repos/${repository}/actions/runs/10/jobs?filter=latest&per_page=100&page=1`,
      ).total_count = f.priorJobs.length;
    }
    if (outcome === 'actual-child-failure')
      f.jobs.push({ ...f.job, name: 'coverage-pnpm-shard-0', conclusion: 'failure' });
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, false, outcome);
  }
});

test('changed check membership can require fresh execution while retaining other successes', async () => {
  const fresh = fixture();
  fresh.pr.body += '\nCI-Repair-Rerun: vitest-browser-shard-3, vitest-dawn-4-of-4';
  assert.deepEqual(await ciRepairQualification(fresh.input, fresh.api), {
    reused: false,
    reason: 'new-work-declared',
  });
  const retained = fixture();
  retained.pr.body += '\nCI-Repair-Rerun: vitest-dawn-4-of-4';
  assert.equal((await ciRepairQualification(retained.input, retained.api)).reused, true);
});

test('ambiguous fresh-work declarations fail closed to normal execution', async () => {
  for (const directive of [
    'CI-Repair-Rerun:',
    'CI-Repair-Rerun: one\nCI-Repair-Rerun: two',
    'CI-Repair-Rerun: one,,two',
  ]) {
    const f = fixture();
    f.pr.body += `\n${directive}`;
    assert.deepEqual(await ciRepairQualification(f.input, f.api), {
      reused: false,
      reason: 'repair-rerun-invalid',
    });
  }
});

test('repair requires exactly one explicit numeric run or same-repository URL', () => {
  assert.equal(repairDeclaration('CI-Repair-From: 11', repository), 11);
  assert.equal(
    repairDeclaration(
      `CI-Repair-From: https://github.com/${repository}/actions/runs/11`,
      repository,
    ),
    11,
  );
  for (const body of [
    null,
    '',
    'CI-Repair-From: 0',
    'CI-Repair-From: 11\nCI-Repair-From: 12',
    'CI-Repair-From: https://github.com/other/repo/actions/runs/11',
  ])
    assert.equal(repairDeclaration(body, repository), undefined);
});

test('declared repair purpose accepts implementation, build, dependency and large changes', async () => {
  for (const files of [
    [{ filename: 'packages/render/src/frame.ts' }],
    [{ filename: 'scripts/forgeax/build-sdk.mjs' }],
    [{ filename: 'pnpm-lock.yaml' }, { filename: 'packages/modeling' }],
    [
      {
        filename: 'packages/render/src/__tests__/fixture.ts',
        previous_filename: 'packages/render/src/frame.ts',
      },
    ],
    Array.from({ length: 300 }, () => ({ filename: 'packages/runtime/src/renderer-host.ts' })),
  ]) {
    const f = fixture();
    f.comparison.files = files;
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, true);
  }
});

test('repair comparisons establish ancestry without classifying the repair files', () => {
  for (const status of ['ahead', 'identical']) assert.equal(repairComparison({ status }), true);
  for (const value of [undefined, {}, { status: 'diverged' }, { status: 'behind' }])
    assert.equal(repairComparison(value), false);
});

test('a failed workflow can supply its individually successful check with original identity', async () => {
  const f = fixture();
  assert.deepEqual(await ciRepairQualification(f.input, f.api), {
    reused: true,
    reason: 'declared-ci-repair',
    sourceRunId: 11,
    sourceJobId: 22,
    sourceSha: oldSha,
    targetSha: newSha,
    sourceUrl: `https://github.com/${repository}/actions/runs/11/job/22`,
  });
});

test('default, fork, producer and failed-dependency routes make no reuse API request', async () => {
  const mutations = [
    (f) => {
      f.pr.body = '';
    },
    (f) => {
      f.input.eventName = 'push';
    },
    (f) => {
      f.pr.head.repo.full_name = 'other/repo';
    },
    (f) => {
      f.input.jobKey = 'core-build';
    },
    (f) => {
      f.input.dependencyResults = 'failure,success';
    },
    (f) => {
      f.input.dependencyResults = 'cancelled';
    },
  ];
  for (const change of mutations) {
    const f = fixture();
    change(f);
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, false);
    assert.equal(f.calls.length, 0);
  }
});

test('foreign PR/repository/branch and unfinished or same-head baselines cannot qualify', async () => {
  for (const change of [
    (f) => {
      f.run.pull_requests = [{ number: 999 }];
    },
    (f) => {
      f.run.head_repository.full_name = 'other/repo';
    },
    (f) => {
      f.run.head_branch = 'other';
    },
    (f) => {
      f.run.status = 'in_progress';
    },
    (f) => {
      f.run.path = '.github/workflows/nightly.yml';
    },
    (f) => {
      f.run.head_sha = newSha;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'baseline-unqualified');
  }
});

test('missing PR association needs a current branch lifetime, not an older reused branch', async () => {
  const f = fixture();
  f.run.pull_requests = [];
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, true);
  f.run.created_at = '2026-10-01T00:00:00Z';
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, false);
});

test('implementation repairs reuse passed checks only with the explicit purpose declaration', async () => {
  const f = fixture();
  f.comparison.files.push({ filename: 'packages/runtime/src/renderer-host.ts' });
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, true);
  f.pr.body = '';
  assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'not-declared');
});

test('merge checkouts preserve ancestry while allowing implementation repairs', async () => {
  const f = fixture();
  f.input.targetSha = originalSha;
  const endpoint = `repos/${repository}/compare/${newSha}...${originalSha}`;
  f.extra.set(endpoint, { status: 'behind', files: [] });
  assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'checkout-inputs-unqualified');
  f.extra.set(endpoint, {
    status: 'ahead',
    files: [{ filename: 'packages/runtime/src/renderer-host.ts' }],
  });
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, true);
});

test('failed, cancelled, skipped, missing and duplicate job outcomes always execute', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const f = fixture();
    f.job.conclusion = conclusion;
    assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'check-did-not-pass');
  }
  for (const mutate of [
    (f) => {
      f.jobs.length = 0;
    },
    (f) => {
      f.jobs.push({ ...f.job, id: 23 });
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, false);
  }
});

test('an artifact-producing shard reruns while its complete consumer needs fresh data', async () => {
  const f = fixture();
  f.input.jobKey = 'coverage-pnpm-shard';
  f.input.checkName = f.job.name = 'coverage-pnpm-shard-0';
  const consumer = { ...f.job, id: 23, name: 'coverage-pnpm', conclusion: 'failure' };
  f.jobs.push(consumer);
  assert.equal(
    (await ciRepairQualification(f.input, f.api)).reason,
    'artifact-consumer-needs-fresh-inputs',
  );
  consumer.conclusion = 'success';
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, false);
  for (const shard of [1, 2, 3])
    f.jobs.push({ ...f.job, id: 30 + shard, name: `coverage-pnpm-shard-${shard}` });
  assert.equal((await ciRepairQualification(f.input, f.api)).reused, true);
});

test('a declared fresh consumer rebuilds every provider even after a fully green suite', async () => {
  for (const directive of ['coverage-pnpm', 'coverage-pnpm-shard-0, coverage-pnpm']) {
    const f = fixture();
    f.run.conclusion = 'success';
    f.input.jobKey = 'coverage-pnpm-shard';
    f.input.checkName = f.job.name = 'coverage-pnpm-shard-2';
    f.jobs.push({ ...f.job, id: 23, name: 'coverage-pnpm' });
    for (const shard of [0, 1, 3])
      f.jobs.push({ ...f.job, id: 30 + shard, name: `coverage-pnpm-shard-${shard}` });
    f.pr.body += `\nCI-Repair-Rerun: ${directive}`;
    assert.deepEqual(await ciRepairQualification(f.input, f.api), {
      reused: false,
      reason: 'artifact-consumer-needs-fresh-inputs',
    });
  }
  const unrelated = fixture();
  unrelated.pr.body += '\nCI-Repair-Rerun: coverage-pnpm';
  assert.equal((await ciRepairQualification(unrelated.input, unrelated.api)).reused, true);
});

function inherit(f, { malformed = false, cycle = false } = {}) {
  f.job.steps = [
    {
      name: malformed ? '[ci-repair-reused] broken' : '[ci-repair-reused] run 5 job 2',
      conclusion: 'success',
    },
  ];
  const run = { ...f.run, id: 5, head_sha: originalSha };
  const job = { ...f.job, id: 2, run_id: 5, steps: cycle ? f.job.steps : [] };
  f.extra.set(`repos/${repository}/actions/runs/5`, run);
  f.extra.set(`repos/${repository}/actions/jobs/2`, job);
  f.extra.set(`repos/${repository}/compare/${originalSha}...${newSha}`, f.comparison);
  return { run, job };
}

test('success reuse chains point to the original executed job, not a green wrapper', async () => {
  const f = fixture();
  inherit(f);
  const result = await ciRepairQualification(f.input, f.api);
  assert.equal(result.sourceRunId, 5);
  assert.equal(result.sourceJobId, 2);
  assert.equal(result.sourceSha, originalSha);
});

test('malformed/cyclic/foreign provenance and divergent original history do not qualify', async () => {
  for (const options of [{ malformed: true }, { cycle: true }]) {
    const f = fixture();
    inherit(f, options);
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, false);
  }
  const foreign = fixture();
  const source = inherit(foreign);
  source.run.path = '.github/workflows/nightly.yml';
  assert.equal((await ciRepairQualification(foreign.input, foreign.api)).reused, false);
  const changed = fixture();
  inherit(changed);
  changed.extra.set(`repos/${repository}/compare/${originalSha}...${newSha}`, {
    status: 'ahead',
    files: [{ filename: 'packages/render/src/frame.ts' }],
  });
  const result = await ciRepairQualification(changed.input, changed.api);
  assert.equal(result.reused, true);
  assert.equal(result.sourceSha, originalSha);
  changed.extra.set(`repos/${repository}/compare/${originalSha}...${newSha}`, {
    status: 'diverged',
  });
  assert.equal(
    (await ciRepairQualification(changed.input, changed.api)).reason,
    'original-success-not-ancestor',
  );
});

test('other workflows resolve their baseline at the declared CI source commit', async () => {
  const f = fixture();
  f.input.workflow = 'native-ray-query.yml';
  f.input.jobKey = 'native-node-gi';
  const run = { ...f.run, id: 12, path: '.github/workflows/native-ray-query.yml' };
  f.extra.set(
    `repos/${repository}/actions/workflows/native-ray-query.yml/runs?event=pull_request&head_sha=${oldSha}&status=completed&per_page=100`,
    { workflow_runs: [run] },
  );
  f.extra.set(`repos/${repository}/actions/runs/12/jobs?filter=latest&per_page=100&page=1`, {
    total_count: 1,
    jobs: [{ ...f.job, run_id: 12 }],
  });
  assert.equal((await ciRepairQualification(f.input, f.api)).sourceRunId, 12);
});

test('compatibility repair reuses only the exact successful carrier at the CI anchor', async () => {
  for (const carrier of ['stable', 'reference', 'legacy', 'webkit']) {
    const f = fixture();
    f.input.workflow = 'webgpu-compatibility.yml';
    f.input.jobKey = 'compatibility';
    f.input.checkName = `Ubuntu / ${carrier}`;
    const run = { ...f.run, id: 12, path: '.github/workflows/webgpu-compatibility.yml' };
    const job = { ...f.job, run_id: 12, name: f.input.checkName };
    f.extra.set(
      `repos/${repository}/actions/workflows/webgpu-compatibility.yml/runs?event=pull_request&head_sha=${oldSha}&status=completed&per_page=100`,
      { workflow_runs: [run] },
    );
    f.extra.set(`repos/${repository}/actions/runs/12/jobs?filter=latest&per_page=100&page=1`, {
      total_count: 1,
      jobs: [job],
    });
    assert.equal((await ciRepairQualification(f.input, f.api)).sourceJobId, job.id);
    job.conclusion = 'failure';
    assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'check-did-not-pass');
    job.conclusion = 'success';
    job.name = 'Ubuntu / another-carrier';
    assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'check-did-not-pass');
  }
});

test('math bench reuses an exact successful peer and keeps unqualified evidence fresh', async () => {
  for (const outcome of ['success', 'failure', 'missing', 'wrong-name', 'foreign', 'older-pr']) {
    const f = fixture();
    f.input.workflow = 'bench.yml';
    f.input.jobKey = 'bench';
    f.input.checkName = 'math bench (informational only)';
    const peer = { ...f.run, id: 12, path: '.github/workflows/bench.yml' };
    const job = { ...f.job, run_id: 12, name: f.input.checkName };
    if (outcome === 'failure') job.conclusion = 'failure';
    if (outcome === 'wrong-name') job.name = 'another math check';
    if (outcome === 'foreign') peer.head_repository = { full_name: 'another/engine' };
    if (outcome === 'older-pr') {
      peer.pull_requests = [];
      peer.created_at = '2026-10-01T00:00:00Z';
    }
    f.extra.set(
      `repos/${repository}/actions/workflows/bench.yml/runs?event=pull_request&head_sha=${oldSha}&status=completed&per_page=100`,
      { workflow_runs: [peer] },
    );
    f.extra.set(`repos/${repository}/actions/runs/12/jobs?filter=latest&per_page=100&page=1`, {
      total_count: outcome === 'missing' ? 0 : 1,
      jobs: outcome === 'missing' ? [] : [job],
    });
    const result = await ciRepairQualification(f.input, f.api);
    assert.equal(result.reused, outcome === 'success', outcome);
    if (outcome === 'success') {
      assert.equal(result.sourceRunId, peer.id);
      assert.equal(result.sourceJobId, job.id);
      assert.equal(result.sourceSha, oldSha);
    }
  }
});

test('SDK reuse preserves the complete successful artifact suite and keeps failed suites fresh', async () => {
  const f = fixture();
  f.input.workflow = 'sdk-pr-preflight.yml';
  f.input.jobKey = 'consumers';
  f.input.checkName = 'sdk-consumer-source';
  const run = { ...f.run, id: 12, path: '.github/workflows/sdk-pr-preflight.yml' };
  const job = { ...f.job, run_id: 12, name: f.input.checkName };
  const aggregate = { ...job, id: 23, name: 'sdk-build', conclusion: 'failure' };
  f.extra.set(
    `repos/${repository}/actions/workflows/sdk-pr-preflight.yml/runs?event=pull_request&head_sha=${oldSha}&status=completed&per_page=100`,
    { workflow_runs: [run] },
  );
  f.extra.set(`repos/${repository}/actions/runs/12/jobs?filter=latest&per_page=100&page=1`, {
    total_count: 2,
    jobs: [job, aggregate],
  });
  assert.equal(
    (await ciRepairQualification(f.input, f.api)).reason,
    'artifact-consumer-needs-fresh-inputs',
  );
  aggregate.conclusion = 'success';
  assert.equal((await ciRepairQualification(f.input, f.api)).sourceRunId, 12);
  f.input.jobKey = 'build-sdk';
  assert.equal(
    (await ciRepairQualification(f.input, f.api)).reason,
    'artifact-provider-or-aggregate',
  );
});

const metricProducers = ['webkit-fallback', 'metrics-validate-browser', 'metrics-validate-runtime'];
function metricsFixture() {
  const f = fixture();
  f.run.run_attempt = 1;
  f.jobs.splice(
    0,
    f.jobs.length,
    ...[...metricProducers, 'metrics-validate'].map((name, index) => ({
      ...f.job,
      id: 30 + index,
      name,
      run_attempt: 1,
    })),
  );
  f.input.jobKey = f.input.checkName = 'webkit-fallback';
  const names = [
    'chromium-fallback-color-lighting-status',
    'metrics-validate-browser-evidence-a1',
    'metrics-report',
  ];
  const artifacts = names.map((name, index) => ({
    id: 50 + index,
    name,
    expired: false,
    size_in_bytes: 10,
    digest: `sha256:${'d'.repeat(64)}`,
    workflow_run: { id: f.run.id, head_sha: oldSha },
  }));
  f.extra.set(`repos/${repository}/actions/runs/11/artifacts?per_page=100&page=1`, {
    total_count: artifacts.length,
    artifacts,
  });
  return { ...f, artifacts };
}

test('metrics reuse preserves one complete original artifact cohort without relabeling', async () => {
  for (const [index, name] of metricProducers.entries()) {
    const f = metricsFixture();
    f.input.jobKey = f.input.checkName = name;
    const result = await ciRepairQualification(f.input, f.api);
    assert.equal(result.reused, true);
    assert.equal(result.sourceJobId, 30 + index);
    assert.equal(result.sourceArtifact.id, 50 + index);
    assert.equal(result.sourceArtifact.sourceRunId, 11);
    assert.equal(result.sourceArtifact.sourceSha, oldSha);
    assert.deepEqual(Object.keys(result.sourceArtifactSuite), metricProducers);
    assert.deepEqual(
      Object.values(result.sourceArtifactSuite).map((row) => row.id),
      [50, 51, 52],
    );
  }
});

test('a failed, missing or explicitly fresh metrics member keeps every producer fresh', async () => {
  for (const name of [...metricProducers, 'metrics-validate']) {
    for (const state of ['failure', 'cancelled', 'skipped', 'missing', 'fresh']) {
      const f = metricsFixture();
      const index = f.jobs.findIndex((job) => job.name === name);
      if (state === 'missing') f.jobs.splice(index, 1);
      else if (state === 'fresh') f.pr.body += `\nCI-Repair-Rerun: ${name}`;
      else f.jobs[index].conclusion = state;
      for (const producer of metricProducers) {
        f.input.jobKey = f.input.checkName = producer;
        assert.equal(
          (await ciRepairQualification(f.input, f.api)).reused,
          false,
          `${name}:${state}:${producer}`,
        );
      }
    }
  }
});

test('metrics reuse rejects expired, missing, duplicate or foreign artifact evidence', async () => {
  for (const invalid of [
    'expired',
    'missing',
    'duplicate',
    'foreign-run',
    'foreign-sha',
    'digest',
    'empty',
    'attempt',
  ]) {
    const f = metricsFixture();
    const artifact = f.artifacts[1];
    if (invalid === 'expired') artifact.expired = true;
    if (invalid === 'missing') artifact.name = 'different';
    if (invalid === 'duplicate') f.artifacts.push({ ...artifact, id: 88 });
    if (invalid === 'foreign-run') artifact.workflow_run.id = 12;
    if (invalid === 'foreign-sha') artifact.workflow_run.head_sha = newSha;
    if (invalid === 'digest') artifact.digest = '';
    if (invalid === 'empty') artifact.size_in_bytes = 0;
    if (invalid === 'attempt') f.jobs[1].run_attempt = 2;
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, false, invalid);
  }
});

test('metrics wrappers cannot combine original producers from different runs', async () => {
  const f = metricsFixture();
  f.jobs[1].steps = [{ name: '[ci-repair-reused] run 12 job 99', conclusion: 'success' }];
  const prior = { ...f.run, id: 12, head_sha: originalSha };
  f.extra.set(`repos/${repository}/actions/runs/12`, prior);
  f.extra.set(`repos/${repository}/actions/jobs/99`, {
    ...f.jobs[1],
    id: 99,
    run_id: 12,
    steps: [],
  });
  assert.equal((await ciRepairQualification(f.input, f.api)).reason, 'artifact-suite-unavailable');
});

test('fresh current metrics providers keep downstream consumers in the fresh cohort', async () => {
  for (const name of metricProducers.slice(1)) {
    const f = metricsFixture();
    f.input.jobKey = f.input.checkName = name;
    f.input.artifactSuiteProviderReused = 'false';
    assert.equal(
      (await ciRepairQualification(f.input, f.api)).reason,
      'artifact-provider-needs-fresh-inputs',
    );
    f.input.artifactSuiteProviderReused = 'true';
    assert.equal((await ciRepairQualification(f.input, f.api)).reused, true);
  }
});

test('all integrated consumers preserve checkout, explicit provenance and step guards', () => {
  for (const [file, ids] of Object.entries(repairReusableJobs)) {
    const workflowPath = join(root, '.github/workflows', file);
    if (!existsSync(workflowPath)) {
      assert.equal(file, 'modeling-ci.yml');
      assert.deepEqual(ids, ['engine-candidate']);
      continue;
    }
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    for (const id of ids) {
      const job = workflow.jobs[id];
      assert.ok(job, `${file}:${id}`);
      if (metricProducers.includes(id)) {
        const values = Object.entries(job.outputs)
          .filter(([key]) => key !== 'metric_suite_reused')
          .map(([, value]) => value);
        assert.equal(values.length, 2);
        assert.ok(
          values.every((value) => /steps\.ci-repair\.outputs\.source_artifact_/.test(value)),
        );
        assert.ok(values.every((value) => /\|\| steps\.upload-/.test(value)));
      } else assert.equal(job.outputs, undefined, 'outputs needed downstream cannot disappear');
      const index = job.steps.findIndex((step) => step.id === 'ci-repair');
      assert.ok(index > 0, `${file}:${id} must qualify after checkout`);
      assert.ok(
        job.steps.slice(0, index).some((step) => step.uses?.startsWith('actions/checkout@')),
      );
      assert.equal(job.steps[index].with['check-name'], job.name ?? id);
      assert.ok(job.steps[index + 1].name.startsWith('[ci-repair-reused]'));
      for (const step of job.steps.slice(index + 2))
        assert.match(
          step.if,
          /steps\.ci-repair\.outputs\.reused != 'true'/,
          `${file}:${id}:${step.name ?? step.uses}`,
        );
      const consumerName = repairArtifactSuites[file]?.[id];
      if (consumerName)
        assert.ok(Object.values(workflow.jobs).some((entry) => entry.name === consumerName));
    }
  }
  const reuseAction = parse(
    readFileSync(join(root, '.github/actions/reuse-passed-ci-check/action.yml'), 'utf8'),
  );
  assert.equal(reuseAction.inputs['target-sha'].default, '');
  assert.equal(
    reuseAction.runs.steps.find((step) => step.id === 'qualify').env.CI_REPAIR_TARGET_SHA,
    '${{ inputs.target-sha }}',
  );
  const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  for (const [name, provider] of [
    ['metrics-validate-browser', 'webkit-fallback'],
    ['metrics-validate-runtime', 'metrics-validate-browser'],
  ]) {
    const qualifier = ci.jobs[name].steps.find((step) => step.id === 'ci-repair');
    assert.equal(
      qualifier.with['artifact-suite-provider-reused'],
      `\${{ needs.${provider}.outputs.metric_suite_reused }}`,
    );
    assert.match(
      ci.jobs[provider].outputs.metric_suite_reused,
      /steps\.ci-repair\.outputs\.reused/,
    );
  }
  assert.ok(
    ci.jobs['core-build'].steps.some((step) =>
      step.run?.includes('ci-repair-qualification.test.mjs'),
    ),
  );
  for (const job of Object.values(ci.jobs)) {
    if (!job.strategy?.matrix) continue;
    if (typeof job.strategy['fail-fast'] === 'string')
      assert.match(
        job.strategy['fail-fast'],
        /!contains\(github.event.pull_request.body, 'CI-Repair-From:'\)/,
      );
  }
  for (const id of [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
    'build-artifacts',
    'public-content',
  ])
    assert.equal(
      ci.jobs[id].steps.some((step) => step.id === 'ci-repair'),
      false,
      id,
    );
});

test('API credential failure writes normal-execution outputs without pretending reuse', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-repair-api-failure-'));
  try {
    const f = fixture();
    const event = join(directory, 'event.json'),
      output = join(directory, 'output');
    writeFileSync(event, JSON.stringify({ pull_request: f.pr }));
    const result = spawnSync(process.execPath, ['scripts/ci/ci-repair-qualification.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        GH_TOKEN: '',
        GITHUB_EVENT_PATH: event,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: repository,
        GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/pull/4960/merge`,
        GITHUB_JOB: 'vitest-browser-shard',
        GITHUB_RUN_ID: '99',
        CI_REPAIR_CHECK_NAME: f.job.name,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reused, false);
    assert.match(readFileSync(output, 'utf8'), /^reused=false\n/);
    const inherited = spawnSync(process.execPath, ['scripts/ci/ci-repair-qualification.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        GH_TOKEN: '',
        GITHUB_EVENT_PATH: event,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: repository,
        GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/pull/4960/merge`,
        GITHUB_JOB: 'metrics-validate-browser',
        GITHUB_RUN_ID: '99',
        CI_REPAIR_CHECK_NAME: 'metrics-validate-browser',
        CI_REPAIR_SUITE_PROVIDER_REUSED: 'true',
      },
    });
    assert.equal(inherited.status, 1);
    assert.equal(JSON.parse(inherited.stdout).reused, false);
    assert.match(inherited.stderr, /cannot mix its artifacts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the built-in API client needs no runner CLI and bounds authenticated requests', async () => {
  const request = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/engine/actions/runs/11');
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.headers['x-github-api-version'], '2022-11-28');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ id: 11 }) };
  };
  assert.deepEqual(
    await requestGitHub('repos/example/engine/actions/runs/11', 'test-token', request),
    { id: 11 },
  );
  await assert.rejects(requestGitHub('repos/example/engine', ''), /token unavailable/);
  for (const status of [403, 404, 429, 500])
    await assert.rejects(
      requestGitHub('repos/example/engine', 'test-token', async () => ({ ok: false, status })),
      /GitHub history unavailable/,
    );
});
