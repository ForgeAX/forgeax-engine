import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  ClippingPlanes,
  clippingPlanesData,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  type RecorderAttachment,
  type ReplayReadbackResult,
  replayDeviceRequest,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

function textureArrayLayers(
  resources: ReturnType<typeof buildFrameModel>['resources'],
  id: string,
) {
  const view = resources.find((resource) => resource.resourceId === id);
  const viewDescriptor = (view?.descriptor as { readonly desc?: unknown } | null)?.desc as
    | {
        readonly arrayLayerCount?: unknown;
        readonly baseArrayLayer?: unknown;
        readonly baseMipLevel?: unknown;
        readonly mipLevelCount?: unknown;
      }
    | undefined;
  const sourceHandleId = (view?.descriptor as { readonly sourceHandleId?: unknown } | null)
    ?.sourceHandleId;
  const texture =
    typeof sourceHandleId === 'string'
      ? resources.find((resource) => resource.resourceId === sourceHandleId)
      : view;
  const descriptor = (texture?.descriptor as { readonly desc?: unknown } | null)?.desc as
    | { readonly dimension?: unknown; readonly mipLevelCount?: unknown; readonly size?: unknown }
    | undefined;
  const size = descriptor?.size;
  const textureLayers = Array.isArray(size)
    ? size[2]
    : (size as { readonly depthOrArrayLayers?: unknown } | null)?.depthOrArrayLayers;
  const dimension = descriptor?.dimension ?? '2d';
  const baseMipLevel =
    typeof viewDescriptor?.baseMipLevel === 'number' ? viewDescriptor.baseMipLevel : 0;
  const sourceMipLevelCount =
    typeof descriptor?.mipLevelCount === 'number' ? descriptor.mipLevelCount : 1;
  const viewMipLevelCount =
    typeof viewDescriptor?.mipLevelCount === 'number'
      ? viewDescriptor.mipLevelCount
      : sourceMipLevelCount - baseMipLevel;
  if (
    typeof textureLayers !== 'number' ||
    !Number.isSafeInteger(textureLayers) ||
    textureLayers < 1 ||
    !Number.isSafeInteger(baseMipLevel) ||
    baseMipLevel < 0 ||
    !Number.isSafeInteger(sourceMipLevelCount) ||
    sourceMipLevelCount < 1 ||
    !Number.isSafeInteger(viewMipLevelCount) ||
    viewMipLevelCount < 1 ||
    baseMipLevel + viewMipLevelCount > sourceMipLevelCount
  )
    throw new Error(`missing array-layer count for shadow texture ${id}`);
  if (dimension === '3d') return Math.max(1, Math.floor(textureLayers / 2 ** baseMipLevel));
  const baseArrayLayer =
    typeof viewDescriptor?.baseArrayLayer === 'number' ? viewDescriptor.baseArrayLayer : 0;
  const layers =
    typeof viewDescriptor?.arrayLayerCount === 'number'
      ? viewDescriptor.arrayLayerCount
      : textureLayers - baseArrayLayer;
  if (
    !Number.isSafeInteger(baseArrayLayer) ||
    baseArrayLayer < 0 ||
    !Number.isSafeInteger(layers) ||
    layers < 1 ||
    baseArrayLayer + layers > textureLayers
  )
    throw new Error(`missing array-layer count for shadow texture ${id}`);
  return layers;
}

