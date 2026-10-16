import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const server = resolve(import.meta.dirname, '../src/mcp-stdio.mjs');
const root = resolve(import.meta.dirname, '../../..');
const expected = [
  'forgeax_asset_inspect', 'forgeax_engine_asset_inspect', 'forgeax_engine_entity_inspect',
  'forgeax_engine_scene_tree_get', 'forgeax_view_status', 'forgeax_view_workspace_pack_reveal',
];

async function discover() {
  const client = new Client({ name: 'forgeax-view-discovery', version: '0.0.0' });
  const env = { ...process.env };
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, root], env });
  await client.connect(transport);
  try { return (await client.listTools()).tools.map(tool => tool.name).sort(); }
  finally { await client.close(); }
}

assert.deepEqual(await discover(), expected);
console.log(JSON.stringify({ ordinaryTools: expected.length }));
