#!/usr/bin/env node

// Machine-readable retained-core and OOS inventory for the v7 RHI debug cut.
// This gate scans only production source and manifests. Test helpers are
// reported separately and never make a production token pass implicitly.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.json']);
const SKIPPED = new Set(['.git', '.forgeax-harness', 'dist', 'node_modules', 'coverage']);

const OOS = [
  { id: 'OOS-1', scope: 'paired differential, result-only viewer, and production comparison policy', paths: ['packages/rhi-debug/src', 'apps/rhi-debug-viewer/src'], tokens: ['paired-differential', 'MaterialDrawProvenance'] },
  { id: 'OOS-2', scope: 'live RPC inspect, WS replay, and replay cache', paths: ['packages/rhi-debug/src', 'packages/remote/src'], tokens: ['inspectAt', 'LRUReplayCache', 'LiveReplayCache'] },
  { id: 'OOS-3', scope: 'v2-v6 readers and converters', paths: ['packages/rhi-debug/src'], tokens: ['convertTapeV2', 'convertTapeV3', 'SUPPORTED_TAPE_VERSIONS'] },
  { id: 'OOS-4', scope: 'legacy CLI, public subpaths, and compatibility aliases', paths: ['packages/rhi-debug/package.json', 'packages/rhi-debug/src/index.ts'], tokens: ['./cli', './capture-browser', 'buildViewerModel', 'buildViewModel'] },
  { id: 'OOS-5', scope: 'UI, compiler, and host dependencies in core or game production', paths: ['packages/rhi-debug/src', 'apps/hello/cube/src'], tokens: ['@codemirror/', 'dockview', '@forgeax/engine-naga', 'from \'react\'', 'node:fs', 'node:path'] },
  { id: 'OOS-6', scope: 'InstanceData, MaterialAsset, authoring, override, and writeback', paths: ['packages/rhi-debug/src'], tokens: ['InstanceData', 'MaterialAsset', 'materialProvenance', 'writeTape', 'liveEngineMutation'] },
  { id: 'OOS-7', scope: 'multi-frame, performance history, and cross-backend product surfaces', paths: ['packages/rhi-debug/src'], tokens: ['PerformanceHistory', 'perPixelHistory', 'CrossBackendComparison'] },
  { id: 'OOS-8', scope: 'second model, readback, parser, or identity owner', paths: ['packages/rhi-debug/src'], tokens: ['buildViewerModel', 'buildViewModel', 'SecondReadbackOwner', 'TapeParserOwner'] },
  { id: 'OOS-9', scope: 'independent DropZone component', paths: ['apps/rhi-debug-viewer/src'], tokens: ['DropZone', 'drop-zone'] },
];

const RETAINED = [
  'packages/rhi-debug/src/protocol/codec.ts',
  'packages/rhi-debug/src/protocol/tape-index.ts',
  'packages/rhi-debug/src/frame-model.ts',
  'packages/rhi-debug/src/replay/session.ts',
  'packages/rhi-debug/src/replay/readback.ts',
  'apps/rhi-debug-viewer/src/viewer-context.tsx',
];

function walk(root, output = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.name !== '.config.json') continue;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) walk(resolve(root, entry.name), output);
      continue;
    }
    const path = resolve(root, entry.name);
    if (path.includes('/__tests__/') || /\.(test|spec)\.[^.]+$/.test(entry.name)) continue;
    if (SOURCE_EXTENSIONS.has(extname(entry.name))) output.push(path);
  }
  return output;
}

function filesFor(root, paths) {
  return paths.flatMap((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return [];
    return SOURCE_EXTENSIONS.has(extname(absolute)) ? [absolute] : walk(absolute);
  });
}

function scan(root, rule) {
  const matches = [];
  for (const path of filesFor(root, rule.paths)) {
    const text = readFileSync(path, 'utf8');
    for (const token of rule.tokens) {
      const index = text.indexOf(token);
      if (index === -1) continue;
      matches.push({ path: relative(root, path), token, line: text.slice(0, index).split('\n').length });
    }
  }
  return { id: rule.id, scope: rule.scope, allowlistedTestHelpers: [], matches, status: matches.length === 0 ? 'pass' : 'fail' };
}

export function buildOosInventory(rootDirectory) {
  const root = resolve(rootDirectory);
  const retainedCore = RETAINED.map((path) => ({ path, present: existsSync(resolve(root, path)) }));
  const oos = OOS.map((rule) => scan(root, rule));
  const failures = [
    ...retainedCore.filter((entry) => !entry.present).map((entry) => ({ kind: 'retained-core-missing', path: entry.path })),
    ...oos.filter((entry) => entry.status === 'fail').map((entry) => ({ kind: 'oos-token', id: entry.id, matches: entry.matches })),
  ];
  return { schemaVersion: 1, root, retainedCore, oos, failures, status: failures.length === 0 ? 'pass' : 'fail' };
}

function parseArgs(argv) {
  const args = { root: resolve(fileURLToPath(new URL('../../..', import.meta.url))), json: false, assertPass: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) args.root = resolve(argv[++index]);
    else if (argv[index] === '--json') args.json = true;
    else if (argv[index] === '--assert-pass') args.assertPass = true;
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = buildOosInventory(args.root);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`RHI debug OOS inventory: ${report.status} (${report.failures.length} failures)\n`);
  if (args.assertPass && report.status !== 'pass') process.exitCode = 1;
}
