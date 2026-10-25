import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getHeapSnapshot } from 'node:v8';

// An independent, intrusive census AFTER ordinary timing. V8 performs GC to
// construct this snapshot. Count live nodes, never call them allocated objects.
// Stream the snapshot once: the numeric node table, then the edge table (only
// to name the property shapes of the most numerous constructors), then the
// trailing strings table for the names those rows reference.
const TOP_NAMES = 40, SHAPED_NAMES = 4, SHAPE_PROPERTIES = 8, TOP_SHAPES = 12;
export async function heapCensus(stream = getHeapSnapshot()) {
  const digest = createHash('sha256');
  let section = 'header', prefix = '', pending = '', meta, nodeFields, edgeFields, nodeTypes, edgeTypes;
  let nodes = 0, column = 0, row = [];
  const byType = {}, byName = new Map();
  let nodeType, nodeName, nodeEdges, shaped, edgeNode = 0, edgeLeft = 0, edgeColumn = 0, edgeType = 0, edgeName = 0, shape = [];
  const shapes = new Map();
  let wanted, stringIndex = 0, inString = false, escaped = false, current = '';
  const finishNodes = () => {
    assert(column === 0 && nodes === meta.node_count, 'incomplete heap census');
    const top = [...byName.values()].sort((a, b) => b.count - a.count);
    shaped = new Set(top.filter(entry => entry.type === 'object').slice(0, SHAPED_NAMES).map(entry => entry.name));
    wanted = new Map(top.slice(0, TOP_NAMES).map(entry => [entry.name, entry]));
    while (edgeNode < nodes && nodeEdges[edgeNode] === 0) edgeNode++;
    edgeLeft = nodeEdges[edgeNode] ?? 0;
  };
  const endShape = () => {
    if (shaped.has(nodeName[edgeNode])) {
      const key = `${nodeName[edgeNode]}|${shape.join(',')}`;
      const entry = shapes.get(key) ?? { name: nodeName[edgeNode], properties: [...shape], count: 0 };
      entry.count++; shapes.set(key, entry);
    }
    shape = [];
    do edgeNode++; while (edgeNode < nodes && nodeEdges[edgeNode] === 0);
    edgeLeft = nodeEdges[edgeNode] ?? 0;
  };
  const finishEdges = () => {
    const top = [...shapes.values()].sort((a, b) => b.count - a.count).slice(0, TOP_SHAPES);
    shapes.clear();
    for (const entry of top) { shapes.set(entry, entry); for (const property of entry.properties) if (!wanted.has(property)) wanted.set(property, {}); }
  };
  const number = part => { const value = Number(part); assert(Number.isSafeInteger(value) && value >= 0, 'invalid heap number'); return value; };
  const consume = (text, onValue) => {
    pending += text;
    const end = pending.indexOf(']');
    const parts = (end >= 0 ? pending.slice(0, end) : pending).split(',');
    const tail = end >= 0 ? pending.slice(end + 1) : '';
    pending = end >= 0 ? '' : parts.pop();
    for (const part of parts) if (part.trim()) onValue(number(part));
    return end >= 0 ? tail : undefined;
  };
  const seek = (text, marker) => {
    prefix += text;
    const start = prefix.indexOf(marker);
    if (start < 0) { prefix = prefix.slice(-marker.length); return undefined; }
    const rest = prefix.slice(start + marker.length); prefix = ''; return rest;
  };
  const onNode = value => {
    row[column] = value;
    if (++column < nodeFields.length) return;
    const type = row[nodeFields.indexOf('type')], name = row[nodeFields.indexOf('name')], size = row[nodeFields.indexOf('self_size')];
    const typeName = nodeTypes[type];
    const entry = byType[typeName] ??= { count: 0, selfBytes: 0 };
    entry.count++; entry.selfBytes += size;
    if (typeName === 'object' || typeName === 'closure' || typeName === 'array') {
      const key = type * 2 ** 32 + name;
      const named = byName.get(key) ?? { type: typeName, name, count: 0, selfBytes: 0 };
      named.count++; named.selfBytes += size; byName.set(key, named);
    }
    nodeType[nodes] = type; nodeName[nodes] = name; nodeEdges[nodes] = row[nodeFields.indexOf('edge_count')];
    nodes++; column = 0;
  };
  const onEdge = value => {
    if (edgeColumn === 0) edgeType = value;
    if (edgeColumn === 1) edgeName = value;
    if (++edgeColumn < edgeFields.length) return;
    edgeColumn = 0;
    if (edgeTypes[edgeType] === 'property' && shape.length < SHAPE_PROPERTIES && shaped.has(nodeName[edgeNode])) shape.push(edgeName);
    if (--edgeLeft === 0) endShape();
  };
  const onStrings = text => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!inString) { if (c === '"') { inString = true; current = ''; } continue; }
      if (escaped) { escaped = false; if (wanted.has(stringIndex)) current += c; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = false; const entry = wanted.get(stringIndex); if (entry) entry.label = current.slice(0, 80); stringIndex++; continue; }
      if (wanted.has(stringIndex) && current.length < 80) current += c;
    }
  };
  for await (const bytes of stream) {
    digest.update(bytes);
    let text = bytes.toString();
    while (text !== undefined && section !== 'done') {
      if (section === 'header') {
        prefix += text;
        const start = prefix.indexOf('"nodes":[');
        if (start < 0) { assert(prefix.length < 1024 * 1024, 'heap metadata budget exceeded'); text = undefined; continue; }
        meta = JSON.parse(prefix.slice(0, start).trim().replace(/,$/, '') + '}').snapshot;
        nodeFields = meta.meta.node_fields; edgeFields = meta.meta.edge_fields;
        nodeTypes = meta.meta.node_types[nodeFields.indexOf('type')]; edgeTypes = meta.meta.edge_types[edgeFields.indexOf('type')];
        nodeType = new Uint8Array(meta.node_count); nodeName = new Uint32Array(meta.node_count); nodeEdges = new Uint32Array(meta.node_count);
        text = prefix.slice(start + '"nodes":['.length); prefix = ''; section = 'nodes';
      } else if (section === 'nodes') {
        text = consume(text, onNode);
        if (text !== undefined) { finishNodes(); section = 'edges-seek'; }
      } else if (section === 'edges-seek') {
        text = seek(text, '"edges":[');
        if (text !== undefined) section = 'edges';
      } else if (section === 'edges') {
        text = consume(text, onEdge);
        if (text !== undefined) { finishEdges(); section = 'strings-seek'; }
      } else if (section === 'strings-seek') {
        text = seek(text, '"strings":[');
        if (text !== undefined) section = 'strings';
      } else { onStrings(text); text = undefined; }
    }
  }
  const label = index => wanted.get(index)?.label ?? null;
  const topNames = [...byName.values()].sort((a, b) => b.count - a.count).slice(0, TOP_NAMES)
    .map(({ type, name, count, selfBytes }) => ({ type, name: label(name), count, selfBytes }));
  const topShapes = [...shapes.values()].map(({ name, properties, count }) => ({ name: label(name), properties: properties.map(label), count }));
  return { nodes, byType, topNames, topShapes, snapshotSha256: digest.digest('hex'), scope: 'live V8 heap nodes after snapshot GC; excludes external payload bytes and allocation churn; shapes list the first own properties of the most numerous constructors' };
}
