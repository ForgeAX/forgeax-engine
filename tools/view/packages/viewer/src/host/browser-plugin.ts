import type { Context } from '@forgeax/engine-plugin';
import type { ViewFrontendConfig } from '../config.ts';
import { createViewWorkspaceClient } from '@forgeax/view-workspace-core/client';

export function resolveSlotRegistry(ctx: Context, config: ViewFrontendConfig) {
  return (
    config.viewSlotRegistry ??
    ctx.get?.('viewSlotRegistry', false) ??
    globalThis.__forgeaxViewSlotRegistry
  );
}

export function createWorkspaceClient(ctx: Context, config: ViewFrontendConfig) {
  const transport = ctx.get?.('hostTransport', false);
  const workspaceConfig = config.workspace;
  if (!transport || !('request' in transport) || !workspaceConfig?.clientId || !workspaceConfig?.token) return undefined;
  return createViewWorkspaceClient({
    transport,
    clientId: workspaceConfig.clientId,
    token: workspaceConfig.token,
  });
}
