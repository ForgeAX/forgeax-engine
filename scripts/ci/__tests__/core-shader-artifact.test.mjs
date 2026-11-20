import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { coreShaderArtifact } from '../core-shader-artifact.mjs';

const repository = 'ForgeAX/forgeax-engine';
const sha = 'a'.repeat(40);
function fixture() {
  const pr = { number: 5146, head: { sha, ref: 'repair', repo: { full_name: repository } } };
  const run = {
    id: 11,
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    head_sha: sha,
    head_branch: 'repair',
    head_repository: { full_name: repository },
    pull_requests: [{ number: pr.number }],
    run_attempt: 1,
    status: 'in_progress',
  };
  const job = {
    id: 22,
    run_id: run.id,
    name: 'ci-core',
    status: 'completed',
    conclusion: 'success',
  };
  const artifact = {
    id: 33,
    name: 'core-build-a1',
    expired: false,
    digest: `sha256:${'b'.repeat(64)}`,
    workflow_run: { id: run.id, head_sha: sha },
  };
  const api = async (endpoint) => {
    if (endpoint.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [run] };
    if (endpoint.includes('/jobs?')) return { total_count: 1, jobs: [job] };
    if (endpoint.includes('/artifacts?')) return { total_count: 1, artifacts: [artifact] };
    if (endpoint.endsWith('/pulls')) return [pr];
    throw new Error(`unexpected API endpoint: ${endpoint}`);
  };
  const input = { repository, sha, eventName: 'pull_request', branch: 'repair', pr };
  return { input, api, run, job, artifact, pr };
}

test('admits a successful core producer while independent CI jobs are still running', async () => {
  const f = fixture();
  assert.deepEqual(await coreShaderArtifact(f.input, f.api), {
    sourceRunId: 11,
    sourceJobId: 22,
    sourceSha: sha,
    artifactId: 33,
    artifactName: 'core-build-a1',
    artifactDigest: f.artifact.digest,
  });
});

function failedOnlyRetryFixture() {
  const f = fixture();
  f.run.run_attempt = 2;
  const original = {
    ...f.job,
    run_attempt: 1,
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:01:00Z',
  };
  Object.assign(f.job, original, { id: 44, run_attempt: 2 });
  const history = [original, f.job];
  return {
    ...f,
    original,
    history,
    api: (endpoint) =>
      endpoint.includes('/jobs?filter=all&')
        ? { total_count: history.length, jobs: history }
        : f.api(endpoint),
  };
}

test('retains the original core artifact and execution after a failed-only retry', async () => {
  const f = failedOnlyRetryFixture();
  const result = await coreShaderArtifact(f.input, f.api);
  assert.equal(result.sourceJobId, f.original.id);
  assert.equal(result.artifactId, f.artifact.id);
  assert.equal(result.artifactName, 'core-build-a1');
  assert.equal(result.artifactDigest, f.artifact.digest);
  assert.equal(result.sourceSha, sha);
});

test('an earlier artifact cannot replace a new or unproven core execution', async () => {
  for (const change of [
    (f) => {
      f.job.started_at = '2026-01-01T00:02:00Z';
      f.job.completed_at = '2026-01-01T00:03:00Z';
    },
    (f) => {
      f.job.completed_at = '2026-01-01T00:01:01Z';
    },
    (f) => {
      delete f.job.started_at;
    },
    (f) => {
      f.original.conclusion = 'failure';
    },
    (f) => {
      f.original.run_id = 99;
    },
    (f) => {
      f.history.push({ ...f.original, id: 55 });
    },
    (f) => {
      f.artifact.expired = true;
    },
    (f) => {
      f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    },
    (f) => {
      f.artifact.digest = '';
    },
  ]) {
    const f = failedOnlyRetryFixture();
    change(f);
    await assert.rejects(coreShaderArtifact(f.input, f.api, { waitMs: 0 }));
  }
});

