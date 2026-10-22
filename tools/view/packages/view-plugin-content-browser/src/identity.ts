import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';

export const PLUGIN_ID = 'forgeax.view.content-browser';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.panel.asset-browser.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/content-browser/frontend';
export const SLOT = 'content-browser';
export const PAGE_TYPE = VIEW_PAGE_TYPES.scene;
export const PANEL_LAYOUT = Object.freeze({
  dock: 'bottom',
  size: Object.freeze({ value: 0.34, unit: 'fraction', additionalPx: 200 }),
  stack: 'tabs',
  order: 0,
});
export const TITLE_I18N_KEY = 'view.slots.contentBrowser';
