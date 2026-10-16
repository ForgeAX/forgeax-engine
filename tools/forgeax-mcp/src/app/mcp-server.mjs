import { APP_VERSION, HTTP_BATCH_SIZE, MCP_SERVERS, VIEW_TITLE, TRANSPORT_TOOL, OPEN_TOOL, UI_URI } from '../contract.ts';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createViewService } from './service.mjs';

/** App-only bytes and Host protocol adapt the same public View/Engine owners. */
export function createViewAppServer(
  client,
  {
    artifactRoot = new URL('../../dist/', import.meta.url),
    viewDocument = 'full-view.html',
    resourceMetadata = {},
    toolMetadata = {},
  } = {},
) {
  const service = createViewService(client, { artifactRoot, viewDocument });
  const server = new McpServer({ name: MCP_SERVERS.view, version: APP_VERSION });
  const metadata = {
    ui: {
      prefersBorder: false,
      permissions: { clipboardWrite: {} },
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
    },
    ...resourceMetadata,
  };
  registerAppResource(server, VIEW_TITLE, UI_URI, { _meta: metadata }, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(new URL('carrier.html', artifactRoot), 'utf8'),
        _meta: metadata,
      },
    ],
  }));
  registerAppTool(
    server,
    OPEN_TOOL,
    {
      title: VIEW_TITLE,
      description:
        'Start the optional View presentation on the selected public backend and open its interface.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI, visibility: ['model', 'app'] }, ...toolMetadata },
    },
    async () => {
      const opened = await service.open();
      return {
        content: [{ type: 'text', text: 'ForgeaX View is ready.' }],
        structuredContent: opened,
      };
    },
  );
  const common = {
    url: z.string().optional(),
    resourceId: z.string().optional(),
    offset: z.number().int().nonnegative().optional(),
    connectionId: z.string().optional(),
    connectionIds: z.array(z.string()).max(12).optional(),
    requestId: z.string().optional(),
    service: z.string().optional(),
    topic: z.string().optional(),
    payload: z.unknown().optional(),
    generation: z.number().int().optional(),
    kind: z.enum(['module', 'worker']).optional(),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    program: z.unknown().optional(),
    bindingId: z.string().uuid().optional(),
    imports: z.record(z.string(), z.object({ identity: z.string(), url: z.string() }).strict()).optional(),
    exports: z.record(z.string(), z.array(z.string()).max(2048)).optional(),
    requests: z.array(z.object({
      action: z.literal('http'), url: z.string(), method: z.enum(['GET', 'HEAD']),
      headers: z.record(z.string(), z.string()),
    }).strict()).min(1).max(HTTP_BATCH_SIZE).optional(),
  };
  registerAppTool(
    server,
    TRANSPORT_TOOL,
    {
      title: 'View platform transport',
      description:
        'Deliver bytes and authenticated public Host messages for the selected View and its admitted project targets.',
      inputSchema: z
        .object({
          action: z.enum([
            'view-document',
            'document',
            'http',
            'http-batch',
            'chunk',
            'host-open',
            'host-request',
            'host-cancel',
            'host-subscribe',
            'host-unsubscribe',
            'host-read',
            'host-close',
            'bundle',
            'program',
          ]),
          ...common,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args, extra) => ({
      content: [{ type: 'text', text: 'View transport result' }],
      structuredContent: await service.invoke(args, { signal: extra.signal }),
    }),
  );
  server.server.onclose = () => service.close();
  return {
    server,
    close: () => {
      service.close();
      return server.close();
    },
  };
}
