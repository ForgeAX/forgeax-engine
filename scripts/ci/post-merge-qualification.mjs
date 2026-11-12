import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function postMergeQualification({ repository, pr, mergeTree, headTree, runs = [] }) {
  if (!mergeTree || mergeTree !== headTree)
    return { skip: false, reason: 'merge-tree-unqualified' };
  const latest = runs
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
  if (latest?.status !== 'completed' || latest.conclusion !== 'success')
    return { skip: false, reason: 'pr-ci-unqualified' };
  return { skip: true, reason: 'qualified-identical-tree', runId: latest.id };
}

function main() {
  const api = (endpoint) =>
    JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30_000 }));
  let result = { skip: false, reason: 'qualification-unavailable' };
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
    }
  } catch {
    // This is an optimization. API/permission/transport failures retain full CI.
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `skip_checks=${result.skip}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
