import { canonical, requireFact } from './lib.mjs';

/** Shared validation and stack ownership for whole-profile and clipped analysis. */
export function cpuProfileGraph(profile) {
  requireFact(Array.isArray(profile.nodes), 'Require CPU nodes');
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
  return { nodes, symbols, nodeSymbols, chainFor };
}
