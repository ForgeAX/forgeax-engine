import { VIEW_PAGE_TYPES } from '@forgeax/view-workspace-core/contract';
import { RESOURCE_FALLBACK_LAYOUT } from '@forgeax/view-workspace-core/resource-page';

export const PLUGIN_ID = 'forgeax.view.asset';
export const FRONTEND_PLUGIN_ID = 'forgeax.view.page.asset.frontend';
export const FRONTEND_MODULE = '@forgeax/view/plugins/asset/frontend';
export const PAGE_TYPE = VIEW_PAGE_TYPES.asset;
export const PAGE_TITLE_I18N_KEY = 'view.pages.asset';
export const PAGE_ORDER = 80;
export const PROPERTIES_SLOT = 'asset-properties';
export const RESOURCE_SELECTOR = Object.freeze({ fallback: true });
export const PAGE_PRIORITY = 0;
export const PROPERTIES_LAYOUT = RESOURCE_FALLBACK_LAYOUT;
export const PROPERTIES_PANEL = 'AssetProperties';
export const PROPERTIES_ICON = 'detail';
export const PROPERTIES_TITLE_I18N_KEY = 'view.slots.assetProperties';
