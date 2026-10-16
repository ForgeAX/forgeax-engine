import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';

export const PLUGIN_ID = 'forgeax.view.plugins';
export const BACKEND_PLUGIN_ID = 'forgeax.view.service.plugin-inspection.backend';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.page.plugin-browser.frontend';
export const BACKEND_MODULE = '@forgeax/view/plugins/plugins/backend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/plugins/frontend';
export const SLOT = 'plugins';
export const PAGE_TYPE = VIEW_PAGE_TYPES.plugins;
export const PANEL_LAYOUT = Object.freeze({
  dock: 'fill',
  stack: 'tabs',
  order: 0,
});
export const TITLE_I18N_KEY = 'view.slots.plugins';
