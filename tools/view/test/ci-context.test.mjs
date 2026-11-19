import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciContext } from '../scripts/ci/context.mjs';
const repository = 'ForgeAX/forgeax-view';
const source = 'a'.repeat(40), candidate = 'b'.repeat(40);
const event = body => ({ pull_request: { number: 247, head: { sha: candidate }, body } });
const run = { id: 10, repository: { full_name: repository }, event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed', head_sha: source, pull_requests: [{ number: 247 }] };
const jobs = { total_count: 1, jobs: [{ id: 20, name: 'architecture', conclusion: 'success', steps: [] }] };
const request = overrides => async path => {
  const data = { '/actions/runs/10': run, [`/compare/${source}...${candidate}`]: { status: 'ahead' }, '/actions/runs/10/jobs?per_page=100': jobs, '/actions/runs/10/artifacts?per_page=100': { total_count: 1, artifacts: [{ name: 'paired-shader-inputs', expired: false, size_in_bytes: 100, workflow_run: { id: 10, head_sha: source } }] }, ...overrides };
  assert.ok(Object.hasOwn(data, path), `Unexpected API ${path}`);
  return data[path];
};
test('normal CI uses the Engine main branch and executes architecture', async () => {
  assert.deepEqual(await ciContext({}, repository, async () => { throw new Error('No API expected'); }), { engine_ref: 'main', architecture_reused: 'false', architecture_origin: '', build_origin: '', build_artifact_run: '', browser_origins: '{"0":"","1":"","2":"","3":""}', view_shards: '[0,1,2,3]' });
});
test('paired repair retains the original successful job and full source identity', async () => {
  const result = await ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10`), repository, request());
  assert.equal(result.engine_ref, candidate);
  assert.equal(result.architecture_reused, 'true');
  assert.equal(result.architecture_origin, `run 10 job 20 source ${source}`);
});
test('failed architecture executes again while unrelated provenance remains explicit', async () => {
  const result = await ciContext(event('CI-Repair-From: 10'), repository, request({ '/actions/runs/10/jobs?per_page=100': { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }] } }));
  assert.equal(result.architecture_reused, 'false');
});
test('foreign, unfinished, divergent and incomplete history cannot reuse a success', async () => {
  for (const overrides of [{ '/actions/runs/10': { ...run, pull_requests: [{ number: 248 }] } }, { '/actions/runs/10': { ...run, status: 'in_progress' } }, { [`/compare/${source}...${candidate}`]: { status: 'diverged' } }, { '/actions/runs/10/jobs?per_page=100': { ...jobs, total_count: 101 } }])
    await assert.rejects(ciContext(event('CI-Repair-From: 10'), repository, request(overrides)));
});
test('duplicate repair declarations retain full execution; Engine source requires a full SHA', async () => {
  assert.equal((await ciContext(event('CI-Repair-From: 10\nCI-Repair-From: 11'), repository, request())).architecture_reused, 'false');
  await assert.rejects(ciContext(event('Engine-Revision: feature-branch'), repository, request()));
});
test('a reuse wrapper is traced back to the actual executed source job', async () => {
  const original = 'c'.repeat(40);
  const result = await ciContext(event('CI-Repair-From: 10'), repository, request({
    '/actions/runs/10/jobs?per_page=100': { ...jobs, jobs: [{ ...jobs.jobs[0], steps: [{ name: `Reuse architecture: run 5 job 6 source ${original}`, conclusion: 'success' }] }] },
    '/actions/runs/5': { ...run, id: 5, head_sha: original },
    '/actions/jobs/6': { id: 6, run_id: 5, name: 'architecture', conclusion: 'success' },
    [`/compare/${original}...${candidate}`]: { status: 'ahead' },
  }));
  assert.equal(result.architecture_origin, `run 5 job 6 source ${original}`);
});

test('paired jobs materialize the pinned Modeling package before workspace resolution', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const name of ['architecture', 'build', 'browser']) {
    const start = workflow.indexOf(`  ${name}:\n`);
    const block = workflow.slice(start + 1).split(/\n  [a-z][a-z-]*:/)[0];
    const materialize = block.indexOf('node scripts/ci/prepare-source-checkout.mjs packages/modeling');
    const install = block.indexOf('run: pnpm install');
    assert.ok(materialize >= 0 && materialize < install, `${name} must resolve the pinned workspace before installation`);
    assert.match(block, /repository: ForgeAX\/forgeax-engine[\s\S]*?persist-credentials: true/);
  }
});

const completeJobs = () => ({ total_count: 7, jobs: ['architecture', 'build', ...[0, 1, 2, 3].map(i => `browser (${i})`), 'bootstrap'].map((name, i) => ({ id: 20 + i, name, conclusion: 'success', steps: [] })) });

test('a failed consumer retains each independent successful build and browser execution', async () => {
  const full = completeJobs();
  const result = await ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10`), repository, request({
    '/actions/runs/10': { ...run, conclusion: 'failure' },
    '/actions/runs/10/jobs?per_page=100': { ...full, jobs: full.jobs.map(job =>
      ['browser (2)', 'bootstrap'].includes(job.name) ? { ...job, conclusion: 'failure' } : job) },
  }));
  assert.equal(result.build_origin, `run 10 job 21 source ${source}`);
  assert.deepEqual(JSON.parse(result.view_shards), [0, 1, 2, 3]);
  const origins = JSON.parse(result.browser_origins);
  assert.equal(origins[2], '');
  for (const shard of [0, 1, 3]) assert.equal(origins[shard], `run 10 job ${22 + shard} source ${source}`);
});

