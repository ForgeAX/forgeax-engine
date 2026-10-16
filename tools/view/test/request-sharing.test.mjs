import assert from 'node:assert/strict'; import {test} from 'node:test';
import {ViewWorkspaceClient} from '@forgeax/view-workspace-core/client';
import {VIEW_WORKSPACE_OPERATIONS,VIEW_WORKSPACE_OPERATION_EFFECTS} from '@forgeax/view-workspace-core/contract';
test('every operation uses its canonical sharing mode and commands execute independently',async()=>{
 for(const operation of VIEW_WORKSPACE_OPERATIONS){
  let calls=0,finish;const result=new Promise(resolve=>finish=resolve);
  const client=new ViewWorkspaceClient({clientId:'test',transport:{request(){calls++;return result;}}});
  const first=client.call(operation),second=client.call(operation);await Promise.resolve();
  assert.equal(calls,VIEW_WORKSPACE_OPERATION_EFFECTS[operation]==='query'?1:2,operation);finish({});await Promise.all([first,second]);
 }
});
test('snapshot leases cancel independently and writes fence later reads without replay',async()=>{
 const pending=[];
 const client=new ViewWorkspaceClient({clientId:'test',transport:{request(_service,request,{signal}){return new Promise(resolve=>pending.push({operation:request.operation,signal,resolve}));}}});
 const controller=new AbortController();const first=client.call('tabs.get',{}, {signal:controller.signal});const second=client.call('tabs.get');await Promise.resolve();assert.equal(pending.length,1);
 const aborted=assert.rejects(first);controller.abort();await aborted;assert.equal(pending[0].signal.aborted,false);
 const write=client.call('tabs.select',{tabId:'other'});const later=client.call('tabs.get');await Promise.resolve();assert.equal(pending.length,3);
 pending[0].resolve({revision:1});pending[1].resolve({});pending[2].resolve({revision:2});assert.deepEqual(await second,{revision:1});assert.deepEqual(await later,{revision:2});await write;
});
test('the last cancelled read releases the underlying transport request',async()=>{
 let signal;const client=new ViewWorkspaceClient({clientId:'test',transport:{request(_s,_p,options){signal=options.signal;return new Promise(()=>{});}}});
 const controller=new AbortController();const read=client.call('scene.tree.get',{}, {signal:controller.signal});const aborted=assert.rejects(read);await Promise.resolve();controller.abort();await aborted;assert.equal(signal.aborted,true);
});
