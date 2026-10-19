import type { Context } from '@forgeax/engine-plugin';
import { createBrowserFrame } from '@forgeax/engine-host/platform';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
export type PlayPresentation = { attach: (element: HTMLElement) => () => void };
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewPlayPresentation: PlayPresentation; } }
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { attachPreviewRenderResizeSync } from '@forgeax/view-workspace-core/render-resize-sync';

/** Browser resources live with the workspace connection, independently of viewport panels. */
export const viewPlayPresentationPlugin = {
  name: 'forgeax.view.service.play-presentation.frontend',
  inject: ['viewOperationClient'],
  provide: ['viewPlayPresentation'],
  apply(ctx: Context, config: { document?: Document } = {}) {
    const document = config.document ?? globalThis.document;
    const platform = ctx.get('frontendPlatform', false);
    const createFrame = platform?.createFrame.bind(platform) ?? ((url: string) => createBrowserFrame(document, url));
    const client = ctx.get('viewOperationClient');
    if (!document?.body) {
      ctx.provide('viewPlayPresentation', { attach: () => () => {} });
      return;
    }
    let frame: HTMLElement | undefined;
    let releaseSurface: (() => Promise<void>) | undefined;
    let targetId: string | undefined;
    let anchor: HTMLElement | undefined;
    let state: WorkspaceState | null = null;
    let disposed = false;
    let resizeKey = '';
    let releaseResize: (() => void) | undefined;
    const stopResize = () => {
      releaseResize?.();
      releaseResize = undefined;
      resizeKey = '';
    };
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      const visible = state?.targetBinding === 'play' && rect !== undefined && rect.width > 0 && rect.height > 0;
      const target = state?.play?.target;
      // Engine queues this request behind its native readiness handshake.
      // Publish placement before capture/pick can begin on the running target.
      const nextResizeKey = visible && target && state?.play?.phase !== 'failed'
        ? `${target.targetId}:${target.generation}` : '';
      if (nextResizeKey !== resizeKey) {
        stopResize();
        resizeKey = nextResizeKey;
        if (resizeKey) releaseResize = attachPreviewRenderResizeSync({ api: client, surface: anchor, target });
      }
      if (!frame) return;
      const dpr = Math.max(1, document.defaultView?.devicePixelRatio ?? 1);
      const width = (state?.play?.target.width ?? 1280) / dpr;
      const height = (state?.play?.target.height ?? 720) / dpr;
      const scale = visible ? Math.min(rect.width / width, rect.height / height) : 1;
      const next = {
        // An unselected Play still owns native startup/cleanup work. CSS
        // visibility:hidden suspends iframe rAF before that work can finish.
        visibility: 'visible',
        opacity: visible ? '1' : '0',
        pointerEvents: visible ? 'auto' : 'none',
        left: `${(rect?.left ?? 0) + (visible ? (rect.width - width * scale) / 2 : 0)}px`,
        top: `${(rect?.top ?? 0) + (visible ? (rect.height - height * scale) / 2 : 0)}px`,
        width: `${width}px`,
        height: `${height}px`,
        transformOrigin: 'top left',
        transform: `scale(${scale})`,
      };
      const style = frame.style;
      if (
        style.visibility === next.visibility &&
        style.opacity === next.opacity &&
        style.pointerEvents === next.pointerEvents &&
        style.left === next.left &&
        style.top === next.top &&
        style.width === next.width &&
        style.height === next.height &&
        style.transform === next.transform
      ) return;
      Object.assign(style, next);
    };
    const refresh = (next: WorkspaceState | null) => {
      if (disposed) return;
      state = next;
      const target = state?.play?.target;
      if (target?.targetId !== targetId) {
        if (frame) frame.style.visibility = 'hidden';
        void Promise.resolve(releaseSurface?.()).catch(error => ctx.logger.error(error));
        releaseSurface = undefined;
        frame = undefined;
        targetId = undefined;
        if (target?.url && (state?.projectPhase === undefined || state.projectPhase === 'running')) {
          targetId = target.targetId;
          const handle = createFrame(target.url);
          frame = handle.element;
          frame.title = 'Play';
          frame.dataset.forgeaxScenePlay = targetId;
          Object.assign(frame.style, { position: 'fixed', border: '0', zIndex: '2' });
          if (!frame.isConnected) document.body.append(frame);
          void handle.ready.catch(error => ctx.logger.error(error));
          releaseSurface = ctx.effect(() => () => handle.dispose());
        }
      }
      place();
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined;
    const win = document.defaultView;
    win?.addEventListener('resize', place);
    win?.addEventListener('scroll', place, true);
    const reader = createWorkspaceStateReader(client);
    const unsubscribe = reader.subscribe(() => refresh(reader.getSnapshot()));
    ctx.provide('viewPlayPresentation', {
      attach(element: HTMLElement) {
        if (anchor) observer?.unobserve(anchor);
        stopResize();
        anchor = element;
        observer?.observe(element);
        place();
        return () => {
          if (anchor !== element) return;
          stopResize();
          observer?.unobserve(element);
          anchor = undefined;
          place();
        };
      },
    });
    ctx.effect(() => async () => {
      disposed = true;
      stopResize();
      unsubscribe();
      observer?.disconnect();
      win?.removeEventListener('resize', place);
      win?.removeEventListener('scroll', place, true);
      await releaseSurface?.();
    });
  },
};
