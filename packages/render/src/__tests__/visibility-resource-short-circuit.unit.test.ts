import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { toShared } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { extractFrames } from '../render-system-extract-tail';

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

function codesForInvalidMaterial(state: number): { hidden: string[]; visible: string[] } {
  const world = new World();
  const assets = new AssetRegistry({} as never);
  const errors = captureWorldErrors();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [toShared<'MaterialAsset'>(999)] } },
      { component: Visibility, data: { state } },
    )
    .unwrap();

  extractFrames([world], 0, assets);
  const hiddenCodes = errors.map((error) => error.code);
  world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  const beforeVisible = errors.length;
  extractFrames([world], 0, assets);
  return { hidden: hiddenCodes, visible: errors.slice(beforeVisible).map((error) => error.code) };
}

describe('visibility resource short circuit', () => {
  it('does not resolve a bad override while hidden, then restores the fallback diagnostic', () => {
    const codes = codesForInvalidMaterial(VisibilityStateValue.hidden);

    expect(codes.hidden).toEqual([]);
    expect(codes.visible).toContain('mesh-renderer-material-override-invalid');
  });

  it('does not validate override overflow while hidden', () => {
    const world = new World();
    const assets = new AssetRegistry({} as never);
    const errors = captureWorldErrors();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        {
          component: MeshRenderer,
          data: {
            materials: [toShared<'MaterialAsset'>(998), toShared<'MaterialAsset'>(999)],
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
