import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { changedCiInputs, comparedCiInputs, unchangedModuleEdges } from './ci-input-changes.mjs';
import { browserFallbackTailSteps, requestGitHub, runJobs } from './ci-repair-qualification.mjs';
import { coreValidationFiles } from './core-validation.mjs';
import {
  latestPostMergePullRequestRun,
  postMergeQualification,
  qualifiedViewExecution,
} from './post-merge-qualification.mjs';
import { dawnExecutionGroups } from './run-dawn-gate.mjs';
import {
  assignBrowserGroupsToShards,
  browserExecutionFiles,
  ciBrowserShardTailSeconds,
  planBrowserGroups,
} from './run-split-vitest-browser.mjs';

export const nativeValidationLanes = Object.freeze({
  browser: [0, 1, 2, 3],
  dawn: [1, 2, 3, 4],
  view: [0, 1, 2, 3],
});

// These platform adapters have their own execution owners. The browser
// fallback always runs the full Snake reconnect/resync journey. WeChat
// platform audio has a dedicated browser test and must keep the Browser fleet.
const platformScope = [
  [
    /^packages\/net-websocket\/src\/(?:node|browser|errors|event-queue|websocket-client-core|websocket-connector)\.ts$/,
    [],
  ],
  [/^packages\/platform-wechat\/src\/(?!index\.ts$)[^/]+(?<!\.d)\.ts$/, ['browser']],
];

export function nativeTestScope(
  comparison,
  isReferenced = () => true,
  keepsModuleEdges = () => false,
) {
  const files = comparison?.files;
  if (!files?.length) return undefined;
  const kinds = new Set();
  for (const { path, status } of files) {
    const match =
      /^(?:packages|apps|templates)\/[^/]+\/(?:[^/]+\/)*__tests__\/(?:[^/]+\/)*([^/]+)\.(browser|dawn|unit|integration)\.test\.ts$/.exec(
        path,
      );
    // These Markdown files describe agent procedures and are outside native inputs.
    if (/^skills\/forgeax-engine-[^/]+\/SKILL(?:\.zh-CN)?\.md$/.test(path)) continue;
    if (status === 'M' && /^tools\/view-plugins\/locales\/(?:en|zh)\.json$/.test(path)) {
      kinds.add('view');
      continue;
    }
    // New CPU-only tests run in Coverage without changing any native entrypoint.
    const addedCpuTest =
      status === 'A' &&
      path.startsWith('packages/') &&
      (match?.[2] === 'unit' || match?.[2] === 'integration');
    if (status !== 'M' && !addedCpuTest) return undefined;
    if (match && !isReferenced(`${match[1]}.${match[2]}.test`, path)) {
      kinds.add(match[2]);
      continue;
    }
    const platform = platformScope.find(([pattern]) => pattern.test(path));
    if (!platform || !keepsModuleEdges(path)) return undefined;
    for (const kind of platform[1]) kinds.add(kind);
  }
  return kinds;
}