test('waits for the existing producer and never selects the shared point artifact', async () => {
  const f = fixture();
  f.job.status = 'in_progress';
  f.job.conclusion = null;
  let time = 0;
  const result = await coreShaderArtifact(f.input, f.api, {
    now: () => time,
    wait: async () => {
      time += 1000;
      f.job.status = 'completed';
      f.job.conclusion = 'success';
    },
    waitMs: 2000,
  });
  assert.equal(result.artifactId, 33);
  f.artifact.name = 'shared-app-inputs-a1';
  await assert.rejects(
    coreShaderArtifact(f.input, f.api, { waitMs: 0 }),
    /core artifact unavailable/,
  );
});

test('rejects incorrect run, source, PR, producer and payload identities', async () => {
  for (const change of [
    (f) => {
      f.run.head_sha = 'c'.repeat(40);
    },
    (f) => {
      f.run.head_branch = 'other';
    },
    (f) => {
      f.run.head_repository.full_name = 'other/engine';
    },
    (f) => {
      f.run.pull_requests = [{ number: 1 }];
    },
    (f) => {
      f.run.event = 'push';
    },
    (f) => {
      f.run.path = '.github/workflows/sdk-pr-preflight.yml';
    },
    (f) => {
      f.run.conclusion = 'cancelled';
    },
    (f) => {
      f.job.conclusion = 'failure';
    },
    (f) => {
      f.job.conclusion = 'skipped';
    },
    (f) => {
      f.job.run_id = 99;
    },
    (f) => {
      f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    },
    (f) => {
      f.artifact.workflow_run.id = 99;
    },
    (f) => {
      f.artifact.expired = true;
    },
    (f) => {
      f.artifact.digest = '';
    },
    (f) => {
      f.artifact.name = 'core-build-a2';
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(coreShaderArtifact(f.input, f.api, { waitMs: 0 }));
  }
});

test('missing PR association requires an independent matching commit association', async () => {
  const f = fixture();
  f.run.pull_requests = [];
  assert.equal((await coreShaderArtifact(f.input, f.api)).artifactId, 33);
  const api = (endpoint) => (endpoint.endsWith('/pulls') ? [] : f.api(endpoint));
  await assert.rejects(coreShaderArtifact(f.input, api, { waitMs: 0 }));
});

test('producer waiting is bounded without starting a source compiler', async () => {
  const f = fixture();
  f.job.status = 'in_progress';
  let time = 0;
  await assert.rejects(
    coreShaderArtifact(f.input, f.api, {
      now: () => time,
      wait: async () => {
        time += 1000;
      },
      waitMs: 2000,
    }),
    /core artifact unavailable/,
  );
  assert.equal(time, 2000);
});

test('compatibility waits for core transfer before its unchanged carrier execution deadline', () => {
  const workflow = parse(readFileSync('.github/workflows/webgpu-compatibility.yml', 'utf8'));
  const admission = workflow.jobs['shader-producer-inputs'];
  const carrier = workflow.jobs.compatibility;
  assert.equal(admission.outputs.artifact_id, '${{ steps.core.outputs.artifact_id }}');
  assert.equal(carrier.needs, 'shader-producer-inputs');
  assert.equal(carrier.if, '${{ always() && !cancelled() }}');
  assert.equal(carrier['timeout-minutes'], 30);
  assert.deepEqual(carrier.strategy.matrix.carrier, ['stable', 'reference', 'legacy', 'webkit']);
  const restore = carrier.steps.find(
    (step) => step.name === 'Restore the admitted Core compiler payload',
  );
  const gpu = carrier.steps.find((step) => step.name?.startsWith('Run actual GPU compatibility'));
  assert.match(restore.run, /needs\.shader-producer-inputs\.outputs\.artifact_id/);
  assert.match(restore.run, /restore-core-shader-inputs\.mjs/);
  assert.match(restore.run, /--compiler-only --build-packages/);
  assert.equal(
    carrier.steps.some((step) => step.uses === './.github/actions/prepare-wgpu-wasm'),
    false,
  );
  const webkit = carrier.steps.find((step) => step.name?.startsWith('Prepare pinned Linux WebKit'));
  assert.ok(carrier.steps.indexOf(restore) < carrier.steps.indexOf(webkit));
  assert.equal(restore['timeout-minutes'], 5);
  assert.ok(carrier.steps.indexOf(restore) < carrier.steps.indexOf(gpu));
});
