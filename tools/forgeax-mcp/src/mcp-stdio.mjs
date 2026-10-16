#!/usr/bin/env node
import { createBridgeClient } from './client.mjs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { operationMcpName } from '@forgeax/engine-tool-runtime';
import { APP_VERSION, MCP_SERVERS } from './contract.ts';

const rootArg = process.argv[2];
if (!rootArg) {
  console.error('Usage: node mcp-stdio.mjs <exact-project-root>');
  process.exit(2);
}
const { request } = await createBridgeClient(rootArg);


const tools = [
  ['view.status', 'Read bounded View and workspace status without starting View.', z.object({}).strict()],
  ['asset.inspect', 'Inspect one trusted Pack authoring source in a bounded child process. A .pack.ts source can execute top-level code.', z.object({ subject: z.string().min(1).max(2048) }).strict()],
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
      const result = await request(operation, args, context.mcpReq.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: !result.ok };
    });
  }
  return server;
});
