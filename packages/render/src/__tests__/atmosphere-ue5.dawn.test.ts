import { readFileSync } from 'node:fs';
import { halfFloat } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { loadCloudRendererModules } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { addAtmosphereLuts, atmosphereAccesses } from '../environment/luts';
import { settleAtmospherePublish } from '../environment/storage';
import { writeAtmosphereUniform } from '../environment/uniform';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import { earthAtmosphere } from './atmosphere-fixture';

it('executes the UE atmosphere graph and reads its actual LUT and buffer outputs', async ({
  skip,
}) => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  if (!adapter.features.has('rg11b10ufloat-renderable')) {
    skip('The selected adapter cannot render packed HDR textures');
    return;
  }
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['rg11b10ufloat-renderable'] })
  ).unwrap();
  const deviceScope = DeviceScope.create(1, 'ue5-atmosphere-test');
  try {
    const { imports } = await loadCloudRendererModules();
    const compile = async (filename: string) => {
      const id = new URL(`../../../shader/src/${filename}`, import.meta.url);
      return (
        await compileShader(readFileSync(id, 'utf8'), {
          id: id.pathname,
          imports,
          defines: { ATMOSPHERE_UTILITY_SHADOWS: true },
        })
      ).unwrap().wgsl;
    };
    const luts = await compile('atmosphere-luts.wgsl');
    const lutsFragment = await compile('atmosphere-luts-fragment.wgsl');
    const view = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 0x48 }).unwrap();
    const viewValues = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    for (const index of [0, 5, 10, 15, 44, 49, 54, 59]) viewValues[index] = 1;
    viewValues.set([0, -0.6, 0.8], 16);
    viewValues.set([100000, 100000, 100000], 20);
    viewValues.set([0, 1000, 0], 24);
    const atmosphere = { ...earthAtmosphere, aerialPerspectiveStart: 100 };
    writeAtmosphereUniform(viewValues, 292, atmosphere, 0, 0.01);
    expect(viewValues[314]).toBeCloseTo(0.1, 7);
    expect(viewValues[318]).toBe(96);
    expect(viewValues[319]).toBe(5);
    device.queue.writeBuffer(view, 0, viewValues).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const parameters = graph
      .importBuffer('capture-parameters', { size: VIEW_UNIFORM_BYTES, usage: 0x48 }, () => view)
      .unwrap();
    const generated = addAtmosphereLuts(graph, parameters, () => true, {}, false, true).unwrap();
    if (generated.execution !== 'compute-volume' || generated.distantSkyBuffer === undefined)
      throw new Error('UE atmosphere mode was not projected');
    expect(
      atmosphereAccesses(generated).some(
        (access) =>
          access.resource === generated.distantSkyBuffer && access.usage === 'storage-read',
      ),
    ).toBe(true);
    const readback = device.createBuffer({ size: 5 * 256, usage: 9 }).unwrap();
    const readbackPort = graph
      .importBuffer('ue5-atmosphere-readback', { size: 5 * 256, usage: 9 }, () => readback)
      .unwrap();
    const observers = [
      generated.transmittance,
      generated.multipleScattering,
      generated.skyView,
      generated.aerialPerspective,
    ];
    const distant = generated.distantSkyBuffer;
    graph
      .addCopyPass('read-ue5-atmosphere', {
        accesses: [
          ...observers.map((resource) => ({ resource, usage: 'copy-src' as const })),
          { resource: distant, usage: 'copy-src' },
          { resource: readbackPort, usage: 'copy-dst' },
        ],
        encodeDirect: (encoder, _frame, resources) => {
          for (const [index, resource] of observers.entries()) {
            const source = resources.textureViewSource?.(resource)?.unwrap();
            if (source === undefined) throw new Error('Missing texture readback source');
            encoder.copyTextureToBuffer(
              {
                texture: source.texture,
                origin: [
                  { x: 0, y: 0, z: 0 },
                  { x: 30, y: 2, z: 0 },
                  { x: 0, y: 24, z: 0 },
                  { x: 16, y: 16, z: 15 },
                ][index] ?? { x: 0, y: 0, z: 0 },
              },
              { buffer: readback, offset: index * 256, bytesPerRow: 256, rowsPerImage: 1 },
              { width: 1, height: 1, depthOrArrayLayers: 1 },
            );
          }
          encoder.copyBufferToBuffer(resources.buffer(distant).unwrap(), 0, readback, 1024, 16);
        },
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    try {
      const resources = compiled
        .inspect()
        .resources.filter(({ label }) => label.startsWith('atmosphere-'));
      expect(
        resources.filter(({ kind }) => kind === 'texture').map(({ descriptor }) => descriptor),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ format: 'rg11b10ufloat', width: 256, height: 64 }),
          expect.objectContaining({ format: 'rg11b10ufloat', width: 32, height: 32 }),
          expect.objectContaining({ format: 'rg11b10ufloat', width: 192, height: 104 }),
          expect.objectContaining({
            format: 'rgba16float',
            width: 32,
            height: 32,
            depthOrArrayLayers: 16,
          }),
        ]),
      );
      expect(resources.filter(({ kind }) => kind === 'texture')).toHaveLength(4);
      const state = {
        environmentFrame: selectEnvironment({
          environments: [{ kind: 'atmosphere', entityKey: 1, sourceKey: 'ue5', atmosphere }],
          fogs: [],
          suns: [{ entityKey: 2, direction: [0, 0.6, -0.8], color: [1, 1, 1], intensity: 100000 }],
        }).unwrap(),
        pendingAtmospherePublish: undefined,
      };
      const white = device
        .createTexture({ format: 'rgba8unorm', size: { width: 1, height: 1 }, usage: 4 })
        .unwrap();
      const shadow = device
        .createTexture({
          format: 'depth32float',
          size: { width: 1, height: 1, depthOrArrayLayers: 2 },
          usage: 4,
        })
        .unwrap();
      const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      compiled
        .execute({
          encoder,
          camera: {
            position: [0, 1000, 0],
            world: viewValues.subarray(0, 16),
            near: 0.01,
            far: 200000,
          },
          frameState: state,
          pipelineState: {
            viewUniformBuffer: view,
            perPassResources: {
              shadowSampler: device.createSampler({ compare: 'greater-equal' }).unwrap(),
            },
            defaultWhiteTextureView: device.createTextureView(white, {}).unwrap(),
            shadowArrayFallbackTextureView: device
              .createTextureView(shadow, { dimension: '2d-array' })
              .unwrap(),
            viewLinearSampler: sampler,
          },
          atmosphereShaders: { luts, lutsFragment },
          runtime: {
            device,
            deviceScope,
            shaderModuleFactory: {
              createShaderModule: ({ label, code }: { label: string; code: string }) =>
                createShaderModuleImmediate(device, { label, code }),
            },
          },
        } as unknown as RenderPipelineFrame)
        .unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      compiled.commitExecution();
      settleAtmospherePublish(state, true);
      const mapped = (await readback.mapAsync(1)).unwrap();
      try {
        const pixels = mapped.getMappedRange().unwrap();
        const bytes = new DataView(pixels);
        expect(bytes.getUint32(0, true)).toBeGreaterThan(0);
        expect(bytes.getUint32(256, true)).toBeGreaterThan(0);
        expect(bytes.getUint32(512, true)).toBeGreaterThan(0);
        const ap = Array.from({ length: 4 }, (_, i) =>
          halfFloat.f16ToF32(bytes.getUint16(768 + i * 2, true)),
        );
        expect(ap.every(Number.isFinite)).toBe(true);
        expect(ap[3]).toBeGreaterThan(0);
        expect(ap[3]).toBeLessThan(1);
        const sky = new Float32Array(pixels, 1024, 4);
        expect([...sky].every(Number.isFinite)).toBe(true);
        expect(sky[0]).toBeGreaterThan(0);
        expect(sky[3]).toBe(0);
      } finally {
        mapped.unmap();
      }
    } finally {
      await compiled.retire();
    }
  } finally {
    deviceScope.retire();
  }
}, 60000);
