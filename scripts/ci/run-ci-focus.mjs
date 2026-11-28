#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerResources, shaderCompileWorkers } from '../lib/runner-resources.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';
import { selectDawnGroups } from './run-dawn-gate.mjs';
import {
  isSmokeAppBuildDeferred,
  parseSmokeFrameBudget,
  partitionRunnableEntries,
  readRoster,
  resolveRunnableEntries,
  runAggregate,
  runEntry,
  runShard,
  selectSmokeEntries,
} from './run-dawn-smoke-roster.mjs';
import {
  allProjectNames,
  buildGroupArgs,
  coverageGroupEnvironment,
  coverageGroupMaxWorkers,
  coverageGroups,
  packageOnlyNodeAppProjects,
} from './run-split-vitest-coverage.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = 'scripts/ci/run-vitest-projects.mjs';

function smokeAppBuilds(entries) {
  return [
    ...new Set(
      entries
        .filter((entry) => !isSmokeAppBuildDeferred(entry))
        .map((entry) => dirname(entry.path)),
    ),
  ];
}
// Pure CPU owners consume their own inputs and package outputs, not Engine profiles.
const packageOnlyUnitOwners = new Set([
  '@forgeax/engine-content',
  '@forgeax/engine-naga',
  '@forgeax/engine-shader-compiler',
  '@forgeax/engine-modeling',
  ...packageOnlyNodeAppProjects,
]);
// These exact CPU fixtures own their complete publication/registry inputs.
// Other shader tests still consume the prepared Engine profile.
const packageOnlyUnitFiles = new Set([
  'packages/vite-plugin-shader/src/__tests__/engine-template-manifest.unit.test.ts',
  'packages/gltf/src/__tests__/meta-pack-ddc.integration.test.ts',
  'packages/import/src/__tests__/meta-pack-ddc.integration.test.ts',
  'packages/pack/src/__tests__/runtime-publication.unit.test.ts',
  'packages/devkit/src/tools/__tests__/model-render-target.unit.test.ts',
  'packages/render/src/__tests__/managed-scene-recording.integration.test.ts',
  ...[
    'manifest-reflection-sharing',
    'manifest-publication',
    'shader-registry-publication-sharing',
    'shader-registry-transaction',
    'native-manifest',
    'shader-manifest-transmission',
  ].map((name) => `packages/shader/src/__tests__/${name}.unit.test.ts`),
]);

// These planner tests exercise source scripts and their own fixtures without
// importing generated Engine packages or invoking the Engine toolchain.
const sourceOnlyNodeFiles = new Set([
  'scripts/ci/__tests__/artifact-range-download.test.mjs',
  'scripts/ci/__tests__/artifact-upload-paths.test.mjs',
  'scripts/ci/__tests__/browser-tail-ownership.test.mjs',
  'scripts/ci/__tests__/browser-work.test.mjs',
  'scripts/ci/__tests__/ci-focus.test.mjs',
  'scripts/ci/__tests__/core-validation.test.mjs',
  'scripts/ci/__tests__/coverage-baseline.test.mjs',
  'scripts/ci/__tests__/native-validation-scope.test.mjs',
  'scripts/ci/__tests__/post-merge-qualification.test.mjs',
  'scripts/ci/__tests__/download-artifact-with-retry.test.mjs',
  'scripts/ci/__tests__/prepare-ci-inputs.test.mjs',
  'scripts/ci/__tests__/recover-repair-shader-inputs.test.mjs',
  'scripts/ci/__tests__/run-split-vitest-browser.test.mjs',
  'scripts/ci/__tests__/run-with-runner-cpu-affinity.test.mjs',
  'scripts/ci/__tests__/sdk-shader-artifacts.test.mjs',
  'scripts/ci/__tests__/source-budget-progress.test.mjs',
  'scripts/ci/__tests__/view-diagnostic-workload.test.mjs',
  'scripts/forgeax/__tests__/sdk-candidate-native-inputs.test.mjs',
  'scripts/forgeax/__tests__/sdk-pr-preflight.test.mjs',
  'scripts/lib/__tests__/vite-http-readiness.test.mjs',
]);

function nodeFocusPlan(selector) {
  if (
    selector.includes('..') ||
    !/^(packages|apps|scripts)\/.+\.test\.(?:mjs|js)$/.test(selector) ||
    !existsSync(join(root, selector))
  )
    throw new Error(`unknown Node test file: ${selector}`);
  return {
    args: ['--test', selector],
    ...(sourceOnlyNodeFiles.has(selector) ? { sourceOnly: true } : { packagesOnly: true }),
  };
}

