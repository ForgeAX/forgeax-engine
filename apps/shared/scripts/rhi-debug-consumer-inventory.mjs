#!/usr/bin/env node
// Enumerate the migration surface before the M7 consumer cut.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TS_EXTENSIONS = new Set(['.ts', '.tsx']);
const SCRIPT_EXTENSIONS = new Set(['.mjs']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.forgeax-harness',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
]);

const INVENTORY_SCRIPT = resolve(fileURLToPath(import.meta.url));

const LEGACY_PATTERNS = [
  'DebugRhiAdapter',
  'createDebugRhiAdapter',
  'InspectorCache',
  'replayDispose',
  '_debugAdapter',
  '_resolveHandle',
  '_events',
  '_getCapturedDevice',
  '_getDescriptorTable',
  'MaterialDrawProvenance',
  'materialProvenance',
  'LiveLinearHdrReadback',
  'readbackLiveLinearHdr',
  'consumeToolPreviewTape',
  'analyzeMergeability',
  'paired-differential',
  'pixelDeltaAbsMean',
  'adaptReplayFormat',
  'SUPPORTED_TAPE_VERSIONS',
  'frame-0.report.json',
  'capture-frame',
  'inspect-at',
  'trigger-browser',
  'forgeax-engine-rhi-debug',
];

const TS_PATTERNS = [...LEGACY_PATTERNS, 'tapePath', 'reportPath', 'drawIdx', 'debugAdapter'];
const SCRIPT_PATTERNS = [...LEGACY_PATTERNS, 'tapePath', 'reportPath', 'drawIdx', 'debugAdapter'];
const JSON_PATTERNS = [
  ...LEGACY_PATTERNS,
  'tapePath',
  'reportPath',
  'drawIdx',
  'debugAdapter',
  'paired',
  'live-linear-hdr',
  'rhi-debug-provider',
];

const TS_ROOTS = [
  'packages/rhi-debug/src',
  'packages/app/src',
  'packages/remote/src',
  'packages/devkit/src',
  'packages/render/src',
  'packages/runtime/src',
  'apps/rhi-debug-viewer/src',
  'apps/preview',
  'apps/shared/src',
  'apps/hello',
  'apps/learn-render',
];

const SCRIPT_ROOTS = [
  'apps/hello',
  'apps/learn-render',
  'apps/preview',
  'apps/shared/scripts',
  'apps/rhi-debug-viewer/fixtures',
  'apps/rhi-debug-viewer/scripts',
  'scripts',
];

const JSON_ROOTS = [
  'packages/rhi-debug',
  'packages/app',
  'packages/remote',
  'packages/devkit',
  'packages/vite-plugin-rhi-debug',
  'apps/rhi-debug-viewer',
  'apps/preview',
  'apps/shared',
  'apps/hello',
  'apps/learn-render',
];

function walkFiles(root, predicate, files = []) {
  if (!existsSync(root)) return files;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.name !== '.config.json') continue;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walkFiles(resolve(root, entry.name), predicate, files);
      continue;
    }
    const path = resolve(root, entry.name);
    if (predicate(path, entry.name)) files.push(path);
  }
  return files;
}

function sourceFiles(root, relativeRoots, extensions) {
  return relativeRoots.flatMap((relativeRoot) =>
    walkFiles(resolve(root, relativeRoot), (path) => extensions.has(extname(path))),
  );
}

function rhiScriptFiles(root) {
  return sourceFiles(root, SCRIPT_ROOTS, SCRIPT_EXTENSIONS).filter((path) => {
    const file = relative(root, path).replaceAll('\\', '/');
    return (
      file.startsWith('apps/shared/scripts/rhi-debug-') ||
      file.startsWith('apps/rhi-debug-viewer/fixtures/') ||
      file.startsWith('apps/rhi-debug-viewer/scripts/') ||
      file.startsWith('scripts/rhi-debug-')
    );
  });
}

