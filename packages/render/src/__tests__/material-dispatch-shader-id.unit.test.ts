import type { EntityHandle } from '@forgeax/engine-ecs';
import type { MaterialPass } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { appendMaterialDispatchEntries, type DispatchEntry } from '../render-system-extract';

const passes: readonly MaterialPass[] = [
  {
    name: 'forward',
    program: {
      module: 'forgeax_material::standard',
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
    },
    renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
  },
  {
    name: 'deferred',
    program: {
      module: 'forgeax_material::standard',
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_gbuffer',
    },
    renderState: { tags: { LightMode: 'Deferred' }, queue: 2000 },
  },
  {
    name: 'shadow-caster',
    program: {
      module: 'forgeax_material::standard',
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_shadow',
    },
    renderState: { tags: { LightMode: 'ShadowCaster' }, queue: 2000 },
  },
];

describe('material dispatch shader identity', () => {
  it('uses the published Pass specialization for every authored pass', () => {
    const dispatch: DispatchEntry[] = [];
    appendMaterialDispatchEntries(dispatch, passes, 0 as EntityHandle, 17, 0, 0, {}, 0, {
      forward: 'forgeax::surface-variant::rusted-iron',
      deferred: 'forgeax::surface-variant::rusted-iron',
      'shadow-caster': 'forgeax::surface-variant::rusted-iron-shadow',
    });

    expect(dispatch.map((entry) => entry.materialShaderId)).toEqual([
      'forgeax::surface-variant::rusted-iron',
      'forgeax::surface-variant::rusted-iron',
      'forgeax::surface-variant::rusted-iron-shadow',
    ]);
  });
});
