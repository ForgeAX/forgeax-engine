import { operationMcpName } from '@forgeax/engine-tool-runtime';
export const APP_VERSION = '0.4.8';
export const HTTP_BATCH_SIZE = 16;
export const MCP_SERVERS = { tools: 'forgeax-tools', view: 'forgeax-view' } as const;
export const VIEW_TITLE = 'ForgeAX View';
export const TRANSPORT_TOOL = 'forgeax_view_transport';
export const OPEN_TOOL = operationMcpName('view.start');
export const GLOBAL_OPEN_TOOL = 'forgeax_view_global_start';
export const BIND_TOOL = 'forgeax_view_workspace_bind';
export const UI_URI = `ui://forgeax/view.html?version=${APP_VERSION}`;
export const GLOBAL_UI_URI = `ui://forgeax/global-view.html?version=${APP_VERSION}`;
export const FILE_OPEN_TOOL = 'forgeax_view_file_open';
export const FILE_UI_URI = `ui://forgeax/file.html?version=${APP_VERSION}`;
export const FILE_EXTENSIONS = ['.pack.json', '.pack.ts'] as const;
export const RESOURCE_CARD_TOOL = 'forgeax_view_resource_card';
export const RESOURCE_ACTION_TOOL = 'forgeax_view_resource_select';
export const RESOURCE_CARD_URI = `ui://forgeax/resource-card.html?version=${APP_VERSION}`;
/** Distinct static resources prevent native chat from merging the three card slots. */
export const RESOURCE_CARD_SLOTS = [
  { tool: RESOURCE_CARD_TOOL, uri: RESOURCE_CARD_URI },
  { tool: `${RESOURCE_CARD_TOOL}_2`, uri: `ui://forgeax/resource-card-2.html?version=${APP_VERSION}` },
  { tool: `${RESOURCE_CARD_TOOL}_3`, uri: `ui://forgeax/resource-card-3.html?version=${APP_VERSION}` },
] as const;
export const RESOURCE_VIEW_TOOL = 'forgeax_view_resource_open';
export const RESOURCE_VIEW_URI = `ui://forgeax/resource-view.html?version=${APP_VERSION}`;

/** Native program import namespace lease shared by the compiler and document adapter. */
export const PROGRAM_IMPORTS_SLOT = 'forgeax.mcp.program-imports';

/** Execute outside compiled modules so remote import rewriting cannot wrap this native loader. */
export const MCP_NATIVE_IMPORT_SOURCE = 'globalThis.__fxMcpImport = (url) => import(url);';

/** Adapter-owned source requests reuse admitted Host event queues. */
export const SOURCE_OPEN_TOPIC = 'forgeax.mcp.source.open';
export const SOURCE_REPLY_SERVICE = 'forgeax.mcp.source.reply';