test('explicit fresh execution overrides individual successes without discarding their siblings', async () => {
  const result = await ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10\nCI-Repair-Rerun: architecture, browser (3)`), repository, request({
    '/actions/runs/10': { ...run, conclusion: 'success' },
    '/actions/runs/10/jobs?per_page=100': completeJobs(),
  }));
  assert.equal(result.architecture_reused, 'false');
  assert.equal(result.build_origin, `run 10 job 21 source ${source}`);
  assert.equal(JSON.parse(result.browser_origins)[3], '');
  assert.equal(JSON.parse(result.browser_origins)[0], `run 10 job 22 source ${source}`);
});

test('ambiguous or unknown fresh check declarations fail closed', async () => {
  for (const body of [
    'CI-Repair-Rerun: browser (4)',
    'CI-Repair-Rerun: build,',
    'CI-Repair-Rerun: build, build',
    'CI-Repair-Rerun: build\nCI-Repair-Rerun: architecture',
  ]) await assert.rejects(ciContext(event(`CI-Repair-From: 10\n${body}`), repository, request()));
});

test('fresh browsers require a fixed Engine SHA or a fresh build that resolves it', async () => {
  for (const engine of ['', `Engine-Revision: ${candidate}\n`]) {
    const result = await ciContext(event(`${engine}CI-Repair-From: 10\nCI-Repair-Rerun: browser (2)`), repository, request({
      '/actions/runs/10': { ...run, conclusion: 'success' },
      '/actions/runs/10/jobs?per_page=100': completeJobs(),
    }));
    assert.equal(result.build_origin, engine ? `run 10 job 21 source ${source}` : '');
    assert.equal(JSON.parse(result.browser_origins)[2], '');
    assert.equal(JSON.parse(result.browser_origins)[3], `run 10 job 25 source ${source}`);
  }
});

test('an explicitly fresh or failed build retains independent successful browser executions', async () => {
  for (const failed of [false, true]) {
    const full = completeJobs();
    const result = await ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10${failed ? '' : '\nCI-Repair-Rerun: build'}`), repository, request({
      '/actions/runs/10': { ...run, conclusion: failed ? 'failure' : 'success' },
      '/actions/runs/10/jobs?per_page=100': { ...full, jobs: full.jobs.map(job =>
        failed && job.name === 'build' ? { ...job, conclusion: 'failure' } : job) },
    }));
    assert.equal(result.build_origin, '');
    assert.ok(Object.values(JSON.parse(result.browser_origins)).every(value => value.startsWith('run 10 job ')));
  }
});

