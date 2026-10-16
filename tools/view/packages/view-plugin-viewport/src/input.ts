import type { Plugin } from '@forgeax/engine-plugin';
import type { EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { reportWorkspaceCommandError } from '@forgeax/view-workspace-core/command-error';
import { ViewWorkspaceInputController } from './workspace-shell.ts';
import { createViewportInputApi } from './camera-client.ts';

/** Bind tools in the document that owns the exact canvas, including isolated Editor realms. */
export const viewportInputPlugin: Plugin.Object = {
  name: 'forgeax.view.viewport.input',
  inject: ['viewOperationClient', 'engineWorkspacePresentation', 'frontendPlatform'],
  apply(ctx) {
    const api = ctx.viewOperationClient!;
    const presentation = ctx.engineWorkspacePresentation!;
    const { window, document } = ctx.frontendPlatform;
    let state: WorkspaceState;
    let controller: ViewWorkspaceInputController | undefined;
    let target: WorkspaceState['preview'];
    let remove: (() => void) | undefined;
    const retire = () => { remove?.(); remove = undefined; void controller?.dispose(); controller = undefined; };
    const accept = (next: WorkspaceState) => {
      state = next;
      const preview = next.selectedTabId === VIEW_WORKSPACE_TAB_ID ? next.preview : null;
      if (preview?.target.targetId === target?.target.targetId && preview?.target.generation === target?.target.generation) return;
      retire(); target = preview;
      if (!preview?.target.targetId) return;
      const surface = presentation.createSurface?.({ target: preview.target as EngineWorkspaceTarget, document, tabId: VIEW_WORKSPACE_TAB_ID }) as HTMLElement | undefined;
      if (!surface?.addEventListener) return;
      const binding = { targetId: preview.target.targetId, targetGeneration: preview.target.generation, tabId: VIEW_WORKSPACE_TAB_ID };
      controller = new ViewWorkspaceInputController({
        api: createViewportInputApi(api, presentation, preview.target as EngineWorkspaceTarget), ...binding, window, document,
        shouldCapture: event => Boolean(surface.contains(event.target as Node)),
        onError: error => reportWorkspaceCommandError(error, { operation: 'camera.input' }),
        onFocusSelection: () => state.sceneSelection?.primary.entityId && api.call('entity.focus', { ...binding, entityId: state.sceneSelection.primary.entityId }),
      });
      remove = controller.attach(surface);
    };
    const unsubscribe = api.subscribe(accept);
    void api.getState().then(accept).catch(() => {});
    ctx.effect(() => () => { unsubscribe(); retire(); });
  },
};
