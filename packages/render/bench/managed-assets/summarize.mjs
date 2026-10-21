import { assetBudget, budgets } from './budgets.mjs';

export function distribution(values, limit) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return undefined;
  const at=q=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)];
  return {count:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99),max:sorted.at(-1),...(limit===undefined?{}:{limit,overBudget:sorted.filter(value=>value>limit).length})};
}

export function summarize(result, heap) {
  const timing={};
  for(const field of ['assetCpuMs','worldCpuMs','cpuDrawMs','preparationCpuMs','submitToObservedWallMs','gpuPassEnvelopeMs','oldestPendingAgeMs'])
    timing[field]=distribution((field==='assetCpuMs'&&result.source.producerSamples?result.source.producerSamples:result.samples).map(sample=>sample[field]),field==='assetCpuMs'?assetBudget(result.config):undefined);
  timing.frameCompletionIntervalMs=distribution(result.frameTimes.slice(1).map((sample,i)=>sample.hostMs-result.frameTimes[i].hostMs),1000/budgets.targetHz);
  timing.wholeFrameMs=distribution(result.frameTimes.map(sample=>sample.wholeFrameMs),1000/budgets.targetHz);
  for(const field of ['sourceTaskCpuMs','sourcePublicationCpuMs'])timing[field]=distribution((result.source.samples??[]).map(sample=>sample[field]));
  const acknowledgments=result.source.acknowledgments??result.samples;
  timing.commitToAckMs=distribution(acknowledgments.map(sample=>sample.commitToAckMs),budgets.commitToAckP95Ms);
  const gpuByConsumer=new Map();
  for(const sample of result.samples)gpuByConsumer.set(sample.consumer??0,sample.gpu);
  let gpu=result.gpu??result.samples.at(-1)?.gpu;
  if(result.config.kind==='backpressure'&&result.mode==='worker'){
    gpu={live:{buffers:0,textures:0,bytes:0},peak:{buffers:0,textures:0,bytes:0},unsupported:[]};
    for(const counters of gpuByConsumer.values()){
      for(const [field,value] of Object.entries(counters)){if(value===null)gpu[field]=null;else if(typeof value==='number'&&gpu[field]!==null)gpu[field]=(gpu[field]??0)+value;}
      for(const kind of ['live','peak'])for(const field of ['buffers','textures','bytes'])gpu[kind][field]+=counters[kind][field];
      gpu.unsupported.push(...counters.unsupported);
    }
  }
  const memoryCategory=(realm,field)=>{
    const points=[realm.before,...(realm.heapSamples??[]),realm.after];
    const observed=points.map(point=>point[field]).filter(Number.isFinite);
    return {before:realm.before[field],after:realm.after[field],observedMax:observed.length?Math.max(...observed):undefined};
  };
  const realms=heap?.realms.map(realm=>({
    type:realm.target.type,url:realm.target.url,role:realm.role,
    allocationBytes:realm.allocationBytes,
    allocationBytesPerCompletedFrameBounds:realm.allocationBytesPerCompletedFrameBounds,
    usedHeapBytes:memoryCategory(realm,'usedSize'),
    backingStorageBytes:memoryCategory(realm,'backingStorageSize'),
    embedderHeapBytes:memoryCategory(realm,'embedderHeapUsedSize'),
  }));
  return {
    config:result.config,mode:result.mode,timing,gpu,
    measurement:result.measurementRunner,
    observation:result.observation,
    preflight:result.preflight,
    artifactVerification:result.artifactVerification,
    artifact:{sourceSha256:result.identity?.sourceSha256,artifactSha256:result.identity?.artifactSha256,carrierSha256:result.identity?.carrierSha256,observation:result.identity?.observation},
    sourceTransport:result.source.transport??result.source.sourceStats?.transport,
    hostTransport:result.hostTransport,
    distinctSourceSteps:result.distinctSourceSteps,coalescedSourceSteps:result.coalescedSourceSteps??result.samples.reduce((sum,sample)=>sum+(sample.coalescedSteps??0),0),
    realmMemory:realms,
    allocationBytes:realms?.every(realm=>Number.isFinite(realm.allocationBytes)) ? realms.reduce((sum,realm)=>sum+realm.allocationBytes,0) : undefined,
    nativeGc:heap?.nativeGc,
    heapEvidenceBoundary:heap?.boundary,
    pixelChecks:result.pixelChecks,
    correctnessFailures:result.failures,
  };
}

export function metrics(summary) {
  const output={};
  for(const [field,value] of Object.entries(summary.timing))if(value)for(const quantile of ['p50','p95','p99','max'])output[`${field}.${quantile}`]=value[quantile];
  for(const field of ['allocationBytes','heapPeakBytes'])if(summary[field]!==undefined)output[field]=summary[field];
  if(summary.gpu){for(const field of ['allocationBytes','bufferUploadBytes','textureUploadBytes','bufferCopyBytes','textureCopyBytes'])if(Number.isFinite(summary.gpu[field]))output[`gpu.${field}`]=summary.gpu[field];output['gpu.peak.bytes']=summary.gpu.peak.bytes;}
  if(summary.gc){output['gc.totalMs']=summary.gc.totalMs;output['gc.count']=summary.gc.count;}
  return output;
}
