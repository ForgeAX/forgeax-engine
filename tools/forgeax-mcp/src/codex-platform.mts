import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { conversationMessageSchema } from './app/bridge-protocol';
import { createMcpViewPlugin } from './app/view-plugin';

/** Codex owns only its optional conversation draft capability. */
export const codexPlatformPlugin = createMcpViewPlugin('forgeax.view.platform.codex', (mcp) => {
  const extensions = new OpenAIExtensions(mcp.app);
  return {
    ...mcp,
    ...(extensions.message
      ? {
          addConversationReference: async ({ title, text }: { title: string; text: string }) => {
            // Keep the documented draft envelope through older extension parsers.
            const message = conversationMessageSchema.parse({
              method: 'ui/message',
              params: {
                role: 'user',
                content: [{ type: 'text', text, _meta: { 'openai/title': title } }],
                _meta: { 'openai/message': { target: 'active', send: false } },
              },
            });
            const result = await mcp.app.sendMessage(message.params);
            if (result.isError) throw new Error('Conversation reference was rejected by the host');
          },
        }
      : {}),
  };
});
