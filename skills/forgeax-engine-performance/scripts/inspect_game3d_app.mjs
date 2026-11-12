import assert from 'node:assert/strict';

/** Resolve the actual public App through the game's inspection closure, without fabricating state. */
export async function inspectGame3dApp(host) {
  const fn = await host.send('Runtime.evaluate', {
    expression: 'globalThis.__forgeaxGameInspection.advance',
    objectGroup: 'game3d-app-inspection',
  });
  assert(fn.result.objectId, 'Actual inspection function unavailable');
  const details = await host.send('Runtime.getProperties', {objectId:fn.result.objectId});
  const scopes = details.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value.objectId;
  assert(scopes, 'Closure scope inspection unavailable');
  const entries = await host.send('Runtime.getProperties', {objectId:scopes});
  for (const scope of entries.result.filter(p=>/^\d+$/.test(p.name))) {
    const properties = await host.send('Runtime.getProperties', {objectId:scope.value.objectId});
    const app = properties.result.find(p=>p.name==='app' && p.value?.objectId);
    if (!app) continue;
    const call = async code => {
      const result = await host.send('Runtime.callFunctionOn', {
        objectId:app.value.objectId, functionDeclaration:code, returnByValue:true,
      });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const capability = await call('function(){return {pause:typeof this.pause,resume:typeof this.resume};}');
    assert.deepEqual(capability,{pause:'function',resume:'function'});
    return {scope:scope.value.description,capability,call};
  }
  throw new Error('Actual App binding unavailable');
}