test('fresh consumers require the original build artifact while successful siblings retain provenance', async () => {
  const artifact = { name: 'paired-shader-inputs', expired: false, size_in_bytes: 100,
    workflow_run: { id: 10, head_sha: source } };
  for (const artifacts of [
    [], [{ ...artifact, expired: true }], [{ ...artifact, size_in_bytes: 0 }],
    [{ ...artifact, workflow_run: { id: 11, head_sha: source } }],
    [{ ...artifact, workflow_run: { id: 10, head_sha: candidate } }], [artifact, artifact],
    [artifact],
  ]) {
    const result = await ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10\nCI-Repair-Rerun: browser (2)`), repository, request({
      '/actions/runs/10': { ...run, conclusion: 'success' },
      '/actions/runs/10/jobs?per_page=100': completeJobs(),
      '/actions/runs/10/artifacts?per_page=100': { total_count: artifacts.length, artifacts },
    }));
    const valid = artifacts.length === 1 && artifacts[0] === artifact;
    assert.equal(result.build_origin, valid ? `run 10 job 21 source ${source}` : '');
    assert.equal(result.build_artifact_run, valid ? '10' : '');
    assert.equal(JSON.parse(result.browser_origins)[3], `run 10 job 25 source ${source}`);
  }
  await assert.rejects(ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10\nCI-Repair-Rerun: browser (2)`), repository, request({
    '/actions/runs/10': { ...run, conclusion: 'success' },
    '/actions/runs/10/jobs?per_page=100': completeJobs(),
    '/actions/runs/10/artifacts?per_page=100': { total_count: 101, artifacts: [] },
  })), /complete build artifact history/);
});

test('a partial repair retrieves the original artifact behind an inherited build wrapper', async () => {
  const full = completeJobs();
  full.jobs[1].steps = [{ name: `Reuse build: run 5 job 6 source ${source}`, conclusion: 'success' }];
  const routes = {
    '/actions/runs/10': { ...run, conclusion: 'success' },
    '/actions/runs/10/jobs?per_page=100': full,
    '/actions/runs/5': { ...run, id: 5 },
    '/actions/jobs/6': { id: 6, run_id: 5, name: 'build', conclusion: 'success' },
    '/actions/runs/5/artifacts?per_page=100': { total_count: 1, artifacts: [{
      name: 'paired-shader-inputs', expired: false, size_in_bytes: 100,
      workflow_run: { id: 5, head_sha: source },
    }] },
  };
  const body = `Engine-Revision: ${candidate}\nCI-Repair-From: 10\nCI-Repair-Rerun: browser (2)`;
  const result = await ciContext(event(body), repository, request(routes));
  assert.equal(result.build_origin, `run 5 job 6 source ${source}`);
  assert.equal(result.build_artifact_run, '5');
  const originalRequest = request(routes);
  const unavailable = await ciContext(event(body), repository, async path => {
    if (path === '/actions/runs/5/artifacts?per_page=100') throw new Error('Artifact API unavailable');
    return originalRequest(path);
  });
  assert.equal(unavailable.build_origin, '');
  assert.equal(unavailable.build_artifact_run, '');
  assert.equal(JSON.parse(unavailable.browser_origins)[3], `run 10 job 25 source ${source}`);
});

test('a completely successful repair cohort reuses every original consumer with all four shards', async () => {
  const result = await ciContext(event('CI-Repair-From: 10'), repository, request({
    '/actions/runs/10': { ...run, conclusion: 'success' },
    '/actions/runs/10/jobs?per_page=100': completeJobs(),
  }));
  assert.equal(result.build_origin, `run 10 job 21 source ${source}`);
  assert.deepEqual(JSON.parse(result.view_shards), [0, 1, 2, 3]);
  for (const [i, origin] of Object.entries(JSON.parse(result.browser_origins)))
    assert.equal(origin, `run 10 job ${22 + Number(i)} source ${source}`);
});

