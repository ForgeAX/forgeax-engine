#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';
import { selectDawnGroups } from './run-dawn-gate.mjs';
import {
  parseSmokeFrameBudget,
  partitionRunnableEntries,
  readRoster,
  resolveRunnableEntries,
  runAggregate,
  runEntry,
  runShard,
  selectSmokeEntries,
} from './run-dawn-smoke-roster.mjs';
import { allProjectNames } from './run-split-vitest-coverage.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vitest = 'scripts/ci/run-vitest-projects.mjs';

export function focusPlan(kind, selector, { frames = 60, shardIndex = 0, shardCount = 1 } = {}) {
  if (typeof selector !== 'string' || !selector || selector.startsWith('-'))
    throw new Error('an exact selector is required');
  if (kind === 'dawn') {
    selectDawnGroups(selector);
    return { args: ['scripts/ci/run-dawn-gate.mjs', '--group', selector] };
  }
  if (kind === 'browser') {
    // Discovery validates exact membership before any browser process starts.
    execFileSync(
      process.execPath,
      ['scripts/ci/run-split-vitest-browser.mjs', '--file', selector, '--dry-run'],
      { cwd: root },
    );
    return { args: ['scripts/ci/run-split-vitest-browser.mjs', '--file', selector] };
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
        apps: [...new Set(entries.map((entry) => dirname(entry.path)))],
        scope: 'full',
        frames,
        shardIndex,
        shardCount,
      };
    }
    const { runnable, independent } = resolved;
    const entry = [...runnable, ...independent].find((candidate) => candidate.gateId === selector);
    if (!entry) throw new Error(`unknown smoke gate ID: ${selector}`);
    return { entry, apps: [dirname(entry.path)], frames };
  }
  if (kind === 'unit' || kind === 'type') {
    const projects = allProjectNames();
    if (projects.includes(selector))
      return {
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
  throw new Error(`unknown focus kind: ${kind}`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (
      ['--kind', '--select', '--frames', '--shard-index', '--shard-count'].includes(arg) &&
      argv[i + 1]
    )
      options[arg.slice(2)] = argv[++i];
    else
      throw new Error(
        'usage: run-ci-focus.mjs --kind unit|type|browser|dawn|smoke --select EXACT_SELECTOR [--dry-run]',
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
    FORGEAX_SHARED_APP_INPUTS_MANIFEST: join(root, 'shared-build-inputs/manifest.json'),
    SMOKE_MIN_FRAMES: String(frames),
  };
  const output = join(root, 'artifacts/ci-focus/result.json');
  const logs = join(dirname(output), 'logs');
  rmSync(dirname(output), { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  let commandIndex = 0;
  const run = async (args, { nativeCoordinator = false } = {}) => {
    const result = await runBrowserCommand([process.execPath, ...args], {
      cwd: root,
      env,
      label: 'ci-focus',
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
    // Existing semantic build receipts validate changed code and output bytes.
    // Every invocation checks them; no unchecked --skip-build path can use old dist.
    for (const owner of ['wgpu-wasm', 'fbx', 'codec'])
      await run([`packages/${owner}/scripts/ensure-wasm.mjs`]);
    await run(['scripts/build.mjs', '--engine']);
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
    } else await run(plan.args, { nativeCoordinator: ['browser', 'dawn'].includes(options.kind) });
    status = 'passed';
    return 0;
  } finally {
    writeFileSync(
      output,
      `${JSON.stringify({ scope: 'diagnostic', head, dirty, kind: options.kind, selector: options.select, status, smoke }, null, 2)}\n`,
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
