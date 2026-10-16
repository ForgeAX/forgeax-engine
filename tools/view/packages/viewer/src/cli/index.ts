import type { ViewCliOptions, ViewCliCapabilities } from '../config.ts';
import plugins from '@forgeax/view-plugin-plugins';

export const VIEW_CLI_CONTRIBUTION_ID = 'forgeax.view.cli';

/** Domain descriptions come from the connected Engine capability owner. */
export function createViewCliContributions(options: ViewCliOptions = {}) {
  const capabilities = options.capabilities as ViewCliCapabilities | undefined;
  const descriptions = capabilities?.descriptions ?? [];
  const domain = descriptions.filter(item => item.id !== 'workspace.get').map(description => ({
    id: `view.workspace.${description.id}`,
    path: ['view', 'workspace', ...description.id.split('.')],
    summary: description.summary, operation: description.id,
  }));
  const operations: readonly string[] = capabilities?.operations ?? (Array.isArray(options.capabilities) ? options.capabilities : []);
  return Object.freeze([...domain, ...plugins.cliContributions.filter(item => operations.includes(item.operation))]);
}