test('failed, missing and duplicate jobs execute fresh while independently successful jobs remain reusable', async () => {
  const full = completeJobs();
  for (const history of [
    { ...full, jobs: full.jobs.map(job => job.name === 'browser (2)' ? { ...job, conclusion: 'failure' } : job) },
    { total_count: 6, jobs: full.jobs.filter(job => job.name !== 'browser (2)') },
    { total_count: 8, jobs: [...full.jobs, full.jobs[2]] },
  ]) {
    const result = await ciContext(event(`Engine-Revision: ${candidate}\nCI-Repair-From: 10`), repository, request({
      '/actions/runs/10': { ...run, conclusion: 'success' },
      '/actions/runs/10/jobs?per_page=100': history,
    }));
    assert.equal(result.architecture_reused, 'true');
    assert.equal(result.build_origin, `run 10 job 21 source ${source}`);
    const origins = JSON.parse(result.browser_origins);
    assert.equal(origins[history.total_count === 8 ? 0 : 2], '');
    assert.equal(origins[1], `run 10 job 23 source ${source}`);
  }
  await assert.rejects(ciContext(event('CI-Repair-From: 10'), repository, request({
    '/actions/runs/10': { ...run, path: '.github/workflows/foreign.yml' },
  })));
});

test('whole-cohort reuse follows each build and browser wrapper back to the executed source', async () => {
  const full = completeJobs();
  full.jobs[1].steps = [{ name: `Reuse build: run 5 job 6 source ${source}`, conclusion: 'success' }];
  const result = await ciContext(event('CI-Repair-From: 10'), repository, request({
    '/actions/runs/10': { ...run, conclusion: 'success' },
    '/actions/runs/10/jobs?per_page=100': full,
    '/actions/runs/5': { ...run, id: 5 },
    '/actions/jobs/6': { id: 6, run_id: 5, name: 'build', conclusion: 'success' },
  }));
  assert.equal(result.build_origin, `run 5 job 6 source ${source}`);
  await assert.rejects(ciContext(event('CI-Repair-From: 10'), repository, request({
    '/actions/runs/10': { ...run, conclusion: 'success' },
    '/actions/runs/10/jobs?per_page=100': full,
    '/actions/runs/5': { ...run, id: 5 },
    '/actions/jobs/6': { id: 6, run_id: 5, name: 'browser (0)', conclusion: 'success' },
  })));
});

function mainHistory(overrides = {}) {
  const merged = 'd'.repeat(40), tree = 'e'.repeat(40);
  const pr = { ...event(`Engine-Revision: ${source}\nCI-Repair-Rerun: build, browser (2)`).pull_request, merged_at: '2026-11-12T00:00:00Z', merge_commit_sha: merged, base: { ref: 'main' }, head: { sha: candidate, ref: 'feature', repo: { full_name: repository } } };
  const data = {
    [`/commits/${merged}/pulls`]: [pr],
    [`/commits/${merged}`]: { commit: { tree: { sha: tree } } },
    [`/commits/${candidate}`]: { commit: { tree: { sha: tree } } },
    [`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${candidate}&per_page=100`]: { total_count: 1, workflow_runs: [{ ...run, head_sha: candidate, conclusion: 'success' }] },
    [`/compare/${candidate}...${candidate}`]: { status: 'identical' },
    '/actions/runs/10/jobs?per_page=100': completeJobs(),
    ...overrides,
  };
  return { event: { ref: 'refs/heads/main', after: merged }, request: async path => {
    assert.ok(Object.hasOwn(data, path), `Unexpected API ${path}`);
    return data[path];
  } };
}

