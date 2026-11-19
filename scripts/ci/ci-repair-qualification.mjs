import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadArtifact, retryArtifact } from './download-artifact-with-retry.mjs';

// Current-input producers and cheap aggregators retain their normal jobs.
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
    'vitest-dawn',
    'portability-bun',
    'webkit-fallback',
    'metrics-validate-browser',
    'metrics-validate-runtime',
  ],
  'native-ray-query.yml': ['native-ray-query-contract', 'native-node-gi'],
  'sdk-pr-preflight.yml': ['consumers', 'aggregate'],
  'webgpu-compatibility.yml': ['compatibility'],
  'modeling-ci.yml': ['engine-candidate'],
});

// A successful name from before an owner moved cannot qualify its new work.
const repairRequiredExecutionSteps = {
  'ci.yml': {
    'view-integration-0': [
      'Prepare matching DevKit browser shader profile',
      'Runtime Pack Worker dev/build JS/TS browser gate',
    ],
    'view-integration-1': [
      'Prepare matching DevKit browser shader profile',
      'DevKit project play browser journeys (uninstrumented)',
    ],
  },
};

function repairExecutionIsComplete(workflow, checkName, job) {
  return (repairRequiredExecutionSteps[workflow]?.[checkName] ?? []).every((name) => {
    const steps = (job.steps ?? []).filter((step) => step.name === name);
    return (
      steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success'
    );
  });
}

// SDK repair aggregates validate independently qualified original reports.
// Coverage and smoke retain their shared-producer artifact requirements.
export const repairArtifactSuites = Object.freeze({
  'ci.yml': {
    'coverage-pnpm-shard': 'coverage-pnpm',
    'coverage-pnpm': 'coverage-pnpm',
    'smoke-fleet': 'smoke-fleet',
    'webkit-fallback': 'metrics-validate',
    'metrics-validate-browser': 'metrics-validate',
    'metrics-validate-runtime': 'metrics-validate',
  },
  'sdk-pr-preflight.yml': { consumers: 'sdk-build', aggregate: 'sdk-build' },
});

export const metricProducers = [
  'webkit-fallback',
  'metrics-validate-browser',
  'metrics-validate-runtime',
];
const metricMembers = [...metricProducers, 'metrics-validate'];

export const coverageMembers = [0, 1, 2, 3].map((shard) => `coverage-pnpm-shard-${shard}`);

export function assertCoverageInputsUnchanged(coveredFiles, changedFiles) {
  const configuration =
    /(^|\/)(?:package\.json|pnpm-lock\.yaml|bun\.lock|tsconfig[^/]*\.json)$|^(?:config\/vitest|vitest\.config\.|scripts\/ci\/run-split-vitest-coverage\.mjs)/;
  const changed = changedFiles.filter(
    (name) =>
      configuration.test(name) ||
      coveredFiles.some((covered) => covered === name || covered.startsWith(`${name}/`)),
  );
  if (changed.length) throw new Error(`coverage-repair-inputs-changed: ${changed.join(', ')}`);
}

