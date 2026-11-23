import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function postMergeQualification({ repository, pr, mergeTree, headTree, runs = [] }) {
  if (!mergeTree || mergeTree !== headTree)
    return { skip: false, reason: 'merge-tree-unqualified' };
  const latest = latestPostMergePullRequestRun({ repository, pr, runs });
  if (latest?.status !== 'completed' || latest.conclusion !== 'success')
    return { skip: false, reason: 'pr-ci-unqualified' };
  return { skip: true, reason: 'qualified-identical-tree', runId: latest.id };
}

export function latestPostMergePullRequestRun({ repository, pr, runs }) {
  return runs
    .filter(
      (run) =>
        run.event === 'pull_request' &&
        run.head_sha === pr.head.sha &&
        run.head_repository?.full_name === repository &&
        (run.pull_requests?.some((entry) => entry.number === pr.number) ||
          // GitHub removes this association from completed runs after merge.
          // An empty list may use the exact repository/head/branch identity.
          (run.pull_requests?.length === 0 && run.head_branch === pr.head.ref)),
    )
    .sort((left, right) => right.id - left.id)[0];
}

// An inherited repair check is useful for its PR, but a post-merge View
// shortcut requires that the paired tests actually ran on this exact tree.
export function qualifiedViewExecution(jobs, runId, head) {
  if (!Array.isArray(jobs)) return false;
  const aggregate = completedJob(jobs, 'view-integration', runId, head);
  if (!aggregate) return false;
  return [0, 1, 2, 3].every((shard) => {
    const job = completedJob(jobs, `view-integration-${shard}`, runId, head);
    const tail =
      shard === 1
        ? 'DevKit project play browser journeys (uninstrumented)'
        : 'Runtime Pack Worker dev/build JS/TS browser gate';
    return (
      successfulStep(job, 'Verify paired candidate and resource-preview roster') &&
      successfulStep(job, tail)
    );
  });
}

function completedJob(jobs, name, runId, head) {
  const matches = jobs.filter((job) => job.name === name);
  const job = matches[0];
  return matches.length === 1 &&
    job.status === 'completed' &&
    job.conclusion === 'success' &&
    job.run_id === runId &&
    job.head_sha === head
    ? job
    : undefined;
}

function successfulStep(job, name) {
  return (
    job?.steps?.filter((step) => step.name === name && step.conclusion === 'success').length === 1
  );
}

function viewQualification(api, repository, result, head) {
  const jobs = api(
    `repos/${repository}/actions/runs/${result.runId}/jobs?filter=latest&per_page=100&page=1`,
  );
  return (
    jobs.total_count === jobs.jobs?.length && qualifiedViewExecution(jobs.jobs, result.runId, head)
  );
}

function main() {
  const api = (endpoint) =>
    JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30_000 }));
  let result = { skip: false, reason: 'qualification-unavailable' };
  let skipView = false;
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const associated = api(`repos/${repository}/commits/${sha}/pulls`);
    const pr = associated.find(
      (entry) => entry.base.ref === 'main' && entry.merged_at && entry.merge_commit_sha === sha,
    );
    if (pr === undefined) result = { skip: false, reason: 'merged-pr-unavailable' };
    else {
      const head = api(`repos/${repository}/git/commits/${pr.head.sha}`);
      const runs = api(
        `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`,
      );
      const merge = api(`repos/${repository}/git/commits/${sha}`);
      result = postMergeQualification({
        repository,
        pr,
        mergeTree: merge.tree.sha,
        headTree: head.tree.sha,
        runs: runs.workflow_runs,
      });
      if (result.skip) skipView = viewQualification(api, repository, result, pr.head.sha);
    }
  } catch {
    // This is an optimization. API/permission/transport failures retain full CI.
  }
  console.log(JSON.stringify({ ...result, skipView }));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `skip_checks=${result.skip}\nskip_view=${skipView}\nview_run_id=${skipView ? result.runId : ''}\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
