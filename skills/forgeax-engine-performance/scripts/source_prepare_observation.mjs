import assert from 'node:assert/strict';
const protocol='source-preparation-observation-v1';
/** Bodies for the existing EngineWorker.remoteEval, or expressions for its CDP realm.
 * Install after matched BUY, finish after all measurement owners stop. No RPC/loop
 * is installed here. The caller authenticates the exact loaded source/build first. */
export function sourcePreparationStartScript({token,worldIdentity,build,maxAttempts=30}){
 assert(typeof token==='string'&&token.length>0&&token.length<=96,'Invalid source observation token');
 assert(typeof worldIdentity==='string'&&worldIdentity.length>0&&worldIdentity.length<=256,'Invalid source World');
 assert(/^[a-f0-9]{40}$/.test(build),'Exact Engine source SHA required');
 assert(Number.isSafeInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=120,'Invalid attempt budget');
 const input=JSON.stringify({protocol,enabled:true,token,worldIdentity,build,maxAttempts,attempts:0,skipped:0,dropped:0,failures:0,probeWallMs:0,observerWallMs:0,clockCalls:0,clockFailures:0,cancelled:false,finalizationWallMs:0,outcomes:{accepted:0,discarded:0,'prepare-error':0,retired:0}});
 return `const root=globalThis.__forgeaxFramePhaseDiagnostics??={};
 const old=root.sourcePreparation;
 if(old!==undefined)return {status:'unavailable',reason:'already-installed'};
 root.sourcePreparation=${input};
 return {status:'armed',protocol:${JSON.stringify(protocol)},token:${JSON.stringify(token)},worldAssertion:${JSON.stringify(worldIdentity)},atMs:performance.now(),timeOriginMs:performance.timeOrigin};`;
}
export function sourcePreparationFinishScript({token,worldIdentity}){
 assert(typeof token==='string'&&token.length<=96&&typeof worldIdentity==='string'&&worldIdentity.length<=256,'Invalid source observation owner');
 return `const root=globalThis.__forgeaxFramePhaseDiagnostics,control=root?.sourcePreparation;
 if(control?.protocol!==${JSON.stringify(protocol)}||control.token!==${JSON.stringify(token)}||control.worldIdentity!==${JSON.stringify(worldIdentity)})return {status:'unavailable',reason:'owner-mismatch'};
 control.enabled=false;control.cancelled=control.result===undefined;
 const result={status:control.result===undefined?'unavailable':'returned',reason:control.result===undefined?'no-qualified-transaction':null,atMs:performance.now(),timeOriginMs:performance.timeOrigin,control};
 const removed=Reflect.deleteProperty(root,'sourcePreparation');return {...result,cleanup:{removed}};`;
}
/** No capture success inference: absent clocks/frame/mutation or omitted/drop/failure
 * remains explicit. A captured failure receipt is evidence, not a successful send. */
export function qualifySourcePreparation(exported,{token,worldIdentity,build}){
 const c=exported?.control,r=c?.result;
 assert(c?.protocol===protocol&&c.token===token&&c.worldIdentity===worldIdentity&&c.build===build,'Source observation owner mismatch');
 assert(Buffer.byteLength(JSON.stringify(exported),'utf8')<=32768,'Source export budget exceeded');
 const issues=[];
 if(exported?.cleanup?.removed!==true)issues.push('cleanup');
 if(c.clockFailures!==0)issues.push('observer-clock');
 if(!r||r.protocol!==protocol)issues.push('no-qualified-transaction');
 else{
  if(r.worldIdentity!==worldIdentity||r.buildAssertion!==build||r.token!==token)issues.push('receipt-owner-mismatch');
  if(r.status!=='accepted')issues.push(`transaction-${r.status}`);
  if(typeof r.source!=='string'||r.source.length===0||!Number.isSafeInteger(r.epoch)||r.epoch<0||!Number.isSafeInteger(r.revision)||r.revision<1)issues.push('source-identity');
  if(!Number.isSafeInteger(r.frameId)||r.frameId<0)issues.push('missing-execution-frame');
  if(!(r.runtimeMeshes>0&&r.meshMutation===true))issues.push('missing-runtime-mesh-mutation');
  if(!Number.isFinite(r.beginMs)||!Number.isFinite(r.endMs)||r.endMs<r.beginMs||!Number.isFinite(r.timeOriginMs)||r.clock?.failures!==0)issues.push('clock');
  if(r.omitted!==0)issues.push('omitted');
 }
 if(c.dropped!==0||c.failures!==0)issues.push('observer-drop-or-failure');
 return {qualified:issues.length===0,issues,diagnosticOnly:true,ordinaryFpsAcceptance:false,
  limitation:'Collector build is an assertion: authenticate loaded sources separately. Exclusive wall phases exclude bracketed observer work; they are neither thread CPU nor removable cost. Probe/final export overhead and capture perturbation remain separate. No GPU fence or prior-World replay.'};
}

/** Reuse the collector's already-owned EngineWorker CDP session; no listener,
 * target discovery or periodic polling is added. Source authority comes from the
 * existing loaded-script/hash qualification, not this requested build string. */
export async function sourcePreparationOperation(session,operation,owner,{sourceQualified,engineCommit}){
 assert(sourceQualified===true&&engineCommit===owner.build,'Authenticated Engine Worker sources required');
 assert(operation==='start'||operation==='finish','Invalid source observation operation');
 const body=operation==='start'?sourcePreparationStartScript(owner):sourcePreparationFinishScript(owner);
 const response=await session.send('Runtime.evaluate',{expression:`(()=>{${body}})()`,returnByValue:true,awaitPromise:false});
 if(response.exceptionDetails) return {status:'unavailable',reason:'evaluation-exception',exceptionDetails:response.exceptionDetails};
 assert(response.result?.type==='object'&&Object.hasOwn(response.result,'value'),'Missing source observation metadata');
 return response.result.value;
}
