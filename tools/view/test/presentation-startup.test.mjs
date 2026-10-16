import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startNativePlugin } from '@forgeax/engine-plugin';
import { presentationFixture as fixture, surfaces, providePresentation as provide } from './support/presentation-fixture.mjs';

test('embedded Shell starts before App and native presentation children follow provider lifetime', async () => {
  const f = fixture();
  try {
    const started = await startNativePlugin(f.ctx, f.root, { frontendConfig: f.config }, { timeoutMs: 120 });
    assert.equal(started.ok, true, JSON.stringify(started.error));
    assert.equal(surfaces(f).length, 0);
    assert.equal(f.pages.size, 0);
    assert.equal(f.counts().claims, 1);
    let provider = await provide(f.ctx, 'app-one');
    const children = surfaces(f);
    assert.equal(children.length, 1);
    await Promise.all(children.map(fiber => fiber.await()));
    assert.ok(children.every(fiber => fiber.state === 2));
    assert.deepEqual([...f.pages], [f.pageType]);
    await provider.dispose();
    await Promise.all(children.map(fiber => fiber.await()));
    assert.ok(children.every(fiber => fiber.state === 0));
    assert.equal(started.value.state, 2);
    assert.equal(f.pages.size, 0);
    provider = await provide(f.ctx, 'app-two');
    await Promise.all(children.map(fiber => fiber.await()));
    assert.equal(surfaces(f).length, children.length);
    assert.ok(surfaces(f).every((fiber, index) => fiber === children[index]));
    assert.ok(children.every(fiber => fiber.state === 2));
    await started.value.dispose();
    assert.ok(children.every(fiber => fiber.uid === null));
    assert.deepEqual(f.counts(), { mounts: 4, unmounts: 4, claims: 1, releases: 1 });
    assert.equal(f.pages.size, 0);
    await provider.dispose();
    await provide(f.ctx, 'app-after-shell');
    assert.equal(surfaces(f).length, children.length);
    assert.ok(surfaces(f).every((fiber, index) => fiber === children[index]));
  } finally { await f.dispose(); }
});

test('failed App leaves embedded Shell active with no pending presentation descendants', async () => {
  const f = fixture();
  try {
    const shell = await startNativePlugin(f.ctx, f.root, { frontendConfig: f.config }, { timeoutMs: 120 });
    assert.equal(shell.ok, true, JSON.stringify(shell.error));
    const app = await startNativePlugin(f.ctx, { name: 'failed-renderer', apply() {
      throw new Error('renderer unavailable');
    } }, {}, { timeoutMs: 120 });
    assert.equal(app.ok, false);
    assert.equal(shell.value.state, 2);
    assert.equal(surfaces(f).length, 0);
    assert.equal(f.pages.size, 0);
  } finally { await f.dispose(); }
});

for (const late of [false, true]) {
  test(`presentation failure remains native FAILED when provider is ${late ? 'late' : 'already active'}`, async () => {
    const f = fixture();
    f.config.panelHost.mountPanel = async () => { throw new Error('surface mount failed'); };
    try {
      if (!late) await provide(f.ctx, 'app');
      const shell = await startNativePlugin(f.ctx, f.root, { frontendConfig: f.config }, { timeoutMs: 120 });
      if (!late) {
        assert.equal(shell.ok, false);
        assert.equal(shell.error.detail.reason, 'failed');
      } else {
        assert.equal(shell.ok, true, JSON.stringify(shell.error));
        await provide(f.ctx, 'late-app');
        const child = surfaces(f).find(fiber => fiber.runtime.name === f.childName);
        assert.ok(child);
        await assert.rejects(child.await(), /surface mount failed/);
        assert.equal(child.state, 3);
        assert.equal(shell.value.state, 2);
      }
      assert.equal(f.pages.size, 0);
    } finally { await f.dispose(); }
  });
}

test('a loading presentation provider does not become a Shell startup dependency', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const provider = f.ctx.plugin({ name: 'loading-app', async apply(inner) {
      inner.provide('engineWorkspacePresentation', {});
      await gate;
    } });
    const shell = await startNativePlugin(f.ctx, f.root, { frontendConfig: f.config }, { timeoutMs: 120 });
    assert.equal(shell.ok, true, JSON.stringify(shell.error));
    assert.equal(surfaces(f).length, 0);
    release();
    await provider.await();
    const children = surfaces(f);
    assert.equal(children.length, 1);
    await Promise.all(children.map(fiber => fiber.await()));
    assert.ok(children.every(fiber => fiber.state === 2));
  } finally { release(); await f.dispose(); }
});

for (const key of ['presentation', 'targetPresentation']) {
  test(`explicit ${key} mounts without an Engine provider`, async () => {
    const f = fixture();
    f.config[key] = {};
    try {
      const shell = await startNativePlugin(f.ctx, f.root, { frontendConfig: f.config }, { timeoutMs: 120 });
      assert.equal(shell.ok, true, JSON.stringify(shell.error));
      assert.deepEqual([...f.pages], [f.pageType]);
      assert.equal(surfaces(f).length, 1);
      assert.equal(surfaces(f)[0].state, 2);
    } finally { await f.dispose(); }
    assert.deepEqual(f.counts(), { mounts: 2, unmounts: 2, claims: 1, releases: 1 });
  });
}