/** One production renderer journey shared by Browser WebGPU and native Dawn. */
export async function verifyClippingPlanes(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
  materials?: { assets: AssetRegistry; handles: readonly AssetHandle<'material'>[] },
) {
  const world = materials === undefined ? new World() : new World({ assets: materials.assets });
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
        },
      },
      { component: ClippingPlanes, data: clippingPlanesData({ planes: [] }) },
    )
    .unwrap();
  const mesh = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -6] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(4, 4, 0.1).unwrap())
            .unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            testAssets(world)
              .create(
                Materials.standard({
                  baseColor: [0.8, 0.1, 0.1, 1],
                  emissive: [1, 0, 0],
                  emissiveIntensity: 1,
                }),
              )
              .unwrap(),
          ],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        cascadeCount: testQuality.cascadeCount,
        direction: [0, 0, -1],
        intensity: 1,
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
      },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const devices: GPUDevice[] = [];
  const reports: unknown[] = [];
  let baselineShadowPixels = 0;
  const profile = renderer.inspect().profile;
  renderValue(renderer.setProfile({ ...profile, renderPath: 'forward', ssao: false }));
  const draw = async (direct: boolean, observe = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = await drawReadyFrame(
      renderer,
      {
        leases: [lease],
        camera: { lease },
        environment: { lease },
        ...(direct ? { geometryLane: 'direct' as const } : {}),
      },
      observe ? ['linear-hdr'] : undefined,
    );
    return receipt;
  };
  const pixel = (read: ReplayReadbackResult, x: number, y: number): number => {
    const data = new DataView(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
    const offset = (y * 64 + x) * (read.format === 'rgba16float' ? 8 : 4);
    if (read.format?.startsWith('depth') || read.format === 'r32float')
      return data.getFloat32(offset, true);
    if (read.format === 'rgba16float') return halfFloat.f16ToF32(data.getUint16(offset, true));
    return (read.bytes[offset] ?? Number.NaN) / 255;
  };
  try {
    let caseIndex = 0;
    let previousGpuShadowClipping: string | undefined;
    for (const [name, planes, intersection, clipShadows, direct] of [
      ['baseline', [], false, true, true],
      [
        'union',
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
        false,
        true,
        true,
      ],
      [
        'intersection',
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
        true,
        true,
        false,
      ],
      ['shadow-opt-out', [[1, 0, 0, 0]], false, false, false],
      ['disabled', [], false, true, false],
    ] as const) {
      if (materials !== undefined) {
        const material = materials.handles[caseIndex];
        if (material === undefined) throw new Error('missing cooked clipping material');
        world.set(mesh, MeshRenderer, { materials: [material] }).unwrap();
      }
      caseIndex += 1;
      world
        .set(
          camera,
          ClippingPlanes,
          clippingPlanesData({
            planes: materials === undefined ? planes : [],
            intersection,
            clipShadows,
          }),
        )
        .unwrap();
      await draw(direct);
      // Retained static shadow depth bakes the camera clipping casters honor,
      // so a change to it rebuilds every static layer in full.
      const shadowClipping =
        clipShadows && materials === undefined && planes.length > 0
          ? JSON.stringify([planes, intersection])
          : '';
      if (!direct && previousGpuShadowClipping !== undefined) {
        const staticReasons = renderer
          .inspect()
          .shadowRaster.views.filter((view) => view.identity.layer === 'static')
          .map((view) => ('invalidationReason' in view ? view.invalidationReason : 'hit'));
        expect(staticReasons.length, `${name} static shadow views`).toBeGreaterThan(0);
        if (shadowClipping !== previousGpuShadowClipping)
          expect(new Set(staticReasons), `${name} static shadow reasons`).toEqual(
            new Set(['view-clipping-changed']),
          );
      }
      if (!direct) previousGpuShadowClipping = shadowClipping;
      for (let frame = 1; frame < testQuality.staticFrames; frame++) await draw(direct);
      expect(errors).toEqual([]);
      if (renderer.requestObservation === undefined)
        throw new Error('missing live HDR observation');
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = await draw(direct, true);
      const live = renderValue(
        await renderer.observe(receipt, { include: ['linear-hdr'] }),
      ).observations?.find((item) => item.domain === 'linear-hdr');
      if (live === undefined) throw new Error('missing live HDR pixels');
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await save(`${name}.rhitape`, captured.bytes);
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      const geometry = model.works.find((work) =>
        work.pipeline.shaders.some(
          (shader) =>
            (shader.entryPoint === 'fs_main' || shader.entryPoint === 'fs_opaque') &&
            shader.source?.includes('clippedByPlanes'),
        ),
      );
      const shadows = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_shadow'),
      );
      if (geometry === undefined || geometry.attachments === null)
        throw new Error(`missing geometry ${name}`);
      expect(geometry.kind).toBe(direct ? 'drawIndexed' : 'drawIndexedIndirect');
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const raw = webgpu._internal_getRawDevice(device);
      if (!raw) throw new Error('missing replay device');
      devices.push(raw);
      raw.pushErrorScope('validation');
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const outputs = workOutputs(geometry);
        const colorOutput = outputs.find((output) => output.name === 'color0');
        const depthOutput = outputs.find((output) => output.name === 'depth');
        if (!colorOutput || !depthOutput) throw new Error('missing color/depth attachments');
        const shadowBinding = geometry.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 3,
        );
        const shadowMapId = shadowBinding?.resourceId;
        if (shadowMapId == null) throw new Error('missing shadow map binding');
        const layerCount = textureArrayLayers(model.resources, shadowMapId);
        const requests = [
          colorOutput.request,
          depthOutput.request,
          // Include the first out-of-range layer used by the old discovery loop.
          ...Array.from({ length: layerCount + 1 }, (_, arrayLayer) => ({
            resourceId: shadowMapId,
            workIndex: geometry.workIndex,
            subresource: { aspect: 'depth-only' as const, mipLevel: 0, arrayLayer },
          })),
        ];
        // All pixels come from one recorded work. Batch them so replay does not
        // restart the complete tape prefix once for each shadow-map layer.
        const batched = renderValue(await replay.readAtWorks(requests));
        const read = (index: number) => {
          const result = batched[index];
          if (result === undefined) throw new Error(`missing batched replay read ${index}`);
          return renderValue(result);
        };
        const color = read(0);
        const depth = read(1);
        expect(color.format).toBe('rgba16float');
        const liveData = new DataView(
          live.bytes.buffer,
          live.bytes.byteOffset,
          live.bytes.byteLength,
        );
        const replayData = new DataView(
          color.bytes.buffer,
          color.bytes.byteOffset,
          color.bytes.byteLength,
        );
        let liveReplayDifference = 0;
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 64 * 4; x++) {
            const a = halfFloat.f16ToF32(
              liveData.getUint16(y * live.metadata.bytesPerRow + x * 2, true),
            );
            const b = halfFloat.f16ToF32(replayData.getUint16(y * 64 * 8 + x * 2, true));
            liveReplayDifference = Math.max(liveReplayDifference, Math.abs(a - b));
          }
        expect(liveReplayDifference).toBeLessThanOrEqual(0.005);
        const samples = [
          [22, 22],
          [42, 22],
          [22, 42],
          [42, 42],
        ].map(([x, y]) => ({
          color: pixel(color, x ?? -1, y ?? -1),
          depth: pixel(depth, x ?? -1, y ?? -1),
        }));
        const expected =
          name === 'union'
            ? [false, true, false, false]
            : name === 'intersection'
              ? [true, true, false, true]
              : name === 'shadow-opt-out'
                ? [false, true, false, true]
                : [true, true, true, true];
        samples.forEach((sample, index) => {
          expect(sample.color > 0.2, `${name} color ${index}`).toBe(expected[index]);
          expect(sample.depth > 0, `${name} depth ${index}`).toBe(expected[index]);
        });
        // A retained shadow layer need not re-raster in the captured frame, so
        // measure the map the receiver samples rather than the raster passes.
        const shadowReads = shadows.map((work) => ({
          workIndex: work.workIndex,
          eventIndex: work.eventIndex,
        }));
        let shadowPixels = 0;
        for (let arrayLayer = 0; ; arrayLayer++) {
          const shadowResult = batched[arrayLayer + 2];
          if (shadowResult === undefined)
            throw new Error(`missing batched shadow read for layer ${arrayLayer}`);
          if (!shadowResult.ok) {
            if (arrayLayer === 0) throw shadowResult.error;
            break;
          }
          const shadowRead = shadowResult.value;
          if (shadowRead === undefined || shadowRead.format !== 'depth32float')
            throw new Error('missing shadow depth evidence');
          const depths = new Float32Array(
            shadowRead.bytes.buffer,
            shadowRead.bytes.byteOffset,
            shadowRead.bytes.byteLength / 4,
          );
          shadowPixels += depths.filter((value) => value > 0).length;
          if (arrayLayer >= layerCount)
            throw new Error('shadow texture descriptor omitted a readable array layer');
        }
        if (name === 'baseline') baselineShadowPixels = shadowPixels;
        expect(baselineShadowPixels).toBeGreaterThan(0);
        const shadowRatio = shadowPixels / baselineShadowPixels;
        const expectedShadowRatio = name === 'union' ? 0.25 : name === 'intersection' ? 0.75 : 1;
        expect(Math.abs(shadowRatio - expectedShadowRatio), `${name} shadow area`).toBeLessThan(
          0.05,
        );
        await save(`${name}-color.${color.format}`, color.bytes);
        await save(`${name}-depth.${depth.format}`, depth.bytes);
        reports.push({
          name,
          digest: captured.digest,
          workIndex: geometry.workIndex,
          eventIndex: geometry.eventIndex,
          draw: geometry.drawCall,
          samples,
          liveReplayDifference,
          shadowPixels,
          shadowRatio,
          shadows: shadowReads,
          unseeded: model.unseededResources,
        });
        expect(await raw.popErrorScope()).toBeNull();
      } finally {
        (await replay.dispose()).unwrap();
      }
    }
    expect(errors).toEqual([]);
    await save('report.json', new TextEncoder().encode(JSON.stringify(reports, null, 2)));
  } finally {
    unsubscribe();
    lease.dispose();
    for (const device of devices) device.destroy();
  }
}
