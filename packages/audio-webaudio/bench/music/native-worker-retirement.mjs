import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Native observation only: no Runtime.evaluate, GC, delayed disposal or mocked counters.
export async function captureWorkerRetirement(session, output) {
  const bounded = (promise, ms) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`native retirement observation exceeded ${ms}ms`)), ms);
    })]).finally(() => clearTimeout(timer));
  };
  const send = (method, params = {}) => bounded(session.send(method, params), 5000);
  await send('Tracing.start', {transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'none',
    traceConfig:{recordMode:'recordUntilFull',traceBufferSizeInKb:65536,
      includedCategories:['disabled-by-default-memory-infra'],excludedCategories:['*']}});
  const dump = await send('Tracing.requestMemoryDump', {deterministic:false,levelOfDetail:'detailed'});
  if (!dump.success) throw new Error('native retirement memory dump unavailable');
  const targets = await send('Target.getTargets');
  const completed = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
  await send('Tracing.end');
  const receipt = await bounded(completed, 10000);
  let data = '';
  try {
    while (true) {
      const row = await send('IO.read', {handle:receipt.stream,size:1048576});
      data += row.base64Encoded ? Buffer.from(row.data,'base64').toString() : row.data;
      if (Buffer.byteLength(data)>134217728) throw new Error('native retirement trace exceeds128MiB');
      if (row.eof) break;
    }
  } finally { await send('IO.close', {handle:receipt.stream}); }
  await writeFile(resolve(output,'native-worker-retirement-trace.json'),data);
  const allocations = [];
  let allocatorDumps = 0;
  for (const event of JSON.parse(data).traceEvents) {
    const allocators = event.args?.dumps?.allocators;
    if (!allocators) continue;
    allocatorDumps++;
    if (!allocators['v8/workers']) continue;
    const scopes = Object.entries(allocators).filter(([name])=>name.includes('/types/DedicatedWorkerGlobalScope'))
      .reduce((sum,[,row])=>sum+Number.parseInt(row.attrs?.object_count?.value??'0',16),0);
    allocations.push({pid:event.pid,v8WorkerBytes:Number.parseInt(allocators['v8/workers'].attrs.size.value,16),WorkerGlobalScopes:scopes});
  }
  if (!allocatorDumps) throw new Error('native retirement allocator evidence unavailable');
  const workerTargets = targets.targetInfos.filter(row=>row.type==='worker');
  const result = {dump,targets,allocations,workerTargets:workerTargets.length,forcedGC:false,
    traceSha256:createHash('sha256').update(data).digest('hex'),
    pass:workerTargets.length===0 && allocations.every(row=>row.WorkerGlobalScopes===0)};
  await writeFile(resolve(output,'native-worker-retirement.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
