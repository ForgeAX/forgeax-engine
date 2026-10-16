import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = resolve(process.argv[2] ?? '.');
const packSource = process.argv[3] ? resolve(process.argv[3]) : undefined;
const client = new Client({ name: 'forgeax-view-codex-smoke', version: '0.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, '../src/mcp-stdio.mjs'), root] });
await client.connect(transport);
try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'forgeax_asset_inspect', 'forgeax_engine_asset_inspect', 'forgeax_engine_entity_inspect',
    'forgeax_engine_scene_tree_get', 'forgeax_view_status', 'forgeax_view_workspace_pack_reveal',
  ]);
  const status = await client.callTool({ name: 'forgeax_view_status', arguments: {} });
  assert.equal(status.isError, false, JSON.stringify(status));
  assert.equal(status.structuredContent.ok, true);
  assert.equal(status.structuredContent.value.root, root);
  assert.equal(status.structuredContent.value.phase, 'ready', 'the combined View must be started');
  assert.equal(Number.isSafeInteger(status.structuredContent.value.revision), true,
    'status must consume the bounded View workspace summary');
  const denied = await client.callTool({ name: 'forgeax_asset_inspect', arguments: { subject: '/etc/passwd' } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'root-mismatch');
  let inspectedPack;
  if (packSource) {
    inspectedPack = await client.callTool({ name: 'forgeax_asset_inspect', arguments: { subject: packSource } });
    assert.equal(inspectedPack.isError, false, JSON.stringify(inspectedPack));
    assert.equal(inspectedPack.structuredContent.value.sourcePath, packSource);
    assert.match(inspectedPack.structuredContent.value.revision, /^sha256:/);
  }
  const tree = await client.callTool({ name: 'forgeax_engine_scene_tree_get', arguments: {
    targetId: 'nonexistent-target', targetGeneration: 1, limit: 1,
  } });
  assert.equal(tree.isError, true);
  assert.equal(tree.structuredContent.error.code, 'engine-workspace-target-mismatch');
  const entity = await client.callTool({ name: 'forgeax_engine_entity_inspect', arguments: {
    targetId: 'nonexistent-target', targetGeneration: 1, entityId: 'nonexistent-entity',
  } });
  assert.equal(entity.isError, true);
  assert.equal(entity.structuredContent.error.code, 'engine-workspace-target-mismatch');
  console.log(JSON.stringify({ tools: tools.length, status: status.structuredContent,
    outsideRoot: denied.structuredContent, pack: inspectedPack?.structuredContent,
    sceneTree: tree.structuredContent, entity: entity.structuredContent }));
} finally {
  await client.close();
}
