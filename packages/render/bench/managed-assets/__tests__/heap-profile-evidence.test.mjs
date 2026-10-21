import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
// A local process provides real byte pipes; this fixture models only the
// existing Playwright decoder surface that the post-window adapter borrows.
class PipeTransport {
  constructor(write, read) {
    this._pipeWrite = write; this._pipeRead = read; this._pendingBuffers = [];
    read.on('data', bytes => this._dispatch(bytes));
  }
  send(message) { this._pipeWrite.write(JSON.stringify(message) + '\0'); }
  _dispatch(bytes) {
    this._pendingBuffers.push(bytes);
    const pending = Buffer.concat(this._pendingBuffers);
    let start = 0, end;
    while ((end = pending.indexOf(0, start)) !== -1) {
      this.onmessage?.(JSON.parse(pending.subarray(start, end).toString()));
      start = end + 1;
    }
    this._pendingBuffers = [pending.subarray(start)];
  }
}
import { openHeapProfileTransport } from '../heap-profile-transport.mjs';
import { createPostWindowEvidence } from '../post-window-evidence.mjs';

const childCode = `
import { once } from 'node:events';
let pending='';const sampling=new Set();
const send=async bytes=>{if(!process.stdout.write(bytes))await once(process.stdout,'drain');};
async function response(request){
 if(['Target.attachToTarget','Target.detachFromTarget'].includes(request.method)&&request.sessionId!=='collector-browser-session')throw new Error('Collector must retain its own browser session');
 if(request.method==='Target.attachToTarget')return send(JSON.stringify({id:request.id,result:{sessionId:request.params.targetId}})+'\\0');
 if(request.method==='Target.detachFromTarget')return send(JSON.stringify({id:request.id,result:{}})+'\\0');
 if(request.method==='Browser.getVersion')return send(JSON.stringify({id:request.id,result:{product:'fixture'}})+'\\0');
 if(request.method==='HeapProfiler.enable')return send(JSON.stringify({id:request.id,result:{}})+'\\0');
 if(request.method==='HeapProfiler.startSampling'){sampling.add(request.sessionId);return send(JSON.stringify({id:request.id,result:{}})+'\\0');}
 if(!sampling.delete(request.sessionId))throw new Error('Sampler frontend identity was lost');
 if(request.sessionId==='failure')return send(JSON.stringify({id:request.id,error:{code:-32000,message:'intentional target failure'}})+'\\0');
 await send(JSON.stringify({method:'fixture.event',params:{alive:true}})+'\\0');
 const count=50_000, item='{"size":32768,"nodeId":1,"ordinal":2},';
 await send('{"id":'+request.id+',"result":{"profile":{"head":{"id":1,"children":[]},"samples":[');
 const batch=item.repeat(16384);
 for(let index=0;index<count;){const next=Math.min(count-index,16384);await send(next===16384?batch:item.repeat(next));index+=next;}
 await send('{"size":65536,"nodeId":1,"ordinal":3}]}}}\\0');
}
let chain=Promise.resolve();
process.stdin.on('data',bytes=>{pending+=bytes;let end;while((end=pending.indexOf('\\0'))!==-1){const message=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);chain=chain.then(()=>response(message));}});
`;

test('real byte pipes retain every sample, ordinary traffic and later failure', async t=>{
 const directory=await mkdtemp(join(tmpdir(),'managed-pipe-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const child=spawn(process.execPath,['--input-type=module','-e',childCode],{stdio:['pipe','pipe','inherit']});
 t.after(()=>child.kill());
 const pipe=new PipeTransport(child.stdin,child.stdout), originalDispatch=pipe._dispatch;
 const connection={_transport:pipe,_lastId:700}, ordinary=[];
 pipe.onmessage=message=>ordinary.push(message);
 const root={_connection:{toImpl:()=>({_session:{_connection:connection,_sessionId:'collector-browser-session'}})}};
 const evidence=await createPostWindowEvidence(join(directory,'raw'));
 const setup=await openHeapProfileTransport(root,evidence);
 const target={targetId:'big',type:'worker'};
 const sampler=await setup.start(target,{samplingInterval:32768});
 await setup.close();
 assert.equal(pipe._dispatch,originalDispatch);
 const transport=await openHeapProfileTransport(root,evidence);
 const result=await transport.stop(target,sampler);
 let count=0,total=0;for(const item of result.profile.samples){count++;total+=item.size;}
 assert.equal(count,50_001);assert.equal(total,50_000*32768+65536);
 assert(result.receipt.bytes>1_000_000);
 await evidence.flush();
 const raw=await readFile(result.receipt.path);
 assert.equal(createHash('sha256').update(raw).digest('hex'),result.receipt.sha256);
 const failedTarget={targetId:'failure',type:'worker'};
 const failedSampler=await transport.start(failedTarget,{samplingInterval:32768});
 await assert.rejects(transport.stop(failedTarget,failedSampler),/intentional target failure/);
 await transport.close();assert.equal(pipe._dispatch,originalDispatch);
 pipe.send({id:++connection._lastId,method:'Browser.getVersion'});
 for(let tries=0;tries<100&&!ordinary.some(item=>item.result?.product==='fixture');tries++)await new Promise(resolve=>setTimeout(resolve,10));
 assert(ordinary.some(item=>item.method==='fixture.event'));
 assert(ordinary.some(item=>item.result?.product==='fixture'));
 console.log(JSON.stringify({bytes:result.receipt.bytes,samples:count,sha256:result.receipt.sha256}));
 child.stdin.end();
});

test('unsupported browser transports fail explicitly', async () => {
  await assert.rejects(openHeapProfileTransport({}), /in-process Playwright Chromium pipe transport/);
});
