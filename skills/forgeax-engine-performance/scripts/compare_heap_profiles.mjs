#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { attributeHeapProfile } from './analyze_heap_profile.mjs';
import { heapNodes, loadHeapSymbols, selectedHeap } from './heap_profile.mjs';
import { emitJson, loadJson, pointer, requireFact, runCli } from './lib.mjs';

export const HEAP_PROFILE_KINDS = ['retained', 'churn'];

/** Package of a source file: `packages/<name>/`, a node_modules package, or its first directory. */
export function sourcePackage(file) {
  const workspace = file.match(/(?:^|\/)packages\/([^/]+)\//);
  if (workspace) return workspace[1];
  const dependency = file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (dependency) return dependency[1];
  const directories = file.split('/').slice(0, -1);
  return directories.length ? directories.slice(0, 2).join('/') : file;
}

/**
 * Treat call frames whose URL is already a source path (an in-place symbolized profile) as
 * symbols. HTTP(S), file and empty URLs stay unresolved.
 */
export function inlineSourceSymbols(profile) {
  const symbols = new Map();
  for (const node of heapNodes(profile)) {
    const { url, lineNumber, columnNumber } = node.callFrame;
    if (!url || /^[a-z][\w+.-]*:\/\//i.test(url) || lineNumber < 0) continue;
    symbols.set(node.id, {
      file: url,
      line: lineNumber + 1,
      column: Math.max(0, columnNumber) + 1,
      name: null,
    });
  }
  return symbols;
}

// Function identity omits line/column so that edits elsewhere in a file keep matching keys.
const functionKey = (row) =>
  `${row.source.file}#${row.functionName || row.source.name || `(anonymous:${row.source.line})`}`;
const unresolvedKey = (row) => {
  const { functionName, url } = row.callFrame;
  return `${functionName || '(anonymous)'} @ ${url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '')}`;
};

function tables(attribution) {
  const add = (map, key, bytes) => map.set(key, (map.get(key) ?? 0) + bytes);
  const packages = new Map(),
    files = new Map(),
    functions = new Map(),
    unresolved = new Map();
  for (const row of attribution.nearestOwnerFiles)
    if (row.key !== '(unresolved)') add(packages, sourcePackage(row.key), row.bytes);
  for (const row of attribution.nearestOwnerFiles) add(files, row.key, row.bytes);
  for (const row of attribution.callers) add(functions, functionKey(row), row.bytes);
  for (const row of attribution.unresolved) add(unresolved, unresolvedKey(row), row.bytes);
  if (attribution.unresolvedBytes) packages.set('(unresolved)', attribution.unresolvedBytes);
  return { packages, files, functions, unresolved };
}

/** Rows of `{key, beforeBytes, afterBytes, deltaBytes, deltaPercent}` sorted by absolute delta. */
export function diffByteTables(before, after, top = Infinity) {
  const rows = [...new Set([...before.keys(), ...after.keys()])].map((key) => {
    const beforeBytes = before.get(key) ?? 0,
      afterBytes = after.get(key) ?? 0;
    return {
      key,
      beforeBytes,
      afterBytes,
      deltaBytes: afterBytes - beforeBytes,
      deltaPercent: beforeBytes ? ((afterBytes - beforeBytes) * 100) / beforeBytes : null,
    };
  });
  rows.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes) || (a.key < b.key ? -1 : 1));
  return rows.slice(0, top);
}

/**
 * Compare two heap profiles of the same population: retained floor vs retained floor, or
 * churn vs churn. Package and total rows are complete; file/function rows are truncated to `top`.
 */
