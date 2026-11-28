import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  inheritedSource,
  repairComparison,
  repairDeclaration,
  requestGitHub,
  runJobs,
  samePullRequest,
} from '../../../../scripts/ci/ci-repair-qualification.mjs';

export async function qualifyOwner(input, api, sourceEngine) {
  const fresh = { reused: false };
  const { pr, repository, checkName } = input;
  if (input.eventName !== 'pull_request' || !pr) return fresh;
  const baseline = repairDeclaration(pr.body, repository);
  const rows = pr.body.split('\n').filter((line) => line.startsWith('CI-Repair-Rerun:'));
  if (!baseline || rows.length !== 1) return fresh;
  const rerun = JSON.parse(rows[0].slice('CI-Repair-Rerun:'.length));
  if (
    !Array.isArray(rerun) ||
    rerun.length === 0 ||
    rerun.some((name) => typeof name !== 'string' || name.trim() !== name || !name) ||
    new Set(rerun).size !== rerun.length ||
    rerun.includes(checkName)
  )
    return fresh;
  let run = await api(`repos/${repository}/actions/runs/${baseline}`);
  if (run.id === Number(input.currentRunId) || run.head_sha === pr.head.sha) return fresh;
  for (let depth = 0; depth < 10; depth++) {
    if (!samePullRequest(run, pr, repository) || run.path !== '.github/workflows/modeling-ci.yml')
      return fresh;
    const comparison = await api(`repos/${repository}/compare/${run.head_sha}...${pr.head.sha}`);
    if (
      !repairComparison(comparison) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length >= 300 ||
      comparison.files.some(
        ({ filename }) =>
          ![
            '.github/workflows/modeling-ci.yml',
            'scripts/mutation/sets/l3-quad.json',
            'scripts/ci/reuse-owner.mjs',
            'scripts/ci/__tests__/reuse-owner.test.mjs',
          ].includes(filename),
      )
    )
      return fresh;
    const jobs = await runJobs(api, repository, run);
    const matches = jobs?.filter((job) => job.name === checkName);
    if (matches?.length !== 1) return fresh;
    const job = matches[0];
    if (job.run_id !== run.id || job.status !== 'completed' || job.conclusion !== 'success')
      return fresh;
    const inherited = inheritedSource(job);
    if (inherited === undefined) return fresh;
    if (inherited) {
      const originalJob = await api(`repos/${repository}/actions/jobs/${inherited.jobId}`);
      if (originalJob.name !== checkName || originalJob.run_id !== inherited.runId) return fresh;
      run = await api(`repos/${repository}/actions/runs/${inherited.runId}`);
      continue;
    }
    if ((await sourceEngine(job.id)) !== input.engineSha) return fresh;
    return {
      reused: true,
      sourceRunId: run.id,
      sourceJobId: job.id,
      sourceSha: run.head_sha,
      sourceUrl: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
    };
  }
  return fresh;
}

async function main() {
  let result = { reused: false };
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    result = await qualifyOwner(
      {
        eventName: process.env.GITHUB_EVENT_NAME,
        pr: event.pull_request,
        repository: process.env.GITHUB_REPOSITORY,
        checkName: process.env.CI_REPAIR_CHECK_NAME,
        currentRunId: process.env.GITHUB_RUN_ID,
        engineSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      },
      (endpoint) => requestGitHub(endpoint, process.env.GH_TOKEN),
      async (id) => {
        const log = execFileSync(
          'gh',
          [
            'api',
            '--allow-escape-sequences',
            `repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${id}/logs`,
          ],
          { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
        );
        const matches = [...log.matchAll(/Z Engine (?:main|source): ([a-f0-9]{40})\r?$/gm)];
        return matches.length === 1 ? matches[0][1] : undefined;
      },
    );
  } catch {
    // Missing, stale or malformed evidence runs the complete normal owner.
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `reused=${result.reused}\nsource_run_id=${result.sourceRunId ?? ''}\nsource_job_id=${result.sourceJobId ?? ''}\nsource_job_url=${result.sourceUrl ?? ''}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      result.reused
        ? `Original check: [${result.sourceRunId}/${result.sourceJobId}](${result.sourceUrl}). Original Modeling source: \`${result.sourceSha}\`. Engine source is unchanged. This owner was not executed again.\n`
        : 'Execute the complete current Modeling owner.\n',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
