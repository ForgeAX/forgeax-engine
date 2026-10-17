import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';

export const PLUGIN_ID = 'forgeax.view.inspector';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.panel.object-inspector.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/inspector/frontend';
export const SLOT = 'inspector';
export const PAGE_TYPE = VIEW_PAGE_TYPES.scene;
export const PANEL_LAYOUT = Object.freeze({
  dock: 'right',
  size: Object.freeze({ value: 0.28, unit: 'fraction' }),
  stack: 'tabs',
  order: 0,
});
export const TITLE_I18N_KEY = 'view.slots.inspector';
