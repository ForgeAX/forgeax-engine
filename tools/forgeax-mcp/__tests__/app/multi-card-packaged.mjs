import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION, RESOURCE_CARD_SLOTS } from '../../src/contract.ts';

if (!process.argv[2]) throw new Error('Usage: multi-card-packaged.mjs <packaged-plugin-directory>');
const plugin = await realpath(resolve(process.argv[2]));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-three-slots-package-')));
const client = new Client({ name: 'static-card-slot-verifier', version: '1' });
try {
  const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
  binding.root = join(temp, 'owned-global');
  binding.codexContext = { ...binding.codexContext, home: temp };
  await writeFile(join(temp, 'hosting.json'), JSON.stringify(binding));
  const consumer = join(temp, 'consumer');
  await mkdir(join(consumer, 'assets'), { recursive: true });
  await writeFile(join(consumer, 'forge.json'), '{}');
  const sources = ['original.pack.json', 'archway.pack.json', 'link-demo.pack.ts'].map(name => join(consumer, 'assets', name));
  for (const path of sources) await writeFile(path, path.endsWith('.ts') ? 'throw new Error("Static admission must not execute source");' : '{}');
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, 'src/codex-app-server.mjs'), join(temp, 'hosting.json')], cwd: temp }));
  assert.equal(client.getServerVersion().version, APP_VERSION);
  const tools = (await client.listTools()).tools;
  const expected = ['forgeax_view_file_open', 'forgeax_view_global_start',
    ...RESOURCE_CARD_SLOTS.map(slot => slot.tool), 'forgeax_view_resource_open', 'forgeax_view_resource_select',
    'forgeax_view_start', 'forgeax_view_transport', 'forgeax_view_workspace_bind'];
  assert.deepEqual(tools.map(tool => tool.name).sort(), expected.sort());
  const listed = (await client.listResources()).resources;
  const digests = [], results = [];
  for (const [index, slot] of RESOURCE_CARD_SLOTS.entries()) {
    const tool = tools.find(value => value.name === slot.tool);
    assert.equal(tool._meta.ui.resourceUri, slot.uri);
    assert.equal(tool._meta['openai/ui'].preferredModelDisplayMode, 'inline');
    assert.ok(listed.some(value => value.uri === slot.uri));
    const contents = (await client.readResource({ uri: slot.uri })).contents;
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, slot.uri);
    assert.ok(contents[0].text.length > 1000);
    assert.deepEqual(contents[0]._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' });
    for (const metadata of [listed.find(value => value.uri === slot.uri)._meta, contents[0]._meta]) {
      assert.equal(metadata['openai/widgetMinFrameHeight'], 0);
      assert.equal(metadata['openai/widgetHeightHint'], 48);
    }
    digests.push(createHash('sha256').update(contents[0].text).digest('hex'));
    const call = args => client.callTool({ name: slot.tool, arguments: args, _meta: { threadId: 'three-slots-same-chat' } });
    const result = await call({ paths: [sources[index]] });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent.resources, [{ path: sources[index], label: basename(sources[index]) }]);
    assert.equal(result._meta?.ui?.resourceUri, undefined);
    results.push({ tool: slot.tool, uri: slot.uri, resources: result.structuredContent.resources,
      heightMetadata: { minFrameHeight: contents[0]._meta['openai/widgetMinFrameHeight'], heightHint: contents[0]._meta['openai/widgetHeightHint'] } });
    for (const args of [{ paths: [], prepareBackend: true }, { paths: [sources[index]], root: '/foreign' },
      { paths: [join(consumer, 'missing.pack.json')], prepareBackend: true }])
      assert.equal((await call(args)).isError, true);
  }
  assert.equal(new Set(RESOURCE_CARD_SLOTS.map(slot => slot.uri)).size, 3);
  assert.equal(new Set(digests).size, 1, 'Every static slot serves identical built carrier bytes');
  const slotUris = new Set(RESOURCE_CARD_SLOTS.map(slot => slot.uri));
  for (const resource of listed.filter(value => !slotUris.has(value.uri))) {
    const content = (await client.readResource({ uri: resource.uri })).contents[0];
    for (const metadata of [resource._meta, content._meta]) {
      assert.equal(metadata?.['openai/widgetMinFrameHeight'], undefined, resource.uri);
      assert.equal(metadata?.['openai/widgetHeightHint'], undefined, resource.uri);
    }
  }
  await assert.rejects(access(join(binding.root, '.forgeax')), { code: 'ENOENT' });
  await assert.rejects(access(join(temp, 'forgeax/view-bindings')), { code: 'ENOENT' });
  console.log(JSON.stringify({ passed: true, version: APP_VERSION, tools: tools.map(value => value.name),
    slots: results, carrierSha256: digests[0], backendAcquired: false, native: 'unverified' }, null, 2));
} finally {
  await client.close();
  await rm(temp, { recursive: true, force: true });
  console.log('cleanup: stdio closed, owned temporary consumer and binding removed');
}
