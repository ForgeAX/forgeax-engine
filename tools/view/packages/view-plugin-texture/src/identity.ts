import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';
import {
  RESOURCE_PREVIEW_LAYOUT,
  RESOURCE_PROPERTIES_LAYOUT,
} from '@forgeax/view-workspace-core/resource-page';

export const PLUGIN_ID = 'forgeax.view.texture';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.page.texture.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/texture/frontend';
export const PAGE_TYPE = VIEW_PAGE_TYPES.texture;
export const PAGE_TITLE_I18N_KEY = 'view.pages.texture';
export const PAGE_ORDER = 32;
export const PREVIEW_SLOT = 'texture-preview';
export const PROPERTIES_SLOT = 'texture-properties';
export const RESOURCE_KINDS = Object.freeze(['texture', 'image']);
export const RESOURCE_SELECTOR = Object.freeze({ kinds: RESOURCE_KINDS });
export const PAGE_PRIORITY = 20;
export const PREVIEW_LAYOUT = RESOURCE_PREVIEW_LAYOUT;
export const PROPERTIES_LAYOUT = RESOURCE_PROPERTIES_LAYOUT;
export const PREVIEW_PANEL = 'TexturePreview';
export const PROPERTIES_PANEL = 'TextureProperties';
export const PREVIEW_ICON = 'image';
export const PROPERTIES_ICON = 'detail';
export const PREVIEW_TITLE_I18N_KEY = 'view.slots.texturePreview';
export const PROPERTIES_TITLE_I18N_KEY = 'view.slots.textureProperties';
