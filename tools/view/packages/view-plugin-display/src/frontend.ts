import type { Context } from '@forgeax/engine-plugin';
import type { Dispose, FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import type { DisplayStatusInput } from './status.ts';
export type DisplayFrontendConfig = FrontendConfig & { displayCarrier?: boolean };
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewDisplayStatus: ViewDisplayStatus } }
import {
  PAGE_TYPE,
  PAGE_TITLE_I18N_KEY,
  DISPLAY_SURFACE_ID,
  DISPLAY_TARGET_ROLE,
  FRONTEND_PLUGIN_ID,
  VIEW_STATUS_SERVICE,
  VIEW_STATUS_TOPIC,
} from './identity.ts';

import { ViewDisplayStatus } from './status.ts';
import { mountRunObserver } from './ui/run-observer.ts';
export { ViewDisplayStatus } from './status.ts';

const viewDisplayFrontendPlugin = {
  name: FRONTEND_PLUGIN_ID,
  inject: ['viewOperationClient'],
  provide: ['viewDisplayStatus'],
  async apply(ctx: Context, config: DisplayFrontendConfig = {}) {
    const pageHost = config.pageHost ?? ctx.get?.('pageHost', false);
    const document = config.document ?? globalThis.document;
    const status = new ViewDisplayStatus();
    let unregisterPageType: (() => void) | undefined;
    let unmountPage: (() => void) | undefined;
    let disposeObservation: Dispose | undefined;
    let live = true;
    if (document?.createElement) {
      if (!pageHost) throw new TypeError('View display Frontend Plugin requires pageHost');
      if (document.getElementById?.(DISPLAY_SURFACE_ID)) {
        throw new Error(`Display Fiber requires one unique surface: ${DISPLAY_SURFACE_ID}`);
      }
      unregisterPageType = pageHost.registerType({
        context: 'project',
      typeId: PAGE_TYPE,
        titleKey: PAGE_TITLE_I18N_KEY,
        order: 10,
        closable: false,
        singleton: true,
        initial: true,
        openable: false,
        layout: 'surface',
        showPanelRail: false,
        hideWhenInactive: config.displayCarrier !== true,
      });
      const surface = document.createElement(config.displayCarrier === true ? 'iframe' : 'section');
      surface.id = DISPLAY_SURFACE_ID;
      if ('name' in surface) surface.name = DISPLAY_SURFACE_ID;
      surface.title = 'ForgeaX runtime capture';
      surface.className = 'fx-view-display-surface';
      surface.dataset.forgeaxViewSurface = 'engine-target';
      surface.dataset.forgeaxViewDisplayOwner = 'frontend-fiber';
      surface.dataset.forgeaxViewTargetRole = DISPLAY_TARGET_ROLE;
      if (config.displayCarrier === true) surface.setAttribute('aria-hidden', 'true');
      surface.style.border = '0';
      surface.style.display = 'block';
      surface.style.pointerEvents = config.displayCarrier === true ? 'none' : 'auto';
      if (config.displayCarrier !== true) {
        surface.dataset.forgeaxViewSurface = 'run-observer';
        surface.className = 'fx-view-run-observer';
        disposeObservation = mountRunObserver({
          document, surface, status, client: ctx.get('viewOperationClient')!,
        });
      }
      try {
        unmountPage = pageHost.mount(PAGE_TYPE, surface);
      } catch (error) {
        unregisterPageType?.();
        throw error;
      }
    }
    ctx.provide('viewDisplayStatus', status);
    const nativeTransport = ctx.get?.('hostTransport', false);
    const transport = nativeTransport && 'request' in nativeTransport ? nativeTransport : undefined;
    let observedEvent = false;
    const unsubscribe = transport?.subscribe?.<DisplayStatusInput>(VIEW_STATUS_TOPIC, (payload) => {
      observedEvent = true;
      status.update(payload ?? {});
    });
    const initialController = new AbortController();
    if (typeof transport?.request === 'function') {
      void transport
        .request<undefined, DisplayStatusInput>(VIEW_STATUS_SERVICE, undefined, { signal: initialController.signal })
        .then((snapshot) => {
          if (live && !observedEvent) status.update(snapshot ?? {});
        })
        .catch(() => {});
    }
    const removeDisconnect = transport?.onDisconnect?.((error) => {
      if (!live) return;
      status.update({ status: 'error', error: error?.message ?? String(error) });
    });
    ctx.effect(() => async () => {
      live = false;
      initialController.abort();
      unsubscribe?.();
      removeDisconnect?.();
      unmountPage?.();
      unregisterPageType?.();
      disposeObservation?.();
      status.dispose();
    });
  },
};

export default viewDisplayFrontendPlugin;
