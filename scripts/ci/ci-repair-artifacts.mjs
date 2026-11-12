import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ciRepairQualification,
  coverageMembers,
  inheritedSource,
  repairDeclaration,
  requestGitHub,
  runArtifacts,
  runJobs,
} from './ci-repair-qualification.mjs';

async function executionSource(context, job, api) {
  const marker = inheritedSource(job);
  if (marker === undefined) throw new Error('ci-repair-artifact-marker');
  if (marker === null)
    return {
      sourceRunId: Number(context.currentRunId),
      sourceJobId: job.id,
      sourceSha: context.targetSha,
      reused: false,
    };
  const proof = await ciRepairQualification(
    {
      ...context,
      workflow: context.workflow,
      jobKey: context.jobKey,
      checkName: job.name,
    },
    api,
  );
  if (!proof.reused || marker.runId !== proof.sourceRunId || marker.jobId !== proof.sourceJobId)
    throw new Error('ci-repair-artifact-source-unqualified');
  return proof;
}

function resultArtifact(artifacts, checkName, source, artifactName) {
  const name = artifactName;
  const matches = artifacts.filter((artifact) => artifact.name === name);
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    !/^[0-9a-f]{40}$/.test(source.sourceSha) ||
    !Number.isSafeInteger(artifact?.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '') ||
    artifact.workflow_run?.id !== source.sourceRunId ||
    artifact.workflow_run?.head_sha !== source.sourceSha
  )
    throw new Error(`ci-repair-artifact-artifact:${checkName}`);
  return artifact;
}

export async function collectRepairArtifactSources(context, checks, artifactName, api) {
  if (
    context.eventName !== 'pull_request' ||
    !repairDeclaration(context.pr?.body, context.repository) ||
    context.targetSha !== context.pr?.head?.sha ||
    !/^[0-9a-f]{40}$/.test(context.targetSha) ||
    !Number.isSafeInteger(Number(context.currentRunId)) ||
    Number(context.currentRunId) <= 0
  )
    throw new Error('ci-repair-artifact-context');
  const jobs = await runJobs(api, context.repository, { id: context.currentRunId });
  if (!jobs) throw new Error('ci-repair-artifact-job-inventory');
  if (jobs.filter((job) => job.name.startsWith(context.checkPrefix)).length !== checks.length)
    throw new Error('ci-repair-artifact-conservation');
  const result = [];
  const artifactRuns = new Map();
  for (const checkName of checks) {
    const matches = jobs.filter((job) => job.name === checkName);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      job.status !== 'completed' ||
      job.conclusion !== 'success' ||
      job.run_id !== Number(context.currentRunId) ||
      !Number.isSafeInteger(job.id) ||
      job.id <= 0
    )
      throw new Error(`ci-repair-artifact-consumer:${checkName}`);
    const source = await executionSource(context, job, api);
    if (!artifactRuns.has(source.sourceRunId)) {
      const artifacts = await runArtifacts(api, context.repository, { id: source.sourceRunId });
      if (!artifacts) throw new Error('ci-repair-artifact-inventory');
      artifactRuns.set(source.sourceRunId, artifacts);
    }
    const artifact = resultArtifact(
      artifactRuns.get(source.sourceRunId),
      checkName,
      source,
      artifactName(checkName),
    );
    result.push({ checkName, artifact, source });
  }
  return result;
}

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

async function restoreCoverageArtifacts(directory) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const api = (endpoint) =>
    requestGitHub(endpoint, process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  const rows = await collectRepairArtifactSources(
    {
      eventName: process.env.GITHUB_EVENT_NAME,
      pr: event.pull_request,
      repository,
      currentRunId: process.env.GITHUB_RUN_ID,
      targetSha,
      workflow: 'ci.yml',
      jobKey: 'coverage-pnpm-shard',
      checkPrefix: 'coverage-pnpm-shard-',
    },
    coverageMembers,
    (name) => name.replace('coverage-pnpm-shard-', 'coverage-shard-'),
    api,
  );
  const download = fileURLToPath(new URL('./download-artifact-with-retry.mjs', import.meta.url));
  for (const { artifact, source } of rows) {
    const destination = resolve(directory, artifact.name);
    execFileSync(
      process.execPath,
      [download, '--artifact-ids', String(artifact.id), '--path', destination],
      {
        stdio: 'inherit',
        env: { ...process.env, FORGEAX_ARTIFACT_EXPECTED_SHA: source.sourceSha },
      },
    );
    if (!source.reused) continue;
    try {
      execFileSync('git', ['cat-file', '-e', `${source.sourceSha}^{commit}`], { stdio: 'pipe' });
    } catch {
      execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', source.sourceSha], {
        stdio: 'pipe',
      });
    }
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', '-z', source.sourceSha, targetSha],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
    const covered = Object.keys(
      JSON.parse(readFileSync(resolve(destination, 'coverage-final.json'), 'utf8')),
    );
    assertCoverageInputsUnchanged(covered, changed);
  }
  mkdirSync('artifacts/ci-repair', { recursive: true });
  writeFileSync('artifacts/ci-repair/coverage-sources.json', `${JSON.stringify(rows, null, 2)}\n`);
  console.log(JSON.stringify({ coverageRepairSources: rows }));
}

if (import.meta.main) {
  if (process.argv[2] !== '--coverage' || !process.argv[3])
    throw new Error('usage: ci-repair-artifacts.mjs --coverage DIRECTORY');
  await restoreCoverageArtifacts(process.argv[3]);
}
