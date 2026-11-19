#!/usr/bin/env node
import { bindStdioLifetime } from './stdio-lifetime.mjs';
import { createBridgeClient } from './client.mjs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { operationMcpName } from '@forgeax/engine-tool-runtime';
import { APP_VERSION, MCP_SERVERS } from './contract.ts';
import { createContextProbe } from './context-probe.mjs';
import { createCodexRouting } from './codex-routing.mjs';

const rootArg = process.argv[2];
if (!rootArg) {
  console.error('Usage: node mcp-stdio.mjs <exact-project-root>');
  process.exit(2);
}
const client = await createBridgeClient(rootArg);
const routing = client.hostingBinding?.codexContext ? createCodexRouting(client.hostingBinding) : undefined;
const probe = createContextProbe();


const tools = [
  ['view.status', 'Read bounded View and workspace status without starting View.', z.object({}).strict()],
  ['asset.inspect', 'Inspect one trusted Pack authoring source in the project returned by View status. A .pack.ts source can execute top-level code.', z.object({ subject: z.string().min(1).max(2048), projectId: z.string().min(1).max(256).optional() }).strict()],
  ['view.workspace.pack.reveal', 'Focus one Pack source in one View page and wait for a visible receipt.', z.object({
      projectId: z.string().min(1).max(256), sourcePath: z.string().min(1).max(2048), revision: z.string().min(1).max(128),
      packageId: z.string().min(1).max(128).optional(), connectionId: z.string().min(1).max(128).optional(),
    }).strict()],
  ['engine.asset.inspect', 'Inspect one published asset GUID in an exact Engine project target.', z.object({
    guid: z.string().min(1).max(128), projectId: z.string().min(1).max(256), targetId: z.string().min(1).max(128),
  }).strict()],
  ['engine.scene.tree.get', 'Read a bounded page of the exact target scene tree.', z.object({
    targetId: z.string().min(1).max(128), targetGeneration: z.number().int().positive(),
    offset: z.number().int().nonnegative().max(1_000_000).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    revision: z.number().int().nonnegative().optional(),
  }).strict()],
  ['engine.entity.inspect', 'Inspect one entity on the exact target generation.', z.object({
    targetId: z.string().min(1).max(128), targetGeneration: z.number().int().positive(),
    entityId: z.string().min(1).max(128),
  }).strict()],
];

void serveStdio(() => {
  const server = new McpServer({ name: MCP_SERVERS.tools, version: APP_VERSION });
  for (const [operation, description, inputSchema] of tools) {
    server.registerTool(operationMcpName(operation), { description, inputSchema,
      annotations: { readOnlyHint: operation !== 'asset.inspect' && operation !== 'view.workspace.pack.reveal' } }, async (args, context) => {
      void probe.record('business-tool', { contextKeys: Object.keys(context), request: context.mcpReq });
      let result;
      try {
        result = routing ? await routing.request(operation, args, context.mcpReq._meta, context.mcpReq.signal)
          : await client.request(operation, args, context.mcpReq.signal);
      } catch (error) {
        result = { ok: false, error: { code: 'view-context-unavailable',
          expected: 'an exact Codex working directory for this request', hint: error.message } };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: !result.ok };
    });
  }
  return server;
});
bindStdioLifetime(() => routing?.close(), { watchParent: Boolean(client.hostingBinding?.codexContext) });
