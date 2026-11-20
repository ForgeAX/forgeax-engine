import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  changedCiInputs,
  comparedCiInputs,
  engineWithoutViewRequired,
  internalSourceOwners,
} from '../ci-input-changes.mjs';
import {
  baselineGroupResult,
  findCoverageProducer,
  reusableCoverageGroup,
  writeCoverageBaseline,
} from '../coverage-baseline.mjs';

const group = { label: 'model', projects: ['@engine/model'], files: [], excludes: [], weight: 900 };
const owner = (dir, dependencies) => ({ dir, manifest: { dependencies } });
const packages = new Map([
  ['@engine/model', owner('model', { '@engine/math': 'workspace:*' })],
  ['@engine/math', owner('math', { '@engine/model': 'workspace:*' })],
  ['@engine/other', owner('other', {})],
]);

test('coverage only reuses unaffected package closure, excluding executable external journeys', () => {
  assert.equal(reusableCoverageGroup(group, packages, new Set(['other'])), true);
  assert.equal(reusableCoverageGroup(group, packages, new Set(['math'])), false);
  assert.equal(reusableCoverageGroup(group, packages, new Set(['unclassified'])), false);
  for (const extra of [
    { files: ['packages/model/src/setup.e2e.test.ts'] },
    { projects: ['unclassified'] },
    { sourceCompilation: true },
    { gpuLease: true },
  ])
    assert.equal(reusableCoverageGroup({ ...group, ...extra }, packages, new Set()), false);
});

test('a portable coverage receipt re-roots only matching untouched coverage and successful tests', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-coverage-success-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, 'packages/model');
  mkdirSync(manifest, { recursive: true });
  writeFileSync(join(manifest, 'package.json'), JSON.stringify({ name: '@engine/model' }));
  const filename = 'packages/model/src/model.ts';
  const file = join(root, filename);
  const tested = 'packages/model/src/model.unit.test.ts';
  const dst = join(root, 'coverage.json');
  writeFileSync(dst, JSON.stringify({ [file]: { path: file, s: { 1: 2 } } }));
  const report = { success: true, testResults: [{ name: join(root, tested) }] };
  writeCoverageBaseline(root, root, 'a'.repeat(40), [group], [{ report, coveragePath: dst }]);
  const baseline = JSON.parse(readFileSync(join(root, 'group-baseline.json'), 'utf8'));
  const green = (result) => result?.success === true;
  const next = join(root, 'new-workspace');
  const reused = baselineGroupResult(next, group, baseline, new Set(), green);
  t.after(() => rmSync(reused.tempDir, { recursive: true, force: true }));
  assert.equal(reused.report.testResults[0].name, join(next, tested));
  const coverage = JSON.parse(readFileSync(reused.coveragePath, 'utf8'));
  assert.deepEqual(coverage[join(next, filename)], { path: join(next, filename), s: { 1: 2 } });
  for (const input of [filename, tested])
    assert.equal(baselineGroupResult(next, group, baseline, new Set([input]), green), undefined);
  assert.equal(
    baselineGroupResult(next, { ...group, label: 'other' }, baseline, new Set(), green),
    undefined,
  );
});

test('the next baseline retains each inherited group’s real original execution', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-coverage-republished-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownerDir = join(root, 'packages/model');
  mkdirSync(ownerDir, { recursive: true });
  writeFileSync(join(ownerDir, 'package.json'), JSON.stringify({ name: '@engine/model' }));
  const file = join(ownerDir, 'src/model.ts');
  const path = join(root, 'coverage.json');
  const inherited = { group: group.label, source: 'a'.repeat(40), run: 1, job: 2, artifact: 3 };
  const report = {
    success: true,
    testResults: [{ name: join(ownerDir, 'src/model.unit.test.ts') }],
  };
  writeFileSync(path, JSON.stringify({ [file]: { path: file, s: { 1: 2 } } }));
  writeCoverageBaseline(
    root,
    root,
    'b'.repeat(40),
    [group],
    [{ report, coveragePath: path, inherited }],
  );
  const baseline = JSON.parse(readFileSync(join(root, 'group-baseline.json'), 'utf8'));
  const reused = baselineGroupResult(root, group, baseline, new Set(), (result) => result.success);
  t.after(() => rmSync(reused.tempDir, { recursive: true, force: true }));
  assert.equal(baseline.source, 'b'.repeat(40));
  assert.deepEqual(reused.origin, inherited);
});

