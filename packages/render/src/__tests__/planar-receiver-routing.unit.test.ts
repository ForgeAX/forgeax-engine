import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { setPlanarCaptureDemand } from '../capture/planar-material';
import { renderMaterialContext } from '../extract/material-context';
import { Materials } from '../materials';
import { type RenderResourceScope, worldRenderResources } from '../publication/resource-scope';
import {
  type MaterialSnapshotCache,
  prepareMaterialSnapshot,
  readPersistentMaterialSnapshot,
  storeMaterialSnapshot,
} from '../render-system-extract';

const { materialContext } = renderMaterialContext({ backendKind: 'webgpu', storageBuffer: true });
const WET_GUID = '019f0000-0000-7000-8000-000000000719';
let cookedWet: MaterialAsset;

async function setup() {
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
  publishRuntimeAssets(assets, [{ guid: WET_GUID, asset: cookedWet }]);
  const loaded = (await assets.load(WET_GUID, 'material')).unwrap();
  const wet = runtimeAssets(assets).borrow<MaterialAsset>(loaded).unwrap();
  const world = new World({ assets });
  const resources = worldRenderResources(world);
  // A stable published revision isolates the planar routing key from asset churn.
  const scope: RenderResourceScope = Object.create(resources, {
    assetRevision: { value: () => 1 },
  });
  return { assets, world, scope, wet };
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

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'planar-routing-publication-'));
    try {
      await writeFile(
        join(root, 'wet.wgsl'),
        `#define_import_path game::wet_ground
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(0.3), input.vertexNormalWS, 0.0, 0.6,
    vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0);
}`,
      );
      // Use the same native publication authority as the game. Static coverage
      // choices cannot enter Render as an uncooked factory result.
      const output = await createMaterialPackCooker([root]).cook({ guid: WET_GUID, source: wet });
      cookedWet = output.payload as MaterialAsset;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('admits the receiver to the G-buffer while its world publishes no capture', async () => {
    const { assets, scope, wet } = await setup();
    const snapshot = prepareMaterialSnapshot({
      handle: 7,
      world: scope,
      assets,
      material: wet,
      materialContext,
    });
    expect(snapshot.deferredPass).toBe(true);
    expect(lightModes(snapshot.passes)).toContain('Deferred');
    expect(lightModes(snapshot.passes)).toContain('Forward');
  });

  it('routes it forward only while a capture is published, and re-prepares when that flips', async () => {
    const { assets, world, scope, wet } = await setup();
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
          materialContext,
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

  it('never keys an ordinary material on the planar routing', async () => {
    const { assets, world, scope } = await setup();
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
        materialContext,
      }),
      scope,
    );
    expect(entry.snapshot.deferredPass).toBe(true);
    expect(entry.planarRouted).toBeUndefined();
    setPlanarCaptureDemand(world, false);
    expect(readPersistentMaterialSnapshot(cache, 9, scope)).toBe(entry);
  });
});