function unitFocusPlan(kind, selector) {
  if (kind === 'node') return nodeFocusPlan(selector);
  const projects = allProjectNames();
  if (projects.includes(selector))
    return {
      ...(packageOnlyUnitOwners.has(selector) ? { packagesOnly: true } : {}),
      args: [
        vitest,
        'run',
        '--project',
        selector,
        '--passWithNoTests=false',
        '--maxWorkers=1',
        kind === 'type' ? '--typecheck.only' : '--typecheck.enabled=false',
      ],
    };
  if (
    selector.includes('..') ||
    !/^(packages|apps|scripts)\/.+\.test\.(?:ts|mts|js|mjs)$/.test(selector) ||
    !existsSync(join(root, selector))
  )
    throw new Error(`unknown ${kind} project or test file: ${selector}`);
  if (kind === 'type') throw new Error('type focus selects an owning project');
  const packageManifest = selector.startsWith('packages/')
    ? join(root, ...selector.split('/').slice(0, 2), 'package.json')
    : undefined;
  const owner =
    packageManifest && existsSync(packageManifest)
      ? JSON.parse(readFileSync(packageManifest, 'utf8')).name
      : undefined;
  const projectArgs = projects.includes(owner)
    ? ['--project', owner]
    : ['--project=@forgeax/*', '--project=unit'];
  return {
    ...(packageOnlyUnitOwners.has(owner) || packageOnlyUnitFiles.has(selector)
      ? { packagesOnly: true }
      : {}),
    args: [
      vitest,
      'run',
      ...projectArgs,
      '--passWithNoTests=false',
      '--maxWorkers=1',
      '--typecheck.enabled=false',
      selector,
    ],
  };
}

function performanceFocusPlan(selector) {
  if (selector === 'ecs-ratios' || selector === 'render-ratios')
    return {
      packagesOnly: true,
      args: [
        'scripts/ci/run-with-runner-cpu-affinity.mjs',
        '--',
        process.execPath,
        vitest,
        'run',
        '--maxWorkers=1',
        `--project=${selector === 'ecs-ratios' ? 'ecs-perf' : 'render-perf'}`,
        '--coverage.enabled=false',
        '--typecheck.enabled=false',
        '--passWithNoTests=false',
      ],
      env:
        selector === 'render-ratios'
          ? { FORGEAX_RENDER_PERF_LIGHTWEIGHT: '1', FORGEAX_CI_CPU_TIME_DIAGNOSTICS: '1' }
          : {},
    };
  if (!['hello-lod-occlusion', 'hello-lod-occlusion-profile'].includes(selector))
    throw new Error(`unknown performance selector: ${selector}`);
  return {
    apps: ['apps/hello/lod-occlusion'],
    args: [
      'scripts/ci/run-with-runner-cpu-affinity.mjs',
      '--',
      process.execPath,
      'scripts/ci/run-lod-performance-with-retry.mjs',
      '--',
      'pnpm',
      '--filter',
      '@forgeax/hello-lod-occlusion',
      'bench:json',
    ],
    gpuLease: true,
    env: {
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=10240',
      ...(selector.endsWith('-profile') ? { FORGEAX_LOD_PROFILE: '1' } : {}),
    },
  };
}

function compatibilityFocusPlan(selector) {
  if (selector !== 'stable') throw new Error(`unknown compatibility selector: ${selector}`);
  return {
    args: ['scripts/ci/run-webgpu-compatibility.mjs'],
    env: { FORGEAX_COMPAT_BROWSER: 'stable' },
  };
}

