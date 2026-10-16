export const PLUGINS_UI_SCHEMA_VERSION = 'forgeax.view.plugins.ui/1';

export const PLUGINS_ACTIONS = Object.freeze({
  search: 'plugins.search',
  refresh: 'plugins.refresh',
  select: 'plugins.select',
});

export const PLUGINS_MODEL_SCHEMA = Object.freeze({
  $id: PLUGINS_UI_SCHEMA_VERSION,
  type: 'object',
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sourceId', 'label', 'version', 'state'],
        properties: {
          sourceId: { type: 'string' },
          label: { type: 'string' },
          version: { type: 'string' },
          state: { enum: ['active', 'inactive', 'error'] },
        },
      },
    },
  },
});
