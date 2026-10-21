import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { Materials } from '../materials';
import { extractFrames } from '../render-system-extract-tail';
import { testAssets } from './helpers/runtime-assets';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureWorldErrors(): Array<{ readonly code: string }> {
  const errors: Array<{ readonly code: string }> = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const error = args[args.length - 1];
    if (typeof error === 'object' && error !== null && 'code' in error) {
      errors.push(error as { readonly code: string });
    }
  });
  return errors;
}

describe('visibility resource short circuit', () => {
  it.each([
    VisibilityStateValue.hidden,
    VisibilityStateValue.visible,
  ])('rejects an invalid reference at the World write boundary (visibility=%s)', (state) => {
    const world = new World();
    const assets = testAssets(world);
    const errors = captureWorldErrors();
    const result = world.spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createPrimitiveMesh('cube').unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: { materials: [999 as never] } },
      { component: Visibility, data: { state } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('asset-reference-invalid');
    expect(extractFrames([world], 0, assets).renderables).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('does not validate override overflow while hidden', () => {
    const world = new World();
    const assets = testAssets(world);
    const errors = captureWorldErrors();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
          },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap(),
              assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap(),
            ],
          },
        },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();

    extractFrames([world], 0, assets);
    expect(errors).toEqual([]);

    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    extractFrames([world], 0, assets);
    expect(errors.map((error) => error.code)).toContain('mesh-renderer-material-override-overflow');
  });
});
