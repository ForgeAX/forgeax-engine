import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = resolve(process.argv[2] ?? '.');
const client = new Client({ name: 'forgeax-view-codex-stopped', version: '0.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, '../src/mcp-stdio.mjs'), root],
}));
try {
  const result = await client.callTool({ name: 'forgeax_view_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.ok(['backend-not-ready', 'backend-unreachable'].includes(result.structuredContent.error.code), JSON.stringify(result));
  console.log(JSON.stringify(result.structuredContent));
} finally {
  await client.close();
}
