/** Open service vocabulary projected onto Cordis Context by capability packages. */
import type { ToolApi } from '@forgeax/engine-tool-runtime';

export interface EngineContextServices {
  toolApi?: ToolApi;
}

declare module '@deepseek-ai/cordis' {
  interface Context extends EngineContextServices {}
}

export * from '@deepseek-ai/cordis';
export * from './asset.js';
export { createContextCapabilityResolver } from './capability.js';
export * from './register-tools.js';
export * from './startup.js';
export { createToolApiPlugin, TOOL_API_SERVICE } from './tool-api.js';