async function readOriginalCoverageFiles(repository, artifact) {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'coverage-admission-'));
  const archive = join(directory, 'coverage.zip');
  try {
    await retryArtifact(() => downloadArtifact(repository, artifact.id, archive));
    const digest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
    if (digest !== artifact.digest) throw new Error('coverage-admission-artifact-digest');
    const coverage = JSON.parse(
      execFileSync('unzip', ['-p', archive, 'coverage-final.json'], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
    const files = Object.keys(coverage);
    if (files.length === 0 || files.some((name) => name.startsWith('/') || /^[A-Za-z]:/.test(name)))
      throw new Error('coverage-admission-file-roster');
    return files;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function changedCoverageFiles(sourceSha, targetSha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceSha}^{commit}`], { stdio: 'pipe' });
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sourceSha], {
      stdio: 'pipe',
    });
  }
  return execFileSync('git', ['diff', '--name-only', '-z', sourceSha, targetSha], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

async function coverageAdmission(input, source, api, readFiles, changedFiles, proof) {
  if (input.workflow !== 'ci.yml' || input.jobKey !== 'coverage-pnpm-shard') return proof;
  const artifacts = await runArtifacts(api, input.repository, source.run);
  const matches = artifacts?.filter(
    (artifact) =>
      artifact.name === input.checkName.replace('coverage-pnpm-shard-', 'coverage-shard-'),
  );
  const artifact = matches?.[0];
  if (
    matches?.length !== 1 ||
    !Number.isSafeInteger(artifact?.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') ||
    artifact.workflow_run?.id !== source.run.id ||
    artifact.workflow_run?.head_sha !== source.run.head_sha
  )
    return normal('coverage-artifact-unqualified');
  try {
    const covered = await readFiles(input.repository, artifact);
    assertCoverageInputsUnchanged(
      covered,
      await changedFiles(source.run.head_sha, input.targetSha),
    );
    return proof;
  } catch (error) {
    return {
      ...normal(
        error.message?.startsWith('coverage-repair-inputs-changed:')
          ? 'coverage-repair-inputs-changed'
          : 'coverage-inputs-unqualified',
      ),
      detail: error.message,
    };
  }
}
const coveragePlaceholder = `coverage-pnpm-shard-\${{ matrix.shard }}`;
const coverageArtifactRestoreStep =
  'Restore original successful and current fresh coverage artifacts';
const coverageUnrunSteps = [
  'Scrub stale global/system git auth header (self-hosted)',
  'Checkout',
  'Qualify earlier success for an explicit CI repair',
  'Materialize pinned View workspace',
  'Setup Node.js and pnpm',
  'Clear stale root dependency links (self-hosted)',
  'Install (frozen)',
  'Download coverage shards',
  'Merge coverage shards and enforce aggregate thresholds',
  'Coverage test performance budget',
];
const coverageDiagnosticSteps = [
  'Set up job',
  'Complete job',
  'Upload coverage diagnostics on failure (feat-20260608-ci-time-cut)',
  'Post Upload coverage diagnostics on failure (feat-20260608-ci-time-cut)',
];

const marker = /^\[ci-repair-reused\] run (\d+) job (\d+)$/;
const maxRepairHistoryDepth = 8;
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
  const value = lines[0].slice('CI-Repair-Rerun:'.length).trim();
  let names;
  try {
    names = value.startsWith('[') ? JSON.parse(value) : value.split(',').map((name) => name.trim());
  } catch {
    return null;
  }
  return Array.isArray(names) &&
    names.length > 0 &&
    names.every((name) => typeof name === 'string' && name.length > 0 && name.trim() === name) &&
    new Set(names).size === names.length
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

export function samePullRequestIdentity(run, pr, repository) {
  if (
    run?.event !== 'pull_request' ||
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

export function samePullRequest(run, pr, repository) {
  return run?.status === 'completed' && samePullRequestIdentity(run, pr, repository);
}

/** A manual repair source needs commit association, not just a reused branch name. */
export async function repairSourceBelongsToPr(api, run, pr, repository) {
  if (samePullRequest(run, pr, repository)) return true;
  if (
    run?.status !== 'completed' ||
    run.event !== 'workflow_dispatch' ||
    !sameRepository(run.repository?.full_name, repository) ||
    !sameRepository(run.head_repository?.full_name, repository) ||
    run.head_branch !== pr.head.ref ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
    !Number.isFinite(Date.parse(pr.created_at)) ||
    !(Date.parse(run.created_at) >= Date.parse(pr.created_at)) ||
    (run.pull_requests?.length > 0 &&
      !run.pull_requests.some((entry) => entry.number === pr.number))
  )
    return false;
  try {
    const associated = await api(`repos/${repository}/commits/${run.head_sha}/pulls`);
    return (
      Array.isArray(associated) &&
      associated.some(
        (candidate) =>
          candidate.number === pr.number &&
          sameRepository(candidate.head?.repo?.full_name, repository) &&
          candidate.head?.ref === pr.head.ref,
      )
    );
  } catch {
    return false;
  }
}

export function inheritedSource(job) {
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
  const selected = response.workflow_runs
    .filter((run) => run.head_sha === anchor.head_sha && samePullRequest(run, pr, repository))
    .sort((left, right) => right.id - left.id)[0];
  if (selected || anchor.event !== 'workflow_dispatch') return selected;
  const manual = await api(
    `repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${anchor.head_sha}&status=completed&per_page=100`,
  );
  for (const run of manual.workflow_runs.sort((left, right) => right.id - left.id))
    if (
      run.head_sha === anchor.head_sha &&
      (await repairSourceBelongsToPr(api, run, pr, repository))
    )
      return run;
  return undefined;
}

export async function runJobs(api, repository, run, filter = 'latest') {
  if (filter !== 'latest' && filter !== 'all') throw new Error('invalid job history filter');
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=${filter}&per_page=100&page=${page}`,
    );
    jobs.push(...response.jobs);
    if (jobs.length >= response.total_count) break;
    if (page === 10) return undefined;
  }
  return jobs;
}

