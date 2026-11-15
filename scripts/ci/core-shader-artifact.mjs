import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requestGitHub, runArtifacts, runJobs } from './ci-repair-qualification.mjs';

const sameRepository = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

async function belongsToSource(run, input, api) {
  if (
    run.path?.split('@')[0] !== '.github/workflows/ci.yml' ||
    run.event !== input.eventName ||
    run.head_sha !== input.sha ||
    run.head_branch !== input.branch ||
    !sameRepository(run.head_repository?.full_name, input.repository)
  )
    return false;
  if (input.eventName === 'pull_request') {
    if (
      !input.pr ||
      input.pr.head.sha !== input.sha ||
      !sameRepository(input.pr.head.repo?.full_name, input.repository)
    )
      return false;
    if (run.pull_requests?.some((pr) => pr.number === input.pr.number)) return true;
    if (run.pull_requests?.length !== 0) return false;
    const associated = await api(`repos/${input.repository}/commits/${input.sha}/pulls`);
    return (
      Array.isArray(associated) &&
      associated.some(
        (pr) =>
          pr.number === input.pr.number &&
          pr.head?.sha === input.sha &&
          pr.head?.ref === input.branch &&
          sameRepository(pr.head?.repo?.full_name, input.repository),
      )
    );
  }
  return input.eventName === 'push' || input.eventName === 'workflow_dispatch';
}

export async function coreShaderArtifact(
  input,
  api,
  { now = Date.now, wait = delay, waitMs = 65 * 60_000, pollMs = 15_000 } = {},
) {
  if (
    !/^[a-f0-9]{40}$/.test(input.sha ?? '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository ?? '')
  )
    throw new Error('invalid core shader source identity');
  const deadline = now() + waitMs;
  let lastRun;
  while (true) {
    const response = await api(
      `repos/${input.repository}/actions/workflows/ci.yml/runs?event=${input.eventName}&head_sha=${input.sha}&per_page=100`,
    );
    if (!Array.isArray(response.workflow_runs))
      throw new Error('core producer history unavailable');
    const matches = [];
    for (const run of response.workflow_runs)
      if (await belongsToSource(run, input, api)) matches.push(run);
    const run = matches.sort((a, b) => b.id - a.id)[0];
    if (run) {
      if (lastRun !== run.id) {
        console.log(
          `[core-shader-inputs] waiting for existing ci-core run=${run.id} source=${input.sha}`,
        );
        lastRun = run.id;
      }
      if (run.conclusion === 'cancelled') throw new Error(`core producer run ${run.id} cancelled`);
      const result = await completedCoreArtifact(run, input, api);
      if (result) return result;
      if (run.status === 'completed') throw new Error('core producer unavailable in completed run');
    }
    if (now() >= deadline) throw new Error(`core artifact unavailable for ${input.sha}`);
    await wait(Math.min(pollMs, deadline - now()));
  }
}

async function completedCoreArtifact(run, input, api) {
  const jobs = await runJobs(api, input.repository, run);
  const producers = jobs?.filter((job) => job.name === 'ci-core') ?? [];
  if (producers.length > 1) throw new Error('ambiguous core producer');
  const job = producers[0];
  if (job?.status === 'completed') {
    if (job.run_id !== run.id || job.conclusion !== 'success')
      throw new Error(`core producer ${job.id} did not succeed`);
    const artifacts = await runArtifacts(api, input.repository, run);
    const selected =
      artifacts?.filter((artifact) => artifact.name === `core-build-a${run.run_attempt}`) ?? [];
    if (selected.length !== 1)
      throw new Error('core artifact unavailable after successful producer');
    const artifact = selected[0];
    if (
      artifact.expired ||
      artifact.workflow_run?.id !== run.id ||
      artifact.workflow_run?.head_sha !== input.sha ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id <= 0 ||
      !/^sha256:[a-f0-9]{64}$/i.test(artifact.digest ?? '')
    )
      throw new Error('core artifact source or digest identity invalid');
    return {
      sourceRunId: run.id,
      sourceJobId: job.id,
      sourceSha: input.sha,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
    };
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = await coreShaderArtifact(
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
      artifact_id: result.artifactId,
      source_run_id: result.sourceRunId,
      source_job_id: result.sourceJobId,
      source_sha: result.sourceSha,
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
