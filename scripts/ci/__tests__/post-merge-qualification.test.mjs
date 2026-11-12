import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { postMergeQualification } from '../post-merge-qualification.mjs';

const repository = 'ForgeAX/forgeax-engine';
const pr = { number: 4917, head: { sha: 'head', ref: 'fix/example' } };
const run = {
  id: 1,
  event: 'pull_request',
  head_sha: 'head',
  head_branch: 'fix/example',
  status: 'completed',
  conclusion: 'success',
  head_repository: { full_name: repository },
  pull_requests: [{ number: 4917 }],
};
const facts = {
  repository,
  pr,
  mergeTree: 'tree',
  headTree: 'tree',
  mergeParent: 'base',
  prBase: 'base',
  runs: [],
};

test('unchanged main with an unfinished or failed PR must run full CI', () => {
  for (const overrides of [
    undefined,
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ]) {
    const runs = overrides === undefined ? [] : [{ ...run, ...overrides }];
    assert.equal(postMergeQualification({ ...facts, runs }).skip, false);
  }
});

test('only matching completed successful PR CI may qualify the exact merge tree', () => {
  assert.deepEqual(postMergeQualification({ ...facts, runs: [run] }), {
    skip: true,
    reason: 'qualified-identical-tree',
    runId: 1,
  });
  assert.equal(
    postMergeQualification({ ...facts, mergeTree: 'integrated-tree', runs: [run] }).skip,
    false,
  );
  for (const overrides of [
    { event: 'workflow_dispatch' },
    { head_sha: 'older-head' },
    { pull_requests: [{ number: 4900 }] },
    { pull_requests: [], head_branch: 'another-branch' },
    { pull_requests: undefined },
    { head_repository: { full_name: 'someone/fork' } },
    { status: 'queued' },
  ]) {
    assert.equal(
      postMergeQualification({ ...facts, runs: [{ ...run, ...overrides }] }).skip,
      false,
    );
  }
});

test('merged runs with an empty PR list retain exact repository/head/branch qualification', () => {
  assert.equal(
    postMergeQualification({ ...facts, runs: [{ ...run, pull_requests: [] }] }).skip,
    true,
  );
});

test('an older green run cannot hide a newer failed or unfinished run', () => {
  for (const overrides of [
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ]) {
    const runs = [run, { ...run, id: 2, ...overrides }];
    assert.equal(postMergeQualification({ ...facts, runs }).skip, false);
  }
});

test('API failure writes an explicit full-CI decision without failing the optimization job', () => {
  const directory = mkdtempSync(join(tmpdir(), 'post-merge-qualification-'));
  try {
    writeFileSync(join(directory, 'gh'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const output = join(directory, 'output');
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../post-merge-qualification.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: repository,
          GITHUB_SHA: 'merge',
          GITHUB_OUTPUT: output,
        },
        encoding: 'utf8',
        timeout: 2_000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).skip, false);
    assert.equal(readFileSync(output, 'utf8'), 'skip_checks=false\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
