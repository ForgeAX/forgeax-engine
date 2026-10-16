// feat-20260608-scene-nesting-ecs-fication M2 / w15 (red phase) — SceneInstance
// component definition + vocab validation.
//
// Confirms:
//   - `defineComponent('SceneInstance', { source: 'shared<SceneAsset>',
//      mapping: 'array<entity>', state: 'unique<SceneInstanceState>' })` registers
//      via the global `resolveComponent` index (single ECS schema vocab path)
//   - schema reads back exactly the 3 D-2 fields (source / mapping / state)
//   - SceneInstanceState interface is a runtime-only TS interface (no ECS
//     schema vocab entry); the ref<SceneInstanceState> field stores a u32
//     handle, the payload is held in the World's UniqueRefStore
//
// Plan anchor: plan-strategy §D-2 (single ref wraps SceneInstanceState
// dynamic structure); plan-tasks §M2 / w15.

import { componentSchema } from '@forgeax/engine-ecs/internal';
import { SceneInstance } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('SceneInstance component (w15)', () => {
  it('has the D-2 3-field schema', () => {
    const schema = componentSchema(SceneInstance) as Record<string, unknown>;
    const fieldNames = Object.keys(schema).sort();
    expect(fieldNames).toEqual(['mapping', 'source', 'state']);
  });

  it('source field is shared<SceneAsset>', () => {
    const schema = componentSchema(SceneInstance) as Record<string, string>;
    expect(schema.source).toBe('shared<SceneAsset>');
  });

  it('mapping field is array<entity>', () => {
    const schema = componentSchema(SceneInstance) as Record<string, string>;
    expect(schema.mapping).toBe('array<entity>');
  });

  it('state field is ref<SceneInstanceState>', () => {
    const schema = componentSchema(SceneInstance) as Record<string, string>;
    expect(schema.state).toBe('unique<SceneInstanceState>');
  });

  it('component name is "SceneInstance" (not "SceneInstanceComponent")', () => {
    expect(SceneInstance.name).toBe('SceneInstance');
  });
});
