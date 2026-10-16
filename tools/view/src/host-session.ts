import type { Browser, Page } from 'playwright';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
type ShellHost = { close?: () => Promise<void> };
type ViewSessionHost = { workspaceEndpoint: string; workspaceAccessToken: string; dispose?: () => Promise<void> };
type MountedShell = { state?: WorkspaceState; shell?: { openProject(root: string): Promise<WorkspaceState> }; api?: Pick<ViewWorkspaceClient, 'openProject'>; dispose?: () => Promise<void> };
export type ViewWorkspaceSessionDependencies = {
  startShell(): Promise<ShellHost>;
  launchBrowser(): Promise<Pick<Browser, 'newPage' | 'close'>>;
  startView(input: { page: Page; allowWrites: boolean }): Promise<ViewSessionHost>;
  mountShell(input: { page: Page; shell: ShellHost; endpoint: string; token: string }): Promise<MountedShell>;
};
/**
 * Lifecycle authority for a single visible View workspace. Dependencies are
 * supplied by the host executable so View itself never launches a browser or
 * implements Engine project loading.
 */
export async function openViewWorkspaceSession(deps: ViewWorkspaceSessionDependencies, { projectRoot, allowWrites = false }: { projectRoot?: string; allowWrites?: boolean } = {}) {
  if (!projectRoot) throw new TypeError('View workspace session requires projectRoot');
  let shell: ShellHost | undefined;
  let browser: Pick<Browser, 'newPage' | 'close'> | undefined;
  let view: ViewSessionHost | undefined;
  let mounted: MountedShell | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await mounted?.dispose?.().catch(() => {});
    await view?.dispose?.().catch(() => {});
    await browser?.close?.().catch(() => {});
    await shell?.close?.().catch(() => {});
  };
  try {
    shell = await deps.startShell();
    browser = await deps.launchBrowser();
    const page = await browser.newPage();
    view = await deps.startView({ page, allowWrites });
    mounted = await deps.mountShell({
      page,
      shell,
      endpoint: view.workspaceEndpoint,
      token: view.workspaceAccessToken,
    });
    // A browser-owned shell performs project.open from the page that owns the
    // View client. Older host adapters return that client to this lifecycle.
    // Accept either form, but never open the same project twice.
    const state =
      mounted?.state ??
      (typeof mounted?.shell?.openProject === 'function'
        ? await mounted.shell.openProject(projectRoot)
        : undefined) ??
      (await mounted?.api?.openProject?.(projectRoot, { tabId: 'forgeax-user-workspace' }));
    if (!state?.project) {
      throw new TypeError('View shell must return an opened project state or workspace API');
    }
    return Object.freeze({ state, close });
  } catch (error) {
    await close();
    throw error;
  }
}
