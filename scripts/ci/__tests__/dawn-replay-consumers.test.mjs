import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { teardownDawnInstance } from '../../lib/dawn-teardown.mjs';

for (const failedOwner of [undefined, 'renderer', 'world', 'texture']) {
  test(`FBX skin smoke releases Dawn after ${failedOwner ?? 'successful'} cleanup`, async () => {
    const source = readFileSync(
      new URL('../../../apps/hello/fbx-skin/scripts/smoke-dawn.mjs', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /process\.exit\(/, 'forced exit bypasses native cleanup');
    const start = source.lastIndexOf('\n} finally {');
    const end = source.indexOf('\n}\n', start + 1);
    assert.ok(start > 0 && end > start);
    assert.ok(source.indexOf("emitSmokeReceipt('hello-fbx-skin/smoke'") > end);
    const gpu = {};
    const navigator = { gpu };
    const cleanup = runInNewContext(
      `(async (renderer, worldContext, renderTarget, sharedDevice, gpu) => { ${source.slice(start + '\n} finally {'.length, end)} })`,
      { teardownDawnInstance, navigator },
    );
    const events = [];
    const fault = new Error(`${failedOwner} cleanup failed`);
    const retire = (owner) => {
      events.push(owner);
      if (failedOwner === owner) throw fault;
    };
    const done = cleanup(
      { dispose: async () => ({ unwrap: () => retire('renderer') }) },
      { fiber: { dispose: async () => retire('world') } },
      { destroy: () => retire('texture') },
      {
        destroy: () => retire('device'),
        queue: { onSubmittedWorkDone: () => retire('drain') },
      },
      gpu,
    );
    if (failedOwner === undefined) await done;
    else await assert.rejects(done, (error) => error === fault);
    assert.deepEqual(events, ['renderer', 'world', 'texture', 'device', 'drain']);
    assert.equal(navigator.gpu, undefined);
  });
}

for (const name of ['profile-ssr-compose', 'profile-ssr-reflection-mips']) {
  test(`${name} drains its replacement device before releasing Dawn after a destruction fault`, async () => {
    const source = readFileSync(
      new URL(`../../../apps/hello/ssr/scripts/${name}.mjs`, import.meta.url),
      'utf8',
    );
    const start = source.lastIndexOf('\n} finally {');
    assert.ok(start > 0);
    const cleanup = runInNewContext(
      `(async (device, backend) => { ${source.slice(start + '\n} finally {'.length, source.lastIndexOf('\n}'))} })`,
      { teardownDawnInstance },
    );
    const events = [];
    const fault = new Error('replacement destruction failed');
    const replacement = { queue: { onSubmittedWorkDone: () => events.push('replacement drain') } };
    const original = {
      destroy: () => events.push('original destroy'),
      queue: { onSubmittedWorkDone: () => events.push('original drain') },
    };
    const backend = {
      rhiWebgpu: {
        disposeDevice(device) {
          assert.equal(device, replacement);
          events.push('replacement destroy');
          throw fault;
        },
      },
      dispose: () => teardownDawnInstance([original], () => events.push('release GPU')),
    };
    await assert.rejects(
      cleanup(replacement, backend),
      (error) => error === fault || error.errors?.includes(fault),
    );
    assert.deepEqual(events, [
      'replacement destroy',
      'replacement drain',
      'original destroy',
      'original drain',
      'release GPU',
    ]);
  });
}
