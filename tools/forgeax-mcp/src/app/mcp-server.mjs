import { APP_VERSION, HTTP_BATCH_SIZE, MCP_SERVERS, VIEW_TITLE, TRANSPORT_TOOL, OPEN_TOOL, UI_URI, GLOBAL_OPEN_TOOL, GLOBAL_UI_URI, BIND_TOOL, RESOURCE_ACTION_TOOL } from '../contract.ts';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createViewService } from './service.mjs';
import { createContextProbe } from '../context-probe.mjs';

function viewAppEntries(routing, fileEntry, resourceCard) {
  const entries = routing
    ? [{ scope: 'workspace', tool: OPEN_TOOL, uri: UI_URI }, { scope: 'global', tool: GLOBAL_OPEN_TOOL, uri: GLOBAL_UI_URI }]
    : [{ scope: 'workspace', tool: OPEN_TOOL, uri: UI_URI }];
  if (fileEntry) entries.push({ ...fileEntry, scope: 'workspace', file: true });
  if (resourceCard) {
    for (const slot of [resourceCard, ...(resourceCard.slots ?? [])])
      entries.push({ ...resourceCard, ...slot, scope: 'workspace', card: true, direct: false });
    if (resourceCard.direct) entries.push({ ...resourceCard.direct, scope: 'workspace', card: true, direct: true });
  }
  return entries;
}

