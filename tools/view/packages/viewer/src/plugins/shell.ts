import type { Context } from '@forgeax/engine-plugin';
import type { ViewFrontendConfig } from '../config.ts';
import { SHELL_PLUGIN_ID } from './shell-identity.ts';
export { SHELL_PLUGIN_ID, SHELL_MODULE } from './shell-identity.ts';

/** The library borrows UI hosts; only the explicit embedded owner mounts React. */
export default {
  name: SHELL_PLUGIN_ID,
  async apply(ctx: Context, config: ViewFrontendConfig = {}) {
    const shell = config.embeddedShell ??
      (config.embedded === true ? (await import('../shell/embedded.tsx')).default : undefined);
    if (shell) {
      const fiber = await ctx.plugin(shell, config);
      await fiber?.await?.();
    }
  },
};