function observedJob(jobs, run, name) {
  if (!jobs) return { kind: 'unknown' };
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length === 0) return { kind: 'missing' };
  if (matches.length !== 1 || matches[0].run_id !== run.id) return { kind: 'unknown' };
  const job = matches[0];
  if (job.status !== 'completed') return { kind: 'unknown', job };
  switch (job.conclusion) {
    case 'success':
    case 'skipped':
      return { kind: job.conclusion, job };
    case 'failure':
    case 'cancelled':
      return { kind: 'failed', job };
    default:
      return { kind: 'unknown', job };
  }
}

async function successfulJob(api, repository, run, name, jobs) {
  const result = observedJob(jobs ?? (await runJobs(api, repository, run)), run, name);
  return result.kind === 'success' ? result.job : undefined;
}

function coreBlocked(jobs, run) {
  return observedJob(jobs, run, 'ci-core').kind === 'failed';
}

function coverageChildrenBlocked(jobs, run) {
  const names = [...coverageMembers, coveragePlaceholder];
  if (jobs.some((job) => job.name.startsWith('coverage-pnpm-shard-') && !names.includes(job.name)))
    return false;
  return names.every((name) => ['missing', 'skipped'].includes(observedJob(jobs, run, name).kind));
}

function inactiveCoverageStep(step) {
  if (
    coverageUnrunSteps.includes(step.name) ||
    step.name === coverageArtifactRestoreStep ||
    step.name.startsWith('[ci-repair-reused]')
  )
    return step.status === 'completed' && step.conclusion === 'skipped';
  if (coverageDiagnosticSteps.includes(step.name))
    return step.status === 'completed' && ['success', 'skipped'].includes(step.conclusion);
  return (
    step.name === 'Require every coverage shard' &&
    step.status === 'completed' &&
    step.conclusion === 'failure'
  );
}

function upstreamOnlyCoverageFailure(jobs, run, job) {
  if (job?.name !== 'coverage-pnpm' || job.conclusion !== 'failure' || !coreBlocked(jobs, run))
    return false;
  if (!coverageChildrenBlocked(jobs, run)) return false;
  const steps = job.steps ?? [];
  const preconditions = steps.filter((step) => step.name === 'Require every coverage shard');
  const markers = steps.filter((step) => step.name.startsWith('[ci-repair-reused]'));
  if (preconditions.length !== 1 || markers.length !== 1) return false;
  if (
    !coverageUnrunSteps.every((name) => steps.filter((step) => step.name === name).length === 1) ||
    steps.filter((step) => step.name === coverageArtifactRestoreStep).length > 1
  )
    return false;
  return steps.every(inactiveCoverageStep);
}

function blockedCheck(input, run, jobs, result) {
  if (input.workflow !== 'ci.yml' || !coreBlocked(jobs, run)) return false;
  const coverageSuite = repairArtifactSuites[input.workflow]?.[input.jobKey] === 'coverage-pnpm';
  if (coverageSuite) {
    if (!coverageChildrenBlocked(jobs, run)) return false;
    const aggregate = observedJob(jobs, run, 'coverage-pnpm');
    if (aggregate.kind === 'failed') return upstreamOnlyCoverageFailure(jobs, run, aggregate.job);
    if (!['missing', 'skipped'].includes(aggregate.kind)) return false;
  }
  return ['missing', 'skipped'].includes(result.kind);
}

