// @forgeax/engine-assets-runtime -- scene-handle-fields coverage (fix issue #709).
// extractSceneEntityHandleGuids + extractMountOverrideHandleGuids identify
// shared<T> / array<shared<T>> schema fields via resolveComponent and read the
// raw GUID string(s). Uses test-unique component names to avoid colliding with
// the engine's real component registry in the shared coverage run.

import { type Component, defineComponent } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { extractSceneEntityHandleGuids } from '../scene-handle-fields';

const T709MeshFilter = defineComponent('T709MeshFilter', { assetHandle: 'shared<MeshAsset>' });
const T709MeshRenderer = defineComponent('T709MeshRenderer', {
  materials: 'array<shared<MaterialAsset>>',
});
const T709SpotLight = defineComponent('T709SpotLight', {
  iesProfile: 'shared<IesProfileAsset>',
  cookie: 'shared<TextureAsset>',
  rollDeg: 'f32',
});
const T709Transform = defineComponent('T709Transform', { x: 'f32' });
const components = new Map<string, Component>([
  [T709MeshFilter.name, T709MeshFilter],
  [T709MeshRenderer.name, T709MeshRenderer],
  [T709SpotLight.name, T709SpotLight],
  [T709Transform.name, T709Transform],
]);

describe('extractSceneEntityHandleGuids', () => {
  it('extracts scalar shared<T> GUID strings', () => {
    const entries = extractSceneEntityHandleGuids(components, {
      mesh: { components: { T709MeshFilter: { assetHandle: 'mesh-guid' } } },
    });
    expect(entries).toEqual([
      {
        entityKey: 'mesh',
        componentName: 'T709MeshFilter',
        fieldName: 'assetHandle',
        guidString: 'mesh-guid',
      },
    ]);
  });

  it('extracts array<shared<T>> element GUIDs with their arrayIndex', () => {
    const entries = extractSceneEntityHandleGuids(components, {
      mesh: { components: { T709MeshRenderer: { materials: ['m0', 'm1'] } } },
    });
    expect(entries).toEqual([
      {
        entityKey: 'mesh',
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'm0',
        arrayIndex: 0,
      },
      {
        entityKey: 'mesh',
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'm1',
        arrayIndex: 1,
      },
    ]);
  });

  it('extracts Spot IES and Cookie handles while retaining roll as a value field', () => {
    const entries = extractSceneEntityHandleGuids(components, {
      light: {
        components: {
          T709SpotLight: {
            iesProfile: 'ies-guid',
            cookie: 'cookie-guid',
            rollDeg: 90,
          },
        },
      },
    });
    expect(entries).toEqual([
      {
        entityKey: 'light',
        componentName: 'T709SpotLight',
        fieldName: 'iesProfile',
        guidString: 'ies-guid',
      },
      {
        entityKey: 'light',
        componentName: 'T709SpotLight',
        fieldName: 'cookie',
        guidString: 'cookie-guid',
      },
    ]);
  });

  it('skips unknown components, non-shared fields, and already-resolved numbers', () => {
    const entries = extractSceneEntityHandleGuids(components, {
      unknown: { components: { NotRegistered709: { assetHandle: 'x' } } },
      transform: { components: { T709Transform: { x: 3 } } },
      resolved: { components: { T709MeshFilter: { assetHandle: 42 } } },
      renderer: { components: { T709MeshRenderer: { materials: [7, 'm-str'] } } },
    });
    // Only the string array element survives.
    expect(entries).toEqual([
      {
        entityKey: 'renderer',
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'm-str',
        arrayIndex: 1,
      },
    ]);
  });
});
