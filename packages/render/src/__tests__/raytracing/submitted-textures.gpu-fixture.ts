import {
  AssetRegistry,
  createMaterialLoader,
  HANDLE_CUBE,
  RuntimeMaterialValue,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok, type TextureAsset } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { renderPublicationTransfers } from '../../publication/contract';
import { installPublicationPrograms } from '../../publication/programs';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { prepareSurfaceMaterialTextures } from '../../raytracing/material-residency';
import { createSubmittedRayPathTracer } from '../../raytracing/path-tracer';
import { rayReferenceFailure } from '../../raytracing/scene';
import type { RayPublicationFixture } from './path-tracer.commands';
import { plane, readBuffer } from './path-tracer.fixture';

/** Texture/sampler publication, Renderer residency and dynamic MASK meet in actual ray hits. */
export async function verifySubmittedTextures(fixture: RayPublicationFixture) {
  const material = fixture.material;
  assert(material.name === 'cutout');
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const received = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const record = validateCookedMaterialRecord(
    JSON.parse(material.cookedPublication.record),
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid: material.name,
      record,
      artifacts: Object.fromEntries(
        Object.entries(material.cookedPublication.artifacts).map(([path, bytes]) => [
          path,
          { bytes: new TextEncoder().encode(bytes) },
        ]),
      ),
    }),
  }).load({ guid: material.name, specializationKey: record.specializationKey ?? '' });
  assert(ready.status === 'Ready', JSON.stringify(ready));
  assets.catalog(material.name, material.asset).unwrap();
  assets.recordMaterialReadiness(material.name, ready);
  assets
    .catalog('coverage', {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]),
    })
    .unwrap();
  assets
    .catalog('nearest', { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' })
    .unwrap();
  const world = new World();
  const handle = world.internSharedRef('MaterialAsset', material.asset);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  const value = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'alphaCutoff',
        kind: 0,
        value: [0.5],
      },
    })
    .unwrap();
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('cube publication is outside this texture fixture');
    },
    device.caps,
  );
  const defaultSampler = device
    .createSampler({ minFilter: 'linear', magFilter: 'linear' })
    .unwrap();
  const identity = { source: 'submitted-ray-textures', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, device.caps);
  const receiver = new RenderPublicationReceiver(identity);
  const outputs: Uint8Array[] = [];
  const facts: { cutoff: number; preparationCpuMs: number; values: number[] }[] = [];
  try {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    for (const cutoff of [0.5, 0, 0.5]) {
      world.set(value, RuntimeMaterialValue, { value: [cutoff] }).unwrap();
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      installPublicationPrograms(received, packet.programs);
      const accepted = receiver.accept(packet).unwrap();
      const snapshot = accepted.frame.renderables[0]?.material;
      assert(snapshot?.materialSurfacePrograms?.['ray-hit']);
      expect(snapshot.materialSurfacePrograms?.['ray-hit'].evaluateCoverage).toBe(cutoff > 0);
      const schema = received.shaderRegistry
        .findMaterialArtifact(snapshot.materialSurfacePrograms['ray-hit'].programKey)
        .unwrap().paramSchema;
      const start = performance.now();
      const prepared = prepareSurfaceMaterialTextures(
        store,
        defaultSampler,
        schema,
        accepted.resources,
        snapshot,
      ).unwrap();
      const textures = prepared.textures;
      const binding = textures.get('baseColorTexture');
      assert(binding);
      expect(binding.sampler).not.toBe(defaultSampler);
      const duplicate = prepareSurfaceMaterialTextures(
        store,
        defaultSampler,
        schema,
        accepted.resources,
        snapshot,
      ).unwrap();
      expect(duplicate.textures.get('baseColorTexture')).toEqual(binding);
      await duplicate.release();
      for (const invalid of [
        { ...snapshot, textureHandles: new Map() },
        { ...snapshot, samplerHandles: new Map() },
      ]) {
        const result = prepareSurfaceMaterialTextures(
          store,
          defaultSampler,
          schema,
          accepted.resources,
          invalid,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('ray-reference-invalid');
      }
      const textureHandle = snapshot.textureHandles?.get('baseColorTexture');
      assert(textureHandle);
      const retainedTexture = store._getTextureGpuTexture(textureHandle, accepted.resources);
      assert(retainedTexture);
      const textureAsset = resolveAssetHandle<TextureAsset>(
        accepted.resources,
        textureHandle,
      ).unwrap();
      expect(store.evictTexture(textureHandle, accepted.resources).freed).toBe(0);
      expect(store.releaseUnreferenced(new Set()).freed).toBe(0);
      expect(retainedTexture.isDestroyed).toBe(false);
      let replaced = false;
      const tracer = (
        await createSubmittedRayPathTracer(
          device,
          async (device, descriptor) => {
            if (!replaced) {
              replaced = true;
              // The transport has begun async shader preparation. Replace the
              // cache entry while its accepted texture binding is still borrowed.
              (
                await store.uploadTexture(
                  textureHandle,
                  textureAsset,
                  {
                    bytes: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]),
                    width: 2,
                    height: 1,
                    mime: 'image/png',
                    colorSpace: 'linear',
                    mipmap: false,
                  },
                  accepted.resources,
                )
              ).unwrap();
              expect(store.getTextureGpuView(textureHandle, accepted.resources)).not.toBe(
                binding.view,
              );
              expect(retainedTexture.isDestroyed).toBe(false);
            }
            return recorder.backend.createShaderModule(device, descriptor);
          },
          {
            generationFence: {
              capturedGeneration: packet.revision,
              currentGeneration: () => receiver.acceptedRevision,
            },
            kernel: fixture.kernel,
            scene: buildRaySurfaceScene([plane()]).unwrap(),
            materials: [{ id: 0, snapshot }],
            shaders: received.shaderRegistry,
            resolveTexture: (_id, name) => {
              const value = textures.get(name);
              return value ? ok(value) : rayReferenceFailure(`missing prepared texture ${name}`);
            },
            lights: [
              {
                kind: 'directional',
                contactShadowLength: 0,
                direction: vec3.create(0, 0, -1),
                color: vec3.create(Math.PI, Math.PI, Math.PI),
                intensity: Math.PI,
              },
            ],
            settings: {
              width: 2,
              height: 1,
              maxBounces: 1,
              seed: 47,
              environment: [0, 0, 0],
              maxDistance: 120,
              rays: [-10, 10].map((x) => ({
                origin: [x, 0, 2],
                direction: [0, 0, -1],
                coneWidth: 0,
                coneSpread: 0,
                active: true,
              })),
            },
          },
        )
      ).unwrap();
      const preparationCpuMs = performance.now() - start;
      try {
        const encoder = device.createCommandEncoder({}).unwrap();
        tracer.recordSample(encoder).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const completion = device.queue.onSubmittedWorkDone();
        prepared.track(completion);
        const released = prepared.release();
        expect(retainedTexture.isDestroyed).toBe(false);
        await completion;
        await released;
        expect(retainedTexture.isDestroyed).toBe(true);
        const bytes = await readBuffer(device, tracer.buffers.accumulation, 160);
        outputs.push(bytes);
        const floats = new Float32Array(bytes.buffer);
        // F0=0 derives F90=0 (F90 = saturate(50 * F0)), so the Standard lobe
        // carries no specular and unit cosines with light radiance PI give exactly 1.
        const lit = 1;
        expect(floats[0]).toBeCloseTo(cutoff > 0 ? 0 : lit, 5);
        expect(floats[20]).toBeCloseTo(lit, 5);
        const words = new Uint32Array(bytes.buffer);
        expect([words[3], words[23], words[7], words[27]]).toEqual([1, 1, 0, 0]);
        facts.push({ cutoff, preparationCpuMs, values: [floats[0] ?? NaN, floats[20] ?? NaN] });
      } finally {
        tracer.dispose();
        await prepared.release();
      }
      const transfers = renderPublicationTransfers(packet);
      publisher
        .recycle(packet.revision, structuredClone(transfers, { transfer: transfers }))
        .unwrap();
    }
    store.destroyAll();
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await capture).unwrap().bytes;
    raw.destroy();
    const tape = decodeTape(bytes).unwrap();
    const model = buildFrameModel(tape);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      const works = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'accumulate'),
      );
      expect(works).toHaveLength(3);
      for (const [i, work] of works.entries()) {
        const output = work.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 6,
        );
        assert(output?.resourceId);
        expect(
          (await replay.readResourceAtWork(output.resourceId, work.workIndex)).unwrap().bytes,
        ).toEqual(outputs[i]);
      }
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return { bytes, outputs, facts };
  } finally {
    store.destroyAll();
    publisher.dispose();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