function referencedTest(name, path) {
  try {
    const paths = execFileSync(
      'git',
      ['grep', '-l', '-F', '-e', name, 'HEAD', '--', 'packages', 'apps', 'templates', 'tools'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return paths.split('\n').some((found) => found && found !== `HEAD:${path}`);
  } catch (error) {
    return error.status !== 1;
  }
}

const nativeStep = {
  browser: 'Vitest browser project (RHI/engine API integration — shard)',
  dawn: 'Vitest dawn project (real GPU — *.dawn.test.ts)',
};

const browserTailSteps = [
  ['Verify actual browser test discovery'],
  [
    'Prepare Dawn device-limit normalization for CSM replay',
    'Directional CSM Browser WebGPU smoke (M5 MVD)',
  ],
  [],
  [],
];

function matchingExecution(jobs, name, requiredSteps, source) {
  const matches = jobs.filter((job) => job.name === name);
  const job = matches[0];
  return (
    matches.length === 1 &&
    job.run_id === source.id &&
    job.head_sha === source.head_sha &&
    job.status === 'completed' &&
    job.conclusion === 'success' &&
    requiredSteps.every((step) =>
      job.steps?.some((item) => item.name === step && item.conclusion === 'success'),
    )
  );
}

const browserCiProfile = Object.freeze({
  FORGEAX_CI_CORE_VALIDATION: '1',
  FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1',
  FORGEAX_BROWSER_FIXED_SMOKE: '1',
});

// Only exact, already-rostered test edits have an individually proved lane.
// Ordinary Dawn files split inside Vitest and intentionally fall back.
export function changedNativeTestLanes(files, browserFiles = browserExecutionFiles) {
  const selected = {};
  const browser = files.filter(({ path }) => path.endsWith('.browser.test.ts'));
  if (browser.length > 0) {
    const groups = planBrowserGroups(coreValidationFiles(browserFiles(), browserCiProfile));
    const owners = assignBrowserGroupsToShards(
      groups,
      nativeValidationLanes.browser.length,
      'balanced',
      {
        tailSeconds: ciBrowserShardTailSeconds,
        concurrency: 2,
        environment: browserCiProfile,
      },
    );
    const lanes = browser.map(({ path }) => {
      const matches = groups.flatMap((group, index) =>
        group.includes(path) ? [owners[index]] : [],
      );
      return matches.length === 1 ? matches[0] : undefined;
    });
    if (lanes.every((lane) => lane !== undefined)) {
      selected.browser = new Set(lanes);
      selected.browserFiles = Object.fromEntries(
        browser.map(({ path }, index) => [path, lanes[index]]),
      );
    }
  }
  const dawn = files.filter(({ path }) => path.endsWith('.dawn.test.ts'));
  if (dawn.length > 0) {
    const lanes = nativeValidationLanes.dawn.map((lane) => [
      lane,
      dawnExecutionGroups(undefined, `${lane}/4`, {
        ...browserCiProfile,
        FORGEAX_DAWN_LIGHTWEIGHT: '1',
        FORGEAX_DAWN_OMIT_AUTHORING_CAPTURES: '1',
      }).flatMap((group) => group.files),
    ]);
    const matched = dawn.map(({ path }) => {
      const matches = lanes.filter(([, members]) => members.includes(path));
      return matches.length === 1 ? matches[0][0] : undefined;
    });
    if (matched.every((lane) => lane !== undefined)) selected.dawn = new Set(matched);
  }
  return selected;
}

export function nativeMatrices(scope, jobs, source, selected = {}) {
  if (!scope || !source || !Array.isArray(jobs)) return nativeValidationLanes;
  const scoped = {};
  for (const kind of ['browser', 'dawn']) {
    const lanes = nativeValidationLanes[kind];
    const allExecuted =
      (kind !== 'browser' ||
        matchingExecution(jobs, 'webkit-fallback', browserFallbackTailSteps, source)) &&
      lanes.every((lane) =>
        matchingExecution(
          jobs,
          kind === 'browser' ? `vitest-browser-shard-${lane}` : `vitest-dawn-${lane}-of-4`,
          [nativeStep[kind], ...(kind === 'browser' ? browserTailSteps[lane] : [])],
          source,
        ),
      );
    const changes = selected[kind];
    scoped[kind] = !allExecuted
      ? lanes
      : !scope.has(kind)
        ? lanes.slice(0, 1)
        : changes?.size
          ? lanes.filter((lane) => changes.has(lane))
          : lanes;
  }
  scoped.view =
    !scope.has('view') && qualifiedViewExecution(jobs, source.id, source.head_sha)
      ? nativeValidationLanes.view.slice(0, 1)
      : nativeValidationLanes.view;
  return scoped;
}

async function qualifiedBaseRun(api, repository, base) {
  const prefix = `repos/${repository}`;
  const workflow = `${prefix}/actions/workflows/ci.yml/runs`;
  const direct = await api(
    `${workflow}?branch=main&event=push&head_sha=${base}&status=success&per_page=5`,
  );
  const main = direct.workflow_runs?.find(
    (run) =>
      run.head_sha === base &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  );
  const pulls = await api(`${prefix}/commits/${base}/pulls`);
  const pr = pulls.find(
    (item) => item.base.ref === 'main' && item.merged_at && item.merge_commit_sha === base,
  );
  if (!pr || !/^[0-9a-f]{40}$/.test(pr.head.sha)) return [main];
  const [baseGit, headGit, history] = await Promise.all([
    api(`${prefix}/git/commits/${base}`),
    api(`${prefix}/git/commits/${pr.head.sha}`),
    api(`${workflow}?event=pull_request&head_sha=${pr.head.sha}&per_page=100`),
  ]);
  const proof = postMergeQualification({
    repository,
    pr,
    mergeTree: baseGit.tree.sha,
    headTree: headGit.tree.sha,
    runs: history.workflow_runs,
  });
  return [main, history.workflow_runs.find((run) => run.id === proof.runId)];
}

export async function planNativeValidation(
  comparison,
  repository,
  api,
  isReferenced,
  keepsModuleEdges,
) {
  const scope = nativeTestScope(comparison, isReferenced, keepsModuleEdges);
  if (!scope) return { lanes: nativeValidationLanes, sources: {} };
  const lanes = { ...nativeValidationLanes };
  const sources = {};
  const selected = changedNativeTestLanes(comparison.files);
  for (const source of (await qualifiedBaseRun(api, repository, comparison.base)).filter(Boolean)) {
    const result = nativeMatrices(scope, await runJobs(api, repository, source), source, selected);
    for (const [kind, matrix] of Object.entries(result)) {
      if (matrix.length < lanes[kind].length) {
        lanes[kind] = matrix;
        sources[kind] = { run: source.id, head: source.head_sha };
      }
    }
  }
  const browserFiles =
    lanes.browser.length < nativeValidationLanes.browser.length ? selected.browserFiles : undefined;
  return { lanes, sources, ...(browserFiles ? { browserFiles } : {}) };
}

export async function planMergedNativeValidation(root, repository, sha, api, isReferenced) {
  const fallback = { lanes: nativeValidationLanes, sources: {} };
  if (
    !/^[0-9a-f]{40}$/.test(sha) ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== sha
  )
    return fallback;
  const prefix = `repos/${repository}`;
  const pulls = await api(`${prefix}/commits/${sha}/pulls`);
  const pr = pulls.find(
    (item) => item.base.ref === 'main' && item.merged_at && item.merge_commit_sha === sha,
  );
  if (!pr || !/^[0-9a-f]{40}$/.test(pr.head.sha)) return fallback;
  const runs = await api(
    `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`,
  );
  const source = latestPostMergePullRequestRun({ repository, pr, runs: runs.workflow_runs });
  if (source?.status !== 'completed' || source.conclusion !== 'success') return fallback;
  const files = changedCiInputs(root, pr.head.sha, sha);
  // Identical trees belong to the existing exact-tree optimization. The
  // delta route retains a current sentinel for each previously executed suite.
  if (!files?.length) return fallback;
  const comparison = { base: pr.head.sha, target: sha, files };
  const scope = nativeTestScope(comparison, isReferenced, (path) =>
    unchangedModuleEdges(root, comparison, path),
  );
  if (!scope) return fallback;
  const lanes = nativeMatrices(scope, await runJobs(api, repository, source), source);
  const sources = Object.fromEntries(
    Object.entries(lanes)
      .filter(([, matrix]) => matrix.length === 1)
      .map(([kind]) => [kind, { run: source.id, head: source.head_sha }]),
  );
  return { lanes, sources };
}

if (import.meta.main) {
  const { GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_SHA, GITHUB_REF, GH_TOKEN } =
    process.env;
  let result = { lanes: nativeValidationLanes, sources: {} };
  const mainPush = GITHUB_EVENT_NAME === 'push' && GITHUB_REF === 'refs/heads/main';
  if (
    (mainPush || GITHUB_EVENT_NAME === 'pull_request') &&
    process.env.FORGEAX_NATIVE_FULL_SCOPE !== '1'
  ) {
    try {
      const signal = AbortSignal.timeout(10_000);
      const api = (endpoint) =>
        requestGitHub(
          endpoint,
          GH_TOKEN,
          (url, options) =>
            fetch(url, { ...options, signal: AbortSignal.any([signal, options.signal]) }),
          {
            sleepFn: () => {
              throw new Error('native validation lookup unavailable');
            },
          },
        );
      const root = process.cwd();
      const comparison = mainPush ? undefined : comparedCiInputs(root);
      result = mainPush
        ? await planMergedNativeValidation(root, GITHUB_REPOSITORY, GITHUB_SHA, api, referencedTest)
        : await planNativeValidation(comparison, GITHUB_REPOSITORY, api, referencedTest, (path) =>
            unchangedModuleEdges(root, comparison, path),
          );
    } catch (error) {
      console.log(`[native-validation] full scope: ${error.message}`);
    }
  }
  console.log(JSON.stringify(result));
  for (const [kind, matrix] of Object.entries(result.lanes))
    appendFileSync(GITHUB_OUTPUT, `${kind}=${JSON.stringify(matrix)}\n`);
  appendFileSync(GITHUB_OUTPUT, `browser_files=${JSON.stringify(result.browserFiles ?? {})}\n`);
}
