export const MATERIAL_UI_SCHEMA_VERSION = 'forgeax.view.material.ui/1';

export const MATERIAL_ACTIONS = Object.freeze({
  search: 'material.search',
  expandAll: 'material.expand-all',
  collapseAll: 'material.collapse-all',
  toggleGroup: 'material.group.toggle',
});

export const MATERIAL_MODEL_SCHEMA = Object.freeze({
  $id: MATERIAL_UI_SCHEMA_VERSION,
  type: 'object',
  required: ['id', 'name', 'shader', 'parameters', 'textures'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    shader: { type: 'string' },
    parameters: {
      type: 'object',
      required: ['baseColor', 'roughness', 'metallic'],
      properties: {
        baseColor: { type: 'string' },
        roughness: { type: 'number', minimum: 0, maximum: 1 },
        metallic: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    textures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slot', 'label'],
        properties: {
          slot: { type: 'string' },
          label: { type: 'string' },
          asset: { type: ['string', 'null'] },
        },
      },
    },
  },
});
