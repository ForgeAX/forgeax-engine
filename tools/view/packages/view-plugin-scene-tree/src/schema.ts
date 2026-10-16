export const SCENE_TREE_UI_SCHEMA_VERSION = 'forgeax.view.scene-tree.ui/1';

export const SCENE_TREE_ACTIONS = Object.freeze({
  search: 'scene-tree.search',
  toggleColumn: 'scene-tree.column.toggle',
  expandAll: 'scene-tree.expand-all',
  collapseAll: 'scene-tree.collapse-all',
  toggleExpanded: 'scene-tree.expanded.toggle',
  toggleVisibility: 'scene-tree.visibility.toggle',
  select: 'scene-tree.select',
  selectRange: 'scene-tree.select-range',
  create: 'scene-tree.create',
  rename: 'scene-tree.rename',
  duplicate: 'scene-tree.duplicate',
  delete: 'scene-tree.delete',
  reparent: 'scene-tree.reparent',
  group: 'scene-tree.group',
  focus: 'scene-tree.focus',
  copyJson: 'scene-tree.copy-json',
  referenceInChat: 'scene-tree.reference-in-chat',
  showContextMenu: 'scene-tree.context-menu.show',
});

export const SCENE_TREE_MODEL_SCHEMA = Object.freeze({
  $id: SCENE_TREE_UI_SCHEMA_VERSION,
  type: 'object',
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'typeLabel', 'depth', 'kind'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          typeLabel: { type: 'string' },
          depth: { type: 'integer', minimum: 0 },
          kind: { enum: ['folder', 'entity'] },
          hidden: { type: 'boolean' },
          hasChildren: { type: 'boolean' },
          expanded: { type: 'boolean' },
        },
      },
    },
  },
});
