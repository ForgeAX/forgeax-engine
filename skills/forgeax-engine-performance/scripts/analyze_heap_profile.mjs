#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { heapNodes, selectedHeap } from './heap_profile.mjs';
import { canonical, emitJson, loadJson, pointer, requireFact, runCli } from './lib.mjs';

export function analyzeHeapProfile(profile, symbols = new Map(), top = 30) {
  requireFact(Number.isSafeInteger(top) && top > 0 && top <= 1000, 'top must be 1..1000');
  const nodes = heapNodes(profile),
    byId = new Map(nodes.map((n) => [n.id, n])),
    parents = new Map();
  for (const node of nodes) for (const child of node.children) parents.set(child.id, node.id);
  for (const [id, source] of symbols)
    requireFact(
      byId.has(id) &&
        typeof source?.file === 'string' &&
        source.file.length > 0 &&
        Number.isSafeInteger(source.line) &&
        source.line > 0 &&
        Number.isSafeInteger(source.column) &&
        source.column > 0,
      'Invalid source symbol',
    );
  const directFiles = new Map(),
    ownerFiles = new Map(),
    callers = new Map(),
    unresolved = new Map();
  const add = (map, key, bytes, facts = {}) => {
    let row = map.get(key);
    if (!row) {
      row = { key, bytes: 0, ...facts };
      map.set(key, row);
    }
    row.bytes += bytes;
    return row;
  };
  let totalBytes = 0,
    directBytes = 0,
    ancestorBytes = 0,
    unresolvedBytes = 0;
  for (const node of nodes) {
    const bytes = node.selfSize;
    totalBytes += bytes;
    if (!bytes) continue;
    const direct = symbols.get(node.id);
    add(directFiles, direct?.file ?? '(unmapped)', bytes);
    let owner = node.id;
    while (owner !== undefined && !symbols.has(owner)) owner = parents.get(owner);
    const source = symbols.get(owner);
    if (!source) {
      unresolvedBytes += bytes;
      add(ownerFiles, '(unresolved)', bytes);
      add(unresolved, canonical(node.callFrame), bytes, { callFrame: node.callFrame });
      continue;
    }
    if (owner === node.id) directBytes += bytes;
    else ancestorBytes += bytes;
    add(ownerFiles, source.file, bytes);
    const row = add(callers, canonical(source), bytes, {
      source,
      functionName: byId.get(owner).callFrame.functionName,
      directBytes: 0,
      descendantBytes: 0,
      descendants: new Map(),
    });
    if (owner === node.id) row.directBytes += bytes;
    else {
      row.descendantBytes += bytes;
      add(row.descendants, canonical(node.callFrame), bytes, { callFrame: node.callFrame });
    }
  }
  requireFact(
    Number.isFinite(totalBytes) && directBytes + ancestorBytes + unresolvedBytes === totalBytes,
    'Allocation conservation failed',
  );
  const sorted = (map) => [...map.values()].sort((a, b) => b.bytes - a.bytes);
  const allCallers = sorted(callers).map((row) => ({
    ...row,
    descendants: sorted(row.descendants),
  }));
  return {
    kind: 'heap-allocation-attribution',
    byteUnit: 'bytes',
    totalBytes,
    sampleCount: profile.samples.length,
    totalSampleBytes: profile.samples.reduce((n, s) => n + s.size, 0),
    nodeCount: nodes.length,
    coverage: {
      directBytes,
      ancestorBytes,
      unresolvedBytes,
      directFraction: totalBytes ? directBytes / totalBytes : null,
      locatedAncestorFraction: totalBytes ? (directBytes + ancestorBytes) / totalBytes : null,
    },
    directFiles: sorted(directFiles),
    nearestOwnerFiles: sorted(ownerFiles),
    callerGroupCount: allCallers.length,
    topNearestCallers: allCallers.slice(0, top),
    unresolvedGroupCount: unresolved.size,
    topUnresolved: sorted(unresolved).slice(0, top),
    interpretation:
      'Each node selfSize is counted once per partition. Direct files and nearest-owner files are alternative views, not additive. Ancestor attribution includes unmapped script and no-URL descendants, not exact allocation expressions. V8 node selfSize and sample size totals can differ and are reported separately. Sampling coverage and collected-object flags do not establish live heap size, exact freed bytes, per-function GC pause or workload acceptance.',
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'profile-pointer': { type: 'string', default: '' },
      symbols: { type: 'string' },
      top: { type: 'string', default: '30' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node analyze_heap_profile.mjs INPUT [--profile-pointer /profiles/1/heap] [--symbols FILE] [--top 30] [--output FILE]',
    );
    return;
  }
  requireFact(positionals.length === 1, 'Require one heap JSON input');
  const input = await loadJson(positionals[0]),
    selected = selectedHeap(pointer(input.value, values['profile-pointer']));
  let symbols = new Map(),
    symbolInput;
  if (values.symbols) {
    symbolInput = await loadJson(values.symbols);
    requireFact(
      symbolInput.value.kind === 'heap-source-symbols' &&
        symbolInput.value.inputSha256 === input.sha256 &&
        symbolInput.value.profilePointer === values['profile-pointer'] &&
        Array.isArray(symbolInput.value.symbols),
      'Symbols belong to another input/profile',
    );
    for (const row of symbolInput.value.symbols) {
      requireFact(!symbols.has(row.nodeId), 'Duplicate source symbol');
      symbols.set(row.nodeId, row.source);
    }
  }
  await emitJson(
    {
      inputSha256: input.sha256,
      profilePointer: values['profile-pointer'],
      metadata: selected.metadata,
      symbolsSha256: symbolInput?.sha256 ?? null,
      ...analyzeHeapProfile(selected.profile, symbols, Number(values.top)),
    },
    values.output,
    [...positionals, ...(values.symbols ? [values.symbols] : [])],
  );
});
