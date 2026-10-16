import { defineWorkspaceOperations } from '@forgeax/view-workspace-core/tool-runtime';

export const PLUGINS_OPERATION_DESCRIPTIONS = defineWorkspaceOperations([
  { id: 'plugins.sources', summary: 'List observable View plugin sources.' },
  { id: 'plugins.inspect', summary: 'Inspect a View plugin source.' },
  { id: 'plugins.watch', summary: 'Watch a View plugin source.' },
]);
