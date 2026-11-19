import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createGitHubHistoryClient,
  repairComparison,
  repairDeclaration,
  repairSourceBelongsToPr,
  requestGitHub,
  samePullRequestIdentity,
} from './ci-repair-qualification.mjs';

const reject = (reason, expectedRunId) => ({ ok: false, reason, expectedRunId });

async function precedingRevision(input, current, api) {
  const { repository, pr } = input;
  for (let page = 1; page <= 10; page++) {
    const response = await api(
      `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.workflow_runs)) throw new Error('invalid run history');
    const previous = response.workflow_runs
      .filter(
        (run) =>
          run.run_number < current.run_number &&
          run.head_sha !== current.head_sha &&
          samePullRequestIdentity(run, pr, pr.head.repo.full_name),
      )
      .sort((a, b) => b.run_number - a.run_number)[0];
    if (previous) return previous;
    if (response.workflow_runs.length < 100) return undefined;
  }
  throw new Error('run history exceeds qualification bound');
}

async function checkDeclaredBaseline(input, current, previous, declared, api) {
  const { repository, pr } = input;
  const anchor = await api(`repos/${repository}/actions/runs/${declared}`);
  if (
    anchor.path?.split('@')[0] !== '.github/workflows/ci.yml' ||
    !Number.isSafeInteger(anchor.run_number) ||
    anchor.run_number >= current.run_number ||
    anchor.head_sha === pr.head.sha ||
    !(await repairSourceBelongsToPr(api, anchor, pr, repository))
  )
    return reject('repair-baseline-unqualified', previous?.id);
  // An independently associated manual repair anchor may supersede the last
  // PR revision, retaining the existing recovery route and source provenance.
  if (
    previous &&
    anchor.id !== previous.id &&
    !(anchor.event === 'workflow_dispatch' && anchor.run_number > previous.run_number)
  )
    return reject('repair-baseline-stale', previous.id);
  const comparison = await api(`repos/${repository}/compare/${anchor.head_sha}...${pr.head.sha}`);
  if (!repairComparison(comparison)) return reject('repair-baseline-not-ancestor', previous?.id);
  return { ok: true, reason: 'repair-declared', sourceRunId: anchor.id };
}

/** A missing declaration must never silently select a fresh full CI run. */
export async function checkPrCiRepair(input, api) {
  if (input.eventName !== 'pull_request') return { ok: true, reason: 'not-a-pr' };
  const { repository, pr, currentRunId } = input;
  const current = await api(`repos/${repository}/actions/runs/${currentRunId}`);
  if (
    !Number.isSafeInteger(current.run_number) ||
    !samePullRequestIdentity(current, pr, pr.head.repo.full_name) ||
    current.head_sha !== pr.head.sha ||
    current.path?.split('@')[0] !== '.github/workflows/ci.yml'
  )
    return reject('current-run-unqualified');
  const previous = await precedingRevision(input, current, api);
  if (previous && previous.status !== 'completed')
    return reject('preceding-run-incomplete', previous.id);
  const declared = repairDeclaration(pr.body, repository);
  if (!previous && !/^CI-Repair-From:/m.test(pr.body ?? ''))
    return { ok: true, reason: 'initial-baseline' };
  if (!declared) return reject('repair-declaration-required', previous?.id);
  return checkDeclaredBaseline(input, current, previous, declared, api);
}

export async function publishRepairStatus(input, result, token, request = fetch) {
  if (!token) throw new Error('required status token unavailable');
  const payload = {
    state: result.ok ? 'success' : 'failure',
    context: 'ci-repair-policy',
    description: result.reason,
    target_url: `https://github.com/${input.repository}/actions/runs/${input.currentRunId}`,
  };
  return requestGitHub(
    `repos/${input.repository}/statuses/${input.pr.head.sha}`,
    token,
    (url, options) =>
      request(url, {
        ...options,
        headers: { ...options.headers, 'content-type': 'application/json' },
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  );
}

async function main() {
  let result;
  let input;
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const event =
      eventName === 'pull_request'
        ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
        : {};
    input = {
      eventName,
      pr: event.pull_request,
      repository: process.env.GITHUB_REPOSITORY,
      currentRunId: process.env.GITHUB_RUN_ID,
    };
    result = await checkPrCiRepair(input, createGitHubHistoryClient(process.env.GH_TOKEN));
  } catch {
    result = reject('repair-history-unavailable');
  }
  if (input?.eventName === 'pull_request' && input.pr?.head?.sha) {
    try {
      await publishRepairStatus(input, result, process.env.CI_REPAIR_STATUS_TOKEN);
    } catch {
      console.error(
        '::error::Could not publish required ci-repair-policy status. Recover status transport or permissions before retrying.',
      );
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(result));
  if (!result.ok) {
    console.error(
      '::error::PR CI repair policy failed. Wait for the preceding CI run to complete, set exactly one CI-Repair-From: line in the PR description before pushing, then read it back. See scripts/ci/README.md.',
    );
    if (result.expectedRunId) console.error(`Expected preceding CI run: ${result.expectedRunId}`);
    console.error(
      'The trigger event captures the description; a later edit requires a new PR event. Unavailable history fails closed; recover transport before retrying.',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
