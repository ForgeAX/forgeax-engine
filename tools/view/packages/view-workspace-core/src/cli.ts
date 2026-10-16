import { VIEW_WORKSPACE_CORE_OPERATION_DESCRIPTIONS } from './api.ts';

export const workspaceCoreCliContributions = Object.freeze(
  VIEW_WORKSPACE_CORE_OPERATION_DESCRIPTIONS.map((description) => ({
    id: `view.workspace.${description.id}`,
    path: ['view', 'workspace', ...description.path],
    summary: description.summary,
    operation: description.id,
  })),
);
