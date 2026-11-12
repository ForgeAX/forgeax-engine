import { operationMcpName } from '@forgeax/engine-tool-runtime';
export const APP_VERSION = '0.4.8';
export const HTTP_BATCH_SIZE = 16;
export const MCP_SERVERS = { tools: 'forgeax-tools', view: 'forgeax-view' } as const;
export const VIEW_TITLE = 'ForgeAX View';
export const TRANSPORT_TOOL = 'forgeax_view_transport';
export const OPEN_TOOL = operationMcpName('view.start');
export const UI_URI = `ui://forgeax/view.html?version=${APP_VERSION}`;

/** Native program import namespace lease shared by the compiler and document adapter. */
export const PROGRAM_IMPORTS_SLOT = 'forgeax.mcp.program-imports';

/** Execute outside compiled modules so remote import rewriting cannot wrap this native loader. */
export const MCP_NATIVE_IMPORT_SOURCE = 'globalThis.__fxMcpImport = (url) => import(url);';
