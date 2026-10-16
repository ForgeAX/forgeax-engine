import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import workspacePlugin from '../packages/view-workspace-core/src/frontend-plugin.ts';
import { beginCaptureSession, enableViewTrace, getViewTraceReport, isViewTraceEnabled, traceShellRegisterDomRoot, wrapViewWorkspaceClient } from '../packages/view-workspace-core/src/view-trace.ts';

test('workspace Fiber owns tracing, including late enable and complete observer cleanup', async t => {
  const globals = ['document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'PerformanceObserver', 'MutationObserver'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const frames = new Set();
  const observers = new Set();
  let sequence = 0;
  class Observer {
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  Object.assign(globalThis, {
    document: {}, location: { origin: 'http://localhost', pathname: '/', search: '?token=private-test-value', href: 'http://localhost/?token=private-test-value' },
    requestAnimationFrame() { const id = ++sequence; frames.add(id); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }, PerformanceObserver: Observer, MutationObserver: Observer,
  });
  for (let cycle = 0; cycle < 10; cycle++) {
    const context = new Context();
    try {
      const fiber = await context.plugin(workspacePlugin);
      await fiber.await();
      assert.equal(isViewTraceEnabled(), false);
      assert.equal(frames.size, 0);
      const client = wrapViewWorkspaceClient({ call: async () => ({ value: 1 }) });
      assert.equal(enableViewTrace(), true);
      assert.equal(enableViewTrace(), true);
      assert.equal(frames.size, 1);
      traceShellRegisterDomRoot({ tagName: 'DIV' });
      beginCaptureSession();
      assert.equal(observers.size, 4);
      assert.deepEqual(await client.call('camera.get'), { value: 1 });
      assert.equal(getViewTraceReport().summary.rpc['camera.get'].n, 1);
      assert.equal(JSON.stringify(getViewTraceReport()).includes('private-test-value'), false);
      await fiber.dispose();
      assert.equal(isViewTraceEnabled(), false);
      assert.equal(enableViewTrace(), false);
      assert.equal(globalThis.__forgeaxViewTrace, undefined);
      assert.equal(frames.size, 0);
      assert.equal(observers.size, 0);
      assert.equal(getViewTraceReport().events.length, 0);
    } finally { await context.fiber.dispose(); }
  }
});