/** App-only bytes and Host protocol adapt the same public View/Engine owners. */
export function createViewAppServer(
  client,
  {
    artifactRoot = new URL('../../dist/', import.meta.url),
    viewDocument = 'full-view.html',
    resourceMetadata = {},
    toolMetadata = {},
    hosting,
    routing,
    entryMetadata,
    fileEntry,
    resourceCard,
  } = {},
) {
  const service = createViewService(client, { artifactRoot, viewDocument, hosting });
  const server = new McpServer({ name: MCP_SERVERS.view, version: APP_VERSION });
  const probe = createContextProbe();
  let rootsRecorded = false;
  const probeRequest = async (event, extra) => {
    if (!probe.enabled) return;
    await probe.record(event, { meta: extra?._meta, capabilities: server.server.getClientCapabilities() });
    if (rootsRecorded || !server.server.getClientCapabilities()?.roots) return;
    rootsRecorded = true;
    try {
      await probe.record('workspace-roots', await server.server.listRoots(undefined, { timeout: 3000 }));
    } catch (error) {
      await probe.record('workspace-roots-unavailable', { code: String(error.code ?? 'unknown') });
    }
  };
  const metadata = {
    ui: {
      prefersBorder: false,
      permissions: { clipboardWrite: {} },
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
    },
    ...resourceMetadata,
  };
  const entries = viewAppEntries(routing, fileEntry, resourceCard);
  for (const entry of entries) {
    const entryResourceMetadata = entry.card ? { ...metadata,
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: entry.direct ? 'fullscreen' : 'inline' },
      // Codex applies its 200px default unless the resource supplies this floor.
      // Intrinsic size notifications still own loading, errors and wrapped cards.
      ...(!entry.direct ? { 'openai/widgetMinFrameHeight': 0, 'openai/widgetHeightHint': 48 } : {}),
    } : metadata;
    registerAppResource(server, VIEW_TITLE, entry.uri, { _meta: entryResourceMetadata }, async (_uri, extra) => {
      void probeRequest('resource-read', extra);
      return {
        contents: [
          {
            uri: entry.uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: (await readFile(new URL('carrier.html', artifactRoot), 'utf8'))
              .replace('__FX_VIEW_ENTRY_SCOPE__', JSON.stringify(entry.scope))
              .replace('__FX_VIEW_ENTRY_KIND__', JSON.stringify(entry.direct ? 'resource-view' : entry.card ? 'card' : entry.file ? 'file' : 'view')),
            _meta: entryResourceMetadata,
          },
        ],
      };
    });
    registerAppTool(
      server,
      entry.tool,
      {
        title: VIEW_TITLE,
        description: entry.card
          ? entry.direct
            ? 'Show a specified asset source in ForgeAX View with initial fullscreen preference. Uses this App, not file or global navigation.'
            : `Show inline ForgeAX asset buttons in card slot ${entry.tool}. For three independent cards, call forgeax_view_resource_card, forgeax_view_resource_card_2 and forgeax_view_resource_card_3 once each with one path. Repeated calls to the same slot share its native App; several paths group buttons in that slot. Clicking selects the resource in the existing chat View; opens this App only when no View is available. Optional prepareBackend warms the same chat backend. The host owns card placement and panel reuse.`
          : 'Open ForgeAX View immediately; its interface discovers and prepares the selected Engine backend.',
        inputSchema: entry.card ? entry.inputSchema : entry.file ? fileEntry.inputSchema
          : resourceCard && entry.scope === 'workspace' ? z.object({
            assetSource: z.object({ path: z.string().min(1).max(2048) }).strict().optional(),
          }).strict() : z.object({}).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: entry.uri, visibility: entry.file || entry.scope === 'global' ? ['app'] : ['model', 'app'] },
          ...(entry.card ? entry.metadata : entry.file ? fileEntry.metadata : entryMetadata ? entryMetadata(entry.scope) : toolMetadata) },
      },
      async (args, extra) => {
        // File entry callbacks only admit static UI. The mounted carrier's
        // document request acquires the same trusted chat route as normal View.
        if (entry.file) return { content: [], structuredContent: args };
        if (entry.card) {
          const result = await entry.prepare(args, extra.signal);
          if (result.isError || !args.prepareBackend) return result;
          const selected = routing ? await routing.route(entry.scope, extra?._meta) : undefined;
          await (selected?.service ?? service).prepare(extra.signal);
          return result;
        }
        if (args.assetSource) {
          const result = await resourceCard.resolve(args.assetSource.path, extra.signal);
          if (!result.ok) return { isError: true, content: [{ type: 'text', text: result.error.hint }], structuredContent: result };
        }
        void probeRequest('view-open', extra);
        const selected = routing ? await routing.route(entry.scope, extra?._meta) : undefined;
        const opened = await (selected?.service ?? service).open();
        return {
          content: [{ type: 'text', text: 'ForgeAX View is open. Backend and project readiness are shown in the interface.' }],
          structuredContent: opened,
        };
      },
    );
  }
  if (resourceCard) registerAppTool(server, RESOURCE_ACTION_TOOL, {
    title: 'Select a ForgeAX asset source',
    description: 'Select a source in the existing chat View, or return admission for the initial View page.',
    inputSchema: z.object({ path: z.string().min(1).max(2048), appDocumentId: z.string().uuid(), entryScope: z.literal('workspace'), displayMode: z.enum(['inline', 'fullscreen']), reuse: z.boolean().default(true), cancel: z.boolean().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ path, ...input }, extra) => {
    const resolved = input.cancel ? undefined : await resourceCard.resolve(path, extra.signal);
    if (resolved && !resolved.ok) return { isError: true, content: [{ type: 'text', text: resolved.error.hint }], structuredContent: resolved };
    const args = { ...input, action: 'source-select', sourcePath: path };
    const options = { signal: extra.signal, sourceContext: () => resolved };
    const result = await (routing ? routing.invoke(args, extra?._meta, options) : service.invoke(args, options));
    return { ...(result.ok ? {} : { isError: true }),
      content: result.ok ? [] : [{ type: 'text', text: result.error.hint }], structuredContent: result };
  });
  if (routing) server.registerTool(BIND_TOOL, {
    title: 'Bind this chat View workspace',
    description: 'Persistently select an absolute workspace directory on this chat’s fixed backend instance. Chat identity comes from the host. Existing pages retire and reconnect automatically; other chats and global View retain their instances.',
    inputSchema: z.object({ directory: z.string().min(1).max(2048) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      const value = await routing.bind(args.directory, extra?._meta, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { ok: true, value } };
    } catch (error) {
      const result = { ok: false, error: { code: 'view-binding-failed', hint: error.message } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });
  const common = {
    appDocumentId: z.string().uuid().optional(),
    entryScope: z.enum(['workspace', 'global']).optional(),
    url: z.string().optional(),
    project: z.string().min(1).max(2048).optional(),
    sourcePath: z.string().min(1).max(2048).optional(),
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
    hostContext: z.unknown().optional(),
    displayMode: z.enum(['inline', 'fullscreen']).optional(),
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
            ...(fileEntry ? ['file-context'] : []),
            ...(resourceCard ? ['source-context'] : []),
            'context-probe',
            'binding-read',
            'app-close',
            'app-context',
            'backend-start',
            'document',
            'document-cancel',
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
    async (args, extra) => {
      if (args.action === 'context-probe') {
        await probeRequest('app-transport', extra);
        await probe.record('app-host-context', args.hostContext);
        return { content: [], structuredContent: {} };
      }
      if (args.action === 'view-document') void probeRequest('view-document', extra);
      const options = { signal: extra.signal,
        ...(resourceCard ? { sourceContext: () => resourceCard.resolve(args.sourcePath, extra.signal) } : {}),
        ...(fileEntry ? { fileContext: () => fileEntry.resolve(extra?._meta, extra.signal) } : {}) };
      return {
        content: [{ type: 'text', text: 'View transport result' }],
        structuredContent: await (routing ? routing.invoke(args, extra?._meta, options) : service.invoke(args, options)),
      };
    },
  );
  let closing;
  const closeServices = () => closing ??= (async () => { try { await service.close(); } finally { await routing?.close(); } })();
  server.server.onclose = () => { void closeServices().catch(error => { console.error(error); process.exitCode = 1; }); };
  return {
    server,
    close: async () => {
      await closeServices();
      return server.close();
    },
  };
}
