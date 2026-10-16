#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { canonical, emitJson, loadJson, pointer, requireFact, runCli, statistics } from './lib.mjs';

export function analyzeCpuProfile(profile, top = 30) {
  requireFact(Number.isSafeInteger(top) && top > 0 && top <= 1000, 'top must be 1..1000');
  requireFact(
    Array.isArray(profile.nodes) &&
      Array.isArray(profile.samples) &&
      profile.samples.length > 0 &&
      Array.isArray(profile.timeDeltas) &&
      profile.samples.length === profile.timeDeltas.length,
    'Require nodes, samples, and matching timeDeltas',
  );
  requireFact(
    Number.isFinite(profile.startTime) &&
      Number.isFinite(profile.endTime) &&
      profile.endTime > profile.startTime,
    'Invalid profile interval',
  );
  statistics(profile.timeDeltas);
  const nodes = new Map();
  const parents = new Map();
  const symbols = new Map();
  const nodeSymbols = new Map();
  for (const node of profile.nodes) {
    requireFact(
      Number.isSafeInteger(node.id) && !nodes.has(node.id),
      'Duplicate or invalid node id',
    );
    const frame = node.callFrame;
    requireFact(
      frame &&
        typeof frame.functionName === 'string' &&
        typeof frame.url === 'string' &&
        Number.isInteger(frame.lineNumber) &&
        Number.isInteger(frame.columnNumber),
      'Invalid call frame',
    );
    nodes.set(node.id, node);
    const location = {
      functionName: frame.functionName,
      url: frame.url,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    };
    const key = canonical(location);
    nodeSymbols.set(node.id, key);
    if (!symbols.has(key)) symbols.set(key, { ...location, selfMs: 0, inclusiveMs: 0 });
    requireFact(node.children === undefined || Array.isArray(node.children), 'Invalid children');
    for (const child of node.children ?? []) {
      requireFact(!parents.has(child), 'Call tree has multiple parents');
      parents.set(child, node.id);
    }
  }
  for (const child of parents.keys()) requireFact(nodes.has(child), 'Unknown child node');
  const chains = new Map();
  const chainFor = (id) => {
    if (chains.has(id)) return chains.get(id);
    const chain = [];
    const seen = new Set();
    for (let at = id; at !== undefined; at = parents.get(at)) {
      requireFact(nodes.has(at) && !seen.has(at), 'Unknown sample node or cyclic call tree');
      seen.add(at);
      chain.push(at);
    }
    chains.set(id, chain);
    return chain;
  };
  for (const id of nodes.keys()) chainFor(id);
  let sampledUs = 0;
  profile.samples.forEach((id, index) => {
    const chain = chainFor(id);
    const delta = profile.timeDeltas[index];
    sampledUs += delta;
    symbols.get(nodeSymbols.get(id)).selfMs += delta / 1000;
    for (const key of new Set(chain.map((at) => nodeSymbols.get(at))))
      symbols.get(key).inclusiveMs += delta / 1000;
  });
  const durationUs = profile.endTime - profile.startTime;
  requireFact(sampledUs <= durationUs + 1, 'Sampled time exceeds profile duration');
  const rows = [...symbols.values()].filter((row) => row.inclusiveMs > 0);
  const ranked = (field) =>
    rows
      .slice()
      .sort((a, b) => b[field] - a[field])
      .slice(0, top);
  return {
    kind: 'sampled-cpu-attribution',
    timeUnit: 'ms',
    sampleCount: profile.samples.length,
    durationMs: durationUs / 1000,
    sampledMs: sampledUs / 1000,
    unobservedMs: Math.max(0, durationUs - sampledUs) / 1000,
    sampleDeltaMicroseconds: statistics(profile.timeDeltas),
    symbolCount: rows.length,
    topSelf: ranked('selfMs'),
    topInclusive: ranked('inclusiveMs'),
    interpretation:
      'timeDeltas weight leaf samples; inclusive symbols are counted once per sample even in recursion. Inclusive rows overlap. Locations remain zero-based and are not source-map resolved. Unobserved time is not GPU or idle attribution.',
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'profile-pointer': { type: 'string', default: '' },
      top: { type: 'string', default: '30' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node analyze_cpu_profile.mjs INPUT [--profile-pointer /profiles/0/profile] [--top 30] [--output FILE]',
    );
    return;
  }
  requireFact(positionals.length === 1, 'Require one input JSON file');
  const input = await loadJson(positionals[0]);
  await emitJson(
    {
      inputSha256: input.sha256,
      profilePointer: values['profile-pointer'],
      ...analyzeCpuProfile(pointer(input.value, values['profile-pointer']), Number(values.top)),
    },
    values.output,
    positionals,
  );
});
