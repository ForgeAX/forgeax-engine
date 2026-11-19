import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { summarizeContext } from '../../src/context-probe.mjs';
import { createViewAppServer } from '../../src/app/mcp-server.mjs';

test('context evidence retains directory locators without recording credentials or conversation content', () => {
  const result = summarizeContext({ cwd: '/worktree', token: 'credential', text: 'conversation',
    nested: { authorization: { uri: 'file:///credential' }, roots: [{ uri: 'file:///workspace' }] } });
  assert.deepEqual(result.directories, [{ path: 'cwd', value: '/worktree' }, { path: 'nested.roots[0].uri', value: 'file:///workspace' }]);
  assert.ok(!JSON.stringify(result).includes('credential'));
  assert.ok(!JSON.stringify(result).includes('conversation'));
});

test('App context diagnostics use public roots and metadata without starting the backend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-context-proof-'));
  const previous = process.env.FORGEAX_CONTEXT_PROBE;
  process.env.FORGEAX_CONTEXT_PROBE = join(directory, 'probe.jsonl');
  let requests = 0;
  const app = createViewAppServer({ root: directory, request() { requests++; throw new Error('Backend should stay stopped'); } });
  const client = new Client({ name: 'context-proof', version: '1' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: 'file:///worktree' }] }));
  const [host, child] = InMemoryTransport.createLinkedPair();
  try {
    await app.server.connect(host);
    await client.connect(child);
    await client.callTool({ name: 'forgeax_view_transport', arguments: { action: 'context-probe', hostContext: { workspaceDirectory: '/worktree', token: 'secret' } },
      _meta: { cwd: '/worktree' } });
    const rows = (await readFile(process.env.FORGEAX_CONTEXT_PROBE, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.event === 'workspace-roots' && row.directories[0].value === 'file:///worktree'));
    assert.ok(rows.some(row => row.event === 'app-transport' && row.directories[0].value === '/worktree'));
    assert.ok(rows.some(row => row.event === 'app-host-context' && row.directories[0].value === '/worktree'));
    assert.equal(requests, 0);
    assert.ok(!JSON.stringify(rows).includes('secret'));
  } finally {
    await client.close();
    await app.close();
    if (previous === undefined) delete process.env.FORGEAX_CONTEXT_PROBE;
    else process.env.FORGEAX_CONTEXT_PROBE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
