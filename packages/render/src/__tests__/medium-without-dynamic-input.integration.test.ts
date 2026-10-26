import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { createRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it('draws a stock medium Surface without a dynamicInput page', async () => {
  const authored: MaterialAsset = {
    kind: 'material',
    parameters: [],
    values: {},
    surface: {
      model: 'single-layer-medium',
      module: 'forgeax_material::default_single_layer_medium_surface',
    },
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::single-layer-medium' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
  };
  const guid = '019f0000-0000-7000-8000-0000000008c0';
  const cooked = await createMaterialPackCooker().cook({ guid, source: authored });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: rhi.createShaderModule,
      createShaderModuleImmediate: rhi.createShaderModuleImmediate,
    },
  );
  const world = new World({ assets: renderer.assetRegistry });
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const lease = attachment.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 30, antialias: 0 } },
      )
      .unwrap();
    publishRuntimeAssets(renderer.assetRegistry, [
      { guid, asset: { ...authored, cooked: record } as MaterialAsset },
    ]);
    const material = (
      await renderer.assetRegistry.load(renderer.assetRegistry.parseGuid(guid), 'material')
    ).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        {
          component: MeshFilter,
          data: { assetHandle: renderer.assetRegistry.create(BUILTIN_CUBE).unwrap() },
        },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    const draw = () =>
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    expect(draw().ok, JSON.stringify(errors)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(draw().ok, JSON.stringify(errors)).toBe(true);
    const passes = (draws.mock.contexts as RhiNullRenderPassEncoder[]).map((pass) => pass.passName);
    expect(passes).toContain('single-layer-medium-nearest-layer');
    expect(passes).toContain('single-layer-medium-color');
    expect(errors).toEqual([]);
  } finally {
    await renderer.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 30_000);
