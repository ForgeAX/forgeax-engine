import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
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
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive, type TextureAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { renderValue } from './standard-gbuffer-replay.fixture';

type StandardOptions = Parameters<typeof Materials.standard>[0];
type SaveEvidence = (name: string, bytes: Uint8Array) => void | Promise<void>;
const delta = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? NaN))));
const sampleHdr = (bytes: Uint8Array, bytesPerRow: number, x = 32, y = 32) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [0, 1, 2].map((channel) =>
    halfFloat.f16ToF32(view.getUint16(y * bytesPerRow + x * 8 + channel * 2, true)),
  );
};

/** One production Surface journey shared by Browser WebGPU and native Dawn. */
export async function verifyNormalBump(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: SaveEvidence,
  frames = testQuality.staticFrames,
) {
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  const geometry = createPlaneGeometry(2.8, 2.8).unwrap();
  const uv0 = geometry.attributes.uv;
  if (!(uv0 instanceof Float32Array)) throw new Error('missing plane UVs');
  const attributes = {
    ...geometry.attributes,
    uv1: Float32Array.from(uv0, (v, i) => (i % 2 === 0 ? 1 - v : v)),
  };
  const mesh = world.allocSharedRef('MeshAsset', {
    ...geometry,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, uv0.length / 2).unwrap().vertices,
  });
  const texture = (data: Uint8Array, width: number, height: number) =>
    world.allocSharedRef('TextureAsset', {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width, height } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data,
    } satisfies TextureAsset);
  const normalTexture = { texture: texture(new Uint8Array([191, 159, 234, 255]), 1, 1) };
  // Independent Three r184 packed-normal oracle: reconstruct original Z,
  // scale XY, normalize, then encode a unit-strength reference map.
  const nx = (191 / 255) * 2 - 1;
  const ny = (159 / 255) * 2 - 1;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const oracleX = (nx * 2) / Math.hypot(nx * 2, nz);
  const normalOracle = {
    texture: texture(new Uint8Array([Math.round((oracleX + 1) * 127.5), 128, 255, 255]), 1, 1),
  };
  const heights = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      heights.set([x * 2 + y, 255 - x * 3, ((x + y) % 2) * 255, 255], i);
    }
  const bumpTexture = { texture: texture(heights, 64, 64) };
  const constantBump = { texture: texture(new Uint8Array([127, 255, 0, 255]), 1, 1) };
  const receiver = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 10,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.6, -0.3, -1], color: [1, 1, 1], intensity: 2, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const cases: readonly { name: string; options: Partial<StandardOptions> }[] = [
    { name: 'flat', options: {} },
    { name: 'normal-zero', options: { normalTexture, normalScale: [0, 0] } },
    {
      name: 'normal-grazing-zero',
      options: {
        normalTexture: { texture: texture(new Uint8Array([255, 128, 128, 255]), 1, 1) },
        normalScale: [0, 0],
      },
    },
    { name: 'normal-x', options: { normalTexture, normalScale: [2, 0] } },
    { name: 'normal-oracle', options: { normalTexture: normalOracle, normalScale: [1, 0] } },
    { name: 'normal-y', options: { normalTexture, normalScale: [0, 2] } },
    { name: 'normal-xy', options: { normalTexture, normalScale: [0.5, -1] } },
    { name: 'bump-zero', options: { bumpTexture, bumpScale: 0 } },
    { name: 'bump-constant', options: { bumpTexture: constantBump, bumpScale: 20 } },
    { name: 'bump', options: { bumpTexture, bumpScale: 8 } },
    { name: 'bump-negative', options: { bumpTexture, bumpScale: -8 } },
    {
      name: 'bump-uv1',
      options: { bumpTexture: { ...bumpTexture, coordinates: { set: 1 } }, bumpScale: 8 },
    },
    {
      name: 'bump-rotated',
      options: {
        bumpTexture: {
          ...bumpTexture,
          coordinates: { transform: { rotation: Math.PI, offset: [1, 1] } },
        },
        bumpScale: 8,
      },
    },
    {
      name: 'normal-priority',
      options: { normalTexture, normalScale: [0, 0], bumpTexture, bumpScale: 20 },
    },
  ];
  const evidence: unknown[] = [];
  const results = new Map<string, number[]>();
  const replayDevices: GPUDevice[] = [];
  try {
    for (const renderPath of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...original, renderPath, ssao: false }));
      for (const entry of cases) {
        const authored = Materials.standard({
          baseColor: [0.5, 0.5, 0.5, 1],
          metallic: 0,
          roughness: 1,
          renderState: { cullMode: 'none' },
          ...entry.options,
        } as StandardOptions);
        const material = world.allocSharedRef('MaterialAsset', authored);
        world.set(receiver, MeshRenderer, { materials: [material] }).unwrap();
        const draw = async () => {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          const receipt = renderValue(
            renderer.draw({
              geometryLane: 'direct',
              leases: [lease],
              camera: { lease },
              environment: { lease },
            }),
          );
          renderValue(await receipt.completed);
          return receipt;
        };
        for (let frame = 0; frame < frames - 1; frame++) await draw();
        renderValue(
          renderer.requestObservation?.(['linear-hdr']) ?? {
            ok: false,
            error: 'observation unavailable',
          },
        );
        const capture = ['normal-xy', 'bump'].includes(entry.name)
          ? recorder.captureFrame()
          : undefined;
        if (capture !== undefined) (await recorder.frameBoundary()).unwrap();
        const receipt = await draw();
        if (capture !== undefined) (await recorder.frameBoundary()).unwrap();
        const observed = renderValue(
          await renderer.observe(receipt, { include: ['linear-hdr'] }),
        ).observations?.find((v) => v.domain === 'linear-hdr');
        if (observed === undefined) throw new Error('HDR observation missing');
        const live = sampleHdr(observed.bytes, observed.metadata.bytesPerRow);
        expect(live.every(Number.isFinite)).toBe(true);
        expect(Math.max(...live)).toBeGreaterThan(0.01);
        results.set(`${renderPath}/${entry.name}`, live);
        await save(`${renderPath}-${entry.name}-live.rgba16f`, observed.bytes);
        const facts: Record<string, unknown> = {
          renderPath,
          case: entry.name,
          completedFrames: frames,
          live,
        };
        if (capture !== undefined) {
          const encoded = (await capture).unwrap();
          const name = `${renderPath}-${entry.name}`;
          await save(`${name}.rhitape`, encoded.bytes);
          const tape = decodeTape(encoded.bytes).unwrap();
          const model = buildFrameModel(tape);
          const geometryWork = model.works.find((work) =>
            work.pipeline.shaders.some((shader) =>
              renderPath === 'forward'
                ? shader.entryPoint === 'fs_main' || shader.entryPoint === 'fs_opaque'
                : shader.entryPoint === 'fs_gbuffer',
            ),
          );
          const lightingWork =
            renderPath === 'forward'
              ? geometryWork
              : model.works.find((work) =>
                  work.pipeline.shaders.some((shader) =>
                    shader.entryPoint?.startsWith('fs_standard_deferred'),
                  ),
                );
          if (geometryWork === undefined || lightingWork === undefined)
            throw new Error('production normal/bump draw missing');
          expect(
            geometryWork.pipeline.shaders.some((shader) =>
              shader.source?.includes('perturbBumpNormal'),
            ),
          ).toBe(true);
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (
            await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
          ).unwrap();
          const rawDevice = webgpu._internal_getRawDevice(device);
          if (rawDevice === undefined) throw new Error('fresh replay device unavailable');
          replayDevices.push(rawDevice);
          const replayErrors: string[] = [];
          rawDevice.addEventListener('uncapturederror', (event) =>
            replayErrors.push(event.error.message),
          );
          rawDevice.pushErrorScope('validation');
          const replay = (
            await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
          ).unwrap();
          try {
            const inspection = (
              await replay.inspectWork(lightingWork.workIndex, ['pipeline', 'bindings', 'pixels'])
            ).unwrap();
            if (inspection.attachment === undefined) throw new Error('RHI replay pixels missing');
            expect(inspection.attachment.format).toBe('rgba16float');
            const replaySample = sampleHdr(inspection.attachment.bytes, 64 * 8);
            let replayDelta = 0;
            for (let y = 8; y < 56; y++)
              for (let x = 8; x < 56; x++) {
                replayDelta = Math.max(
                  replayDelta,
                  delta(
                    sampleHdr(observed.bytes, observed.metadata.bytesPerRow, x, y),
                    sampleHdr(inspection.attachment.bytes, 64 * 8, x, y),
                  ),
                );
              }
            await save(`${name}-replay.rgba16f`, inspection.attachment.bytes);
            expect(replayDelta).toBeLessThanOrEqual(0.005);
            const uniform = geometryWork.bindings.find(
              (binding) => binding.groupIndex === 1 && binding.binding === 0,
            );
            if (uniform?.resourceId == null) throw new Error('material UBO missing');
            const buffer = (await replay.readResource(uniform.resourceId)).unwrap();
            const numeric = derive(STANDARD_PIPELINE_PARAM_SCHEMA).numericMembers;
            const field = numeric.find(
              (v) => v.name === (entry.name === 'bump' ? 'bumpScale' : 'normalScale'),
            );
            if (field === undefined) throw new Error('scale ABI missing');
            const view = new DataView(
              buffer.bytes.buffer,
              buffer.bytes.byteOffset,
              buffer.bytes.byteLength,
            );
            const offset = (uniform.bufferOffset ?? 0) + field.offset;
            const scale =
              entry.name === 'bump'
                ? [view.getFloat32(offset, true)]
                : [view.getFloat32(offset, true), view.getFloat32(offset + 4, true)];
            expect(scale).toEqual(entry.name === 'bump' ? [8] : [0.5, -1]);
            const textureName = 'normalTexture';
            const textureField = derive(STANDARD_PIPELINE_PARAM_SCHEMA).resourceBindings.find(
              (v) => v.name === textureName,
            );
            const textureBinding = geometryWork.bindings.find(
              (v) => v.groupIndex === 1 && v.binding === textureField?.binding,
            );
            if (textureBinding?.resourceId == null)
              throw new Error('normal/bump texture binding missing');
            const pixels = (await replay.readResource(textureBinding.resourceId)).unwrap();
            expect(Array.from(pixels.bytes)).toEqual(
              Array.from(entry.name === 'bump' ? heights : new Uint8Array([191, 159, 234, 255])),
            );
            const textureResource = model.resources.find(
              (v) => v.resourceId === textureBinding.resourceId,
            );
            const sourceId = (
              textureResource?.descriptor as { sourceHandleId?: string } | undefined
            )?.sourceHandleId;
            const inputLineage = model.resources.filter((v) =>
              [uniform.resourceId, textureBinding.resourceId, sourceId].includes(v.resourceId),
            );
            expect(
              model.unseededResources.filter((v) =>
                inputLineage.some((input) => input.resourceId === v.resourceId),
              ),
            ).toEqual([]);
            expect(await rawDevice.popErrorScope()).toBeNull();
            expect(replayErrors).toEqual([]);
            Object.assign(facts, {
              digest: tapeDigest(encoded.bytes),
              workIndex: geometryWork.workIndex,
              eventIndex: geometryWork.eventIndex,
              replayWorkIndex: lightingWork.workIndex,
              replaySample,
              replayDelta,
              scale,
              inputLineage,
              comparedPixels: 48 * 48,
              bindings: geometryWork.bindings,
              unseededResources: model.unseededResources,
            });
          } finally {
            (await replay.dispose()).unwrap();
          }
        }
        evidence.push(facts);
        await save('report.json', new TextEncoder().encode(JSON.stringify(evidence, null, 2)));
      }
      const value = (name: string) => results.get(`${renderPath}/${name}`) ?? [];
      for (const flat of [
        'normal-zero',
        'normal-grazing-zero',
        'bump-zero',
        'bump-constant',
        'normal-priority',
      ])
        expect(delta(value('flat'), value(flat)), flat).toBeLessThanOrEqual(0.002);
      for (const changed of [
        'normal-x',
        'normal-y',
        'normal-xy',
        'bump',
        'bump-negative',
        'bump-uv1',
      ])
        expect(delta(value('flat'), value(changed)), changed).toBeGreaterThan(0.005);
      expect(delta(value('normal-x'), value('normal-oracle'))).toBeLessThanOrEqual(0.005);
      expect(delta(value('normal-x'), value('normal-y'))).toBeGreaterThan(0.005);
      expect(delta(value('bump'), value('bump-negative'))).toBeGreaterThan(0.01);
      expect(delta(value('bump'), value('bump-uv1'))).toBeGreaterThan(0.005);
      expect(delta(value('bump-negative'), value('bump-rotated'))).toBeLessThanOrEqual(0.01);
    }
    for (const entry of cases)
      expect(
        delta(
          results.get(`forward/${entry.name}`) ?? [],
          results.get(`deferred/${entry.name}`) ?? [],
        ),
        entry.name,
      ).toBeLessThanOrEqual(0.05);
    expect(errors).toEqual([]);
  } catch (error) {
    await save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify({ error: String(error), errors, renderer: renderer.inspect() }, null, 2),
      ),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
    for (const device of replayDevices) device.destroy();
  }
}
