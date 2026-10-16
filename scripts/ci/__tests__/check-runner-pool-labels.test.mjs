import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkPostMergeRunnerPolicy,
  checkPullRequestRunnerPolicy,
  checkWorkflowDirectory,
  checkWorkflowText,
} from '../check-runner-pool-labels.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('all repository workflow runner selectors satisfy the pool contract', () => {
  const result = checkWorkflowDirectory(resolve(repoRoot, '.github/workflows'));
  assert.deepEqual(result.errors, []);
  const selfHosted = result.selectors.filter((selector) => selector.kind === 'self-hosted');
  assert.ok(selfHosted.length > 0);
  assert.ok(
    selfHosted.every(
      (selector) =>
        ['standard', 'heavy'].includes(selector.pool) || selector.capabilities?.includes('gpu'),
    ),
  );
  assert.ok(selfHosted.some((selector) => selector.capabilities?.includes('gpu')));
  assert.ok(result.selectors.some((selector) => selector.kind === 'mixed'));
});

test('rejects a self-hosted selector without a pool label', () => {
  const result = checkWorkflowText(
    'jobs:\n  bench:\n    runs-on: [self-hosted, Linux, X64]\n',
    'bench.yml',
  );
  assert.match(result.errors[0], /exactly one of standard or heavy/);
});

test('rejects a self-hosted selector carrying both pool labels', () => {
  const result = checkWorkflowText(
    'jobs:\n  bench:\n    runs-on: [self-hosted, Linux, X64, standard, heavy]\n',
    'bench.yml',
  );
  assert.match(result.errors[0], /found standard, heavy/);
});

test('accepts the nightly GitHub-hosted matrix', () => {
  const result = checkWorkflowText(
    [
      'jobs:',
      '  smoke:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - runner: \'"ubuntu-latest"\'',
      '          - runner: \'"macos-latest"\'',
      '    runs-on: $' + '{{ fromJSON(matrix.runner) }}',
    ].join('\n'),
    'nightly.yml',
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.selectors[0].kind, 'github-hosted');
});

test('accepts a nightly matrix with self-hosted Linux and hosted native coverage', () => {
  const result = checkWorkflowText(
    [
      'jobs:',
      '  smoke:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - runner: \'["self-hosted", "Linux", "X64", "standard"]\'',
      '          - runner: \'"macos-latest"\'',
      '    runs-on: $' + '{{ fromJSON(matrix.runner) }}',
    ].join('\n'),
    'nightly.yml',
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.selectors[0].kind, 'mixed');
  assert.equal(result.selectors[0].pool, 'standard');
  assert.deepEqual(result.selectors[0].hostedLabels, ['macos-latest']);
});

test('rejects a dynamic matrix that can select self-hosted without a pool', () => {
  const result = checkWorkflowText(
    [
      'jobs:',
      '  smoke:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - runner: \'"self-hosted"\'',
      '    runs-on: $' + '{{ fromJSON(matrix.runner) }}',
    ].join('\n'),
    'nightly.yml',
  );
  assert.match(result.errors[0], /dynamic self-hosted runner selection/);
});

test('rejects a job without a runner selector or reusable workflow', () => {
  const result = checkWorkflowText('jobs:\n  orphan:\n    timeout-minutes: 5\n', 'broken.yml');
  assert.match(result.errors[0], /must declare runs-on or use a reusable workflow/);
});

test('rejects a GitHub-hosted selector in a pull-request workflow', () => {
  const result = checkPullRequestRunnerPolicy(
    ['name: PR', 'on:', '  pull_request:', 'jobs:', '  hosted:', '    runs-on: ubuntu-latest'].join(
      '\n',
    ),
    'pr.yml',
  );
  assert.equal(result.pullRequest, true);
  assert.match(result.errors[0], /PR-triggered job must use a self-hosted runner/);
});

test('rejects a direct hosted native selector outside nightly', () => {
  const result = checkWorkflowText('jobs:\n  hosted:\n    runs-on: macos-15\n', 'ci.yml');
  assert.match(result.errors[0], /do not use it for daily development/);
});

test('ignores a disabled non-compliant native selector', () => {
  const result = checkWorkflowText(
    `jobs:\n  hosted:\n    if: \${{ false }}\n    runs-on: macos-15\n`,
    'ci.yml',
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.selectors, []);
});

test('allows a hosted selector when the job is explicitly non-PR', () => {
  const result = checkPullRequestRunnerPolicy(
    [
      'name: Mixed',
      'on:',
      '  pull_request:',
      '  workflow_dispatch:',
      'jobs:',
      '  manual:',
      "    if: github.event_name == 'workflow_dispatch'",
      '    runs-on: ubuntu-latest',
    ].join('\n'),
    'mixed.yml',
  );
  assert.deepEqual(result.errors, []);
});

test('all main-push and workflow-run post-merge jobs are self-hosted', () => {
  const result = checkWorkflowDirectory(resolve(repoRoot, '.github/workflows'), {
    requireSelfHostedPostMerge: true,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.postMergeWorkflows.includes('ci.yml'));
  assert.ok(result.postMergeWorkflows.includes('native-ray-query.yml'));
  assert.ok(result.postMergeWorkflows.includes('post-merge-monitor.yml'));
  assert.equal(result.postMergeHostedSelectors.length, 0);
});

test('rejects a GitHub-hosted selector in a main-push workflow', () => {
  const result = checkPostMergeRunnerPolicy(
    [
      'name: Main push',
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  hosted:',
      '    runs-on: ubuntu-latest',
    ].join('\n'),
    'main-push.yml',
  );
  assert.equal(result.mainPush, true);
  assert.match(result.errors[0], /post-merge job must use a self-hosted runner/);
});

test('allows a hosted selector for a manual-only job in a main-push workflow', () => {
  const result = checkPostMergeRunnerPolicy(
    [
      'name: Mixed',
      'on:',
      '  push:',
      '    branches: [main]',
      '  workflow_dispatch:',
      'jobs:',
      '  manual:',
      "    if: github.event_name == 'workflow_dispatch'",
      '    runs-on: ubuntu-latest',
    ].join('\n'),
    'mixed.yml',
  );
  assert.deepEqual(result.errors, []);
});

test('rejects a GitHub-hosted selector in a workflow-run monitor', () => {
  const result = checkPostMergeRunnerPolicy(
    [
      'name: Post merge',
      'on:',
      '  workflow_run:',
      '    workflows: [CI]',
      '    types: [completed]',
      '    branches: [main]',
      'jobs:',
      '  hosted:',
      "    if: github.event.workflow_run.event == 'push'",
      '    runs-on: ubuntu-latest',
    ].join('\n'),
    'post-merge.yml',
  );
  assert.equal(result.workflowRun, true);
  assert.match(result.errors[0], /post-merge job must use a self-hosted runner/);
});
