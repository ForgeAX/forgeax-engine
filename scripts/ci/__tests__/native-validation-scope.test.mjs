import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unchangedModuleEdges } from '../ci-input-changes.mjs';
import {
  changedNativeTestLanes,
  nativeMatrices,
  nativeTestScope,
  nativeValidationLanes,
  planMergedNativeValidation,
  planNativeValidation,
} from '../native-validation-scope.mjs';

const fallbackTails = [
  'MSAA paired P2 proof (real OFF/ON captures)',
  'Multiplayer snake browser E2E (M16 reconnect/resync)',
];
const edit = (path, status = 'M') => ({ path, status });
const browserTest = edit('packages/render/src/mesh/__tests__/mesh.browser.test.ts');
const dawnTest = edit('packages/render/src/__tests__/mesh.dawn.test.ts');
const unreferenced = () => false;
const base = 'b'.repeat(40);
const source = {
  id: 88,
  head_sha: base,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
};
const success = (name) => ({ name, conclusion: 'success' });
const job = (name, steps) => ({
  name,
  run_id: source.id,
  head_sha: base,
  status: 'completed',
  conclusion: 'success',
  steps: steps.map(success),
});
const jobs = [
  job('webkit-fallback', fallbackTails),
  ...nativeValidationLanes.browser.map((lane) =>
    job(`vitest-browser-shard-${lane}`, [
      'Vitest browser project (RHI/engine API integration — shard)',
      ...(lane === 0 ? ['Verify actual browser test discovery'] : []),
      ...(lane === 1
        ? [
            'Prepare Dawn device-limit normalization for CSM replay',
            'Directional CSM Browser WebGPU smoke (M5 MVD)',
          ]
        : []),
    ]),
  ),
  ...nativeValidationLanes.dawn.map((lane) =>
    job(`vitest-dawn-${lane}-of-4`, ['Vitest dawn project (real GPU — *.dawn.test.ts)']),
  ),
  ...nativeValidationLanes.view.map((lane) =>
    job(`view-integration-${lane}`, [
      'Verify paired candidate and resource-preview roster',
      lane === 1
        ? 'DevKit project play browser journeys (uninstrumented)'
        : 'Runtime Pack Worker dev/build JS/TS browser gate',
    ]),
  ),
  job('view-integration', ['Require current View checks']),
];

test('an existing Browser test uses its exact daily lane when the base really ran the fleet', () => {
  const path = 'packages/app/__tests__/level-runtime-split.browser.test.ts';
  const selected = changedNativeTestLanes([edit(path)]);
  const allLanes = [...selected.browser];
  assert.equal(allLanes.length, 1);
  assert.deepEqual(nativeMatrices(new Set(['browser']), jobs, source, selected).browser, allLanes);
  const incomplete = jobs.filter(({ name }) => name !== 'vitest-browser-shard-1');
  assert.deepEqual(
    nativeMatrices(new Set(['browser']), incomplete, source, selected).browser,
    nativeValidationLanes.browser,
  );
  assert.deepEqual(
    changedNativeTestLanes([edit(path)], () => []),
    {},
  );
  assert.deepEqual(
    nativeMatrices(new Set(['browser']), jobs, source, {}).browser,
    nativeValidationLanes.browser,
  );
  const roster = execFileSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--group-concurrency=2',
      '--shard-strategy=balanced',
      '--shard-count=4',
      `--shard-index=${allLanes[0]}`,
      '--dry-run',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGEAX_CI_CORE_VALIDATION: '1',
        FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1',
        FORGEAX_BROWSER_FIXED_SMOKE: '1',
        FORGEAX_BROWSER_SCOPED_FILES: JSON.stringify(selected.browserFiles),
      },
    },
  );
  assert.ok(roster.includes(path));
});

test('only explicitly rostered Dawn tests select a single lane', () => {
  const path = 'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts';
  const scope = new Set(['dawn']);
  const selected = changedNativeTestLanes([edit(path)]);
  assert.deepEqual([...selected.dawn], [1]);
  assert.deepEqual(nativeMatrices(scope, jobs, source, selected).dawn, [1]);
  assert.deepEqual(changedNativeTestLanes([edit(path), dawnTest]), {});
  const authoring = 'packages/modeling/examples/mech-gt/__tests__/s6.case.dawn.test.ts';
  assert.deepEqual(changedNativeTestLanes([edit(path), edit(authoring)]), {});
  assert.deepEqual(nativeMatrices(scope, jobs, source, {}).dawn, nativeValidationLanes.dawn);
});

