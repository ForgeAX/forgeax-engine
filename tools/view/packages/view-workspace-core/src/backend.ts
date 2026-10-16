import type { Context } from '@forgeax/engine-plugin';
import type { ToolContribution } from '@forgeax/engine-tool-runtime';
import type { BrokerOptions, WorkspaceAuthorization } from './broker.ts';
export type WorkspaceBackendConfig = { workspaceAccessToken?: string; workspaceAuthorize?: WorkspaceAuthorization; packSources?: BrokerOptions['packSources'] };
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewWorkspaceCore: ViewWorkspaceBroker; viewWorkspaceAccessToken: string; } }
import { ViewWorkspaceBroker } from './broker.ts';
import { registerTools } from '@forgeax/engine-plugin';
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { VIEW_WORKSPACE_OPERATIONS, createWorkspaceRequest } from './contract.ts';
import { createWorkspaceToolContributions, defineWorkspaceOperations, workspaceToolValue } from './tool-runtime.ts';

export const VIEW_WORKSPACE_CORE_PLUGIN_ID = 'forgeax.view.service.workspace.backend';
export const VIEW_WORKSPACE_CORE_MODULE = '@forgeax/view-workspace-core/backend';

export const viewWorkspaceCoreBackendPlugin = {
  name: VIEW_WORKSPACE_CORE_PLUGIN_ID,
  inject: ['toolApi'],
  provide: ['viewWorkspaceCore', 'viewWorkspaceAccessToken'],
  apply(ctx: Context, config: WorkspaceBackendConfig = {}) {
    const workspace = new ViewWorkspaceBroker({
      engine: ctx.get?.('engineWorkspace', false),
      engineForCaller: ctx.get?.('engineWorkspaceForCaller', false),
      toolApi: ctx.get?.('toolApi', false),
      display: caller => ctx.get?.('viewStatus', false)?.(caller),
      accessToken: config.workspaceAccessToken,
      authorize: config.workspaceAuthorize,
      packSources: config.packSources,
    });
    const toolApi = ctx.get?.('toolApi', false);
    const operations = defineWorkspaceOperations(VIEW_WORKSPACE_OPERATIONS.map(operation => ({
      id: `view.workspace.${operation}`,
      operation,
    })));
    const tools: ToolContribution[] = createWorkspaceToolContributions(workspace, operations);
    tools.push(defineTool({
      id: 'view.workspace.call', path: ['view', 'workspace', 'call'],
      title: 'Call View workspace API', summary: 'Call an operation on the running View workspace.',
      realm: 'host',
      argsSchema: toolJsonSchema({ type: 'object', properties: { operation: { type: 'string' }, args: { type: 'object' }, root: { type: 'string' } }, required: ['operation'], additionalProperties: false }),
      resultSchema: toolJsonSchema({}), inputSchema: { type: 'object' }, outputSchema: {}, evidence: [],
    }, async (input, context) => {
      const result = await workspace.call(createWorkspaceRequest((input as { operation: string }).operation, (input as { args?: Record<string, unknown> }).args ?? {}, {
        clientId: 'view-cli', token: workspace.accessToken,
      }), { signal: context.signal, caller: context.caller });
      return workspaceToolValue(result);
    }));
    const revokeTools = toolApi ? registerTools(ctx, tools, {
      sourceId: 'view-workspace', module: '@forgeax/view-workspace-core/backend', realm: 'host',
    }) : undefined;
    const connection = ctx.get?.('hostTransport', false);
    const transport = connection && 'register' in connection ? connection : undefined;
    const unregister = transport ? workspace.registerTransport(transport, {
      routeThroughTools: Boolean(revokeTools),
    }) : undefined;
    ctx.provide('viewWorkspaceCore', workspace);
    ctx.provide('viewWorkspaceAccessToken', workspace.accessToken);
    ctx.effect(() => async () => { unregister?.(); await revokeTools?.(); await workspace.dispose(); });
  },
};
export default viewWorkspaceCoreBackendPlugin;
