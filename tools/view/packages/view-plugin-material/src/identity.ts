import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';
import {
  RESOURCE_PREVIEW_LAYOUT,
  RESOURCE_PROPERTIES_LAYOUT,
} from '@forgeax/view-workspace-core/resource-page';

export const PLUGIN_ID = 'forgeax.view.material';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.page.material.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/material/frontend';
export const PAGE_TYPE = VIEW_PAGE_TYPES.material;
export const PAGE_TITLE_I18N_KEY = 'view.pages.material';
export const PAGE_ORDER = 30;
export const PREVIEW_SLOT = 'material-preview';
export const PROPERTIES_SLOT = 'material-properties';
export const STATS_SLOT = 'material-stats';
export const SLOT = PROPERTIES_SLOT;
export const RESOURCE_KINDS = Object.freeze(['material']);
export const RESOURCE_SELECTOR = Object.freeze({ kinds: RESOURCE_KINDS });
export const PAGE_PRIORITY = 20;
export const PREVIEW_LAYOUT = RESOURCE_PREVIEW_LAYOUT;
export const PROPERTIES_LAYOUT = RESOURCE_PROPERTIES_LAYOUT;
export const PANEL_LAYOUT = PROPERTIES_LAYOUT;
export const PREVIEW_PANEL = 'MaterialPreview';
export const PROPERTIES_PANEL = 'MaterialProperties';
export const PREVIEW_ICON = 'sparkle';
export const PROPERTIES_ICON = 'sliders';
export const PREVIEW_TITLE_I18N_KEY = 'view.slots.materialPreview';
export const PROPERTIES_TITLE_I18N_KEY = 'view.slots.materialProperties';
export const TITLE_I18N_KEY = PROPERTIES_TITLE_I18N_KEY;
