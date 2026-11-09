import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { heapSnapshotCensus } from './heap_snapshot_census.mjs';
import { allocationTrace, allocationTraceDifference, allocationTraceDistribution } from './allocation_trace.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const controlName = 'forgeaxTrackedAllocationControl';

/** App is paused/drained on entry. Each real Worker validates its own cumulative counters. */
export async function captureTraceWindow({ selected, send, out, report, save, inspect, resume, pause, move }) {
  const snapshot = async (realm, suffix, stop = false) => {
    realm.chunks = []; realm.size = 0; realm.overflow = false;
    await send(realm.sessionId, stop ? 'HeapProfiler.stopTrackingHeapObjects' : 'HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 120000);
    if (stop) realm.tracking = false;
    assert(!realm.overflow, 'Snapshot exceeded 256 MiB bound');
    const bytes = Buffer.from(realm.chunks.join('')); delete realm.chunks;
    const path = `${out}/${realm.name}-${suffix}.heapsnapshot`;
    await writeFile(path, bytes);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  const evaluate = async (realm, expression) => {
    const result = await send(realm.sessionId, 'Runtime.evaluate', {expression,returnByValue:true});
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const loadTrace = async receipt => allocationTrace(JSON.parse(await readFile(receipt.path, 'utf8')));
  const loadControl = async receipt => {
    const snapshot = JSON.parse(await readFile(receipt.path, 'utf8'));
    const count = heapSnapshotCensus(snapshot).byName.find(row => row.key === 'object:ForgeaxTraceWitness')?.count ?? 0;
    return {trace:allocationTrace(snapshot),count};
  };
  const baselines = new Map();
  report.method = 'Intrusive cumulative V8 heap-allocation trace deltas, not ordinary allocation rates. Actual App pause/drain brackets snapshots and a real 2-second movement window. Each selected Worker validates 10000 live witness objects, then 64 survivors with unchanged cumulative source counters after GC. Source counters also include VM events. VM events and profiler bookkeeping remain included; external/GPU backing is separate.';
  report.realms = [];
  for (const realm of selected) {
    await send(realm.sessionId, 'HeapProfiler.enable');
    assert(await evaluate(realm, "!Object.hasOwn(globalThis,'__forgeaxTraceControl') && !Object.hasOwn(globalThis,'__forgeaxTraceRing') && !Object.hasOwn(globalThis,'__forgeaxTraceWitness')"), 'Trace namespace already exists');
    realm.controlOwned = true;
    await evaluate(realm, `if(Object.hasOwn(globalThis,'__forgeaxTraceControl')) throw Error('Trace control already exists'); globalThis.__forgeaxTraceWitness=class ForgeaxTraceWitness{constructor(value){this.value=value;}};globalThis.__forgeaxTraceRing=new Array(10000).fill(null);globalThis.__forgeaxTraceControl=function ${controlName}(n){for(let i=0;i<n;i++)globalThis.__forgeaxTraceRing[i%10000]=new globalThis.__forgeaxTraceWitness(i);return n};__forgeaxTraceControl(1000);\n//# sourceURL=forgeax-trace-control.mjs`);
    await send(realm.sessionId, 'HeapProfiler.startTrackingHeapObjects', {trackAllocations:true}); realm.tracking=true;
    await evaluate(realm, '__forgeaxTraceControl(30000)');
    await send(realm.sessionId, 'HeapProfiler.collectGarbage', {}, 60000);
    const warm = await snapshot(realm, 'control-warm');
    const before = await loadTrace(warm);
    await evaluate(realm, '__forgeaxTraceControl(10000)');
    await send(realm.sessionId, 'HeapProfiler.collectGarbage', {}, 60000);
    const validated = await snapshot(realm, 'control-validated');
    const live = await loadControl(validated), proof = allocationTraceDifference(before, live.trace);
    const knownCount = proof.nodes.filter(row=>row.name===controlName).reduce((n,row)=>n+row.count,0);
    assert(knownCount >= 10000,'Actual Worker source counters must cover all known events');
    assert.equal(live.count,10000,'Every live control witness must appear in the snapshot');
    await evaluate(realm, 'for(let i=64;i<__forgeaxTraceRing.length;i++)__forgeaxTraceRing[i]=null;');
    await send(realm.sessionId,'HeapProfiler.collectGarbage',{},60000);
    const baseline = await snapshot(realm,'control-collected');
    const collected = await loadControl(baseline);
    assert.equal(collected.count,64,'GC control must retain exactly the bounded witness set');
    const afterGc = allocationTraceDifference(before,collected.trace);
    assert.equal(afterGc.nodes.filter(row=>row.name===controlName).reduce((n,row)=>n+row.count,0),knownCount,'Cumulative source counters must survive GC unchanged');
    baselines.set(realm.name, collected.trace);
    realm.traceRow={name:realm.name,target:realm.target,control:{expected:10000,count:knownCount,liveWitnesses:live.count,survivingWitnesses:collected.count,warm,validated,collected:baseline},baseline};
    report.realms.push(realm.traceRow);
    await evaluate(realm, 'delete globalThis.__forgeaxTraceControl;delete globalThis.__forgeaxTraceRing;delete globalThis.__forgeaxTraceWitness;\n//# sourceURL=forgeax-trace-cleanup.mjs');
    await send(realm.sessionId,'HeapProfiler.collectGarbage',{},60000);
    await save();
  }
  report.traceBefore = await inspect();
  await resume();
  report.traceMotion = await move(2000);
  await pause();
  report.traceAfter = await inspect();
  assert(report.traceAfter.execution.frame.completed > report.traceBefore.execution.frame.completed, 'Traced movement must complete frames');
  for (const realm of selected) {
    await send(realm.sessionId,'HeapProfiler.collectGarbage',{},60000);
    const final = await snapshot(realm,'allocation-window',true);
    const delta = allocationTraceDifference(baselines.get(realm.name),await loadTrace(final));
    const bytes=Buffer.from(JSON.stringify(delta,null,2)+'\n'),path=`${out}/${realm.name}-allocation-counts.json`;
    await writeFile(path,bytes);
    Object.assign(realm.traceRow,{snapshot:final,counts:{count:delta.count,bytes:delta.bytes,path,sha256:hash(bytes),distribution:allocationTraceDistribution(delta)},after:await send(realm.sessionId,'Runtime.getHeapUsage')});
    await send(realm.sessionId,'HeapProfiler.disable');await save();
  }
  return report.traceAfter;
}
