import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyOwner } from '../reuse-owner.mjs';

const repository = 'ForgeAX/forgeax-modeling';
const checkName = 'Modeling owner (1/4)';
const run = {
  id: 1,
  status: 'completed',
  event: 'pull_request',
  path: '.github/workflows/modeling-ci.yml',
  head_sha: 'before',
  head_branch: 'candidate',
  head_repository: { full_name: repository },
  pull_requests: [{ number: 726 }],
};
const job = {
  id: 2,
  run_id: 1,
  name: checkName,
  status: 'completed',
  conclusion: 'success',
  steps: [],
};
function fixture() {
  const input = {
    eventName: 'pull_request',
    repository,
    checkName,
    currentRunId: 3,
    engineSha: 'engine',
    pr: {
      number: 726,
      head: { sha: 'after', ref: 'candidate' },
      body: 'CI-Repair-From: 1\nCI-Repair-Rerun: ["Modeling owner (2/4)"]',
    },
  };
  const responses = new Map([
    [`repos/${repository}/actions/runs/1`, structuredClone(run)],
    [
      `repos/${repository}/compare/before...after`,
      { status: 'ahead', files: [{ filename: 'scripts/mutation/sets/l3-quad.json' }] },
    ],
    [
      `repos/${repository}/actions/runs/1/jobs?filter=latest&per_page=100&page=1`,
      { total_count: 1, jobs: [structuredClone(job)] },
    ],
  ]);
  const api = async (endpoint) => {
    assert.ok(responses.has(endpoint), endpoint);
    return responses.get(endpoint);
  };
  return { input, responses, qualify: () => qualifyOwner(input, api, async () => 'engine') };
}

test('retains original successful run, job and source with identical Engine input', async () => {
  const result = await fixture().qualify();
  assert.deepEqual(result, {
    reused: true,
    sourceRunId: 1,
    sourceJobId: 2,
    sourceSha: 'before',
    sourceUrl: `https://github.com/${repository}/actions/runs/1/job/2`,
  });
});
test('explicit fresh owner executes normally', async () => {
  const f = fixture();
  f.input.checkName = 'Modeling owner (2/4)';
  assert.equal((await f.qualify()).reused, false);
});
test('changed Engine input executes normally', async () => {
  const f = fixture();
  f.input.engineSha = 'changed';
  assert.equal((await f.qualify()).reused, false);
});
test('changed kernel input executes normally', async () => {
  const f = fixture();
  f.responses
    .get(`repos/${repository}/compare/before...after`)
    .files.push({ filename: 'src/quad/remesh.ts' });
  assert.equal((await f.qualify()).reused, false);
});
test('failed or skipped job cannot qualify', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    const f = fixture();
    f.responses.get(
      `repos/${repository}/actions/runs/1/jobs?filter=latest&per_page=100&page=1`,
    ).jobs[0].conclusion = conclusion;
    assert.equal((await f.qualify()).reused, false);
  }
});
test('unfinished or unrelated baseline cannot qualify', async () => {
  for (const change of [
    { status: 'in_progress' },
    { head_branch: 'unrelated' },
    { head_repository: { full_name: 'other/repository' } },
    { path: '.github/workflows/other.yml' },
  ]) {
    const f = fixture();
    Object.assign(f.responses.get(`repos/${repository}/actions/runs/1`), change);
    assert.equal((await f.qualify()).reused, false);
  }
});
test('ambiguous inherited marker cannot qualify', async () => {
  const f = fixture();
  f.responses.get(
    `repos/${repository}/actions/runs/1/jobs?filter=latest&per_page=100&page=1`,
  ).jobs[0].steps = [{ name: '[ci-repair-reused] malformed', conclusion: 'success' }];
  assert.equal((await f.qualify()).reused, false);
});
