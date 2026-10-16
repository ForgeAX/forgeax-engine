import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';

export const PLUGIN_ID = 'forgeax.view.scene-tree';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.panel.scene-hierarchy.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/scene-tree/frontend';
export const SLOT = 'scene-tree';
export const PAGE_TYPE = VIEW_PAGE_TYPES.editor;
export const PANEL_LAYOUT = Object.freeze({
  dock: 'left',
  size: Object.freeze({ value: 0.17, unit: 'fraction' }),
  stack: 'tabs',
  order: 0,
});
export const TITLE_I18N_KEY = 'view.slots.sceneTree';
