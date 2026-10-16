export const CONTENT_BROWSER_UI_SCHEMA_VERSION = 'forgeax.view.content-browser.ui/1';

export const CONTENT_BROWSER_ACTIONS = Object.freeze({
  search: 'content-browser.search',
  navigate: 'content-browser.navigate',
  navigateBack: 'content-browser.navigate.back',
  navigateForward: 'content-browser.navigate.forward',
  refresh: 'content-browser.refresh',
  setView: 'content-browser.view.set',
  setThumbnailSize: 'content-browser.thumbnail-size.set',
  setFilter: 'content-browser.filter.set',
  setSort: 'content-browser.sort.set',
  select: 'content-browser.select',
  activate: 'content-browser.activate',
  toggleFavorite: 'content-browser.favorite.toggle',
  toggleSourceGroup: 'content-browser.source-group.toggle',
  toggleDetailPanel: 'content-browser.detail-panel.toggle',
  togglePackExpansion: 'content-browser.pack.expand.toggle',
  showContextMenu: 'content-browser.context-menu.show',
  copyPath: 'content-browser.copy-path',
});

export const CONTENT_BROWSER_MODEL_SCHEMA = Object.freeze({
  $id: CONTENT_BROWSER_UI_SCHEMA_VERSION,
  type: 'object',
  required: ['projectLabel', 'folder', 'view', 'files', 'folders'],
  properties: {
    projectLabel: { type: 'string' },
    folder: { type: 'string' },
    view: { enum: ['grid', 'list', 'column'] },
    thumbnailSize: { type: 'number', minimum: 48, maximum: 200 },
    detailPanelOpen: { type: 'boolean' },
    favorites: { type: 'array', items: { type: 'string' } },
    expandedPacks: { type: 'array', items: { type: 'string' } },
    folders: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'path', 'name', 'childCount'],
        properties: {
          type: { const: 'folder' },
          path: { type: 'string' },
          name: { type: 'string' },
          childCount: { type: 'number' },
        },
      },
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'path', 'name', 'family', 'assets'],
        properties: {
          type: { const: 'file' },
          path: { type: 'string' },
          name: { type: 'string' },
          family: {
            enum: ['code', 'config', 'doc', 'scene', 'pack', 'meta', 'image', 'audio', 'model', 'font', 'ui', 'data', 'other'],
          },
          isAssetPackage: { type: 'boolean' },
          assets: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type', 'guid', 'kind', 'name', 'packPath'],
              properties: {
                type: { const: 'asset' },
                guid: { type: 'string' },
                kind: { type: 'string' },
                name: { type: 'string' },
                packPath: { type: 'string' },
                estimatedSize: { type: 'number' },
                packModifiedAt: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
});
