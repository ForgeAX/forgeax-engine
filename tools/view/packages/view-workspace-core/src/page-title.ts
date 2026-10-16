import type { WorkspaceState } from './contract.ts';
import type { WorkspaceStateClient } from './workspace-state.ts';
import { createWorkspaceStateReader } from './workspace-state.ts';

/**
 * Live title for the editor page. The Host workspace snapshot is the SSOT:
 * when a preview/scene is bound, the tab shows that asset's name. The page
 * type's titleKey remains the idle fallback — this helper never invents a
 * static label, so the shell stays decoupled from scene vocabulary.
 *
 * @param {unknown} state
 * @returns {string | undefined}
 */
export function editorPageTitleFromWorkspace(state: WorkspaceState | null | undefined) {
  const asset = state && typeof state === 'object' ? state.preview?.asset : undefined;
  if (!asset || typeof asset !== 'object') return undefined;
  for (const candidate of [asset.name, asset.label]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

/**
 * Page controller matching forgeax-interface: `getTitle()` reads now,
 * `subscribeTitle()` fires when the workspace snapshot changes. No polling,
 * and ViewerShell does not read preview.asset itself.
 *
 * @param {unknown} client
 */
export function createEditorPageTitleController(client: WorkspaceStateClient | undefined) {
  const reader = createWorkspaceStateReader(client);
  return Object.freeze({
    getTitle() {
      return editorPageTitleFromWorkspace(reader.getSnapshot());
    },
    subscribeTitle(listener: () => void) {
      return reader.subscribe(listener);
    },
    dispose() {
      reader.dispose();
    },
  });
}