function jsonFiles(root, relativeRoots) {
  return relativeRoots.flatMap((relativeRoot) =>
    walkFiles(resolve(root, relativeRoot), (_path, name) =>
      name === 'package.json' ||
      name.endsWith('.schema.json') ||
      name.endsWith('.pack.json') ||
      name.endsWith('.meta.json') ||
      name.endsWith('.config.json'),
    ),
  );
}

function countPattern(text, pattern) {
  const lines = [];
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(escaped, 'g');
  let lineNumber = 1;
  let nextLineBreak = text.indexOf('\n');
  for (const match of text.matchAll(expression)) {
    const start = match.index ?? 0;
    while (nextLineBreak !== -1 && nextLineBreak < start) {
      lineNumber += 1;
      nextLineBreak = text.indexOf('\n', nextLineBreak + 1);
    }
    lines.push(lineNumber);

    // Count newlines inside a match too, so this stays correct if a future
    // inventory token spans lines. Current migration tokens are single-line.
    const end = start + match[0].length;
    while (nextLineBreak !== -1 && nextLineBreak < end) {
      lineNumber += 1;
      nextLineBreak = text.indexOf('\n', nextLineBreak + 1);
    }
  }
  return { count: lines.length, lines };
}

function scanFiles(root, files, patterns) {
  const matches = [];
  const patternCounts = Object.fromEntries(patterns.map((pattern) => [pattern, 0]));
  for (const path of files.sort()) {
    if (path === INVENTORY_SCRIPT) continue;
    const text = readFileSync(path, 'utf8');
    const fileMatches = [];
    for (const pattern of patterns) {
      const result = countPattern(text, pattern);
      if (result.count === 0) continue;
      patternCounts[pattern] += result.count;
      fileMatches.push({ pattern, count: result.count, lines: result.lines });
    }
    if (fileMatches.length > 0) {
      matches.push({ path: relative(root, path).replaceAll('\\', '/'), matches: fileMatches });
    }
  }
  return {
    scannedFileCount: files.length,
    matchedFileCount: matches.length,
    totalMatches: Object.values(patternCounts).reduce((sum, count) => sum + count, 0),
    patternCounts,
    matches,
  };
}

export function scanConsumerInventory(rootDirectory) {
  const root = resolve(rootDirectory);
  const channels = {
    tsModule: scanFiles(root, sourceFiles(root, TS_ROOTS, TS_EXTENSIONS), TS_PATTERNS),
    typesErasedScript: scanFiles(
      root,
      rhiScriptFiles(root),
      SCRIPT_PATTERNS,
    ),
    jsonSchema: scanFiles(root, jsonFiles(root, JSON_ROOTS), JSON_PATTERNS),
  };
  const baseline = Object.values(channels).reduce(
    (summary, channel) => ({
      scannedFileCount: summary.scannedFileCount + channel.scannedFileCount,
      matchedFileCount: summary.matchedFileCount + channel.matchedFileCount,
      totalMatches: summary.totalMatches + channel.totalMatches,
    }),
    { scannedFileCount: 0, matchedFileCount: 0, totalMatches: 0 },
  );
  return {
    schemaVersion: 1,
    root,
    channels,
    baseline,
  };
}

function parseArgs(argv) {
  const args = { json: false, assertZero: false, root: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') args.json = true;
    else if (argument === '--assert-zero') args.assertZero = true;
    else if (argument === '--root' && argv[index + 1]) args.root = argv[++index];
    else if (argument === '--out' && argv[index + 1]) args.out = argv[++index];
    else if (argument === '--help') {
      process.stdout.write(
        'Usage: node apps/shared/scripts/rhi-debug-consumer-inventory.mjs [--root DIR] [--json] [--out FILE] [--assert-zero]\n',
      );
      return null;
    }
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) process.exit(0);
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const report = scanConsumerInventory(args.root ?? defaultRoot);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) writeFileSync(resolve(args.out), output);
  if (args.json || args.out) process.stdout.write(output);
  else process.stdout.write(`M7 consumer baseline: ${report.baseline.totalMatches} matches in ${report.baseline.matchedFileCount} files\n`);
  if (args.assertZero && report.baseline.totalMatches > 0) process.exitCode = 1;
}
