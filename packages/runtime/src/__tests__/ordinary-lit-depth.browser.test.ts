import { FixedTime, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok, type RuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';

function renderValue<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error), { cause: result.error });
  return result.value;
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    startOrdinaryLitDepth(): Promise<{ id: string; guid: string; binding: RuntimeAssetBinding }>;
    stopOrdinaryLitDepth(id: string): Promise<void>;
  }
}

it.each([
  { sampleCount: 1, current: false },
  { sampleCount: 4, current: false },
  { sampleCount: 1, current: true },
] as const)('ordinary ECS custom-lit reads real scene depth with $sampleCount samples (current=$current) and restores the next shared View', async ({
  sampleCount,
  current,
}) => {
  const server = await commands.startOrdinaryLitDepth();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const errors: unknown[] = [];
  const copies: { buffer: Buffer; device: RhiDevice }[] = [];
  let observe = false;
  const pipeline: RenderPipeline = {
    build({ graph }, topology) {
      const color = createRenderPipelineTarget(graph, 'ordinary-color', {
        format: 'rgba8unorm',
        size: 'surface',
        sampleCount,
      }).unwrap();
      const resolved =
        sampleCount === 4
          ? createRenderPipelineTarget(graph, 'ordinary-resolved', {
              format: 'rgba8unorm',
              size: 'surface',
            }).unwrap()
          : color;
      const depth = createRenderPipelineTarget(graph, 'ordinary-depth', {
        format: 'depth32float-stencil8',
        size: 'surface',
        sampleCount,
      }).unwrap();
      const seed = addTypedScenePass(graph, {
        name: 'ordinary-seed',
        color,
        depth,
        selector: { LightMode: ['DepthSeed'] },
        clearColor: [0, 0, 0, 1],
      });
      if (!seed.ok) return seed;
      const scene = addTypedScenePass(graph, {
        name: 'ordinary-consumers',
        color,
        depth: current
          ? { ...depth, currentMaterialDepthExtent: { width: canvas.width, height: canvas.height } }
          : depth,
        materialSceneDepth: topology.materialSceneDepth,
        ...(sampleCount === 4 ? { resolve: resolved } : {}),
        selector: { LightMode: ['Forward'] },
        colorLoadOp: 'load',
        depthLoadOp: 'load',
      });
      if (!scene.ok) return scene;
      const read = graph.addCopyPass('ordinary-live-readback', {
        accesses: [{ resource: resolved.view, usage: 'copy-src' }],
        encode({ encoder, frame, resources }) {
          if (!observe) return;
          const buffer = frame.runtime.device.createBuffer({ size: 256 * 64, usage: 9 }).unwrap();
          encoder.copyTextureToBuffer(
            { texture: resources.texture(resolved.texture).unwrap() },
            { buffer, bytesPerRow: 256, rowsPerImage: 64 },
            { width: 64, height: 64, depthOrArrayLayers: 1 },
          );
          copies.push({ buffer, device: frame.runtime.device });
        },
      });
      if (!read.ok) return read;
      const surface = importRenderPipelineSurface(graph, topology);
      if (!surface.ok) return surface;
      return addTypedOutputTransformPass(graph, resolved, surface.value.storage, {
        outputOnly: true,
        dither: false,
      });
    },
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        pipeline,
        rhi: webgpu.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice(device) {
            renderValue(device.nativeDevice()).addEventListener('uncapturederror', (event) =>
              errors.push(event.error.message),
            );
            return ok(device);
          },
        },
      },
      {
        shaderManifestUrl: '/shaders/manifest.json',
        importTransport: createDevImportTransport(server.binding),
      },
    ),
  );
  const { renderer, assets } = host;
  const world = new World({ assets });
  try {
    assets.configureRuntimeBinding(server.binding);
    const lit = (await assets.load(renderValue(AssetGuid.parse(server.guid)), 'material')).unwrap();
    const quad = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    const seedSource = Materials.unlit([1, 0, 0, 1], { renderState: { cullMode: 'none' } });
    const seedPass = seedSource.passes?.[0];
    if (seedPass === undefined) throw new Error('missing seed material pass');
    const seed = assets
      .create({
        ...seedSource,
        passes: [
          {
            ...seedPass,
            renderState: { ...seedPass.renderState, tags: { LightMode: 'DepthSeed' } },
          },
        ],
      })
      .unwrap();
    const restore = assets
      .create(Materials.unlit([0, 0, 1, 1], { queue: 3100, renderState: { cullMode: 'none' } }))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 10,
            antialias: 0,
            bloom: 0,
            tonemap: 0,
          },
        },
      )
      .unwrap();
    const renderables = [
      { at: [0, 0, 0], scale: [3, 3, 1], material: seed },
      { at: [-0.5, 0, 0.2], scale: [0.8, 0.8, 1], material: lit },
      { at: [0.5, 0, 0.2], scale: [0.8, 0.8, 1], material: restore },
    ] as const;
    const [, litEntity] = renderables.map((row) =>
      world
        .spawn(
          { component: Transform, data: { pos: row.at, scale: row.scale } },
          { component: MeshFilter, data: { assetHandle: quad } },
          { component: MeshRenderer, data: { materials: [row.material] } },
        )
        .unwrap(),
    );
    if (litEntity === undefined) throw new Error('missing lit geometry');
    const lease = renderValue(renderer.attach(world));
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = renderValue(renderer.draw({ source: lease, geometryLane: 'direct' }));
      renderValue(await receipt.completed);
      return receipt;
    };
    await completeReadyFrame(draw);
    observe = true;
    await completeReadyFrame(draw);
    observe = false;
    const readback = copies.pop();
    if (readback === undefined) throw new Error('ordinary depth consumer produced no readback');
    const mapped = (await readback.buffer.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
    let green = 0,
      blue = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      if ((bytes[i + 1] ?? 0) > 200 && (bytes[i] ?? 0) < 20) green++;
      if ((bytes[i + 2] ?? 0) > 200 && (bytes[i + 1] ?? 0) < 20) blue++;
    }
    if (green <= 30 || blue <= 30 || errors.length > 0) {
      const colors = new Map<string, number>();
      for (let i = 0; i < bytes.length; i += 4) {
        const key = Array.from(bytes.subarray(i, i + 4)).join(',');
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
      await commands.writeFile(
        `artifacts/ordinary-lit-depth/${sampleCount}-failure.json`,
        JSON.stringify(
          { green, blue, colors: [...colors], errors, renderer: renderer.inspect() },
          null,
          2,
        ),
      );
    }
    expect(green).toBeGreaterThan(30);
    expect(blue).toBeGreaterThan(30);
    expect(errors).toEqual([]);
    mapped.unmap();
    readback.device.destroyBuffer(readback.buffer).unwrap();
    if (sampleCount === 1) {
      // Reuse the already exercised native Direct pipeline for the publication
      // receipt. Wave 1 owns the paired physics and scene-index publication.
      const replacement = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
      const prepared = renderValue(
        renderer.prepareDynamicGeometry({
          world,
          entity: litEntity,
          meshHandle: replacement,
          revision: 1,
        }),
      );
      const accepted = renderValue(
        renderer.acceptDynamicGeometry(prepared, {
          world,
          fixedStep: world.getResource(FixedTime).tick,
        }),
      );
      const recorded = await completeReadyFrame(draw);
      expect(world.get(litEntity, MeshFilter).unwrap().assetHandle).toBe(replacement);
      expect(renderer.dynamicGeometryReceipt(accepted)).toMatchObject({
        frameId: recorded.frameId,
        recordStageConsumed: true,
        recordStageLane: 'cpu',
      });
    }
  } finally {
    for (const copy of copies) copy.device.destroyBuffer(copy.buffer).unwrap();
    renderValue(await renderer.dispose());
    await commands.stopOrdinaryLitDepth(server.id);
    canvas.remove();
  }
}, 120_000);
