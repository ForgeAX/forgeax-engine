import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import { createFrontendHost, createHostAssembly } from '@forgeax/engine-host';
import { presentationFixture } from './support/presentation-fixture.mjs';
import { viewInspectorFrontendPlugin } from '../packages/view-plugin-plugins/src/runtime.ts';
test('late native presentation failure reaches the View inspection report', async () => {
  const f = presentationFixture();
  const { ctx, fibers } = f;
  const reports = [];
  const turns = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };
  f.config.panelHost.mountPanel = async () => { throw new Error('late-panel-mount-failed'); };
  const transport = {
    async request(service, request) {
      if (service !== 'forgeax.view.inspector.report')
        throw new Error('unexpected service: ' + service);
      reports.push(structuredClone(request.args.report));
      return { sourceId: 'review-source', generation: 1 };
    },
  };
  Object.assign(f.config, { transport, token: 'test-token', workspace: { clientId: 'review-client' } });
  let host;
  try {
    host = await createFrontendHost({
      context: ctx,
      assembly: createHostAssembly({
        root: { program: 'review-root', codeRevision: 'test', config: {} },
      }),
      resolveRoot: async () => f.root,

    });
    await host.activate();
    await turns();
    const before = reports.length;
    let notices = 0;
    host.assembly.subscribe(() => {
      notices++;
    });
    const provider = ctx.plugin({
      name: 'review-app',
      apply(inner) {
        inner.provide('engineWorkspacePresentation', {});
      },
    });
    await provider.await();
    const child = fibers.find((fiber) => fiber.runtime?.name === f.childName);
    await assert.rejects(child.await(), /late-panel-mount-failed/);
    await turns();
    const fresh = host.assembly.inspection.find(
      (fiber) => fiber.name === f.childName,
    );
    assert.equal(fresh.state, 'failed');
    const captured = reports
      .at(-1)
      .plugins.find(
        (fiber) =>
          fiber.module === f.childName || fiber.name === f.childName,
      );
    console.log(
      JSON.stringify({
        shell: host.status.state,
        liveChild: fresh,
        reportsBefore: before,
        reportsAfter: reports.length,
        assemblyNotices: notices,
        lastReportedChild: captured ?? null,
      }),
    );
    assert.ok(
      reports.length > before,
      'late Fiber state must be reported without unrelated tool changes',
    );
    assert.equal(captured?.fiberState, 'failed');
    assert.equal(host.status.state, 'active');
  } finally {
    await host?.dispose();
    await f.dispose();
  }
});

test('reporting stops and cancels pending work when its native owner is disposed', async () => {
  const ctx = new Context();
  const reports = [];
  const signals = [];
  let block = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const turns = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const transport = {
    async request(service, request, options) {
      signals.push(options?.signal);
      reports.push(structuredClone(request.args.report));
      if (block) await gate;
      return { sourceId: 's', generation: reports.length };
    },
  };
  let host;
  try {
    host = await createFrontendHost({
      context: ctx,
      assembly: createHostAssembly({
        root: { program: 'review-root', codeRevision: 'test', config: {} },
      }),
      resolveRoot: async () => ({
        name: 'review-root',
        apply(inner) {
          inner.plugin(viewInspectorFrontendPlugin, {
            document: {},
            transport,
            token: 't',
            workspace: { clientId: 'c' },
          });
        },
      }),
    });
    await host.activate();
    await turns();
    const baseline = reports.length;
    block = true;
    for (let i = 0; i < 8; i++) {
      const f = ctx.plugin({ name: 'unrelated-' + i, apply() {} });
      await f.await();
    }
    await turns();
    const blocked = reports.length;
    await host.dispose();
    const atDispose = reports.length;
    assert.equal(signals.at(-1)?.aborted, true, 'in-flight report is cancelled at native disposal');
    block = false;
    release();
    await turns();
    const afterDrain = reports.length;
    console.log(
      JSON.stringify({
        baseline,
        blocked,
        atDispose,
        afterDrain,
        postDisposeSends: afterDrain - atDispose,
        states: reports.slice(atDispose).map((report) => report.actual.state),
      }),
    );
    assert.equal(reports.length, atDispose, 'disposed reporter must not send queued snapshots');
  } finally {
    release();
    await host?.dispose();
    await ctx.fiber.dispose();
  }
});


test('native inspection reports one actual Fiber per plugin without activation-receipt duplicates', async () => {
  const ctx = new Context();
  const reports = [];
  let host;
  try {
    host = await createFrontendHost({
      context: ctx,
      assembly: createHostAssembly({ root: { program: 'single-inspection', codeRevision: 'test', config: {} } }),
      resolveRoot: async () => ({ name: 'single-inspection', apply(inner) {
        inner.plugin(viewInspectorFrontendPlugin, { document: {}, token: 't', workspace: { clientId: 'c' },
          transport: { async request(service, request) {
            reports.push(structuredClone(request.args.report));
            return { sourceId: 's', generation: 1 };
          } },
        });
      } }),
    });
    await host.activate();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    const report = reports.at(-1);
    const actual = host.assembly.inspection;
    assert.equal(report.plugins.length, actual.length);
    assert.equal(report.actual.entries.length, actual.length);
    assert.equal(new Set(report.plugins.map(plugin => plugin.fiberId)).size, actual.length);
    assert.ok(report.plugins.every(plugin => plugin.module !== 'unknown'));
  } finally { await host?.dispose(); await ctx.fiber.dispose(); }
});
