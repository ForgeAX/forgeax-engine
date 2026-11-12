import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { setPlanarCaptureDemand } from '../capture/planar-material';
import { Materials } from '../materials';
import { type RenderResourceScope, worldRenderResources } from '../publication/resource-scope';
import {
  type MaterialSnapshotCache,
  prepareMaterialSnapshot,
  readPersistentMaterialSnapshot,
  storeMaterialSnapshot,
} from '../render-system-extract';

function setup() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('unexpected shader compile');
        },
      },
      manifestUrl: undefined,
    }),
  });
  const world = new World({ assets });
  const resources = worldRenderResources(world);
  // A stable published revision isolates the planar routing key from asset churn.
  const scope: RenderResourceScope = Object.create(resources, {
    assetRevision: { value: () => 1 },
  });
  return { assets, world, scope };
}

const lightModes = (passes: readonly { renderState?: { tags?: unknown } }[]) =>
  passes.map((pass) => (pass.renderState?.tags as { LightMode?: string } | undefined)?.LightMode);

describe('planar receiver snapshot routing (SSR receives a planar surface without a capture)', () => {
  const wet = Materials.standard({
    surfaceModule: 'game::wet_ground',
    parameters: [{ name: 'rippleStrength', type: 'f32' }],
    values: { rippleStrength: 0.08 },
    planarReflection: true,
  }) as MaterialAsset;

  it('admits the receiver to the G-buffer while its world publishes no capture', () => {
    const { assets, scope } = setup();
    const snapshot = prepareMaterialSnapshot({
      handle: 7,
      world: scope,
      assets,
      material: wet,
      programSelections: undefined,
    });
    expect(snapshot.deferredPass).toBe(true);
    expect(lightModes(snapshot.passes)).toContain('Deferred');
    expect(lightModes(snapshot.passes)).toContain('Forward');
  });

  it('routes it forward only while a capture is published, and re-prepares when that flips', () => {
    const { assets, world, scope } = setup();
    const cache: MaterialSnapshotCache = new Map();
    const prepare = () =>
      storeMaterialSnapshot(
        cache,
        7,
        prepareMaterialSnapshot({
          handle: 7,
          world: scope,
          assets,
          material: wet,
          programSelections: undefined,
        }),
        scope,
      );
    setPlanarCaptureDemand(world, true);
    const forward = prepare();
    expect(forward.snapshot.deferredPass).toBe(false);
    expect(lightModes(forward.snapshot.passes)).not.toContain('Deferred');
    expect(forward.planarRouted).toBe(true);
    // Unrelated to asset revisions: the cached forward-only snapshot stays valid.
    expect(readPersistentMaterialSnapshot(cache, 7, scope)).toBe(forward);
    setPlanarCaptureDemand(world, false);
    expect(readPersistentMaterialSnapshot(cache, 7, scope)).toBeUndefined();
    const deferred = prepare();
    expect(deferred.snapshot.deferredPass).toBe(true);
    expect(readPersistentMaterialSnapshot(cache, 7, scope)).toBe(deferred);
  });

  it('never keys an ordinary material on the planar routing', () => {
    const { assets, world, scope } = setup();
    setPlanarCaptureDemand(world, true);
    const cache: MaterialSnapshotCache = new Map();
    const entry = storeMaterialSnapshot(
      cache,
      9,
      prepareMaterialSnapshot({
        handle: 9,
        world: scope,
        assets,
        material: Materials.standard({ baseColor: [1, 1, 1, 1] }) as MaterialAsset,
        programSelections: undefined,
      }),
      scope,
    );
    expect(entry.snapshot.deferredPass).toBe(true);
    expect(entry.planarRouted).toBeUndefined();
    setPlanarCaptureDemand(world, false);
    expect(readPersistentMaterialSnapshot(cache, 9, scope)).toBe(entry);
  });
});
