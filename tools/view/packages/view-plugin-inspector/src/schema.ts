export const INSPECTOR_UI_SCHEMA_VERSION = 'forgeax.view.inspector.ui/2';

export const INSPECTOR_ACTIONS = Object.freeze({
  search: 'inspector.search',
  focus: 'inspector.focus',
  copyEntity: 'inspector.entity.copy',
  expandAll: 'inspector.expand-all',
  collapseAll: 'inspector.collapse-all',
  toggleComponent: 'inspector.component.toggle',
  copyComponent: 'inspector.component.copy',
  copyField: 'inspector.field.copy',
  showContextMenu: 'inspector.context-menu.show',
  selectGroup: 'inspector.group.select',
  toggleComponentTree: 'inspector.component-tree.toggle',
  selectEntityRoot: 'inspector.entity-root.select',
  selectComponent: 'inspector.component.select',
  openAsset: 'inspector.asset.open',
});

export const INSPECTOR_MODEL_SCHEMA = Object.freeze({
  $id: INSPECTOR_UI_SCHEMA_VERSION,
  type: ['object', 'null'],
  required: ['id', 'name', 'components'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    badge: { type: 'string' },
    components: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'fields'],
        properties: {
          name: { type: 'string' },
          icon: { type: 'string' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'label', 'kind', 'value'],
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                kind: { enum: ['vector3', 'vector4', 'angle3', 'number', 'bool', 'switch', 'text', 'enum', 'color', 'asset'] },
                value: {},
                options: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
});
