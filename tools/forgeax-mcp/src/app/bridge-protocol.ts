import { McpUiMessageRequestSchema, type App } from '@modelcontextprotocol/ext-apps';
import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';

// The base SDK schema strips extension metadata from message params. Preserve
// that envelope across our nested bridges, including openai/message.send=false.
export const conversationMessageSchema = McpUiMessageRequestSchema.extend({
  params: McpUiMessageRequestSchema.shape.params.passthrough(),
});
export function relayConversation(bridge: AppBridge, app: App) {
  bridge.setRequestHandler(conversationMessageSchema, (request, extra) =>
    app.sendMessage(request.params, { signal: extra.signal }),
  );
}
