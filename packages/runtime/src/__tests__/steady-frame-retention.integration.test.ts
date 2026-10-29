import { readFileSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';

// Shader preparation is a file prerequisite, as in the maintained Native gate.
const manifestPath = process.env.SHADOW_ADMISSION_SHADER_MANIFEST;
const contents =
  manifestPath === undefined
    ? await (async () => {
        const built = await buildEngineShaderManifest();
        return JSON.stringify(
          'toJSON' in built ? built : publishShaderManifest(built.entries, built.materialShaders),
        );
      })()
    : Uint8Array.from(readFileSync(manifestPath)).buffer;

function frameRequest(lease: Parameters<Renderer['draw']>[0]['leases'][number]) {
  return { leases: [lease], camera: { lease }, environment: { lease } };
}

// D=0 frames through the ordinary local World path: every retained owner keeps
// its prepared work, so no reuse key may be a per-frame object identity.
it('keeps steady frames free of prepared-plan, batch and shadow rebuilds', async () => {
  const manifestUrl = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  installDefaultAssetDecoders(assets);
  const world = new World({ assets });
  world
    .spawn(
      { component: Transform, data: { pos: [0, 4, 12] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 80,
          antialias: 0,
          bloom: 0,
          tonemap: 7,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.8, -1],
        castShadow: true,
        mapSize: 64,
        cascadeCount: 3,
        shadowDistance: 40,
      },
    })
    .unwrap();
  const materials = [
    Materials.standard({ baseColor: [0.8, 0.1, 0.05, 1] }),
    Materials.standard({ baseColor: [0.1, 0.1, 0.8, 1] }),
  ].map((material) => testAssets(world).create(material).unwrap());
  const meshes = [createBoxGeometry(1, 1, 1), createBoxGeometry(0.5, 2, 0.5)].map((geometry) =>
    testAssets(world).create(geometry.unwrap()).unwrap(),
  );
  for (let index = 0; index < 12; index++)
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [(index % 4) * 2 - 3, 0, Math.floor(index / 4) * 2] },
        },
        { component: MeshFilter, data: { assetHandle: meshes[index % 2] as number } },
        { component: MeshRenderer, data: { materials: [materials[(index >> 1) % 2] as number] } },
      )
      .unwrap();
  const canvas = { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
  const renderer = (
    await createRenderer(canvas, { rhi }, { shaderManifestUrl: manifestUrl })
  ).unwrap();
  try {
    const lease = renderer.attach(world).unwrap();
    const frame = async () => {
      world.update(1 / 60).unwrap();
      const receipt = renderer.draw(frameRequest(lease)).unwrap();
      await receipt.completed;
      return renderer.inspect().renderScene.gpuDriven;
    };
    // Warm-up admits assets, shadow views and the static caster layer.
    for (let index = 0; index < 8; index++) await frame();
    const warm = await frame();
    expect(warm.channels.every((channel) => channel.lane === 'gpu')).toBe(true);
    expect(warm.shadowViews.length).toBeGreaterThan(0);
    for (let index = 0; index < 60; index++) {
      const steady = await frame();
      expect({
        planRebuildBatches: steady.planRebuildBatches,
        preparedBatchBuilds: steady.preparedBatchBuilds,
        filteredPlanBuilds: steady.filteredPlanBuilds,
        preparedAssemblyHits: steady.preparedAssemblyHits,
        invalidatedShadowViews: steady.shadowViews.filter((view) => view.cache !== 'hit').length,
      }).toEqual({
        planRebuildBatches: 0,
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
        preparedAssemblyHits: 2,
        invalidatedShadowViews: 0,
      });
    }
    // Falsifier: an accepted material edit must not be adopted from the last
    // assembly's pinned version.
    testAssets(world)
      .update(materials[0] as number, { values: { baseColor: [0, 1, 0, 1] } })
      .unwrap();
    const edited = await frame();
    expect(edited.preparedAssemblyHits).toBeLessThan(2);
    for (let index = 0; index < 3; index++) await frame();
    expect((await frame()).preparedAssemblyHits).toBe(2);
  } finally {
    renderer.dispose();
    URL.revokeObjectURL(manifestUrl);
  }
}, 60_000);
