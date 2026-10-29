import { loadJson, requireFact } from './lib.mjs';

export function heapNodes(profile, { allowOrphanSamples = false } = {}) {
  requireFact(
    profile?.head && Array.isArray(profile.samples),
    'Require SamplingHeapProfile head and samples',
  );
  const nodes = [],
    ids = new Set(),
    pending = [profile.head];
  while (pending.length) {
    const node = pending.pop(),
      frame = node?.callFrame;
    requireFact(
      nodes.length < 500000 && Number.isSafeInteger(node?.id) && !ids.has(node.id),
      'Duplicate, cyclic or oversized heap tree',
    );
    requireFact(
      Number.isFinite(node.selfSize) && node.selfSize >= 0 && Array.isArray(node.children),
      'Invalid heap self size or children',
    );
    requireFact(
      frame &&
        typeof frame.url === 'string' &&
        typeof frame.functionName === 'string' &&
        Number.isInteger(frame.lineNumber) &&
        frame.lineNumber >= -1 &&
        Number.isInteger(frame.columnNumber) &&
        frame.columnNumber >= -1,
      'Invalid heap call frame',
    );
    ids.add(node.id);
    nodes.push(node);
    for (const child of node.children) pending.push(child);
  }
  for (const sample of profile.samples)
    requireFact(
      Number.isSafeInteger(sample?.nodeId) &&
        (allowOrphanSamples || ids.has(sample.nodeId)) && Number.isFinite(sample.size) && sample.size >= 0,
      'Invalid heap sample',
    );
  return nodes;
}

export function selectedHeap(value) {
  const profile = value?.profile?.head ? value.profile : value;
  return {
    profile,
    metadata: value?.profile?.head
      ? {
          samplingInterval: value.samplingInterval ?? null,
          durationMs: value.durationMs ?? null,
          includesCollectedByMinorGC: value.includesCollectedByMinorGC ?? null,
          includesCollectedByMajorGC: value.includesCollectedByMajorGC ?? null,
        }
      : null,
  };
}

/**
 * Read a `symbolize_heap_profile.mjs` output and refuse symbols produced for another
 * input file or profile pointer. Without a path, returns an empty symbol map.
 */
export async function loadHeapSymbols(input, path, profilePointer) {
  const symbols = new Map();
  if (!path) return { symbols, symbolInput: undefined };
  const symbolInput = await loadJson(path);
  requireFact(
    symbolInput.value.kind === 'heap-source-symbols' &&
      symbolInput.value.inputSha256 === input.sha256 &&
      symbolInput.value.profilePointer === profilePointer &&
      Array.isArray(symbolInput.value.symbols),
    'Symbols belong to another input/profile',
  );
  for (const row of symbolInput.value.symbols) {
    requireFact(!symbols.has(row.nodeId), 'Duplicate source symbol');
    symbols.set(row.nodeId, row.source);
  }
  return { symbols, symbolInput };
}
