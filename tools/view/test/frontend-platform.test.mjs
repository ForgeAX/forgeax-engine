import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Context} from '@forgeax/engine-plugin';
import {createFrontendPlatformPlugin} from '@forgeax/engine-host/platform';

test('native Fiber replacement retains one platform owner and removal revokes its capability', async () => {
 const context=new Context();
 const browser={writeClipboard:async()=>{}};
 const hosted={writeClipboard:async()=>{}};
 for (const platform of [browser,hosted,browser]) {
  const fiber=context.plugin(createFrontendPlatformPlugin(platform));await fiber.await();
  assert.equal(fiber.ctx.get('frontendPlatform'),platform);
  await fiber.dispose();
  assert.equal(context.get('frontendPlatform',false),undefined);
 }
});
