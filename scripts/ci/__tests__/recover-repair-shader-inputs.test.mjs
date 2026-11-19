import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reusableSharedShader, sharedShaderReceipt } from '../../lib/shared-build-cache.mjs';
import {
  findRepairShaderSource,
  restoreRepairShaderProfile,
} from '../recover-repair-shader-inputs.mjs';

const repository = 'ForgeAX/forgeax-engine';
const pr = {
  number: 77,
  body: 'CI-Repair-From: 103',
  created_at: '2026-01-01T00:00:00Z',
  head: { ref: 'ci-test', sha: 'd'.repeat(40), repo: { full_name: repository } },
};
const run = (id, sha, number = 77) => ({
  id,
  run_number: id,
  run_attempt: 1,
  event: 'pull_request',
  status: 'completed',
  path: '.github/workflows/ci.yml',
  head_branch: pr.head.ref,
  head_repository: pr.head.repo,
  head_sha: sha.repeat(40),
  pull_requests: [{ number }],
});

test('uses an earlier same-PR successful Core archive when the declared attempt failed', async () => {
  const anchor = run(103, 'c');
  const foreignPr = run(102, 'b', 78);
  const source = run(101, 'a');
  const artifact = {
    id: 601,
    name: 'shared-app-inputs-a1',
    expired: false,
    digest: `sha256:${'e'.repeat(64)}`,
    workflow_run: { id: source.id, head_sha: source.head_sha },
  };
  const prefix = `repos/${repository}`;
  const observed = [];
  const endpoints = new Map([
    [`${prefix}/actions/runs/103`, anchor],
    [
      `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&branch=ci-test&per_page=12`,
      { workflow_runs: [source, foreignPr, anchor] },
    ],
    [
      `${prefix}/actions/runs/103/jobs?filter=latest&per_page=100&page=1`,
      { total_count: 0, jobs: [] },
    ],
    [
      `${prefix}/actions/runs/101/jobs?filter=latest&per_page=100&page=1`,
      {
        total_count: 1,
        jobs: [
          { id: 501, run_id: 101, name: 'ci-core', status: 'completed', conclusion: 'success' },
        ],
      },
    ],
    [`${prefix}/compare/${source.head_sha}...${pr.head.sha}`, { status: 'ahead' }],
    [
      `${prefix}/actions/runs/101/artifacts?per_page=100&page=1`,
      { total_count: 1, artifacts: [artifact] },
    ],
  ]);
  const api = async (path) => {
    observed.push(path);
    assert.ok(endpoints.has(path), path);
    return endpoints.get(path);
  };
  assert.deepEqual(await findRepairShaderSource({ pr, repository }, api), {
    artifactId: artifact.id,
    runId: source.id,
    sha: source.head_sha,
  });
  assert.equal(
    observed.some((path) => path.includes('/102/')),
    false,
  );
});

test('leaves normal source preparation in control without a declared same-repo repair', async () => {
  const noApi = () => assert.fail('ordinary CI should not request a recovery artifact');
  assert.equal(await findRepairShaderSource({ pr: { ...pr, body: '' }, repository }, noApi), null);
  assert.equal(
    await findRepairShaderSource(
      {
        pr: { ...pr, head: { ...pr.head, repo: { full_name: 'another/repo' } } },
        repository,
      },
      noApi,
    ),
    null,
  );
});

test('releases the archive staging directory when the optional recovery child fails', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'failed-shader-recovery-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const eventPath = join(scratch, 'event.json');
  writeFileSync(eventPath, '{');
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../recover-repair-shader-inputs.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        FORGEAX_BUILD_NO_TASK_CACHE: '0',
        RUNNER_TEMP: scratch,
      },
      timeout: 5000,
    },
  );
  assert.match(output, /archive unavailable; Core will verify or build both profiles/);
  assert.deepEqual(readdirSync(scratch), ['event.json']);
});

function publishFixture(root, directory, bytes, fingerprint) {
  const payload = join(directory, 'shaders', 'manifest.json');
  mkdirSync(dirname(join(root, payload)), { recursive: true });
  writeFileSync(join(root, payload), bytes);
  writeFileSync(
    join(root, directory, 'manifest.json'),
    JSON.stringify({
      producer: 'shared-app-inputs',
      shaderBuild: sharedShaderReceipt(root, join(root, payload), fingerprint),
      payload: { engineShaderManifest: payload },
    }),
  );
}

test('copies exact source-bound payload bytes and rejects stale, wrong-profile or corrupt inputs', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'shader-recovery-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const producer = join(scratch, 'producer');
  const checkout = join(scratch, 'checkout');
  const source = 'shared-app-inputs/profiles/base-ssao';
  const destination = 'engine-inputs/base-ssao';
  const base = `sha256:${'b'.repeat(64)}`;
  const point = `sha256:${'c'.repeat(64)}`;
  const bytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 17, 22]);
  publishFixture(producer, source, bytes, base);

  assert.equal(restoreRepairShaderProfile(checkout, producer, source, destination, point), false);
  assert.equal(restoreRepairShaderProfile(checkout, producer, source, destination, base), true);
  const receipt = join(checkout, destination, 'manifest.json');
  const payload = reusableSharedShader(checkout, receipt, base);
  assert.deepEqual(readFileSync(payload), bytes);

  const damaged = join(producer, source, 'shaders', 'manifest.json');
  writeFileSync(damaged, 'corrupt');
  assert.equal(restoreRepairShaderProfile(checkout, producer, source, destination, base), false);
  assert.deepEqual(readFileSync(payload), bytes);
  assert.equal(
    restoreRepairShaderProfile(checkout, producer, source, 'another-destination', base),
    false,
  );
});
