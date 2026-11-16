import { heapNodes } from './heap_profile.mjs';
import { heapSnapshotCensus } from './heap_snapshot_census.mjs';
import { requireFact } from './lib.mjs';

function finish(model) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const n of model.nodes) {
    n.totalBytes = n.selfBytes;
    n.totalCount = n.selfCount;
    n.children = [];
  }
  for (let i = model.nodes.length - 1; i >= 0; i--) {
    const n = model.nodes[i];
    if (n.parentId !== null) {
      const p = byId.get(n.parentId);
      requireFact(p, 'Missing memory parent');
      p.totalBytes += n.totalBytes;
      p.totalCount += n.totalCount;
      p.children.push(n.id);
    }
  }
  for (const n of model.nodes)
    n.children.sort(
      (a, b) =>
        byId.get(b).totalBytes - byId.get(a).totalBytes ||
        byId.get(b).totalCount - byId.get(a).totalCount ||
        a.localeCompare(b),
    );
  for (const n of model.nodes)
    requireFact(
      Number.isFinite(n.totalBytes) && n.totalBytes >= 0 && Number.isSafeInteger(n.totalCount),
      'Memory totals overflow',
    );
  model.summary = {
    ...model.summary,
    totalBytes: byId.get(model.rootId).totalBytes,
    totalCount: byId.get(model.rootId).totalCount,
    nodeCount: model.nodes.length,
  };
  return model;
}
const base = (mode) => ({
  schemaVersion: 1,
  kind: 'memory-explorer',
  mode,
  byteUnit: 'bytes',
  rootId: 'root',
  nodes: [],
  records: [],
  references: [],
  summary: {},
});

export function allocationMemoryModel(profile, { metadata = null, symbols = new Map() } = {}) {
  const raw = heapNodes(profile, { allowOrphanSamples: true }),
    model = base('sampled-allocation-stack');
  const parents = new Map();
  for (const n of raw) for (const c of n.children) parents.set(c.id, n.id);
  model.countLabel = 'recorded allocation samples';
  model.metadata = metadata;
  model.nodes = raw.map((n) => ({
    id: n.id === profile.head.id ? 'root' : 'allocation:' + n.id,
    parentId: parents.has(n.id)
      ? parents.get(n.id) === profile.head.id
        ? 'root'
        : 'allocation:' + parents.get(n.id)
      : null,
    label: symbols.get(n.id)?.functionName || n.callFrame.functionName || '(anonymous)',
    selfBytes: n.selfSize,
    selfCount: 0,
    callFrame: n.callFrame,
    source: symbols.get(n.id) ?? null,
    rawNodeId: n.id,
    type: 'call-stack',
  }));
  const byRaw = new Map(model.nodes.map((n) => [n.rawNodeId, n]));
  for (const [id, source] of symbols)
    requireFact(
      byRaw.has(id) &&
        typeof source?.file === 'string' &&
        source.file.length > 0 &&
        Number.isSafeInteger(source.line) &&
        source.line > 0 &&
        Number.isSafeInteger(source.column) &&
        source.column > 0,
      'Invalid source symbol',
    );
  let sampleSizeBytes = 0,
    orphanSampleBytes = 0;
  for (const [i, s] of profile.samples.entries()) {
    requireFact(
      s.ordinal === undefined || (Number.isSafeInteger(s.ordinal) && s.ordinal >= 0),
      'Invalid sample ordinal',
    );
    let n = byRaw.get(s.nodeId);
    if (!n) {
      orphanSampleBytes += s.size;
      n = model.nodes.find((n) => n.id === 'unresolved');
      if (!n) {
        n = {
          id: 'unresolved',
          parentId: 'root',
          label: 'Unresolved sample owners',
          selfBytes: 0,
          selfCount: 0,
          type: 'unknown',
        };
        model.nodes.push(n);
      }
    }
    n.selfCount++;
    sampleSizeBytes += s.size;
    model.records.push({
      id: 'sample:' + i,
      nodeId: n.id,
      rawNodeId: s.nodeId,
      ordinal: s.ordinal ?? null,
      reportedSizeBytes: s.size,
    });
  }
  model.summary = {
    mappedSelfBytes: raw.reduce((sum, n) => sum + (symbols.has(n.id) ? n.selfSize : 0), 0),
    symbolsProvided: symbols.size > 0,
    sampleSizeBytes,
    orphanSampleBytes,
    orphanSamples: model.records.filter((r) => r.nodeId === 'unresolved').length,
  };
  model.interpretation = [
    'Statistical allocation call stacks. Every recorded sample has a path; this is not every real allocation or object.',
    'Tree bytes sum V8 node selfSize once. Recorded sample-size totals are separate and may differ; unresolved sample bytes are not silently added twice.',
    'Collected-object flags and sampling interval determine the population. Unknown metadata stays unknown. This does not establish live heap, retained sizes, GC pauses, native/GPU totals or ordinary performance.',
  ];
  return finish(model);
}

