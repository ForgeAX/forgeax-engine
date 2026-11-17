import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requestGitHub, runJobs } from './ci-repair-qualification.mjs';
import { coreShaderArtifact, producerArtifact } from './core-shader-artifact.mjs';

/** Select both existing producers from the independently admitted Main run. */
export async function sdkShaderArtifacts(input, api, options = {}) {
  const { now = Date.now, wait = delay, waitMs = 65 * 60_000, pollMs = 15_000 } = options;
  const deadline = now() + waitMs;
  const core = await coreShaderArtifact(input, api, options);
  while (true) {
    const run = await api(`repos/${input.repository}/actions/runs/${core.sourceRunId}`);
    if (run.id !== core.sourceRunId || run.head_sha !== core.sourceSha)
      throw new Error('SDK point producer run identity changed');
    if (run.conclusion === 'cancelled') throw new Error('SDK point producer run cancelled');
    const jobs = await runJobs(api, input.repository, run);
    const producers = jobs?.filter((job) => job.name === 'shared-app-inputs') ?? [];
    if (producers.length > 1) throw new Error('ambiguous SDK point producer');
    const job = producers[0];
    if (job?.status === 'completed') {
      return completedSdkShaderArtifacts(input, api, core, run, job);
    }
    if (run.status === 'completed' || now() >= deadline)
      throw new Error('SDK point artifact unavailable from the admitted Main run');
    await wait(Math.min(pollMs, deadline - now()));
  }
}

async function completedSdkShaderArtifacts(input, api, core, run, job) {
  if (job.run_id !== run.id || job.conclusion !== 'success')
    throw new Error('SDK point producer did not succeed');
  const { artifact, sourceJob } = await producerArtifact(input, api, run, job);
  return {
    core,
    point: {
      sourceRunId: run.id,
      sourceJobId: sourceJob.id,
      sourceSha: input.sha,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
    },
  };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = await sdkShaderArtifacts(
    {
      repository: process.env.GITHUB_REPOSITORY,
      sha,
      eventName: process.env.GITHUB_EVENT_NAME,
      branch: event.pull_request?.head.ref ?? process.env.GITHUB_REF_NAME,
      pr: event.pull_request,
    },
    (endpoint) => requestGitHub(endpoint, process.env.GH_TOKEN),
  );
  console.log(JSON.stringify(result));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries({
      core_artifact_id: result.core.artifactId,
      point_artifact_id: result.point.artifactId,
      source_run_id: result.core.sourceRunId,
      source_sha: result.core.sourceSha,
      core_job_id: result.core.sourceJobId,
      point_job_id: result.point.sourceJobId,
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
