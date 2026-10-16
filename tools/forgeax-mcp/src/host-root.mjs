import viewProduct from '@forgeax/view/plugin';
import mcpBridge from './bridge.mjs';

export default {
  name: 'forgeax.mcp.view.host',
  apply(ctx) {
    // Cordis owns both child Fibers. Awaiting their activation inside this
    // parent apply would deadlock the native startup barrier.
    ctx.plugin(viewProduct);
    ctx.plugin(mcpBridge);
  },
};