function snapshotObjectReferences(snapshot, offsetIds, edgesAt, w) {
  const references = [];
  const ef = snapshot.snapshot.meta.edge_fields,
    et = snapshot.snapshot.meta.edge_types;
  requireFact(
    Array.isArray(ef) && Array.isArray(et) && Array.isArray(snapshot.edges),
    'Snapshot needs edge metadata',
  );
  const ew = ef.length,
    kindAt = ef.indexOf('type'),
    enameAt = ef.indexOf('name_or_index'),
    toAt = ef.indexOf('to_node');
  requireFact(
    kindAt >= 0 &&
      enameAt >= 0 &&
      toAt >= 0 &&
      snapshot.edges.length % ew === 0 &&
      Array.isArray(et[kindAt]),
    'Invalid snapshot edge columns',
  );
  let cursor = 0;
  for (let i = 0; i < snapshot.nodes.length; i += w) {
    const count = snapshot.nodes[i + edgesAt];
    requireFact(Number.isSafeInteger(count) && count >= 0, 'Invalid outgoing edge count');
    for (let j = 0; j < count; j++, cursor += ew) {
      requireFact(cursor + ew <= snapshot.edges.length, 'Snapshot edge counts exceed payload');
      const kind = et[kindAt][snapshot.edges[cursor + kindAt]],
        target = offsetIds.get(snapshot.edges[cursor + toAt]),
        raw = snapshot.edges[cursor + enameAt];
      const name = kind === 'element' || kind === 'hidden' ? String(raw) : snapshot.strings[raw];
      requireFact(
        typeof kind === 'string' && target && typeof name === 'string',
        'Invalid snapshot reference',
      );
      references.push([offsetIds.get(i), target, kind, name]);
    }
  }
  requireFact(cursor === snapshot.edges.length, 'Snapshot edges left unowned');
  if (snapshot.snapshot.edge_count !== undefined)
    requireFact(
      snapshot.snapshot.edge_count === references.length,
      'Snapshot reference count does not match payload',
    );
  return references;
}

