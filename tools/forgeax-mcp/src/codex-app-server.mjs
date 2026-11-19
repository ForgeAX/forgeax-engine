import { bindStdioLifetime } from './stdio-lifetime.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenAIExtensions, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { createBridgeClient } from './client.mjs';
import { createViewAppServer } from './app/mcp-server.mjs';
import { createAppHosting } from './app/hosting.mjs';
import { createCodexRouting } from './codex-routing.mjs';
import { createViewService } from './app/service.mjs';
import { codexFileEntry } from './codex-file-entry.mjs';
import { codexResourceCard } from './codex-resource-card.mjs';
const client = await createBridgeClient(process.argv[2]);
const routing = client.hostingBinding?.codexContext ? createCodexRouting(client.hostingBinding, {
  createPresentation: (selectedClient, binding, directory) => createViewService(selectedClient, {
    artifactRoot: new URL('../dist/', import.meta.url), viewDocument: 'codex-view.html',
    hosting: createAppHosting(binding, { initialProject: directory }),
  }),
}) : undefined;
const app = createViewAppServer(client, {
  artifactRoot: new URL('../dist/', import.meta.url),
  viewDocument: 'codex-view.html',
  fileEntry: codexFileEntry,
  resourceCard: codexResourceCard,
  ...(routing ? { routing } : client.hostingBinding ? { hosting: createAppHosting(client.hostingBinding) } : {}),
  resourceMetadata: {
    'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' },
  },
  ...(!routing ? { toolMetadata: {
    'openai/ui': OpenAIUiToolMetadataSchema.parse({
      entrypoints: [{ type: 'global' }, { type: 'thread' }],
      preferredModelDisplayMode: 'fullscreen',
    }),
  } } : {}),
  ...(routing ? { entryMetadata: scope => ({
    'openai/ui': OpenAIUiToolMetadataSchema.parse({
      entrypoints: [{ type: scope === 'global' ? 'global' : 'thread' }],
      preferredModelDisplayMode: 'fullscreen',
    }),
  }) } : {}),
});
new OpenAIExtensions(app.server);
bindStdioLifetime(() => app.close(), { watchParent: Boolean(client.hostingBinding?.codexContext) });
await app.server.connect(new StdioServerTransport());
