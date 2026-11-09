import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Artifact producers and cheap aggregators deliberately retain their normal jobs.
export const repairReusableJobs = Object.freeze({
  'ci.yml': [
    'view-integration-shards',
    'primary-pnpm',
    'coverage-perf',
    'coverage-pnpm-shard',
    'coverage-pnpm',
    'smoke-fleet-required-context',
    'vitest-browser-shard',
    'shared-inputs-browser',
    'smoke-fleet',
    'bevy-smoke-fleet',
    'vitest-dawn',
    'portability-bun',
  ],
  'native-ray-query.yml': ['native-ray-query-contract', 'native-node-gi'],
  'sdk-pr-preflight.yml': ['consumers', 'aggregate'],
  'webgpu-compatibility.yml': ['compatibility'],
});

// A failed or explicitly fresh artifact consumer needs complete current inputs.
// Reuse providers only when the complete suite can inherit its prior validation.
export const repairArtifactSuites = Object.freeze({
  'ci.yml': { 'coverage-pnpm-shard': 'coverage-pnpm', 'smoke-fleet': 'smoke-fleet' },
  'sdk-pr-preflight.yml': { consumers: 'sdk-build', aggregate: 'sdk-build' },
});

const marker = /^\[ci-repair-reused\] run (\d+) job (\d+)$/;
const normal = (reason) => ({ reused: false, reason });
const workflowFile = (path = '') => path.split('@')[0].split('/').at(-1);
const sameRepository = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function repairDeclaration(body = '', repository) {
  if (typeof body !== 'string') return undefined;
  const lines = body.split('\n').filter((line) => /^CI-Repair-From:/.test(line));
  if (lines.length !== 1) return undefined;
  const value = lines[0].slice('CI-Repair-From:'.length).trim();
  const prefix = `https://github.com/${repository}/actions/runs/`;
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0
    ? Number(id)
    : undefined;
}

function freshChecks(body = '') {
  const lines = body.split('\n').filter((line) => /^CI-Repair-Rerun:/.test(line));
  if (lines.length === 0) return [];
  if (lines.length !== 1) return null;
  const names = lines[0]
    .slice('CI-Repair-Rerun:'.length)
    .split(',')
    .map((name) => name.trim());
  return names.every((name) => name.length > 0) && new Set(names).size === names.length
    ? names
    : null;
}

function declaredFreshExecution(body, checkName) {
  const rerun = freshChecks(body);
  if (rerun === null) return normal('repair-rerun-invalid');
  if (rerun.includes(checkName)) return normal('new-work-declared');
  return undefined;
}

// The declaration attests CI-repair purpose. File kinds do not invalidate a
// passed check; comparison evidence establishes only the required ancestry.
export function repairComparison(comparison) {
  return ['ahead', 'identical'].includes(comparison?.status);
}

export function samePullRequest(run, pr, repository) {
  if (
    run?.event !== 'pull_request' ||
    run.status !== 'completed' ||
    !sameRepository(run.head_repository?.full_name, repository) ||
    run.head_branch !== pr.head.ref
  )
    return false;
  if (run.pull_requests?.some((entry) => entry.number === pr.number)) return true;
  // GitHub can omit associations. A branch reused by an older PR is insufficient.
  return (
    run.pull_requests?.length === 0 &&
    Number.isFinite(Date.parse(pr.created_at)) &&
    Date.parse(run.created_at) >= Date.parse(pr.created_at)
  );
}

function inheritedSource(job) {
  const proofs = (job.steps ?? []).filter(
    (step) => step.conclusion === 'success' && step.name.startsWith('[ci-repair-reused]'),
  );
  if (proofs.length === 0) return null;
  const match = proofs.length === 1 ? marker.exec(proofs[0].name) : null;
  return match ? { runId: Number(match[1]), jobId: Number(match[2]) } : undefined;
}

async function runForWorkflow(api, repository, workflow, anchor, pr) {
  if (workflowFile(anchor.path) === workflow) return anchor;
  const response = await api(
    `repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${anchor.head_sha}&status=completed&per_page=100`,
  );
  return response.workflow_runs
    .filter((run) => samePullRequest(run, pr, repository))
    .sort((left, right) => right.id - left.id)[0];
}

async function successfulJob(api, repository, run, name) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    jobs.push(...response.jobs);
    if (jobs.length >= response.total_count) break;
    if (page === 10) return undefined;
  }
  const matches = jobs.filter((job) => job.name === name);
  return matches.length === 1 &&
    matches[0].run_id === run.id &&
    matches[0].status === 'completed' &&
    matches[0].conclusion === 'success'
    ? matches[0]
    : undefined;
}

async function originalSuccess(api, input, run, job) {
  const seen = new Set();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(job.id)) return undefined;
    seen.add(job.id);
    const source = inheritedSource(job);
    if (source === undefined) return undefined;
    if (source === null) return { run, job };
    run = await api(`repos/${input.repository}/actions/runs/${source.runId}`);
    job = await api(`repos/${input.repository}/actions/jobs/${source.jobId}`);
    if (
      !samePullRequest(run, input.pr, input.repository) ||
      workflowFile(run.path) !== input.workflow ||
      job.run_id !== run.id ||
      job.name !== input.checkName ||
      job.status !== 'completed' ||
      job.conclusion !== 'success'
    )
      return undefined;
  }
  return undefined;
}

