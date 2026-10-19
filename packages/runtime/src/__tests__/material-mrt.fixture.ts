import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { type MaterialAsset, ok, type RuntimeAssetBinding } from '@forgeax/engine-types';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

export async function verifyMaterialMrt(options: {
  binding: RuntimeAssetBinding;
  guid: string;
  shaderManifestUrl: string;
  save(name: string, bytes: Uint8Array): void | Promise<void>;
}) {
  const errors: unknown[] = [];
  let surface: GPUTexture | undefined;
  let rawDevice: GPUDevice | undefined;
  let size = 32;
  const canvas = {
    width: size,
    height: size,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        rawDevice = config.device;
        rawDevice.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        surface?.destroy();
        surface = rawDevice.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const copies: {
    buffer: Buffer;
    device: RhiDevice;
    format: string;
    size: number;
    stride: number;
  }[] = [];
  let observe = false;
  const pipeline: RenderPipeline = {
    build({ graph }, topology) {
      const formats = ['rgba16float', 'r32uint', 'rgba8unorm', 'rgba16float'] as const;
      const colors = formats.map((format, i) =>
        createRenderPipelineTarget(graph, `mrt-${i}`, {
          format,
          size: 'surface',
          usage: 0x15,
        }).unwrap(),
      );
      const color = colors[0];
      if (color === undefined) throw new Error('missing MRT color target');
      const depth = createRenderPipelineTarget(graph, 'mrt-depth', {
        format: 'depth32float-stencil8',
        size: 'surface',
      }).unwrap();
      const scene = addTypedScenePass(graph, {
        name: 'material-mrt',
        color: color,
        colorTargets: colors,
        depth,
        selector: { LightMode: ['Forward'] },
        colorClearValues: [
          [0.125, 0.125, 0.125, 0],
          [0, 0, 0, 0],
          // Preserve byte 128 through the masked attachment without placing
          // its clear value halfway between UNORM8 bytes 127 and 128.
          [0, 0.25, 128 / 255, 1],
          [0, 0, 0, 0],
        ],
      });
      if (!scene.ok) return scene;
      const copied = graph.addCopyPass('mrt-live-readback', {
        accesses: colors.map((target) => ({ resource: target.view, usage: 'copy-src' as const })),
        encode({ encoder, frame, resources }) {
          if (!observe) return;
          for (const target of colors) {
            const stride =
              Math.ceil((size * (target.format === 'rgba16float' ? 8 : 4)) / 256) * 256;
            const buffer = frame.runtime.device
              .createBuffer({ size: stride * size, usage: 9 })
              .unwrap();
            encoder.copyTextureToBuffer(
              { texture: resources.texture(target.texture).unwrap() },
              { buffer, bytesPerRow: stride, rowsPerImage: size },
              { width: size, height: size, depthOrArrayLayers: 1 },
            );
            copies.push({
              buffer,
              device: frame.runtime.device,
              format: target.format,
              size,
              stride,
            });
          }
        },
      });
      if (!copied.ok) return copied;
      const display = importRenderPipelineSurface(graph, topology);
      if (!display.ok) return display;
      return addTypedOutputTransformPass(graph, color, display.value.storage, {
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
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice(device) {
            return ok(recorder.backend.unwrapDeviceForSurface(device).unwrap());
          },
        },
      },
      {
        shaderManifestUrl: options.shaderManifestUrl,
        importTransport: createDevImportTransport(options.binding),
      },
    ),
  );
  const { renderer, assets } = host;
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const devices: GPUDevice[] = [];
  try {
    assets.configureRuntimeBinding(options.binding);
    const material = renderValue(
      await assets.loadByGuid<MaterialAsset>(renderValue(AssetGuid.parse(options.guid))),
    );
    expect(material.passes?.[0]?.outputs).toHaveLength(4);
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
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef(
              'MeshAsset',
              createBoxGeometry(1.5, 1.5, 1.5).unwrap(),
            ),
          },
        },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', material)] },
        },
      )
      .unwrap();
    const lease = renderValue(renderer.attach(world));
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = renderValue(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          geometryLane: 'direct',
        }),
      );
      renderValue(await receipt.completed);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    for (let i = 0; i < testQuality.staticFrames; i++) await draw();
    for (const extent of [32, 48]) {
      size = extent;
      canvas.width = canvas.height = extent;
      for (let i = 0; i < 3; i++) await draw();
      observe = true;
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const encoded = (await capture).unwrap();
      observe = false;
      await options.save(`${extent}.rhitape`, encoded.bytes);
      const tape = decodeTape(encoded.bytes).unwrap();
      const model = buildFrameModel(tape);
      const work = model.works.find(
        (item) =>
          item.attachments?.colorViewHandleIds.length === 4 &&
          (item.kind === 'draw' || item.kind === 'drawIndexed'),
      );
      if (work?.attachments === null || work === undefined)
        throw new Error('MRT draw absent from real frame');
      const live: Uint8Array[] = [];
      for (const copy of copies.splice(0)) {
        const mapped = (await copy.buffer.mapAsync(1)).unwrap();
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
        const bpp = copy.format === 'rgba16float' ? 8 : 4;
        const packed = new Uint8Array(size * size * bpp);
        for (let row = 0; row < size; row++)
          packed.set(
            bytes.subarray(row * copy.stride, row * copy.stride + size * bpp),
            row * size * bpp,
          );
        mapped.unmap();
        copy.device.destroyBuffer(copy.buffer).unwrap();
        live.push(packed);
      }
      expect(live).toHaveLength(4);
      const [colorPixels, idPixels, maskPixels, dataPixels] = live;
      if (!colorPixels || !idPixels || !maskPixels || !dataPixels)
        throw new Error('missing live MRT attachment');
      const center = (size / 2) * size + size / 2;
      expect(
        [...new Uint16Array(colorPixels.buffer).slice(center * 4, center * 4 + 4)].map(
          halfFloat.f16ToF32,
        ),
      ).toEqual([0.375, 0.625, 0.875, 1]);
      expect(new Uint32Array(idPixels.buffer)[center]).toBe(123456789);
      expect([...maskPixels.slice(center * 4, center * 4 + 4)]).toEqual([191, 64, 128, 255]);
      expect(
        [...new Uint16Array(dataPixels.buffer).slice(center * 4, center * 4 + 4)].map(
          halfFloat.f16ToF32,
        ),
      ).toEqual([-2, 0.125, 4, 1]);
      expect(new Uint32Array(idPixels.buffer)[0]).toBe(0);
      for (const falsify of [false, true]) {
        const replayTape = falsify
          ? decodeTape(
              encodeTape({
                ...tape,
                events: tape.events.map((event, index) =>
                  index === work.eventIndex
                    ? event.kind === 'drawIndexed'
                      ? { ...event, indexCount: 0 }
                      : event.kind === 'draw'
                        ? { ...event, vertexCount: 0 }
                        : event
                    : event,
                ),
              }).unwrap(),
            ).unwrap()
          : tape;
        if (falsify)
          await options.save(`${extent}-missing-draw.rhitape`, encodeTape(replayTape).unwrap());
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(
            replayDeviceRequest(replayTape, adapter.features, adapter.limits),
          )
        ).unwrap();
        const raw = webgpu._internal_getRawDevice(device);
        if (raw === undefined) throw new Error('missing replay device');
        devices.push(raw);
        raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const replay = (
          await openReplay(replayTape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const inspection = (
            await replay.inspectWork(work.workIndex, ['pipeline', 'bindings'])
          ).unwrap();
          if (!falsify)
            await options.save(
              `${extent}-inspection.json`,
              new TextEncoder().encode(JSON.stringify(inspection, null, 2)),
            );
          for (const [index, id] of work.attachments.colorViewHandleIds.entries()) {
            const pixels = (await replay.readResourceAtWork(id, work.workIndex)).unwrap();
            const expected = live[index];
            if (expected === undefined) throw new Error('missing reference pixels');
            if (falsify) expect([...pixels.bytes]).not.toEqual([...expected]);
            else expect([...pixels.bytes]).toEqual([...expected]);
          }
        } finally {
          (await replay.dispose()).unwrap();
        }
      }
      await options.save(
        `${extent}.json`,
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: tapeDigest(encoded.bytes),
              workIndex: work.workIndex,
              eventIndex: work.eventIndex,
              attachments: work.attachments,
              unseededResources: model.unseededResources,
              extent,
              colorBlend: [0.375, 0.625, 0.875, 1],
              objectId: 123456789,
              maskBytes: [191, 64, 128, 255],
              screenData: [-2, 0.125, 4, 1],
              liveReplayEqual: true,
              missingDrawFalsifier: true,
            },
            null,
            2,
          ),
        ),
      );
    }
    expect(errors).toEqual([]);
  } catch (error) {
    await options.save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify(
          { error, errors, renderer: renderer.inspect() },
          (_key, value) =>
            value instanceof Error
              ? { ...value, message: value.message, cause: value.cause }
              : value,
          2,
        ),
      ),
    );
    throw error;
  } finally {
    for (const copy of copies) copy.device.destroyBuffer(copy.buffer).unwrap();
    renderValue(await renderer.dispose());
    surface?.destroy();
    (await recorder.dispose()).unwrap();
    for (const device of devices) device.destroy();
    rawDevice?.destroy();
  }
}
