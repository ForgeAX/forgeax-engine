// Browser acceptance composition; deliberately not a product startup API.
import { startView } from '../dist/modules/index.mjs';
import { VIEW_WORKSPACE_TAB_ID } from '../dist/modules/workspace/contract.mjs';

/** Await the product plugin mounted in the Engine-owned target document. */
export async function waitForLiveViewerShell(page, { timeout = 30_000 } = {}) {
  await page.waitForFunction(() => {
    const ready = globalThis.__forgeaxViewReady;
    if (ready?.error) throw new Error(ready.error);
    return ready?.mounted === true;
  }, undefined, { timeout });
}

/**
 * The embedding launcher supplies a Page. Native Host plugins own the backend,
 * project provider and frontend Shell; the generated page owns the only App.
 */
export async function startViewLiveIntegration({ page, projectRoot, config = {} } = {}) {
  if (!page || typeof page.goto !== 'function') {
    throw new TypeError('View requires an already-open owner Page');
  }
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw new TypeError('View requires a project root');
  }
  const { devKitWorkspacePlugin: workspacePlugin } = await import('@forgeax/engine/devkit');
  if (!workspacePlugin) throw new Error('The installed Engine does not expose devKitWorkspacePlugin; install the matching Engine SDK before opening a workspace.');
  const view = await startView({
    workspacePlugin,
    workspaceOptions: config.workspace,
    disabledPages: config.disabledPages,
    frontendConfig: { embedded: true, workspace: { resourceBrowser: true }, layout: { responsiveAutoTuck: false } },
    workspacePort: config.workspacePort ?? 0,
    frontend: false,
  });
  let disposePromise;
  let targetUrl;
  const dispose = () =>
    (disposePromise ??= (async () => {
      try {
        if (targetUrl && !page.isClosed() && page.url() === targetUrl) {
          await page.goto('about:blank');
        }
      } finally {
        await view.dispose();
      }
    })());
  try {
    const state = await view.workspaceCore.openProject({
      root: projectRoot,
      tabId: VIEW_WORKSPACE_TAB_ID,
    });
    const target = state.projectTarget;
    if (!target?.url) throw new Error('Engine did not publish its project target URL');
    targetUrl = target.url;
    await page.goto(target.url);
    await waitForLiveViewerShell(page, {
      timeout: config.readyTimeout ?? 120_000,
    });
    await view.workspaceCore.listAssets({
      projectId: state.project.id,
      tabId: VIEW_WORKSPACE_TAB_ID,
    });
    return Object.freeze({
      carrier: view.carrier,
      backendHost: view.backendHost,
      hostBinding: view.hostBinding,
      workspaceCore: view.workspaceCore,
      get pageWorkspace() {
        const pages = [...view.workspaceCore.pageSessions.values()];
        if (pages.length !== 1) throw new Error(`Expected one headed View page, found ${pages.length}`);
        return pages[0].broker;
      },
      target,
      connection: Object.freeze({
        endpoint: view.workspaceEndpoint,
        token: view.workspaceAccessToken,
        frontendEndpoint: view.workspaceFrontendEndpoint,
        frontendTicket: view.workspaceFrontendTicket,
      }),
      dispose,
    });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