async function priorWorkflowRuns(api, input, anchor) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `repos/${input.repository}/actions/workflows/${input.workflow}/runs?event=pull_request&branch=${encodeURIComponent(input.pr.head.ref)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count))
      return undefined;
    runs.push(...response.workflow_runs);
    if (runs.length >= response.total_count) {
      const candidates = runs.filter(
        (run) =>
          run.id < anchor.id &&
          workflowFile(run.path) === input.workflow &&
          samePullRequestIdentity(run, input.pr, input.repository),
      );
      const anchorTime = Date.parse(anchor.created_at);
      if (
        !Number.isFinite(anchorTime) ||
        candidates.some(
          (run) =>
            !Number.isFinite(Date.parse(run.created_at)) || Date.parse(run.created_at) > anchorTime,
        )
      )
        return undefined;
      return candidates.sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id,
      );
    }
  }
  return undefined;
}

async function selectRepairSource(api, input, anchor, run) {
  let jobs = await runJobs(api, input.repository, run);
  let result = observedJob(jobs, run, input.checkName);
  if (result.kind === 'success') return { run, job: result.job, jobs };
  if (!blockedCheck(input, run, jobs, result)) return normal('check-did-not-pass');
  const history = await priorWorkflowRuns(api, input, anchor);
  if (!history) return normal('history-unavailable');
  const blockedRunIds = [run.id];
  for (const candidate of history.slice(0, maxRepairHistoryDepth)) {
    if (candidate.status !== 'completed') return normal('history-run-incomplete');
    const ancestry = await api(
      `repos/${input.repository}/compare/${candidate.head_sha}...${anchor.head_sha}`,
    );
    if (!repairComparison(ancestry)) return normal('history-not-ancestor');
    jobs = await runJobs(api, input.repository, candidate);
    result = observedJob(jobs, candidate, input.checkName);
    if (result.kind === 'success') return { run: candidate, job: result.job, jobs, blockedRunIds };
    if (!blockedCheck(input, candidate, jobs, result)) return normal('check-did-not-pass');
    blockedRunIds.push(candidate.id);
  }
  return normal('check-did-not-pass');
}

async function originalSuccess(api, input, run, job) {
  const seen = new Set();
  for (let depth = 0; depth < maxRepairHistoryDepth; depth++) {
    if (seen.has(job.id)) return undefined;
    seen.add(job.id);
    const source = inheritedSource(job);
    if (source === undefined) return undefined;
    if (source === null) return { run, job };
    run = await api(`repos/${input.repository}/actions/runs/${source.runId}`);
    job = await api(`repos/${input.repository}/actions/jobs/${source.jobId}`);
    if (
      !(await repairSourceBelongsToPr(api, run, input.pr, input.repository)) ||
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

export async function runArtifacts(api, repository, run) {
  const artifacts = [];
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.artifacts) || !Number.isSafeInteger(response.total_count))
      return undefined;
    artifacts.push(...response.artifacts);
    if (artifacts.length >= response.total_count) return artifacts;
  }
  return undefined;
}

export function metricArtifactName(name, job) {
  if (name === 'webkit-fallback') return 'chromium-fallback-color-lighting-status';
  if (name === 'metrics-validate-runtime') return 'metrics-report';
  return Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0
    ? `metrics-validate-browser-evidence-a${job.run_attempt}`
    : undefined;
}

function metricArtifact(artifacts, source) {
  const name = metricArtifactName(source.job.name, source.job);
  if (!name) return undefined;
  const matches = artifacts.filter((artifact) => artifact.name === name);
  if (matches.length !== 1) return undefined;
  const artifact = matches[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') ||
    artifact.workflow_run?.id !== source.run.id ||
    artifact.workflow_run?.head_sha !== source.run.head_sha
  )
    return undefined;
  return {
    id: artifact.id,
    name,
    digest: artifact.digest,
    sourceRunId: source.run.id,
    sourceJobId: source.job.id,
    sourceSha: source.run.head_sha,
  };
}

async function metricSuiteArtifacts(api, input, run, jobs) {
  const sources = [];
  for (const name of metricProducers) {
    const job = await successfulJob(api, input.repository, run, name, jobs);
    const source = await originalSuccess(api, { ...input, checkName: name }, run, job);
    if (!source) return undefined;
    sources.push(source);
  }
  const original = sources[0].run;
  if (sources.some((source) => source.run.id !== original.id)) return undefined;
  const originalJobs = await runJobs(api, input.repository, original);
  if (!metricMembers.every((name) => observedJob(originalJobs, original, name).kind === 'success'))
    return undefined;
  const artifacts = await runArtifacts(api, input.repository, original);
  if (!artifacts) return undefined;
  const result = {};
  for (const source of sources) {
    const artifact = metricArtifact(artifacts, source);
    if (!artifact) return undefined;
    result[source.job.name] = artifact;
  }
  return result;
}

async function qualifiedAnchor(anchor, input, api) {
  return (
    workflowFile(anchor.path) === 'ci.yml' &&
    (await repairSourceBelongsToPr(api, anchor, input.pr, input.repository)) &&
    anchor.id !== Number(input.currentRunId) &&
    anchor.head_sha !== input.pr.head.sha
  );
}

async function reusableArtifactSuite(api, input, run, jobs) {
  const consumer = repairArtifactSuites[input.workflow]?.[input.jobKey];
  if (!consumer) return true;
  // The SDK repair aggregate validates each consumer's original report and source.
  if (input.workflow === 'sdk-pr-preflight.yml' && input.jobKey === 'consumers') return true;
  if (declaredFreshExecution(input.pr.body, consumer)) return false;
  if (input.workflow === 'ci.yml' && input.jobKey === 'coverage-pnpm-shard') return true;
  if (input.workflow === 'ci.yml' && consumer === 'metrics-validate')
    return metricMembers.every(
      (name) =>
        !declaredFreshExecution(input.pr.body, name) &&
        observedJob(jobs, run, name).kind === 'success',
    );
  if (input.workflow === 'ci.yml' && consumer === 'coverage-pnpm')
    return [...coverageMembers, consumer].every(
      (name) => observedJob(jobs, run, name).kind === 'success',
    );
  return Boolean(await successfulJob(api, input.repository, run, consumer, jobs));
}

function repairIntent(input) {
  if (input.eventName !== 'pull_request' || !input.pr) return normal('not-a-pr');
  const { pr, repository, workflow, jobKey, checkName } = input;
  if (!repairReusableJobs[workflow]?.includes(jobKey))
    return normal('artifact-provider-or-aggregate');
  if (
    repairArtifactSuites[workflow]?.[jobKey] === 'metrics-validate' &&
    input.artifactSuiteProviderReused === 'false'
  )
    return normal('artifact-provider-needs-fresh-inputs');
  const baseline = repairDeclaration(pr.body, repository);
  if (!baseline) return normal('not-declared');
  const fresh = declaredFreshExecution(pr.body, checkName);
  if (fresh) return fresh;
  if (!sameRepository(pr.head.repo?.full_name, repository)) return normal('foreign-source');
  if (/\b(?:failure|cancelled)\b/.test(input.dependencyResults ?? ''))
    return normal('dependency-failed');
  return { baseline };
}

/** Explicit CI-repair purpose accepts earlier passes, including implementation repairs. */
export async function ciRepairQualification(
  input,
  api,
  { readCoverageFiles = readOriginalCoverageFiles, coverageChanges = changedCoverageFiles } = {},
) {
  const intent = repairIntent(input);
  if (intent.reused === false) return intent;
  const { baseline } = intent;
  const { pr, repository, workflow, jobKey, checkName, targetSha } = input;
  const anchor = await api(`repos/${repository}/actions/runs/${baseline}`);
  if (!(await qualifiedAnchor(anchor, input, api))) return normal('baseline-unqualified');
  const changes = await api(`repos/${repository}/compare/${anchor.head_sha}...${pr.head.sha}`);
  if (!repairComparison(changes)) return normal('baseline-not-ancestor');
  if (targetSha !== pr.head.sha) {
    const checkout = await api(`repos/${repository}/compare/${pr.head.sha}...${targetSha}`);
    if (!repairComparison(checkout)) return normal('checkout-inputs-unqualified');
  }
  const run = await runForWorkflow(api, repository, workflow, anchor, pr);
  if (!run) return normal('workflow-baseline-missing');
  const selected = await selectRepairSource(api, input, anchor, run);
  if (!selected.job) return selected;
  if (!(await reusableArtifactSuite(api, input, selected.run, selected.jobs)))
    return normal('artifact-consumer-needs-fresh-inputs');
  const source = await originalSuccess(api, { ...input, pr }, selected.run, selected.job);
  if (!source) return normal('reuse-provenance-unqualified');
  if (!repairExecutionIsComplete(workflow, checkName, source.job))
    return normal('required-execution-step-unqualified');
  const metrics = repairArtifactSuites[workflow]?.[jobKey] === 'metrics-validate';
  if (metrics && !metricProducers.includes(checkName))
    return normal('metrics-check-name-unqualified');
  const artifacts = metrics
    ? await metricSuiteArtifacts(api, input, selected.run, selected.jobs)
    : undefined;
  if (metrics && !artifacts) return normal('artifact-suite-unavailable');
  if (source.run.head_sha !== anchor.head_sha) {
    const comparison = await api(
      `repos/${repository}/compare/${source.run.head_sha}...${targetSha}`,
    );
    if (!repairComparison(comparison)) return normal('original-success-not-ancestor');
  }
  const proof = {
    reused: true,
    reason: 'declared-ci-repair',
    sourceRunId: source.run.id,
    sourceJobId: source.job.id,
    sourceSha: source.run.head_sha,
    targetSha,
    sourceUrl: `https://github.com/${repository}/actions/runs/${source.run.id}/job/${source.job.id}`,
    ...(artifacts ? { sourceArtifact: artifacts[checkName], sourceArtifactSuite: artifacts } : {}),
    ...(selected.blockedRunIds
      ? {
          declaredAnchorRunId: anchor.id,
          blockedRunIds: selected.blockedRunIds,
          selectedSuiteRunId: selected.run.id,
        }
      : {}),
  };
  return coverageAdmission(input, source, api, readCoverageFiles, coverageChanges, proof);
}

