import assert from 'node:assert/strict';
import test from 'node:test';
import { game3dArchiveDrained, inspectGame3dApp } from '../inspect_game3d_app.mjs';

test('source archive waits for physical Render completion after Engine publication has drained', () => {
  const report = {
    execution: {
      engine: { health: 'idle' },
      frame: { submitted: 1666, completed: 1666, inFlight: 0 },
      render: { submittedFrame: 1666, completedFrame: 1665 },
    },
  };
  assert.equal(game3dArchiveDrained(report), false);
  report.execution.render.completedFrame = 1666;
  assert.equal(game3dArchiveDrained(report), true);
  report.execution.engine.health = 'running';
  assert.equal(game3dArchiveDrained(report), false);
  assert.equal(game3dArchiveDrained({}), false);
});

function fixture(options = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate')
        return { result: options.noFunction ? {} : { objectId: 'inspection-function' } };
      if (method === 'Runtime.getProperties') {
        if (params.objectId === 'inspection-function')
          return {
            internalProperties: options.noScopes
              ? []
              : [{ name: '[[Scopes]]', value: { objectId: 'scopes' } }],
          };
        if (params.objectId === 'scopes')
          return {
            result: [
              { name: 'length', value: { value: 1 } },
              { name: '0', value: { objectId: 'scope', description: 'actual app closure' } },
            ],
          };
        if (params.objectId === 'scope')
          return {
            result: options.noApp
              ? []
              : [
                  { name: 'other', value: { objectId: 'unrelated' } },
                  { name: 'app', value: { objectId: 'actual-app' } },
                ],
          };
      }
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(params.objectId, 'actual-app');
        if (options.exception) return { exceptionDetails: { text: 'native call failed' } };
        return {
          result: {
            value: params.functionDeclaration.includes('typeof')
              ? (options.capability ?? { pause: 'function', resume: 'function' })
              : 'native-result',
          },
        };
      }
      throw new Error('Unexpected method');
    },
  };
}

test('resolves the actual closure capability and dispatches calls on that same App', async () => {
  const host = fixture(),
    control = await inspectGame3dApp(host);
  assert.equal(control.scope, 'actual app closure');
  assert.equal(await control.call('function(){return this.pause();}'), 'native-result');
  const last = host.calls.at(-1);
  assert.equal(last.params.objectId, 'actual-app');
  assert.equal(last.params.returnByValue, true);
});

test('missing function, scopes or App fail closed without fabricating a pause', async () => {
  for (const options of [{ noFunction: true }, { noScopes: true }, { noApp: true }]) {
    const host = fixture(options);
    await assert.rejects(inspectGame3dApp(host));
    assert.equal(host.calls.filter((c) => c.method === 'Runtime.callFunctionOn').length, 0);
  }
});

test('rejects wrong capabilities and preserves actual call exceptions', async () => {
  await assert.rejects(
    inspectGame3dApp(fixture({ capability: { pause: 'undefined', resume: 'function' } })),
  );
  await assert.rejects(inspectGame3dApp(fixture({ exception: true })), /native call failed/);
});

test('resolves a minified binding only through the actual inspection closure and unique App capability', async () => {
  const host = fixture();
  const original = host.send.bind(host);
  host.send = async (method, params) => {
    if (method === 'Runtime.getProperties' && params.objectId === 'scope')
      return {
        result: [
          { name: 'x', value: { type: 'object', objectId: 'actual-app' } },
          { name: 'y', value: { type: 'object', objectId: 'unrelated' } },
        ],
      };
    if (
      method === 'Runtime.callFunctionOn' &&
      params.functionDeclaration.includes('this.execution?.report')
    )
      return { result: { value: params.objectId === 'actual-app' } };
    return original(method, params);
  };
  const control = await inspectGame3dApp(host);
  assert.equal(await control.call('function(){return this.pause();}'), 'native-result');
  const prior = host.send;
  host.send = (method, params) =>
    method === 'Runtime.callFunctionOn' &&
    params.functionDeclaration.includes('this.execution?.report')
      ? Promise.resolve({ result: { value: true } })
      : prior(method, params);
  await assert.rejects(inspectGame3dApp(host), /ambiguous/);
});
