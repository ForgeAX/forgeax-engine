import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { assert } from 'vitest';
import { prepareRuntimeAssetPublication } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import {
  collectMaterialSources,
  createMaterialPackCooker,
} from '../../../../shader-compiler/src/material/pack-cooker';
import { cookRayMaterial } from '../../../../shader-compiler/src/material/ray-material';
import { buildMaterialSourceCatalog } from '../../../../shader-compiler/src/material/source-catalog';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { renderMaterialContext } from '../../extract/material-context';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { prepareProbeCards } from '../../raytracing/renderer-probe-cards';
import { SceneFieldRows } from '../../raytracing/scene-field-projection';
import type { RenderSystemInternals } from '../../record/render-context';
import { extractSource } from '../../render-system-extract-tail';
import { PersistentRenderScene } from '../../scene/render-scene';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import { createProbeGlobalMesh, probeGlobalProfile } from './probe-global.fixture';

const MATERIAL = '019f0000-0000-7000-8000-00000000ca01';
const TEXTURE = '019f0000-0000-7000-8000-00000000ca02';
const source = `#define_import_path game::published_card
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material, baseColorTexture, baseColorTexture_sampler}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let sample = textureSample(baseColorTexture, baseColorTexture_sampler, input.uv0);
  return SurfaceData(sample.rgb * material.baseColor.rgb, normalize(input.vertexNormalWS),
    0.0, material.roughness, vec3f(0.125), 1.0, sample.a, material.alphaCutoff, 0.0);
}`;

export async function cookCustomCardPublication(timeDependent = false) {
  const directory = await mkdtemp(join(tmpdir(), 'custom-card-publication-'));
  try {
    await writeFile(
      join(directory, 'surface.wgsl'),
      timeDependent ? source.replace('vec3f(0.125)', 'vec3f(input.frameTime)') : source,
    );
    const material: MaterialAsset = {
      kind: 'material',
      surface: { model: 'standard', module: 'game::published_card' },
      parameters: standardSurfaceParameters([
        { name: 'baseColor', type: 'color' },
        { name: 'baseColorTexture', type: 'texture' },
        { name: 'roughness', type: 'f32' },
        { name: 'alphaCutoff', type: 'f32' },
      ]),
      values: {
        baseColor: [0.25, 0.5, 0.75, 1],
        baseColorTexture: TEXTURE,
        roughness: 0.375,
        alphaCutoff: 0,
      },
      passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
    };
    if (!timeDependent) {
      const engine = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
      const sources = buildMaterialSourceCatalog(
        await collectMaterialSources([directory, engine], [engine]),
      ).unwrap();
      const card = await cookRayMaterial({
        material: MATERIAL,
        table: { [MATERIAL]: material },
        sources,
        context: 'card-capture',
      });
      assert(card.ok, card.ok ? '' : JSON.stringify(card.error));
    }
    const cooked = await createMaterialPackCooker([directory]).cook({
      guid: MATERIAL,
      source: material,
      sourcePath: join(directory, 'material.json'),
    });
    return prepareRuntimeAssetPublication([
      { guid: MATERIAL, asset: cooked.payload as MaterialAsset, refs: cooked.refs },
      {
        guid: TEXTURE,
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data: new Uint8Array([
            255, 64, 32, 255, 32, 255, 64, 0, 64, 32, 255, 255, 255, 255, 255, 255,
          ]),
        },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The production Card factory and its bindings, with only the GPU port replaced by Null. */
export async function preparePublishedCards(
  fixture: Awaited<ReturnType<typeof customCardPublicationFixture>>,
) {
  const projected = fixture.project().unwrap();
  const device = await queryTestDevice();
  Object.assign(device.limits, {
    maxTextureDimension2D: 8192,
    maxSampledTexturesPerShaderStage: 16,
  });
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const sampler = device.createSampler({}).unwrap();
  const codes: string[] = [];
  const runtime = {
    device,
    shaderRegistry: fixture.shaders,
    gpuStore: store,
    deviceScope: { generation: 1 },
    getPipelineState: () => ({ defaultSampler: sampler }),
    createShaderModule: (...args: Parameters<typeof createShaderModule>) => {
      codes.push(args[1].code);
      return createShaderModule(...args);
    },
  } as unknown as RenderSystemInternals;
  const composition = packGlobalSdfComposition(
    projected.instances,
    probeGlobalProfile.grid,
  ).unwrap();
  const cards = await prepareProbeCards(
    runtime,
    projected.sources,
    projected.instances,
    composition.sources,
    { resolution: 16, budget: 16, maxCaptureBytes: 1024 * 1024 },
  );
  return { cards, device, codes, projected, store };
}

/** Actual cook -> Pack wire -> Registry -> World material -> retained Field rows. */
export async function customCardPublicationFixture(
  install: Awaited<ReturnType<typeof cookCustomCardPublication>>,
) {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry({ shaderRegistry: shaders });
  install(assets);
  const material = (await assets.load(MATERIAL, 'material')).unwrap();
  const texture = (await assets.load(TEXTURE, 'texture')).unwrap();
  const mesh = assets.create(await createProbeGlobalMesh(0.5, 0.5, 0.5)).unwrap();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const lease = createRenderReadLease(world);
  const context = renderMaterialContext(
    { backendKind: 'webgpu', storageBuffer: true },
    { maxSampledTexturesPerShaderStage: 16 },
  ).materialContext;
  assert(context);
  const caches = scene.materialSnapshotCacheStore(context);
  const draw = () => {
    world.update(0).unwrap();
    scene.extractComposition(
      world,
      assets,
      (request) =>
        extractSource(world, assets, caches, {
          materialContext: context,
          cull: 'none',
          renderables: request,
        }),
      lease,
    );
    const frame = scene.compositionRetainedScene();
    assert(frame);
    return frame;
  };
  let frame = draw();
  const rows = new SceneFieldRows();
  return {
    assets,
    shaders,
    world,
    texture,
    rows,
    get acceptedMaterial() {
      const slot = frame.slots.at(0);
      assert(slot);
      const resource = slot.snapshot.materials[0] ?? slot.snapshot.material;
      return frame.materials.get(resource)?.snapshot ?? resource.snapshot;
    },
    get projection() {
      return assets.getMaterialProjectionForPayload(
        frame.source.resolveAsset<MaterialAsset>(material).unwrap(),
      );
    },
    get frame() {
      return frame;
    },
    refresh() {
      frame = draw();
    },
    project() {
      return rows.update(
        frame,
        frame.source,
        { maxInstances: 8, maxFieldBytes: 1024 * 1024 },
        assets,
      );
    },
    dispose() {
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}
