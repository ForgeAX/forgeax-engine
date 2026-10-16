import { requireFact } from './lib.mjs';

export function heapNodes(profile) {
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
      ids.has(sample.nodeId) && Number.isFinite(sample.size) && sample.size >= 0,
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