test('a merged repair can nominate only its same-PR original Coverage execution', async () => {
  const repository = 'example/engine';
  const originalSha = 'a'.repeat(40);
  const prHead = 'b'.repeat(40);
  const main = 'c'.repeat(40);
  const pr = {
    number: 91,
    base: { ref: 'main' },
    head: { sha: prHead, ref: 'repair' },
    merge_commit_sha: main,
    merged_at: '2026-11-19T12:30:00Z',
  };
  const original = {
    id: 52,
    event: 'pull_request',
    status: 'completed',
    path: '.github/workflows/ci.yml',
    head_sha: originalSha,
    head_branch: pr.head.ref,
    head_repository: { full_name: repository },
    pull_requests: [{ number: pr.number }],
  };
  const repaired = { ...original, id: 63, head_sha: prHead, conclusion: 'success' };
  const job = (run, id, name) => ({
    id,
    run_id: run.id,
    head_sha: run.head_sha,
    name: 'coverage-pnpm-shard-1',
    conclusion: 'success',
    steps: [{ name, conclusion: 'success' }],
  });
  const marker = '[ci-repair-reused] run 52 job 402';
  const produced = 'Vitest coverage (v8) (bounded runtime children)';
  const routes = {
    [`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${main}&status=success&per_page=5`]:
      { workflow_runs: [] },
    [`commits/${main}/pulls`]: [pr],
    [`git/commits/${main}`]: { tree: { sha: 'same-tree' } },
    [`git/commits/${prHead}`]: { tree: { sha: 'same-tree' } },
    [`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${prHead}&per_page=100`]: {
      workflow_runs: [repaired],
    },
    'actions/runs/63/jobs?filter=latest&per_page=100&page=1': {
      jobs: [job(repaired, 490, marker)],
      total_count: 1,
    },
    'actions/runs/52': original,
    'actions/runs/52/jobs?filter=latest&per_page=100&page=1': {
      jobs: [job(original, 402, produced)],
      total_count: 1,
    },
  };
  const api = async (endpoint) => {
    const route = endpoint.replace(`repos/${repository}/`, '');
    assert.ok(route in routes, `unexpected API route: ${route}`);
    return routes[route];
  };
  const admitted = await findCoverageProducer(api, repository, main, 1);
  assert.equal(admitted.run.head_sha, originalSha);
  assert.equal(admitted.job.id, 402);
  original.pull_requests = [{ number: 90 }];
  assert.equal(await findCoverageProducer(api, repository, main, 1), undefined);
  original.pull_requests = [{ number: pr.number }];
  routes['actions/runs/52/jobs?filter=latest&per_page=100&page=1'].jobs = [
    job(original, 402, marker),
  ];
  assert.equal(await findCoverageProducer(api, repository, main, 1), undefined);
});

test('uncertain CI input changes retain full verification', () => {
  const change = (path, status = 'M') => ({ path, status });
  assert.deepEqual(
    internalSourceOwners([change('packages/math/src/vector.ts')]),
    new Set(['math']),
  );
  for (const edited of [
    change('packages/math/src/vector.ts', 'A'),
    change('packages/math/src/__tests__/vector.unit.test.ts'),
    change('packages/math/src/string.wgsl'),
    change('pnpm-lock.yaml'),
    change('packages/modeling'),
  ])
    assert.equal(internalSourceOwners([edited]), undefined);
  assert.equal(engineWithoutViewRequired(undefined), true);
  assert.equal(
    engineWithoutViewRequired({ files: [change('tools/view'), change('skills/example/SKILL.md')] }),
    false,
  );
  assert.equal(engineWithoutViewRequired({ files: [change('scripts/build.mjs')] }), true);
});

test('CI uses the exact base and checkout and treats a rename as a deletion and addition', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-ci-source-comparison-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', ...args],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  const directory = 'packages/math/src';
  const before = `${directory}/before.ts`;
  const after = `${directory}/after.ts`;
  git('init', '-q');
  mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, before), 'export const value = 7;\n');
  git('add', before);
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('mv', before, after);
  git('commit', '-qm', 'rename');
  const target = git('rev-parse', 'HEAD');
  const eventFile = join(root, 'event.json');
  const event = {
    pull_request: {
      base: { sha: base, ref: 'main', repo: { full_name: 'example/engine' } },
      head: { sha: target },
    },
  };
  writeFileSync(eventFile, JSON.stringify(event));
  const env = {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'example/engine',
    GITHUB_EVENT_PATH: eventFile,
  };
  const comparison = comparedCiInputs(root, env);
  assert.equal(comparison.base, base);
  assert.equal(comparison.target, target);
  assert.deepEqual(changedCiInputs(root, base, target), comparison.files);
  assert.deepEqual(comparison.files.map(({ status }) => status).sort(), ['A', 'D']);
  assert.equal(internalSourceOwners(comparison.files), undefined);
  event.pull_request.head.sha = base;
  writeFileSync(eventFile, JSON.stringify(event));
  assert.equal(comparedCiInputs(root, env), undefined);
});