export async function requestGitHub(endpoint, token, request = fetch, retryOptions = {}) {
  if (!token) throw new Error('GitHub token unavailable');
  let serverDelay = 0;
  const sleep =
    retryOptions.sleepFn ?? ((seconds) => new Promise((done) => setTimeout(done, seconds * 1000)));
  const result = await retryArtifact(
    async () => {
      serverDelay = 0;
      const signal = AbortSignal.timeout(30_000);
      try {
        const response = await request(`https://api.github.com/${endpoint}`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
          signal,
        });
        if (!response.ok) {
          const retryAfter = response.headers?.get('retry-after');
          const remaining = response.headers?.get('x-ratelimit-remaining');
          const throttled =
            response.status === 429 ||
            (response.status === 403 && (typeof retryAfter === 'string' || remaining === '0'));
          if (throttled) {
            const reset = Number(response.headers?.get('x-ratelimit-reset'));
            serverDelay =
              retryAfter && /^\d+$/.test(retryAfter)
                ? Number(retryAfter)
                : remaining === '0' && reset > 0
                  ? Math.max(0, Math.ceil(reset - Date.now() / 1000))
                  : 60;
            if (serverDelay > 60) {
              const limited = new Error('GitHub history rate limit exceeds recovery bound');
              limited.code = 'GITHUB_HISTORY_RATE_LIMIT_BOUND';
              throw limited;
            }
          } else serverDelay = 0;
          const error = new Error(
            `GitHub history unavailable: HTTP ${throttled ? 429 : response.status} response`,
          );
          error.code = `GITHUB_HISTORY_HTTP_${response.status}`;
          throw error;
        }
        return await response.json();
      } catch (error) {
        if (signal.aborted || error?.name === 'TimeoutError') {
          const deadline = new Error('GitHub history unavailable: HTTP 408 deadline', {
            cause: error,
          });
          deadline.code = 'GITHUB_HISTORY_DEADLINE';
          throw deadline;
        }
        throw error;
      }
    },
    {
      onRetry: ({ attempt }) =>
        console.error(`GitHub history transport retry ${attempt}/3: ${endpoint}`),
      ...retryOptions,
      sleepFn: (delay) => sleep(Math.max(delay, serverDelay)),
    },
  );
  return result.value;
}

