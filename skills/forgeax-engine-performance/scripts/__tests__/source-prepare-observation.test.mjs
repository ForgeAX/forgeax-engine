import assert from 'node:assert/strict';
import {test}from'node:test';
import {qualifySourcePreparation,sourcePreparationFinishScript,sourcePreparationStartScript}from'../source_prepare_observation.mjs';
const owner={token:'one',worldIdentity:'test-world',build:'a'.repeat(40)};
const run=script=>new Function('world','performance','globalThis',script)({identity:'test-world'},performance,root);
let root;
test('uses the existing realm evaluation, preserves execution sink and rejects duplicate/wrong-token cleanup',()=>{
 const execution={enabled:true};root={__forgeaxFramePhaseDiagnostics:{execution}};
 assert.equal(run(sourcePreparationStartScript(owner)).status,'armed');
 assert.equal(root.__forgeaxFramePhaseDiagnostics.execution,execution);
 assert.equal(run(sourcePreparationStartScript(owner)).reason,'already-installed');
 assert.equal(run(sourcePreparationFinishScript({...owner,token:'other'})).reason,'owner-mismatch');
 const result=run(sourcePreparationFinishScript(owner));assert.equal(result.reason,'no-qualified-transaction');
 assert.equal(result.control.cancelled,true);assert.equal(root.__forgeaxFramePhaseDiagnostics.sourcePreparation,undefined);
 assert.equal(root.__forgeaxFramePhaseDiagnostics.execution,execution);
});
test('never turns missing mutation/frame/clock/omissions or an original failed send into success',()=>{
 const control={protocol:'source-preparation-observation-v1',...owner,dropped:0,failures:0,clockFailures:0};
 const r={...control,buildAssertion:owner.build,status:'accepted',source:'actual-source',epoch:1,revision:2,frameId:7,runtimeMeshes:1,meshMutation:true,beginMs:1,endMs:3,timeOriginMs:5,clock:{failures:0},omitted:0};
 const check=result=>qualifySourcePreparation({control:{...control,result},cleanup:{removed:true}},owner);
 assert.equal(check(r).qualified,true);
 for(const change of [{status:'discarded'},{source:null},{frameId:null},{runtimeMeshes:0},{meshMutation:false},{omitted:1},{clock:{failures:1}}])assert.equal(check({...r,...change}).qualified,false);
 assert.equal(check(undefined).qualified,false);
});
test('validates bounded opt-in arguments before installing anything',()=>{
 assert.throws(()=>sourcePreparationStartScript({...owner,build:'latest'}));
 assert.throws(()=>sourcePreparationStartScript({...owner,maxAttempts:121}));
 assert.throws(()=>sourcePreparationStartScript({...owner,worldIdentity:'x'.repeat(257)}));
});

test('uses one authenticated existing CDP session call and preserves evaluation failure',async()=>{
 const {sourcePreparationOperation}=await import('../source_prepare_observation.mjs');
 let calls=0;
 const session={async send(method,params){calls++;assert.equal(method,'Runtime.evaluate');assert.equal(params.returnByValue,true);return {exceptionDetails:{text:'original evaluation error'}};}};
 await assert.rejects(()=>sourcePreparationOperation(session,'start',owner,{sourceQualified:false,engineCommit:owner.build}));
 assert.equal(calls,0);
 const result=await sourcePreparationOperation(session,'start',owner,{sourceQualified:true,engineCommit:owner.build});
 assert.equal(calls,1);assert.deepEqual(result.exceptionDetails,{text:'original evaluation error'});
});