export function snapshotMemoryModel(snapshot) {
  const census = heapSnapshotCensus(snapshot),
    model = base('snapshot-object-census');
  model.countLabel = 'V8 snapshot nodes';
  model.nodes.push({
    id: 'root',
    parentId: null,
    label: 'Snapshot objects and VM nodes',
    type: 'group',
    selfBytes: 0,
    selfCount: 0,
  });
  const fields = snapshot.snapshot.meta.node_fields,
    w = fields.length;
  const at = (n) => fields.indexOf(n),
    typeAt = at('type'),
    nameAt = at('name'),
    idAt = at('id'),
    sizeAt = at('self_size'),
    edgesAt = at('edge_count');
  requireFact(idAt >= 0 && edgesAt >= 0, 'Snapshot needs object identities and edge counts');
  const types = snapshot.snapshot.meta.node_types[typeAt],
    groups = new Map(),
    offsetIds = new Map();
  const group = (parent, key, label) => {
    const k = parent + '/' + key;
    if (!groups.has(k)) {
      const id = 'group:' + groups.size;
      groups.set(k, id);
      model.nodes.push({ id, parentId: parent, label, type: 'group', selfBytes: 0, selfCount: 0 });
    }
    return groups.get(k);
  };
  const identities = new Set();
  for (let i = 0; i < snapshot.nodes.length; i += w) {
    const type = types[snapshot.nodes[i + typeAt]],
      rawId = snapshot.nodes[i + idAt];
    requireFact(
      Number.isSafeInteger(rawId) && !identities.has(rawId),
      'Invalid or duplicate snapshot object id',
    );
    identities.add(rawId);
    const name = type.includes('string')
      ? 'String contents hidden'
      : snapshot.strings[snapshot.nodes[i + nameAt]];
    const parent = group(group('root', type, type), name, name || '(unnamed)');
    const id = 'object:' + rawId;
    offsetIds.set(i, id);
    model.nodes.push({
      id,
      parentId: parent,
      label: (name || type) + ' #' + rawId,
      type,
      rawObjectId: rawId,
      selfBytes: snapshot.nodes[i + sizeAt],
      selfCount: 1,
    });
  }
  model.references = snapshotObjectReferences(snapshot, offsetIds, edgesAt, w);
  model.summary = {
    snapshotNodes: census.count,
    referenceCount: model.references.length,
    stringContents: 'hidden in normalized data',
  };
  model.interpretation = [
    'Snapshot census hierarchy groups type / name / object id. These folders are grouping, not allocation stacks or dominator ownership.',
    'Every captured V8 node is counted once by shallow self size; VM, strings, internal and native nodes are included. Do not add external backing twice or call this process/GPU memory.',
    'Object references and incoming references are raw graph edges, not computed retained sizes. Weak references do not keep targets alive; shortcuts are navigation aids.',
    'Taking a snapshot can pause execution and trigger GC. Reading this existing file is offline. Snapshot identities alone do not establish allocation history or exact freed bytes.',
  ];
  finish(model);
  requireFact(
    model.summary.totalBytes === census.selfBytes && model.summary.totalCount === census.count,
    'Snapshot hierarchy lost population',
  );
  return model;
}

export function inspectMemory(model, id = model.rootId, { offset = 0, limit = 100 } = {}) {
  requireFact(
    model?.kind === 'memory-explorer' && model.schemaVersion === 1,
    'Require normalized memory explorer JSON',
  );
  requireFact(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= 1000,
    'Invalid memory page bounds',
  );
  const byId = new Map(model.nodes.map((n) => [n.id, n])),
    node = byId.get(id);
  requireFact(node, 'Unknown memory node');
  const path = [],
    seen = new Set();
  for (let n = node; n; n = byId.get(n.parentId)) {
    requireFact(!seen.has(n.id), 'Cyclic memory path');
    seen.add(n.id);
    path.unshift({ id: n.id, label: n.label });
  }
  const outgoing = model.references.filter((r) => r[0] === id),
    incoming = model.references.filter((r) => r[1] === id);
  const records = model.records.filter((r) => r.nodeId === id);
  return {
    path,
    node: { ...node, children: node.children.slice(offset, offset + limit) },
    childCount: node.children.length,
    offset,
    limit,
    children: node.children.slice(offset, offset + limit).map((k) => {
      const { children, ...summary } = byId.get(k);
      return { ...summary, childCount: children.length };
    }),
    records: { total: records.length, rows: records.slice(offset, offset + limit) },
    outgoing: { total: outgoing.length, rows: outgoing.slice(offset, offset + limit) },
    incoming: { total: incoming.length, rows: incoming.slice(offset, offset + limit) },
    interpretation: model.interpretation,
    summary: model.summary,
    mode: model.mode,
    countLabel: model.countLabel,
  };
}

export function defaultMemoryNode(model) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  let node = byId.get(model.rootId);
  for (let i = 0; i < 20; i++) {
    const child = node.children
      .map((id) => byId.get(id))
      .sort((a, b) => b.totalBytes - a.totalBytes)[0];
    if (!child || !node.totalBytes || child.totalBytes / node.totalBytes < 0.995) break;
    node = child;
  }
  return node.id;
}
