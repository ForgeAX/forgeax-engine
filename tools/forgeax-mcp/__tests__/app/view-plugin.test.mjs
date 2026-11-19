import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Context, startNativePlugin } from '@forgeax/engine-plugin';

test('offline native View starts ACTIVE and tracks late workspace service removal and replacement', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'forgeax-view-plugin-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = process.env.FORGEAX_TEST_VIEW_PLUGIN ?? new URL('../../src/app/view-plugin.ts', import.meta.url).pathname;
  const calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.__viewPluginProbe = { calls, platform: {
    app: {}, startBackend: async () => { calls.push('startup'); },
    fileOpener: { attach(client, owner) { calls.push(['attach', client.id, owner.id]); return () => calls.push(['detach', client.id, owner.id]); } },
  } };
  t.after(() => { globalThis.window = previousWindow; delete globalThis.__viewPluginProbe; });
  const result = await build({ stdin: { contents: await readFile(source, 'utf8'), resolveDir: new URL('../../src/app/', import.meta.url).pathname, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'borrow-platform-and-shell', setup(builder) {
      builder.onResolve({ filter: /^(\.\/mcp-platform-plugin|@forgeax\/view\/viewer\/(application|panels))$/ }, args => ({ path: args.path, namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === './mcp-platform-plugin'
        ? 'export const mcpPlatformPlugin={name:"probe.platform",provide:["mcpViewPlatform"],apply(ctx){ctx.provide("mcpViewPlatform",globalThis.__viewPluginProbe.platform)}};'
        : args.path.endsWith('/panels') ? 'export default {}'
        : 'export function mountViewApplication(){globalThis.__viewPluginProbe.calls.push("mount");return()=>globalThis.__viewPluginProbe.calls.push("unmount")}' }));
    } }] });
  const modulePath = join(temp, 'plugin.mjs'); await writeFile(modulePath, result.outputFiles[0].text);
  const { createMcpViewPlugin } = await import(pathToFileURL(modulePath));
  const realm = new Context(); t.after(() => realm.fiber.dispose());
  const started = await startNativePlugin(realm, createMcpViewPlugin(), undefined, { timeoutMs: 200 });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  assert.deepEqual(calls, ['mount', 'startup']);
  const first = { id: 'first' }, second = { id: 'second' };
  const removeFirst = realm.provide('viewOperationClient', first);
  assert.deepEqual(calls, ['mount', 'startup'], 'A workspace client alone must wait for its Shell frame owner');
  const firstOwner = { id: 'frame-first' }, secondOwner = { id: 'frame-second' };
  const removeOwner = realm.provide('viewProjectDocumentFrameOwner', firstOwner);
  assert.deepEqual(calls.at(-1), ['attach', 'first', 'frame-first']);
  await removeOwner();
  assert.deepEqual(calls.at(-1), ['detach', 'first', 'frame-first']);
  const removeReplacementOwner = realm.provide('viewProjectDocumentFrameOwner', secondOwner);
  assert.deepEqual(calls.at(-1), ['attach', 'first', 'frame-second']);
  await removeFirst();
  assert.deepEqual(calls.at(-1), ['detach', 'first', 'frame-second']);
  const removeSecond = realm.provide('viewOperationClient', second);
  assert.deepEqual(calls.at(-1), ['attach', 'second', 'frame-second']);
  await started.value.dispose();
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'detach' && call[1] === 'second').length, 1);
  await removeSecond(); await removeReplacementOwner();
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'detach').length, 3);
  assert.equal(calls.filter(call => call === 'unmount').length, 1);
});