test('only detached native test edits admit a narrow validation plan', () => {
  assert.deepEqual(
    nativeTestScope({ files: [browserTest, dawnTest] }, unreferenced),
    new Set(['browser', 'dawn']),
  );
  for (const files of [
    [],
    [edit(browserTest.path, 'A')],
    [browserTest, edit('packages/render/src/mesh/renderer.ts')],
    [browserTest, edit('tools/view')],
    [edit('packages/render/src/native.dawn.test.ts')],
  ]) {
    assert.equal(nativeTestScope({ files }, unreferenced), undefined);
  }
  assert.equal(
    nativeTestScope({ files: [browserTest] }, (name) => name === 'mesh.browser.test'),
    undefined,
  );
});

test('new isolated CPU tests and View locale changes retain their execution owners', () => {
  const cpu = edit('packages/geometry/src/__tests__/new.unit.test.ts', 'A');
  const locale = edit('tools/view-plugins/locales/en.json');
  const comparison = { files: [cpu, locale] };
  const scope = nativeTestScope(comparison, unreferenced);
  assert.deepEqual(scope, new Set(['unit', 'view']));
  assert.deepEqual(nativeMatrices(scope, jobs, source), {
    browser: [0],
    dawn: [1],
    view: nativeValidationLanes.view,
  });
  assert.equal(
    nativeTestScope(comparison, () => true),
    undefined,
  );
  for (const path of [
    'packages/runtime/src/renderer.ts',
    'packages/app/src/execution/protocol.ts',
    'pnpm-lock.yaml',
  ])
    assert.equal(nativeTestScope({ files: [cpu, edit(path)] }, unreferenced), undefined);
});

test('backend-only source scope retains Browser for WeChat and fails closed for new edges', () => {
  const webSocket = edit('packages/net-websocket/src/node.ts');
  const wechat = edit('packages/platform-wechat/src/audio.ts');
  const stable = () => true;
  assert.deepEqual(nativeTestScope({ files: [webSocket] }, unreferenced, stable), new Set());
  assert.deepEqual(
    nativeTestScope({ files: [wechat] }, unreferenced, stable),
    new Set(['browser']),
  );
  assert.deepEqual(
    nativeTestScope({ files: [webSocket, dawnTest] }, unreferenced, stable),
    new Set(['dawn']),
  );
  for (const files of [
    [edit(webSocket.path, 'A')],
    [edit('packages/platform-wechat/src/index.ts')],
    [edit('packages/platform-wechat/src/core-js.d.ts')],
    [webSocket, edit('packages/net/src/session.ts')],
  ])
    assert.equal(nativeTestScope({ files }, unreferenced, stable), undefined);
  assert.equal(
    nativeTestScope({ files: [webSocket] }, unreferenced, () => false),
    undefined,
  );
});

