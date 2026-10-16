import type { ViewCliOptions } from '@forgeax/view-viewer/config';
import { contract } from './commands.ts';
import {
  createViewCliContributions as createProductCliContributions,
  VIEW_CLI_CONTRIBUTION_ID,
} from '@forgeax/view-viewer/cli';

import { runViewProjectOpen } from './view-project-open.ts';
import {
  runViewStartInteractive,
  runViewStatus,
  runViewStop,
} from './view-start.ts';
import { workspaceCoreCliContributions } from '@forgeax/view-workspace-core/cli';

export { VIEW_CLI_CONTRIBUTION_ID };

export function createViewHostCliContributions() {
  const executors = {
    start: runViewStartInteractive,
    status: runViewStatus,
    stop: runViewStop,
    projectOpen: runViewProjectOpen,
  };
  return Object.freeze(contract.commands.map(command => ({
    id: command.id, path: command.path, summary: command.summary, ...('exportName' in command ? { run: executors[command.exportName] } : {}),
  })));
}

function hasWorkspaceCapabilities(options?: ViewCliOptions) {
  return Array.isArray(options?.capabilities) || (options?.capabilities !== undefined && 'operations' in options.capabilities && Array.isArray(options.capabilities.operations));
}

function filterCapabilities(contributions: typeof workspaceCoreCliContributions, options?: ViewCliOptions) {
  const declared = Array.isArray(options?.capabilities)
    ? options.capabilities
    : options?.capabilities && 'operations' in options.capabilities ? options.capabilities.operations : undefined;
  if (!Array.isArray(declared)) return contributions;
  const operations = new Set(declared);
  return contributions.filter(({ operation }) => operations.has(operation));
}

/** Compose package lifecycle and explicitly active workspace/product commands. */
export function createViewCliContributions(options?: ViewCliOptions) {
  return Object.freeze([
    ...createViewHostCliContributions(),
    ...(hasWorkspaceCapabilities(options)
      ? filterCapabilities(workspaceCoreCliContributions, options)
      : []),
    ...createProductCliContributions(options),
  ]);
}
