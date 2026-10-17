import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';

export const PLUGIN_ID = 'forgeax.view.viewport';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.panel.scene-viewport.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/viewport/frontend';
export const SLOT = 'viewport';
export const PAGE_TYPE = VIEW_PAGE_TYPES.scene;
export const PANEL_LAYOUT = Object.freeze({
  dock: 'fill',
  stack: 'tabs',
  order: 0,
});
/** Scene page center viewport is pinned; the shell must not offer a close affordance. */
export const PANEL_CLOSABLE = false;
export const TITLE_I18N_KEY = 'view.slots.viewport';
export const VIEWPORT_SURFACE_ID = 'forgeax-view-viewport-surface';
export const VIEWPORT_TARGET_ROLE = 'human-readonly';
