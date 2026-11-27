import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const source=readFileSync(new URL('../native-sponza.mjs',import.meta.url),'utf8').replaceAll('\r\n','\n');
const start='  const teardownErrors = [];';
const end='  if (roamCamera !== undefined) {';
assert.equal(source.split(start).length,2);
const from=source.indexOf(start),to=source.indexOf(end,from);
assert(to>from,'The ordinary Native teardown block must remain directly observable');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
// Execute the production finally statements without importing the Native app,
// creating an adapter, or replacing the Renderer disposal contract.
const teardown=new AsyncFunction('renderer','debugUi','nativeRhiCapture','nativeWindow','report',source.slice(from,to)+'\nreturn teardownErrors;');

function owners(renderer,events=[]){
 return {renderer,events,debugUi:{ui:{dispose(){events.push('ui');}}},
  nativeRhiCapture:{async dispose(){events.push('capture');return {status:'disposed'};}},
  nativeWindow:{close(){events.push('window');return {ok:true,value:undefined};}},
  report:{rhiCapture:{status:'disabled'}}};
}
const run=x=>teardown(x.renderer,x.debugUi,x.nativeRhiCapture,x.nativeWindow,x.report);

test('waits for the actual deferred Renderer disposal before releasing its Native window',async()=>{
 const events=[];let finish;
 const pending=new Promise(resolve=>{finish=resolve;});
 const x=owners({dispose(){events.push('renderer-start');return pending;}},events);
 const done=run(x);
 try{await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['renderer-start']);}
 finally{finish({ok:true,value:undefined});await done;}
 assert.deepEqual(events,['renderer-start','ui','capture','window']);
});
test('retains a structured Renderer Result.err and still closes every remaining owner',async()=>{
 const error={code:'webgpu-runtime-error',detail:{step:'device.destroy'},expected:'all owners retire',hint:'preserve the failure'};
 const x=owners({async dispose(){return {ok:false,error};}});
 const failures=await run(x);assert.deepEqual(failures,[{step:'renderer.dispose',error}]);
 assert.equal(failures[0].error,error);assert.deepEqual(x.events,['ui','capture','window']);
});
test('cleans up a missing Renderer and a normally disposed Renderer',async()=>{
 for(const renderer of [undefined,{async dispose(){return {ok:true,value:undefined};}}]){
  const x=owners(renderer);assert.deepEqual(await run(x),[]);assert.deepEqual(x.events,['ui','capture','window']);
 }
});
test('records rejected asynchronous disposal and continues Native cleanup',async()=>{
 const x=owners({async dispose(){throw Error('rejected Renderer retirement');}});
 assert.deepEqual(await run(x),['Error: rejected Renderer retirement']);assert.deepEqual(x.events,['ui','capture','window']);
});
test('records synchronous disposal failure and continues Native cleanup',async()=>{
 const x=owners({dispose(){throw Error('synchronous Renderer retirement');}});
 assert.deepEqual(await run(x),['Error: synchronous Renderer retirement']);assert.deepEqual(x.events,['ui','capture','window']);
});
test('attempts all cleanup after Renderer, UI, capture and window failures',async()=>{
 const events=[],rendererError={code:'renderer-dispose-failed'},windowError={code:'window-close-failed'};
 const x=owners({async dispose(){events.push('renderer');return {ok:false,error:rendererError};}},events);
 x.debugUi.ui.dispose=()=>{events.push('ui');throw Error('UI failure');};
 x.nativeRhiCapture.dispose=async()=>{events.push('capture');throw Error('capture failure');};
 x.nativeWindow.close=()=>{events.push('window');return {ok:false,error:windowError};};
 assert.deepEqual(await run(x),[{step:'renderer.dispose',error:rendererError},'Error: UI failure','Error: capture failure',JSON.stringify(windowError)]);
 assert.deepEqual(events,['renderer','ui','capture','window']);
});
