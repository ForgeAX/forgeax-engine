#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { emitJson, loadJson, requireFact, runCli } from './lib.mjs';

/** Self allocation events/bytes from V8's cumulative trace tree, including later-collected events. */
export function allocationTrace(snapshot) {
  const meta = snapshot?.snapshot?.meta;
  requireFact(Array.isArray(meta?.trace_node_fields) && Array.isArray(meta?.trace_function_info_fields), 'Require allocation trace metadata');
  const fields = meta.trace_node_fields, functions = meta.trace_function_info_fields;
  const tree = snapshot.trace_tree, infos = snapshot.trace_function_infos, strings = snapshot.strings;
  requireFact(Array.isArray(tree) && tree.length > 0 && Array.isArray(infos) && Array.isArray(strings), 'Require a snapshot captured with trackAllocations enabled');
  const at = name => { const index = fields.indexOf(name); requireFact(index >= 0, 'Missing trace field ' + name); return index; };
  const field = name => { const index = functions.indexOf(name); requireFact(index >= 0, 'Missing function field ' + name); return index; };
  const idAt = at('id'), functionAt = at('function_info_index'), countAt = at('count'), sizeAt = at('size'), childrenAt = at('children');
  const nameAt = field('name'), scriptAt = field('script_name'), lineAt = field('line'), columnAt = field('column');
  requireFact(infos.length % functions.length === 0, 'Invalid trace function table');
  const ids = new Set(), rows = [], pending = [tree];
  let count = 0, bytes = 0;
  while (pending.length) {
    const nodes = pending.pop();
    requireFact(nodes.length % fields.length === 0, 'Invalid trace node table');
    for (let i = 0; i < nodes.length; i += fields.length) {
      const id = nodes[i + idAt], index = nodes[i + functionAt], selfCount = nodes[i + countAt], selfBytes = nodes[i + sizeAt], children = nodes[i + childrenAt];
      requireFact(Number.isSafeInteger(id) && !ids.has(id), 'Invalid/duplicate trace node');
      ids.add(id);
      requireFact(Number.isSafeInteger(index) && index >= 0 && (index + 1) * functions.length <= infos.length, 'Invalid trace function index');
      requireFact(Number.isSafeInteger(selfCount) && selfCount >= 0 && Number.isSafeInteger(selfBytes) && selfBytes >= 0 && Array.isArray(children), 'Invalid trace count/bytes/children');
      const base = index * functions.length;
      const name = strings[infos[base + nameAt]], url = strings[infos[base + scriptAt]];
      requireFact(typeof name === 'string' && typeof url === 'string', 'Invalid trace source strings');
      count += selfCount; bytes += selfBytes;
      rows.push({ id, functionIndex: index, name, url, line: infos[base + lineAt], column: infos[base + columnAt], count: selfCount, bytes: selfBytes });
      pending.push(children);
    }
  }
  return { kind: 'v8-allocation-trace', count, bytes, nodes: rows,
    interpretation: 'Cumulative V8 tracked heap allocation events and heap bytes, summed once from trace-node self counters. Includes later-collected events and VM allocations. Not Poisson sample records, surviving-object counts, logical application objects, external ArrayBuffer/GPU backing or ordinary uninstrumented rates. Function positions are one-based function starts, not exact allocation expressions. Validate coverage with a known-allocation/GC control on the actual runtime.' };
}

/** Same active tracker across snapshots; counters survive GC and trace IDs never recycle. */
export function allocationTraceDifference(before, after) {
  const previous = new Map(before.nodes.map(row => [row.id, row]));
  const nodes = after.nodes.map(row => {
    const old = previous.get(row.id);
    if (old) {
      requireFact(['functionIndex','name','url','line','column'].every(key => old[key] === row[key]), 'Trace identity changed; require the same tracker');
      previous.delete(row.id);
    }
    const count = row.count - (old?.count ?? 0), bytes = row.bytes - (old?.bytes ?? 0);
    requireFact(count >= 0 && bytes >= 0, 'Trace counters decreased; require the same tracker');
    return {...row,count,bytes};
  });
  requireFact(previous.size === 0, 'Trace nodes disappeared; require the same tracker');
  return {kind:'v8-allocation-trace-delta',count:nodes.reduce((n,row)=>n+row.count,0),bytes:nodes.reduce((n,row)=>n+row.bytes,0),nodes,interpretation:after.interpretation};
}

/** Alternative conserved partition; group identical function starts across call paths. */
export function allocationTraceDistribution(trace, limit = 10) {
  requireFact(Number.isSafeInteger(limit) && limit > 0, 'Require a positive row limit');
  const groups = new Map();
  for (const row of trace.nodes) {
    const key = JSON.stringify([row.name,row.url,row.line,row.column]);
    let group = groups.get(key);
    if (!group) {
      group = {name:row.name,url:row.url,line:row.line,column:row.column,count:0,bytes:0};
      groups.set(key, group);
    }
    group.count += row.count; group.bytes += row.bytes;
  }
  const sorted = [...groups.values()].sort((a,b)=>b.bytes-a.bytes || b.count-a.count || a.name.localeCompare(b.name));
  const totalCount = sorted.reduce((n,row)=>n+row.count,0), totalBytes = sorted.reduce((n,row)=>n+row.bytes,0);
  requireFact(totalCount === trace.count && totalBytes === trace.bytes, 'Trace totals do not match self counters');
  const rows = sorted.slice(0,limit);
  const rest = sorted.slice(limit);
  rows.push({name:'(other)',url:'',line:0,column:0,count:rest.reduce((n,row)=>n+row.count,0),bytes:rest.reduce((n,row)=>n+row.bytes,0)});
  return {count:totalCount,bytes:totalBytes,rows:rows.map(row=>({...row,countFraction:totalCount?row.count/totalCount:0,byteFraction:totalBytes?row.bytes/totalBytes:0}))};
}

runCli(import.meta.url, async () => {
  const {values,positionals} = parseArgs({allowPositionals:true,options:{output:{type:'string'},help:{type:'boolean'}}});
  if (values.help) { console.log('node allocation_trace.mjs SNAPSHOT [--output FILE]'); return; }
  requireFact(positionals.length === 1, 'Require one allocation-tracked snapshot');
  const input = await loadJson(positionals[0]);
  const trace = allocationTrace(input.value);
  await emitJson({inputSha256:input.sha256,...trace,distribution:allocationTraceDistribution(trace)},values.output,positionals);
});
