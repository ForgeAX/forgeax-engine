import type { Context } from '@forgeax/engine-plugin';
import type { EngineWorkspacePresentation, EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { FrontendConfig, PanelHost } from '@forgeax/view-workspace-core/frontend-contract';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceInputOptions } from './workspace-shell.ts';
export type ViewportFrontendConfig = FrontendConfig & { presentation?: EngineWorkspacePresentation; targetPresentation?: EngineWorkspacePresentation; viewportSurface?: HTMLElement; workspace?: { mountId?: string } };
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    viewWorkspaceShell: ViewWorkspaceShell;
    viewPreviewInputController: (options: WorkspaceInputOptions) => ViewWorkspaceInputController;
  }
}
import { readEnginePresentation } from '@forgeax/view-workspace-core/engine-presentation';
import { createBrowserPagePresentation, ViewWorkspaceInputController, ViewWorkspaceShell } from './workspace-shell.ts';
import { PAGE_TYPE, PANEL_CLOSABLE, PANEL_LAYOUT, FRONTEND_PLUGIN_ID, SLOT, TITLE_I18N_KEY } from './identity.ts';
import { attachViewportRenderResizeSync } from './render-resize-sync.ts';
import { attachViewportPageInputGate } from './page-input-gate.ts';
import { mountPlayToolbar } from './play-toolbar.ts';
import { fitSceneSurface } from './scene-surface.ts';
import { viewPlayPresentationPlugin } from './play-presentation.ts';
import { attachEngineFatalBanner } from './engine-fatal-banner.ts';

function claimViewportPanel(panelHost: PanelHost) {
  return panelHost.claim({
    id: SLOT, home: { kind: 'page', pageType: PAGE_TYPE }, titleKey: TITLE_I18N_KEY,
    activity: { labelKey: TITLE_I18N_KEY, icon: 'box' }, layout: PANEL_LAYOUT,
    closable: PANEL_CLOSABLE,
    dockTitleHidden: true,
  });
}

function liveWorkspacePresentation(ctx: Context, config: ViewportFrontendConfig, { api, document, container }: { api: ViewWorkspaceClient; document: Document; container: HTMLElement }): EngineWorkspacePresentation {
  const read = () => readEnginePresentation(config, ctx);
  return new Proxy<EngineWorkspacePresentation>({}, {
    get(_, prop) {
      if (prop === 'surfacePlacement') return read()?.surfacePlacement ?? 'shell';
      const workspace = read();
      if (prop === 'attach') {
        return async (input: { target: EngineWorkspaceTarget; element: unknown; tabId?: string }) => {
          if (workspace?.attachScene) {
            const remove = workspace.attachScene({ target: input.target, container });
            const detachResize = attachViewportRenderResizeSync({ api, surface: container, target: input.target });
            return () => { detachResize(); remove(); };
          }
          const remove = await workspace?.attach?.(input);
          const surface = input.element as HTMLElement | null | undefined;
          if (!surface?.style || !surface.parentElement) return remove;
          const onContextMenu = (event: MouseEvent) => {
            event.preventDefault();
          };
          surface.addEventListener?.('contextmenu', onContextMenu);
          const restoreFit = workspace?.surfacePlacement === 'owner' ? () => {} : fitSceneSurface(surface);
          const detachResize = attachViewportRenderResizeSync({
            api,
            surface,
            target: input.target,
          });
          return async () => {
            detachResize();
            surface.removeEventListener?.('contextmenu', onContextMenu);
            restoreFit();
            await remove?.();
          };
        };
      }
      if (prop === 'createSurface') {
        if (typeof workspace?.createSurface === 'function') return workspace.createSurface;
        return (input: { document?: Document }) => (input?.document ?? document)?.getElementById?.('app-shell') ?? null;
      }
      if (prop === 'resolveTarget') return workspace?.resolveTarget;
      return prop === 'detach' ? workspace?.detach : undefined;
    },
  });
}

const viewportSurfacePlugin = {
  name: FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'viewPlayPresentation'],
  provide: ['viewWorkspaceShell', 'viewPreviewInputController'],
  async apply(ctx: Context, config: ViewportFrontendConfig = {}) {
    ctx.provide('viewPreviewInputController', (options) => new ViewWorkspaceInputController(options));
    const document = config.document ?? globalThis.document;
    const api = ctx.get('viewOperationClient')!;
    const element = config.viewportSurface;
    if (!element || !document?.createElement) return;
    const workspace = readEnginePresentation(config, ctx);
    if (workspace && !ctx.get('engineWorkspacePresentation', false)) {
      ctx.provide('engineWorkspacePresentation', workspace);
    }
    let shell: ViewWorkspaceShell | undefined;
    let play: ReturnType<typeof mountPlayToolbar> | undefined;
    try {
      play = mountPlayToolbar({ document, element, client: api });
      const mainSurface = document.createElement('div');
      Object.assign(mainSurface.style, {
        flex: '1',
        minWidth: '0',
        minHeight: '0',
        width: '100%',
        height: '100%',
        position: 'relative',
      });
      Object.assign(play.surface.style, { display: 'flex' });
      play.surface.append(mainSurface);
      ctx.effect(() => ctx.get('viewPlayPresentation')!.attach(mainSurface));
      shell = new ViewWorkspaceShell({ document, element: mainSurface, mountId: element.id,
        api, presentation: {
          workspace: liveWorkspacePresentation(ctx, config, { api, document, container: mainSurface }),
          display: createBrowserPagePresentation({ document }),
        },
        resourceBrowser: false, inspectorPanel: false, presentationOnly: true,
      });
      ctx.provide('viewWorkspaceShell', shell);
      ctx.effect(() => attachEngineFatalBanner({ document, host: mainSurface, writeClipboard: ctx.get('frontendPlatform', false)?.writeClipboard }));
      ctx.effect(() => attachViewportPageInputGate({
        element,
        input: ctx.get('engineWorkspaceInput', false),
        pageType: PAGE_TYPE,
        document,
      }));
    } catch (error) {
      await shell?.dispose(); play?.dispose(); throw error;
    }
    ctx.effect(() => async () => { await shell?.dispose(); play?.dispose(); });
  },
};

const viewViewportFrontendPlugin = {
  name: FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient', 'viewScenePage'],
  async apply(ctx: Context, config: ViewportFrontendConfig = {}) {
    const panelHost = config.panelHost ?? ctx.get?.('panelHost', false);
    if (!panelHost) return;
    const unclaim = claimViewportPanel(panelHost);
    ctx.effect(() => unclaim);
    // Play/Engine providers suspend only the canvas inside this fill slot.
    // The dock is claimed with the other scene panels as soon as the page exists.
    const document = config.document ?? globalThis.document;
    if (!document?.createElement) return;
    const element = document.createElement('div');
    element.id = config.workspace?.mountId ?? 'forgeax-view-workspace';
    element.className = 'fx-view-viewport-surface';
    await panelHost.waitForSlot(SLOT);
    const unmount = panelHost.mount(SLOT, element);
    ctx.effect(() => () => unmount?.());
    await ctx.plugin({
      ...viewportSurfacePlugin,
      name: `${FRONTEND_PLUGIN_ID}.surface`,
    }, { ...config, viewportSurface: element });
  },
};

export { viewViewportFrontendPlugin, viewPlayPresentationPlugin };
export default viewViewportFrontendPlugin;