function qualifiedAnchor(anchor, input) {
  return (
    workflowFile(anchor.path) === 'ci.yml' &&
    samePullRequest(anchor, input.pr, input.repository) &&
    anchor.id !== Number(input.currentRunId) &&
    anchor.head_sha !== input.pr.head.sha
  );
}

async function reusableArtifactSuite(api, input, run) {
  const consumer = repairArtifactSuites[input.workflow]?.[input.jobKey];
  if (!consumer) return true;
  if (declaredFreshExecution(input.pr.body, consumer)) return false;
  return Boolean(await successfulJob(api, input.repository, run, consumer));
}

/** Explicit CI-repair purpose accepts earlier passes, including implementation repairs. */
export async function ciRepairQualification(input, api) {
  if (input.eventName !== 'pull_request' || !input.pr) return normal('not-a-pr');
  const { pr, repository, workflow, jobKey, checkName, targetSha } = input;
  if (!repairReusableJobs[workflow]?.includes(jobKey))
    return normal('artifact-provider-or-aggregate');
  const baseline = repairDeclaration(pr.body, repository);
  if (!baseline) return normal('not-declared');
  const fresh = declaredFreshExecution(pr.body, checkName);
  if (fresh) return fresh;
  if (!sameRepository(pr.head.repo?.full_name, repository)) return normal('foreign-source');
  if (/\b(?:failure|cancelled)\b/.test(input.dependencyResults ?? ''))
    return normal('dependency-failed');
  const anchor = await api(`repos/${repository}/actions/runs/${baseline}`);
  if (!qualifiedAnchor(anchor, input)) return normal('baseline-unqualified');
  const changes = await api(`repos/${repository}/compare/${anchor.head_sha}...${pr.head.sha}`);
  if (!repairComparison(changes)) return normal('baseline-not-ancestor');
  if (targetSha !== pr.head.sha) {
    const checkout = await api(`repos/${repository}/compare/${pr.head.sha}...${targetSha}`);
    if (!repairComparison(checkout)) return normal('checkout-inputs-unqualified');
  }
  const run = await runForWorkflow(api, repository, workflow, anchor, pr);
  if (!run) return normal('workflow-baseline-missing');
  if (!(await reusableArtifactSuite(api, input, run)))
    return normal('artifact-consumer-needs-fresh-inputs');
  const job = await successfulJob(api, repository, run, checkName);
  if (!job) return normal('check-did-not-pass');
  const source = await originalSuccess(api, { ...input, pr }, run, job);
  if (!source) return normal('reuse-provenance-unqualified');
  if (source.run.head_sha !== anchor.head_sha) {
    const comparison = await api(
      `repos/${repository}/compare/${source.run.head_sha}...${targetSha}`,
    );
    if (!repairComparison(comparison)) return normal('original-success-not-ancestor');
  }
  return {
    reused: true,
    reason: 'declared-ci-repair',
    sourceRunId: source.run.id,
    sourceJobId: source.job.id,
    sourceSha: source.run.head_sha,
    targetSha,
    sourceUrl: `https://github.com/${repository}/actions/runs/${source.run.id}/job/${source.job.id}`,
  };
}

export async function requestGitHub(endpoint, token, request = fetch) {
  if (!token) throw new Error('GitHub token unavailable');
  const response = await request(`https://api.github.com/${endpoint}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub history unavailable (${response.status})`);
  return response.json();
}

async function main() {
  let result = normal('qualification-unavailable');
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const api = (endpoint) => requestGitHub(endpoint, process.env.GH_TOKEN);
    result = await ciRepairQualification(
      {
        eventName: process.env.GITHUB_EVENT_NAME,
        pr: event.pull_request,
        repository: process.env.GITHUB_REPOSITORY,
        workflow: workflowFile(process.env.GITHUB_WORKFLOW_REF),
        jobKey: process.env.GITHUB_JOB,
        checkName: process.env.CI_REPAIR_CHECK_NAME,
        dependencyResults: process.env.CI_REPAIR_DEPENDENCY_RESULTS,
        currentRunId: process.env.GITHUB_RUN_ID,
        targetSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      api,
    );
  } catch {
    // Missing API access, unavailable history or malformed metadata runs normal CI.
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    const rows = {
      reused: result.reused,
      source_run_id: result.sourceRunId ?? '',
      source_job_id: result.sourceJobId ?? '',
      source_job_url: result.sourceUrl ?? '',
    };
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(rows)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = result.reused
      ? `Reused [the earlier successful check](${result.sourceUrl}).\n\nOriginal source: \`${result.sourceSha}\`. Current checkout: \`${result.targetSha}\`.\n\nThe check was not executed again in this run. Required artifacts are preserved or rebuilt before consumers execute.\n`
      : `Normal CI execution: \`${result.reason}\`.\n`;
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### CI repair: ${process.env.CI_REPAIR_CHECK_NAME}\n\n${summary}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
