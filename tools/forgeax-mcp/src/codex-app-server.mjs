import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenAIExtensions, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { createBridgeClient } from './client.mjs';
import { createViewAppServer } from './app/mcp-server.mjs';
const client = await createBridgeClient(process.argv[2]);
const app = createViewAppServer(client, {
  artifactRoot: new URL('../dist/', import.meta.url),
  viewDocument: 'codex-view.html',
  resourceMetadata: {
    'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' },
  },
  toolMetadata: {
    'openai/ui': OpenAIUiToolMetadataSchema.parse({
      entrypoints: [{ type: 'global' }, { type: 'thread' }],
      preferredModelDisplayMode: 'fullscreen',
    }),
  },
});
new OpenAIExtensions(app.server);
process.stdin.once('end', () => {
  void app.close();
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
await app.server.connect(new StdioServerTransport());