test('main promotion inherits only a successful PR cohort at exactly the merged Git tree', async () => {
  const fixture = mainHistory();
  const result = await ciContext(fixture.event, repository, fixture.request);
  assert.equal(result.engine_ref, source);
  assert.equal(result.build_origin, `run 10 job 21 source ${candidate}`);
});

test('a different merge tree, missing success or foreign merged PR keeps normal main execution', async () => {
  for (const overrides of [
    { [`/commits/${candidate}`]: { commit: { tree: { sha: 'f'.repeat(40) } } } },
    { [`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${candidate}&per_page=100`]: { total_count: 1, workflow_runs: [{ ...run, head_sha: candidate, conclusion: 'failure' }] } },
    { [`/commits/${'d'.repeat(40)}/pulls`]: [] },
  ]) {
    const fixture = mainHistory(overrides);
    const result = await ciContext(fixture.event, repository, fixture.request);
    assert.equal(result.build_origin, '');
    assert.equal(result.architecture_reused, 'false');
  }
});

test('fresh context contracts run before qualification and all inherited consumer steps are guarded', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node --test test\/ci-context.test.mjs test\/architecture-ci.test.mjs\n\s+node scripts\/ci\/context.mjs/);
  for (const name of ['build', 'browser']) {
    const start = workflow.indexOf(`  ${name}:\n`);
    const block = workflow.slice(start + 1).split(/\n  [a-z][a-z-]*:/)[0];
    const steps = block.split('\n      - ').slice(1);
    for (const step of steps)
      assert.match(step, name === 'build'
        ? /if: needs\.context\.outputs\.build_origin (?:!=|==) ''/
        : /if: fromJSON\(needs\.context\.outputs\.browser_origins\)\[format\('\{0\}', matrix\.shard\)\] (?:!=|==) ''/);
  }
  assert.match(workflow, /view_shards: \$\{\{ steps\.view-shards\.outputs\.shards \|\| needs\.context\.outputs\.view_shards \}\}/);
});

test('post-merge empty membership needs matching source, branch and independent commit association', async () => {
  const associated = [{ number: 247, head: { ref: 'feature', repo: { full_name: repository } } }];
  const empty = { ...run, head_sha: candidate, conclusion: 'success', pull_requests: [], head_repository: { full_name: repository }, head_branch: 'feature' };
  const route = `/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${candidate}&per_page=100`;
  const fixture = mainHistory({ [route]: { total_count: 1, workflow_runs: [empty] }, [`/commits/${candidate}/pulls`]: associated });
  assert.equal((await ciContext(fixture.event, repository, fixture.request)).build_origin, `run 10 job 21 source ${candidate}`);
  for (const invalid of [
    { ...empty, head_repository: { full_name: 'foreign/repo' } },
    { ...empty, head_branch: 'other' },
    { ...empty, pull_requests: [{ number: 248 }] },
  ]) {
    const rejected = mainHistory({ [route]: { total_count: 1, workflow_runs: [invalid] } });
    assert.equal((await ciContext(rejected.event, repository, rejected.request)).build_origin, '');
  }
  const missing = mainHistory({ [route]: { total_count: 1, workflow_runs: [empty] }, [`/commits/${candidate}/pulls`]: [] });
  assert.equal((await ciContext(missing.event, repository, missing.request)).build_origin, '');
});

test('the newest failure or unfinished run blocks main promotion over an older green run', async () => {
  const route = `/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${candidate}&per_page=100`;
  for (const latest of [
    { ...run, id: 11, head_sha: candidate, conclusion: 'failure' },
    { ...run, id: 11, head_sha: candidate, status: 'in_progress', conclusion: null },
  ]) {
    const fixture = mainHistory({ [route]: { total_count: 2, workflow_runs: [latest, { ...run, head_sha: candidate, conclusion: 'success' }] } });
    assert.equal((await ciContext(fixture.event, repository, fixture.request)).build_origin, '');
  }
});
