import type { Plugin } from '@forgeax/engine-plugin';
import type { EngineWorkspaceTarget } from '@forgeax/engine/app';
import type { WorkspacePreview, WorkspaceState, WorkspaceTarget } from '@forgeax/view-workspace-core/contract';
import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { reportWorkspaceCommandError } from '@forgeax/view-workspace-core/command-error';
import {
  cameraPoseWithPivot,
  createViewportInputApi,
  meshAabbCenter,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
} from '@forgeax/view-workspace-core/preview-camera';
import { installNativePreviewHost } from '@forgeax/view-workspace-core/preview-surface';
import type { PreviewOwner } from '@forgeax/view-workspace-core/engine-presentation';
import { ViewWorkspaceInputController } from './workspace-shell.ts';

/** Bind tools in the document that owns the exact canvas, including isolated Scene realms. */
export const viewportInputPlugin: Plugin.Object = {
  name: 'forgeax.view.viewport.input',
  inject: ['viewOperationClient', 'engineWorkspacePresentation', 'frontendPlatform'],
  apply(ctx) {
    const api = ctx.viewOperationClient!;
    const presentation = ctx.engineWorkspacePresentation!;
    const { window, document } = ctx.frontendPlatform;
    let state: WorkspaceState | undefined;
    let controller: ViewWorkspaceInputController | undefined;
    let target: WorkspaceState['preview'];
    let remove: (() => void) | undefined;
    let meshController: ViewWorkspaceInputController | undefined;
    let meshRemove: ((reason?: string) => void) | undefined;
    let meshEpoch = 0;
    const retire = () => { remove?.(); remove = undefined; void controller?.dispose(); controller = undefined; };
    const retireMesh = () => {
      meshEpoch += 1;
      const detach = meshRemove;
      const current = meshController;
      meshRemove = undefined;
      meshController = undefined;
      detach?.('input-detached');
      void current?.dispose();
    };
    const bindMesh = async (shown: { target: WorkspaceTarget; container: HTMLElement; owner: PreviewOwner }) => {
      retireMesh();
      if (shown.owner.pageType !== 'mesh') return;
      const epoch = meshEpoch;
      const targetId = String(shown.target.targetId);
      const targetGeneration = shown.target.generation;
      const latest = await api.getState().catch(() => state);
      if (epoch !== meshEpoch || !latest) return;
      const preview = latest.previews?.find((entry: WorkspacePreview) =>
        String(entry.target.targetId) === targetId && entry.target.generation === targetGeneration);
      if (preview?.asset?.kind !== 'mesh') return;
      const local = createViewportInputApi(api, presentation, { targetId });
      const pose = await rememberInitialPreviewCamera(local, preview.target);
      if (epoch !== meshEpoch) return;
      const mesh = new ViewWorkspaceInputController({
        api: local,
        targetId,
        targetGeneration,
        tabId: VIEW_WORKSPACE_TAB_ID,
        selectOnClick: false,
        window,
        document,
        shouldCapture: (event) => {
          const node = event.target as Node | null;
          return Boolean(node && shown.container.contains(node));
        },
        onError: error => reportWorkspaceCommandError(error, { operation: 'camera.input' }),
        onFocusSelection: async () => {
          await mesh.abort('camera-restore');
          const pivot = meshAabbCenter(preview.assetBinding);
          await restorePreviewCamera(local, preview.target, pivot ? cameraPoseWithPivot(pose, pivot) : pose);
        },
      });
      if (epoch !== meshEpoch) {
        void mesh.dispose();
        return;
      }
      meshController = mesh;
      meshRemove = mesh.attach(shown.container);
    };
    if (document.defaultView && document.defaultView.parent !== document.defaultView) {
      ctx.effect(() => installNativePreviewHost({
        presentation, client: api, document, window, createContainer: () => document.createElement('div'),
        onPreview: async (shown) => {
          if (!shown) { retireMesh(); return; }
          try { await bindMesh(shown); }
          catch (error) { reportWorkspaceCommandError(error, { operation: 'camera.input' }); }
        },
        onFinishCamera: async () => { await meshController?.finish(); },
      }));
    }
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
        onFocusSelection: () => state?.sceneSelection?.primary.entityId && api.call('entity.focus', { ...binding, entityId: state.sceneSelection.primary.entityId }),
      });
      remove = controller.attach(surface);
    };
    const unsubscribe = api.subscribe(accept);
    void api.getState().then(accept).catch(() => {});
    ctx.effect(() => () => { unsubscribe(); retire(); retireMesh(); });
  },
};