function coverageFocusEnvironment(group, resources, maxWorkers) {
  const workers = group.sourceCompilation
    ? process.env.FORGEAX_SHADER_COMPILE_WORKERS
    : shaderCompileWorkers(
        resources,
        process.env.FORGEAX_SHADER_COMPILE_WORKERS,
        (group.files.length > 0 ? 1 : 2) * maxWorkers,
      );
  const environment =
    group.sourceCompilation && process.env.NODE_OPTIONS !== undefined
      ? { NODE_OPTIONS: process.env.NODE_OPTIONS }
      : {};
  return {
    ...coverageGroupEnvironment(group, resources, workers, environment),
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
}

export function focusPlan(
  kind,
  selector,
  { frames = 60, shardIndex = 0, shardCount = 1, resources = runnerResources() } = {},
) {
  if (typeof selector !== 'string' || !selector || selector.startsWith('-'))
    throw new Error('an exact selector is required');
  if (kind === 'coverage') {
    const groups = coverageGroups(allProjectNames(), 8, { isolateFiles: true });
    const selected = groups.filter(
      (group) => group.label === selector || group.files.includes(selector),
    );
    if (selected.length !== 1) throw new Error(`unknown or ambiguous coverage child: ${selector}`);
    const maxWorkers = coverageGroupMaxWorkers(
      selected[0],
      { coverage: true, maxWorkers: 1, modelingMaxWorkers: 2 },
      resources,
      2,
    );
    return {
      packagesOnly: selected[0].packagesOnly === true,
      env: coverageFocusEnvironment(selected[0], resources, maxWorkers),
      gpuLease: selected[0].gpuLease,
      args: [
        ...buildGroupArgs({
          cliPath: vitest,
          group: selected[0],
          maxWorkers,
          coverage: true,
          coverageDir: 'artifacts/ci-focus/coverage',
          reportPath: 'artifacts/ci-focus/vitest.json',
        }),
        '--passWithNoTests=false',
      ],
    };
  }
  if (kind === 'allocation') {
    if (!['all', 'math', 'ecs'].includes(selector))
      throw new Error(`unknown foundation allocation selector: ${selector}`);
    return {
      args: [
        'scripts/ci/run-foundation-allocations.mjs',
        '--select',
        selector,
        '--output',
        'artifacts/ci-focus/foundation-allocation',
      ],
    };
  }
  if (kind === 'dawn') {
    selectDawnGroups(selector);
    return { args: ['scripts/ci/run-dawn-gate.mjs', '--group', selector] };
  }
  if (kind === 'performance') return performanceFocusPlan(selector);
  if (kind === 'compatibility') return compatibilityFocusPlan(selector);
  if (kind === 'browser') {
    // Discovery validates exact membership before any browser process starts.
    execFileSync(
      process.execPath,
      ['scripts/ci/run-split-vitest-browser.mjs', '--file', selector, '--dry-run'],
      { cwd: root },
    );
    return {
      args: ['scripts/ci/run-split-vitest-browser.mjs', '--file', selector],
      ...(process.env.FORGEAX_CI_CORE_VALIDATION === '1'
        ? { env: { FORGEAX_BROWSER_COST_REPORT: '1' } }
        : {}),
    };
  }
  if (kind === 'view') {
    const groups = JSON.parse(
      execFileSync(process.execPath, ['scripts/ci/run-view-integration.mjs', '--list-groups'], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
    if (!groups.includes(selector)) throw new Error(`unknown View integration group: ${selector}`);
    return {
      args: ['scripts/ci/run-view-integration.mjs', '--candidate', '--group', selector],
    };
  }
  if (kind === 'smoke') {
    frames = parseSmokeFrameBudget(frames);
    const resolved = resolveRunnableEntries({ roster: readRoster() });
    if (selector === 'all') {
      const entries = partitionRunnableEntries(selectSmokeEntries(resolved, 'full'), {
        shardIndex,
        shardCount,
      });
      return {
        entries,
        apps: smokeAppBuilds(entries),
        scope: 'full',
        frames,
        shardIndex,
        shardCount,
      };
    }
    const { runnable, independent } = resolved;
    const entry = [...runnable, ...independent].find((candidate) => candidate.gateId === selector);
    if (!entry) throw new Error(`unknown smoke gate ID: ${selector}`);
    return { entry, apps: smokeAppBuilds([entry]), frames };
  }
  if (['unit', 'type', 'node'].includes(kind)) return unitFocusPlan(kind, selector);
  throw new Error(`unknown focus kind: ${kind}`);
}

/** Use the semantic build for owners that consume generated outputs. */
export function focusBuildArgs(plan, assetsSourceRoot) {
  if (plan.sourceOnly) return undefined;
  return [
    'scripts/build.mjs',
    plan.packagesOnly ? '--packages-only' : '--engine',
    ...(assetsSourceRoot === undefined ? [] : ['--assets-source-root', resolve(assetsSourceRoot)]),
  ];
}

async function prepareFocus(plan, assetsSourceRoot, run) {
  const buildArgs = focusBuildArgs(plan, assetsSourceRoot);
  if (buildArgs === undefined) return;
  // Semantic receipts validate current inputs and every generated output.
  for (const owner of ['wgpu-wasm', 'fbx', 'codec'])
    await run([`packages/${owner}/scripts/ensure-wasm.mjs`]);
  await run(buildArgs);
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (
      [
        '--kind',
        '--select',
        '--frames',
        '--shard-index',
        '--shard-count',
        '--assets-source-root',
      ].includes(arg) &&
      argv[i + 1]
    )
      options[arg.slice(2)] = argv[++i];
    else
      throw new Error(
        'usage: run-ci-focus.mjs --kind unit|node|coverage|type|browser|compatibility|performance|dawn|smoke|view|allocation --select EXACT_SELECTOR [--dry-run]',
      );
  }
  const frames = parseSmokeFrameBudget(options.frames ?? process.env.SMOKE_MIN_FRAMES);
  const plan = focusPlan(options.kind, options.select, {
    frames,
    shardIndex: Number(options['shard-index'] ?? 0),
    shardCount: Number(options['shard-count'] ?? 1),
  });
  console.log(
    JSON.stringify({ scope: 'diagnostic', kind: options.kind, selector: options.select, ...plan }),
  );
  if (options.dryRun) return 0;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const env = {
    ...process.env,
    EXPECTED_PRODUCT_SHA: head,
    ...(plan.apps?.length
      ? { FORGEAX_SHARED_APP_INPUTS_MANIFEST: join(root, 'shared-build-inputs/manifest.json') }
      : {}),
    SMOKE_MIN_FRAMES: String(frames),
  };
  const output = join(root, 'artifacts/ci-focus/result.json');
  const logs = join(dirname(output), 'logs');
  rmSync(dirname(output), { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  let commandIndex = 0;
  const run = async (
    args,
    { nativeCoordinator = false, gpuLease = false, commandEnv = {} } = {},
  ) => {
    const result = await runBrowserCommand([process.execPath, ...args], {
      cwd: root,
      env: { ...env, ...commandEnv },
      label: 'ci-focus',
      gpuLease,
      timeoutMs: 30 * 60_000,
      excludeGpuLeaseQueue: nativeCoordinator && env.FORGEAX_LOCAL_GPU_LEASE === '1',
    });
    writeFileSync(join(logs, `command-${++commandIndex}.log`), result.output);
    if (result.status !== 0) throw new Error(`focus command failed (${result.status}): ${args[0]}`);
  };
  const dirty =
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0;
  let status = 'failed';
  let smoke;
  try {
    await prepareFocus(plan, options['assets-source-root'], run);
    if (plan.apps?.length) await run(['scripts/build-shared-inputs.mjs']);
    for (const app of plan.apps ?? [])
      await run([
        'scripts/build-apps.mjs',
        app,
        '--shared-input-manifest',
        env.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
      ]);
    if (plan.entry || plan.entries) {
      process.env.EXPECTED_PRODUCT_SHA = head;
      process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      if (plan.entries) {
        const reportPath = join(dirname(output), `shard-${plan.shardIndex}.json`);
        smoke = await runShard({
          frames,
          scope: 'full',
          shardIndex: plan.shardIndex,
          shardCount: plan.shardCount,
          expectedProductSha: head,
          reportPath,
        });
        if (plan.shardCount === 1)
          smoke = runAggregate({
            frames,
            scope: 'full',
            shardCount: 1,
            expectedProductSha: head,
            reportDirectory: dirname(output),
          });
      } else {
        const result = await runEntry({
          entry: plan.entry,
          shardIndex: 0,
          reportPath: output,
          timeoutMs: 300_000,
          frames,
        });
        smoke = result;
        if (result.status !== 'pass')
          throw new Error(`smoke focus failed: ${JSON.stringify(result)}`);
      }
    } else
      await run(plan.args, {
        nativeCoordinator: ['browser', 'compatibility', 'dawn', 'view'].includes(options.kind),
        gpuLease: plan.gpuLease === true,
        commandEnv: plan.env,
      });
    status = 'passed';
    return 0;
  } finally {
    writeFileSync(
      output,
      `${JSON.stringify({ scope: 'diagnostic', head, dirty, kind: options.kind, selector: options.select, buildMode: plan.sourceOnly ? 'source-only' : plan.packagesOnly ? 'packages-only' : 'engine', status, smoke }, null, 2)}\n`,
    );
    console.log(`[ci-focus] ${status}; this selected run does not replace complete PR CI`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
