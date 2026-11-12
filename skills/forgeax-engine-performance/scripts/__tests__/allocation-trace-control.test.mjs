import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import test from 'node:test';
import { allocationTrace, allocationTraceDifference } from '../allocation_trace.mjs';

test('real V8 trace counts collected heap allocation events separately from survivors', { skip: typeof globalThis.gc !== 'function' }, async () => {
  const session = new Session(); session.connect();
  let chunks = [], tracking = false;
  session.on('HeapProfiler.addHeapSnapshotChunk', ({params}) => chunks.push(params.chunk));
  try {
    await session.post('Runtime.evaluate',{expression:'globalThis.__forgeaxTraceWitness=class ForgeaxTraceWitness { constructor(value){this.value=value;} }; globalThis.__forgeaxTraceRing = new Array(10000).fill(null); globalThis.__forgeaxTraceControl = function forgeaxTrackedControl(n) { for(let i=0;i<n;i++) globalThis.__forgeaxTraceRing[i%10000] = new globalThis.__forgeaxTraceWitness(i); return n; }; __forgeaxTraceControl(1000);',returnByValue:true});
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startTrackingHeapObjects',{trackAllocations:true});tracking=true;
    // Profiling activation can allocate VM metadata inside the first call.
    // Exclude that measured warm-up with a same-tracker baseline, without resetting counters.
    await session.post('Runtime.evaluate',{expression:'__forgeaxTraceControl(30000)',returnByValue:true});
    globalThis.gc();chunks=[];
    await session.post('HeapProfiler.takeHeapSnapshot',{reportProgress:false});
    const baseline=allocationTrace(JSON.parse(chunks.join('')));
    await session.post('Runtime.evaluate',{expression:'__forgeaxTraceControl(10000)',returnByValue:true});
    globalThis.gc();chunks=[];
    await session.post('HeapProfiler.takeHeapSnapshot',{reportProgress:false});
    const snapshot=JSON.parse(chunks.join(''));
    const trace=allocationTraceDifference(baseline,allocationTrace(snapshot)),target=trace.nodes.filter(n=>n.name==='forgeaxTrackedControl');
    // V8 also attributes VM metadata allocations to a function. Verify actual
    // known-object coverage, then prove its cumulative counter survives GC.
    const eventCount=target.reduce((n,row)=>n+row.count,0);
    assert(eventCount >= 10000);
    const meta=snapshot.snapshot.meta,width=meta.node_fields.length;
    const nameAt=meta.node_fields.indexOf('name'),typeAt=meta.node_fields.indexOf('type');
    let survivors=0;
    for(let i=0;i<snapshot.nodes.length;i+=width)
      if(snapshot.strings[snapshot.nodes[i+nameAt]]==='ForgeaxTraceWitness'&&meta.node_types[typeAt][snapshot.nodes[i+typeAt]]==='object')survivors++;
    assert.equal(survivors,10000);
    await session.post('Runtime.evaluate',{expression:'for(let i=64;i<__forgeaxTraceRing.length;i++)__forgeaxTraceRing[i]=null;',returnByValue:true});
    globalThis.gc();chunks=[];
    await session.post('HeapProfiler.stopTrackingHeapObjects',{reportProgress:false});tracking=false;
    const collected=JSON.parse(chunks.join('')),afterGc=allocationTraceDifference(baseline,allocationTrace(collected));
    assert.equal(afterGc.nodes.filter(n=>n.name==='forgeaxTrackedControl').reduce((n,row)=>n+row.count,0),eventCount);
    let remaining=0;
    for(let i=0;i<collected.nodes.length;i+=width)
      if(collected.strings[collected.nodes[i+nameAt]]==='ForgeaxTraceWitness'&&meta.node_types[typeAt][collected.nodes[i+typeAt]]==='object')remaining++;
    assert.equal(remaining,64);
  } finally {
    if(tracking)await session.post('HeapProfiler.stopTrackingHeapObjects',{reportProgress:false}).catch(()=>{});
    delete globalThis.__forgeaxTraceRing;delete globalThis.__forgeaxTraceControl;delete globalThis.__forgeaxTraceWitness;session.disconnect();
  }
});
