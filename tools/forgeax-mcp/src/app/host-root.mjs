import viewProduct from '@forgeax/view/plugin';
import mcpBridge from '../bridge.mjs';
import frontend from '../../dist/editor-manifest.mjs';

/** Build-owned immutable frontend identity survives Host program compilation. */
export default {
  name: 'forgeax.mcp.view.host',
  apply(ctx) {
    ctx.plugin(viewProduct, { frontend });
    ctx.plugin(mcpBridge);
  },
};
