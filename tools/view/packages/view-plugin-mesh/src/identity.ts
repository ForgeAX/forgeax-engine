import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';
import {
  RESOURCE_PREVIEW_LAYOUT,
  RESOURCE_PROPERTIES_LAYOUT,
} from '@forgeax/view-workspace-core/resource-page';

export const PLUGIN_ID = 'forgeax.view.mesh';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.page.mesh.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/mesh/frontend';
export const PAGE_TYPE = VIEW_PAGE_TYPES.mesh;
export const PAGE_TITLE_I18N_KEY = 'view.pages.mesh';
export const PAGE_ORDER = 31;
export const PREVIEW_SLOT = 'mesh-preview';
export const PROPERTIES_SLOT = 'mesh-properties';
export const RESOURCE_KINDS = Object.freeze(['mesh']);
export const RESOURCE_SELECTOR = Object.freeze({ kinds: RESOURCE_KINDS });
export const PAGE_PRIORITY = 20;
export const PREVIEW_LAYOUT = RESOURCE_PREVIEW_LAYOUT;
export const PROPERTIES_LAYOUT = RESOURCE_PROPERTIES_LAYOUT;
export const PREVIEW_PANEL = 'MeshPreview';
export const PROPERTIES_PANEL = 'MeshProperties';
export const PREVIEW_ICON = 'box';
export const PROPERTIES_ICON = 'detail';
export const PREVIEW_TITLE_I18N_KEY = 'view.slots.meshPreview';
export const PROPERTIES_TITLE_I18N_KEY = 'view.slots.meshProperties';
