import { requireFact } from './lib.mjs';

/** Lossless snapshot storage; numeric graph endpoints avoid repeated object-ID strings. */
export function encodeMemoryModel(model, { consume = false } = {}) {
  if (model.mode !== 'snapshot-object-census' || model.encoding) return model;
  const byId = new Map(model.nodes.map((n, i) => [n.id, i]));
  const strings = [],
    indices = new Map();
  const intern = (value) => {
    requireFact(typeof value === 'string', 'Invalid snapshot storage string');
    if (!indices.has(value)) {
      indices.set(value, strings.length);
      strings.push(value);
    }
    return indices.get(value);
  };
  const nodes = model.nodes.map((n, i) => {
    const parent = n.parentId === null ? -1 : byId.get(n.parentId);
    requireFact(
      Number.isSafeInteger(parent) && parent < i,
      'Snapshot storage requires parent-first nodes',
    );
    requireFact(
      Object.keys(n).every((k) =>
        [
          'id',
          'parentId',
          'label',
          'type',
          'selfBytes',
          'selfCount',
          'totalBytes',
          'totalCount',
          'rawObjectId',
          'children',
        ].includes(k),
      ),
      'Unknown snapshot node fields',
    );
    return [
      n.id,
      parent,
      n.label,
      intern(n.type),
      n.selfBytes,
      n.selfCount,
      n.totalBytes,
      n.totalCount,
      n.rawObjectId ?? null,
    ];
  });
  const references = consume ? model.references : new Array(model.references.length);
  for (let i = 0; i < model.references.length; i++) {
    const edge = model.references[i],
      from = byId.get(edge[0]),
      to = byId.get(edge[1]);
    requireFact(from !== undefined && to !== undefined, 'Unknown snapshot reference endpoint');
    references[i] = [from, to, intern(edge[2]), intern(edge[3])];
  }
  return Object.assign(consume ? model : { ...model }, {
    encoding: 'indexed-rows-v1',
    nodeFields: [
      'id',
      'parentIndex',
      'label',
      'typeString',
      'selfBytes',
      'selfCount',
      'totalBytes',
      'totalCount',
      'rawObjectId',
    ],
    referenceFields: ['fromIndex', 'toIndex', 'kindString', 'nameString'],
    strings,
    nodes,
    references,
  });
}

/** Consume a parsed wire value in place to avoid duplicating multi-million-edge arrays. */
export function decodeMemoryModel(model) {
  if (!model?.encoding) return model;
  requireFact(
    model.kind === 'memory-explorer' &&
      model.schemaVersion === 1 &&
      model.mode === 'snapshot-object-census' &&
      model.encoding === 'indexed-rows-v1',
    'Unsupported memory storage encoding',
  );
  requireFact(
    JSON.stringify(model.nodeFields) ===
      JSON.stringify([
        'id',
        'parentIndex',
        'label',
        'typeString',
        'selfBytes',
        'selfCount',
        'totalBytes',
        'totalCount',
        'rawObjectId',
      ]) &&
      JSON.stringify(model.referenceFields) ===
        JSON.stringify(['fromIndex', 'toIndex', 'kindString', 'nameString']),
    'Invalid memory storage fields',
  );
  requireFact(
    Array.isArray(model.strings) &&
      model.strings.every((s) => typeof s === 'string') &&
      Array.isArray(model.nodes) &&
      Array.isArray(model.references),
    'Invalid memory storage tables',
  );
  const text = (index) => {
    requireFact(
      Number.isSafeInteger(index) && index >= 0 && index < model.strings.length,
      'Invalid memory string index',
    );
    return model.strings[index];
  };
  const identities = new Set();
  const decodeNode = (row, i) => {
    requireFact(
      Array.isArray(row) &&
        row.length === 9 &&
        typeof row[0] === 'string' &&
        !identities.has(row[0]) &&
        typeof row[2] === 'string',
      'Invalid indexed memory node',
    );
    identities.add(row[0]);
    requireFact(
      Number.isSafeInteger(row[1]) && (i === 0 ? row[1] === -1 : row[1] >= 0 && row[1] < i),
      'Invalid indexed memory parent',
    );
    requireFact(
      [row[4], row[6]].every((n) => Number.isFinite(n) && n >= 0) &&
        [row[5], row[7]].every((n) => Number.isSafeInteger(n) && n >= 0),
      'Invalid indexed memory totals',
    );
    requireFact(
      row[8] === null || (Number.isSafeInteger(row[8]) && row[8] >= 0),
      'Invalid indexed object identity',
    );
    const node = {
      id: row[0],
      parentId: row[1] === -1 ? null : model.nodes[row[1]].id,
      label: row[2],
      type: text(row[3]),
      selfBytes: row[4],
      selfCount: row[5],
      totalBytes: row[6],
      totalCount: row[7],
      children: [],
    };
    if (row[8] !== null) node.rawObjectId = row[8];
    model.nodes[i] = node;
    if (row[1] !== -1) model.nodes[row[1]].children.push(node.id);
  };
  for (let i = 0; i < model.nodes.length; i++) decodeNode(model.nodes[i], i);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  requireFact(model.nodes[0]?.id === model.rootId, 'Invalid indexed memory root');
  for (const n of model.nodes)
    n.children.sort(
      (a, b) =>
        byId.get(b).totalBytes - byId.get(a).totalBytes ||
        byId.get(b).totalCount - byId.get(a).totalCount ||
        a.localeCompare(b),
    );
  for (const edge of model.references) {
    requireFact(
      Array.isArray(edge) &&
        edge.length === 4 &&
        [edge[0], edge[1]].every(
          (i) => Number.isSafeInteger(i) && i >= 0 && i < model.nodes.length,
        ),
      'Invalid indexed memory reference',
    );
    edge[0] = model.nodes[edge[0]].id;
    edge[1] = model.nodes[edge[1]].id;
    edge[2] = text(edge[2]);
    edge[3] = text(edge[3]);
  }
  delete model.encoding;
  delete model.strings;
  delete model.nodeFields;
  delete model.referenceFields;
  return model;
}