test('module-edge admission uses exact Git content and rejects new lazy dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-native-source-scope-'));
  const file = 'subject.ts';
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = (text) => {
    writeFileSync(join(root, file), text);
    git('add', file);
    git(
      '-c',
      'user.name=Scope Test',
      '-c',
      'user.email=scope@example.test',
      'commit',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    const base = commit("import { value } from './source'; export const read = () => value + 1;");
    const body = commit("import { value } from './source'; export const read = () => value + 2;");
    const edge = commit(
      "import { value } from './source'; export const read = () => import('./view');",
    );
    assert.equal(unchangedModuleEdges(root, { base, target: body }, file), true);
    assert.equal(unchangedModuleEdges(root, { base, target: edge }, file), false);
    assert.equal(unchangedModuleEdges(root, { base, target: edge }, 'absent.ts'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact execution receipts omit three unaffected lanes but retain real representative lanes', async () => {
  const scope = nativeTestScope({ files: [browserTest] }, unreferenced);
  assert.deepEqual(nativeMatrices(scope, jobs, source), {
    browser: [0, 1, 2, 3],
    dawn: [1],
    view: [0],
  });
  const declined = jobs.map((row) =>
    row.name === 'vitest-dawn-3-of-4' ? { ...row, steps: [] } : row,
  );
  assert.deepEqual(nativeMatrices(scope, declined, source).dawn, [1, 2, 3, 4]);
  const missingCsm = jobs.map((row) => ({
    ...row,
    steps: row.steps.filter((step) => !step.name.startsWith('Directional CSM')),
  }));
  assert.deepEqual(
    nativeMatrices(new Set(['dawn']), missingCsm, source).browser,
    nativeValidationLanes.browser,
  );
  const missingFallbackTail = jobs.map((row) =>
    row.name === 'webkit-fallback' ? { ...row, steps: row.steps.slice(0, 1) } : row,
  );
  assert.deepEqual(
    nativeMatrices(new Set(['dawn']), missingFallbackTail, source).browser,
    nativeValidationLanes.browser,
  );
  assert.deepEqual(
    nativeMatrices(scope, jobs, { ...source, head_sha: 'different-head' }),
    nativeValidationLanes,
  );
  const api = async (endpoint) => {
    if (endpoint.includes('/commits/')) return [];
    if (endpoint.includes('/workflows/')) return { workflow_runs: [source] };
    assert.match(endpoint, /runs\/88\/jobs/);
    return { total_count: jobs.length, jobs };
  };
  const planned = await planNativeValidation(
    { files: [dawnTest], base },
    'example/engine',
    api,
    unreferenced,
  );
  assert.deepEqual(planned.lanes, { browser: [0], dawn: [1, 2, 3, 4], view: [0] });
  assert.deepEqual(planned.sources, {
    browser: { run: 88, head: base },
    view: { run: 88, head: base },
  });
});

test('merged trees reuse only unaffected suites with fresh exact-head source jobs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-merged-native-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = 'example/engine';
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = (name) => {
    git('add', '.');
    git('-c', 'user.name=Scope Test', '-c', 'user.email=scope@example.test', 'commit', '-qm', name);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  mkdirSync(join(root, 'packages/render/src/__tests__'), { recursive: true });
  writeFileSync(join(root, dawnTest.path), 'export const example = 1;\n');
  const head = commit('PR head');
  writeFileSync(join(root, dawnTest.path), 'export const example = 2;\n');
  const merge = commit('merge tree');
  const pr = {
    number: 42,
    base: { ref: 'main' },
    merged_at: '2026-11-20',
    merge_commit_sha: merge,
    head: { sha: head, ref: 'example' },
  };
  const run = {
    ...source,
    head_sha: head,
    event: 'pull_request',
    head_repository: { full_name: repository },
    pull_requests: [{ number: pr.number }],
  };
  const actualJobs = jobs.map((entry) => ({ ...entry, head_sha: head }));
  const api =
    (candidateJobs, latest = run) =>
    async (endpoint) => {
      if (endpoint.endsWith('/pulls')) return [pr];
      if (endpoint.includes('/workflows/')) return { workflow_runs: [latest] };
      assert.match(endpoint, /runs\/88\/jobs/);
      return { total_count: candidateJobs.length, jobs: candidateJobs };
    };
  const plan = await planMergedNativeValidation(
    root,
    repository,
    merge,
    api(actualJobs),
    unreferenced,
  );
  assert.deepEqual(plan.lanes, { browser: [0], dawn: [1, 2, 3, 4], view: [0] });
  assert.equal(
    (
      await planMergedNativeValidation(
        root,
        repository,
        merge,
        api(actualJobs, { ...run, conclusion: 'failure' }),
        unreferenced,
      )
    ).lanes,
    nativeValidationLanes,
  );
  const inherited = actualJobs.map((entry) =>
    entry.name === 'vitest-browser-shard-2' ? { ...entry, steps: [] } : entry,
  );
  assert.deepEqual(
    (await planMergedNativeValidation(root, repository, merge, api(inherited), unreferenced)).lanes,
    { browser: [0, 1, 2, 3], dawn: [1, 2, 3, 4], view: [0] },
  );
  assert.equal(
    (await planMergedNativeValidation(root, repository, merge, api(actualJobs), () => true)).lanes,
    nativeValidationLanes,
  );
});