// One qualification observes immutable completed history repeatedly. Keep its
// authenticated inventory local to this invocation, and never retain failures.
export function createGitHubHistoryClient(token, request = fetch, retryOptions) {
  const responses = new Map();
  return async (endpoint) => {
    if (!responses.has(endpoint)) {
      const response = requestGitHub(endpoint, token, request, retryOptions).catch((error) => {
        responses.delete(endpoint);
        throw error;
      });
      responses.set(endpoint, response);
    }
    return responses.get(endpoint);
  };
}

async function main() {
  let result = normal('qualification-unavailable');
  let declaredRepair = false;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    declaredRepair =
      process.env.GITHUB_EVENT_NAME === 'pull_request' &&
      Boolean(repairDeclaration(event.pull_request?.body, process.env.GITHUB_REPOSITORY));
    const api = createGitHubHistoryClient(process.env.GH_TOKEN);
    result = await ciRepairQualification(
      {
        eventName: process.env.GITHUB_EVENT_NAME,
        pr: event.pull_request,
        repository: process.env.GITHUB_REPOSITORY,
        workflow: workflowFile(process.env.GITHUB_WORKFLOW_REF),
        jobKey: process.env.GITHUB_JOB,
        checkName: process.env.CI_REPAIR_CHECK_NAME,
        dependencyResults: process.env.CI_REPAIR_DEPENDENCY_RESULTS,
        artifactSuiteProviderReused: process.env.CI_REPAIR_SUITE_PROVIDER_REUSED,
        currentRunId: process.env.GITHUB_RUN_ID,
        targetSha:
          process.env.CI_REPAIR_TARGET_SHA ||
          execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      api,
    );
  } catch (error) {
    // Keep credentials and response bodies out of diagnostics.
    const code = error?.code ?? error?.cause?.code;
    const detail = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
    console.error(`CI repair history unavailable: ${error?.name ?? 'Error'}${detail}`);
    // Missing API access, unavailable history or malformed metadata runs normal CI.
  }
  console.log(JSON.stringify(result));
  if (process.env.CI_REPAIR_SUITE_PROVIDER_REUSED === 'true' && !result.reused) {
    console.error(
      'An inherited metrics provider requires the same complete inherited cohort; normal execution cannot mix its artifacts.',
    );
    process.exitCode = 1;
  }
  if (process.env.GITHUB_OUTPUT) {
    const rows = {
      reused: result.reused,
      declared_repair: declaredRepair,
      source_run_id: result.sourceRunId ?? '',
      source_job_id: result.sourceJobId ?? '',
      source_job_url: result.sourceUrl ?? '',
      source_artifact_id: result.sourceArtifact?.id ?? '',
      source_artifact_name: result.sourceArtifact?.name ?? '',
    };
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(rows)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    let summary = result.reused
      ? `Reused [the earlier successful check](${result.sourceUrl}).\n\nOriginal source: \`${result.sourceSha}\`. Current checkout: \`${result.targetSha}\`.\n\nThe check was not executed again in this run. Required artifacts are preserved or rebuilt before consumers execute.\n`
      : `Normal CI execution: \`${result.reason}\`.\n`;
    if (result.sourceArtifact)
      summary += `\nPreserved original artifact: \`${result.sourceArtifact.name}\` (ID \`${result.sourceArtifact.id}\`, \`${result.sourceArtifact.digest}\`). No current-source artifact was created.\n`;
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### CI repair: ${process.env.CI_REPAIR_CHECK_NAME}\n\n${summary}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