export function compareHeapProfiles(before, after, { kind, top = 30 }) {
  requireFact(HEAP_PROFILE_KINDS.includes(kind), 'kind must be retained or churn');
  requireFact(Number.isSafeInteger(top) && top > 0 && top <= 1000, 'top must be 1..1000');
  for (const side of [before, after]) {
    const collected = side.metadata?.includesCollectedByMajorGC;
    requireFact(
      collected === null || collected === undefined || collected === (kind === 'churn'),
      `Profile metadata contradicts kind ${kind}`,
    );
  }
  const a = attributeHeapProfile(before.profile, before.symbols),
    b = attributeHeapProfile(after.profile, after.symbols);
  const ta = tables(a),
    tb = tables(b);
  const side = (attribution, input) => ({
    totalBytes: attribution.totalBytes,
    sampleCount: input.profile.samples.length,
    samplingInterval: input.metadata?.samplingInterval ?? null,
    locatedFraction: attribution.totalBytes
      ? (attribution.directBytes + attribution.ancestorBytes) / attribution.totalBytes
      : null,
  });
  const intervals = [before, after].map((s) => s.metadata?.samplingInterval ?? null);
  return {
    kind: 'heap-profile-comparison',
    profileKind: kind,
    byteUnit: 'bytes',
    before: side(a, before),
    after: side(b, after),
    total: diffByteTables(new Map([['total', a.totalBytes]]), new Map([['total', b.totalBytes]]))[0],
    samplingIntervalsMatch:
      intervals.includes(null) ? null : intervals[0] === intervals[1],
    packages: diffByteTables(ta.packages, tb.packages),
    files: diffByteTables(ta.files, tb.files, top),
    functions: diffByteTables(ta.functions, tb.functions, top),
    unresolved: diffByteTables(ta.unresolved, tb.unresolved, top),
    interpretation:
      'Rows use nearest source-owner attribution: unmapped and no-URL frames count toward their nearest symbolized caller. Function keys are file#name without line, so anonymous functions keep their line. Both inputs are Poisson samples: deltas smaller than a few sampling intervals times sqrt(samples) are noise. Retained compares surviving objects at capture time (after a forced GC when the producer did so); churn compares allocation volume including collected objects, not freed bytes or GC time. Cross-build comparisons need symbols; unresolved keys use generated names and URL paths, which only match within one build.',
  };
}

async function readSide(path, profilePointer, symbolsPath, inline) {
  const input = await loadJson(path);
  const selected = selectedHeap(pointer(input.value, profilePointer));
  const { symbols, symbolInput } = await loadHeapSymbols(input, symbolsPath, profilePointer);
  requireFact(!(inline && symbolInput), 'Use either --*-symbols or --inline-sources');
  return {
    input,
    symbolInput,
    profile: selected.profile,
    metadata: selected.metadata,
    symbols: inline ? inlineSourceSymbols(selected.profile) : symbols,
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      kind: { type: 'string' },
      'before-pointer': { type: 'string', default: '' },
      'after-pointer': { type: 'string', default: '' },
      'before-symbols': { type: 'string' },
      'after-symbols': { type: 'string' },
      'inline-sources': { type: 'boolean' },
      top: { type: 'string', default: '30' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node compare_heap_profiles.mjs BEFORE AFTER --kind retained|churn [--before-pointer P] [--after-pointer P] [--before-symbols FILE] [--after-symbols FILE] [--inline-sources] [--top 30] [--output FILE]',
    );
    return;
  }
  requireFact(positionals.length === 2, 'Require BEFORE and AFTER heap JSON inputs');
  const before = await readSide(
    positionals[0],
    values['before-pointer'],
    values['before-symbols'],
    values['inline-sources'],
  );
  const after = await readSide(
    positionals[1],
    values['after-pointer'],
    values['after-symbols'],
    values['inline-sources'],
  );
  await emitJson(
    {
      beforeSha256: before.input.sha256,
      afterSha256: after.input.sha256,
      beforeSymbolsSha256: before.symbolInput?.sha256 ?? null,
      afterSymbolsSha256: after.symbolInput?.sha256 ?? null,
      inlineSources: values['inline-sources'] ?? false,
      ...compareHeapProfiles(before, after, { kind: values.kind, top: Number(values.top) }),
    },
    values.output,
    [
      ...positionals,
      ...[values['before-symbols'], values['after-symbols']].filter(Boolean),
    ],
  );
});
