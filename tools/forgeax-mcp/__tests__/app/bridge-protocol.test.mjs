import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpUiMessageRequestSchema } from '@modelcontextprotocol/ext-apps';
import { conversationMessageSchema } from '../../src/app/bridge-protocol.ts';
test('nested AppBridge retains draft-only behavior and the titled reference', () => {
  const request = {
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text: 'Asset GUID', _meta: { 'openai/title': 'scene/showcase' } }],
      _meta: { 'openai/message': { target: 'active', send: false } },
    },
  };
  assert.equal(McpUiMessageRequestSchema.parse(request).params._meta, undefined);
  assert.deepEqual(conversationMessageSchema.parse(request), request);
});
