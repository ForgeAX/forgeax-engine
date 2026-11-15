import { halfFloat } from '@forgeax/engine-math';
import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { type WaterVisualContact, waterAdvancedOutputNames } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import { createComputeStateForModule, resolvedGraphView } from '../../compute-graph-state';
import { prepareWaterFluidFoamFrame, type WaterFluidFoamFrame } from '../fluid-foam';
import { addWaterFluidSharedGraph, type WaterFluidGraphFrame } from '../fluid-graph';

it('retains contact pixels through 60 completed graph generations and unrelated root changes', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const options = { resolution: 16, decayPerSecond: 0.6, strengthPerMps: 0.5 };
  const material = {
    worldIdentity: 'ocean-world',
    bodyGuid: 'ocean',
    bodyGeneration: 1,
    materialHandle: 1,
    mapping: { kind: 'mapped' as const, centerXZ: [0, 0] as const, extentM: 16 },
  };
  const root = {
    worldIdentity: 'ocean-world',
    rootEntity: 1,
    rootGeneration: 1,
    sourceIdentity: 'hull',
  };
  const probe = (frame: number, index = 0): WaterVisualContact => ({
    kind: 'visual-probe',
    sourceIdentity: 'hull',
    sourcePhysicsStep: frame + 1,
    queryTimeSeconds: frame / 60,
    rootEntity: 1,
    rootGeneration: 1,
    probeId: `probe-${index}`,
    bodyGuid: 'ocean',
    bodyGeneration: 1,
    phase: 'contact',
    coverage: 0.8,
    contact: {
      kind: 'water-plane-intersection',
      positionM: frame === 0 ? [0, 0, 0] : [-6, 0, -6],
      radiusM: frame === 0 ? 3 : 0.5,
      relativeVelocityMps: [0, 0, 0],
    },
  });
  const readback = device.createBuffer({ size: 256 * 16, usage: 1 | 8 }).unwrap();
  let previous: CompiledRenderGraph<WaterFluidGraphFrame> | undefined;
  let submitted: WaterFluidFoamFrame | undefined;
  let firstPixel = 0;
  let allocations: (string | undefined)[] = [];
  try {
    for (let frame = 0; frame < 60; frame++) {
      const extraRoot =
        frame >= 10 && frame < 30
          ? [{ ...root, rootEntity: 9, rootGeneration: frame < 20 ? 1 : 2 }]
          : [];
      const roots = frame < 40 ? [root, ...extraRoot] : [];
      const count = frame === 0 ? 1 : frame < 40 ? frame % 6 : 0;
      const foam = prepareWaterFluidFoamFrame(
        {
          timeSeconds: frame / 60,
          materials: [material],
          roots,
          events: Array.from({ length: count }, (_, index) => ({
            worldIdentity: root.worldIdentity,
            event: probe(frame, index),
          })),
        },
        options,
        0,
        frame + 1,
        submitted,
      ).unwrap();
      if (foam === undefined) throw new Error('Missing contact-foam fixture frame');
      const render = {
        token: `frame-${frame}`,
        frameNumber: frame + 1,
        deviceGeneration: 0,
        simulations: [],
        waterInfoViewIdentity: undefined,
        contactFoam: foam,
        required: new Set<string>(),
        encoded: new Set<string>(),
      };
      const builder = new RenderGraphBuilder<WaterFluidGraphFrame>();
      addWaterFluidSharedGraph({
        graph: builder,
        waterFluid: render,
        waterInfoPublication: undefined,
      }).unwrap();
      const graph = builder
        .compile({
          device,
          surfaceSize: { width: 16, height: 16 },
          ...(previous === undefined ? {} : { reuseResourcesFrom: previous }),
        })
        .unwrap();
      const inspection = graph.inspect();
      const currentAllocations = inspection.resources
        .filter((resource) => /-history[01]$/.test(resource.label))
        .map((resource) => resource.physicalAllocationKey);
      expect(currentAllocations).toHaveLength(2);
      for (const key of currentAllocations)
        expect(typeof key === 'string' && key.length > 0).toBe(true);
      expect(currentAllocations[0]).not.toBe(currentAllocations[1]);
      if (frame === 0) allocations = currentAllocations;
      else expect(currentAllocations).toEqual(allocations);
      expect(
        inspection.resources.find((resource) => resource.label === 'water-fluid-contact-events')
          ?.byteSize,
      ).toBe(4096 * 32);
      const encoder = device.createCommandEncoder().unwrap();
      const runtime = {
        device,
        immediateShaderModuleFactory: {
          createShaderModule: (desc: Parameters<typeof rhi.createShaderModuleImmediate>[1]) =>
            rhi.createShaderModuleImmediate(device, desc),
        },
      };
      graph.execute({ encoder, runtime }).unwrap();
      const output = graph.getColorTargetTexture('water-fluid-foam-final');
      if (output === undefined) throw new Error('Missing submitted contact-foam output');
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 16 },
        { width: 16, height: 16, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      graph.commitExecution();
      expect([...render.required].every((pass) => render.encoded.has(pass))).toBe(true);
      const mapped = (await readback.mapAsync(1)).unwrap();
      const pixel = halfFloat.f16ToF32(
        new DataView(mapped.getMappedRange().unwrap()).getUint16(8 * 256 + 8 * 8, true),
      );
      mapped.unmap();
      if (frame === 0) {
        firstPixel = pixel;
        expect(pixel).toBeGreaterThan(0.79);
      }
      expect(pixel).toBeGreaterThan(
        firstPixel * Math.exp((-options.decayPerSecond * frame) / 60) * 0.97,
      );
      expect(pixel).toBeLessThanOrEqual(
        firstPixel * Math.exp((-options.decayPerSecond * frame) / 60) + 0.001,
      );
      submitted = foam;
      if (previous !== undefined) (await previous.retire()).unwrap();
      previous = graph;
    }
    expect(errors).toEqual([]);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    if (previous !== undefined) (await previous.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
    native.destroy();
  }
});

it('retains rotated producer foam in world history after its local patch exits and resets', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const options = { resolution: 16, decayPerSecond: 0.6, strengthPerMps: 0.5 };
  const material = {
    worldIdentity: 'ocean-world',
    bodyGuid: 'ocean',
    bodyGeneration: 1,
    materialHandle: 1,
    mapping: { kind: 'mapped' as const, centerXZ: [0, 0] as const, extentM: 16 },
  };
  const source = {
    ...material,
    recipeGuid: 'shallow',
    simulationGeneration: 1,
    viewIdentity: 'main',
  };
  const names = waterAdvancedOutputNames(source.recipeGuid, source.bodyGuid, source.worldIdentity);
  const readback = device.createBuffer({ size: 256 * 16, usage: 1 | 8 }).unwrap();
  let previous: CompiledRenderGraph<WaterFluidGraphFrame> | undefined;
  let submitted: WaterFluidFoamFrame | undefined;
  let firstPixel = 0;
  try {
    for (let frame = 0; frame < 60; frame++) {
      const foam = prepareWaterFluidFoamFrame(
        { timeSeconds: frame / 60, materials: [material], roots: [], events: [] },
        options,
        0,
        frame + 1,
        submitted,
      ).unwrap();
      if (foam === undefined) throw new Error('Missing composed-foam fixture frame');
      const builder = new RenderGraphBuilder<WaterFluidGraphFrame>();
      const produced = frame < 40;
      const fields = new Map<
        string,
        { view: import('@forgeax/engine-render-graph').GraphTextureView; format: 'rgba32float' }
      >();
      if (produced) {
        const field = builder
          .createTexture(names.foam, {
            format: 'rgba32float',
            size: { width: 16, height: 16 },
            usage: 4 | 8,
          })
          .unwrap();
        const mapping = builder
          .createTexture(names.mapping, {
            format: 'rgba32float',
            size: { width: 2, height: 2 },
            usage: 4 | 8,
          })
          .unwrap();
        const fieldView = builder.view(field).unwrap();
        const mappingView = builder.view(mapping).unwrap();
        fields.set(names.foam, { view: fieldView, format: 'rgba32float' });
        fields.set(names.mapping, { view: mappingView, format: 'rgba32float' });
        const module = rhi
          .createShaderModuleImmediate(device, {
            code: `
@group(0) @binding(0) var foam: texture_storage_2d<rgba32float,write>;
@group(0) @binding(1) var mapping: texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(16,16) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  textureStore(foam, vec2<i32>(id.xy), vec4<f32>(${frame === 0 ? '0.75' : '0.0'}, 0.0, 0.0, 0.0));
  if (all(id.xy < vec2<u32>(2))) {
    textureStore(mapping, vec2<i32>(id.xy), select(vec4<f32>(${frame === 0 ? '-2.0' : '5.0'}, 1.0, 4.0, 4.0), vec4<f32>(1.57079632679, 1.0, 0.0, 0.0), id.x == 1u));
  }
}`,
          })
          .unwrap();
        const state = createComputeStateForModule(
          device,
          module,
          'shallow-foam-producer',
          [0, 1].map((binding) => ({
            binding,
            visibility: 4,
            storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
          })),
          'main',
        );
        builder
          .addComputePass('shallow-foam-producer', {
            accesses: [
              { resource: fieldView, usage: 'storage-write' },
              { resource: mappingView, usage: 'storage-write' },
            ],
            encodeDirect(pass, _frame, resources) {
              const bindings = device
                .createBindGroup({
                  layout: state.layout,
                  entries: [fieldView, mappingView].map((view, binding) => ({
                    binding,
                    resource: { kind: 'textureView', value: resolvedGraphView(resources, view) },
                  })),
                })
                .unwrap();
              pass.setPipeline(state.pipeline);
              pass.setBindGroup(0, bindings);
              pass.dispatchWorkgroups(1, 1, 1);
            },
          })
          .unwrap();
      }
      const render = {
        token: `frame-${frame}`,
        frameNumber: frame + 1,
        deviceGeneration: 0,
        simulations: [],
        waterInfoViewIdentity: 'main',
        contactFoam: foam,
        shallowFoamSources: produced
          ? [{ ...source, simulationGeneration: frame < 20 ? 1 : 2 }]
          : [],
        required: new Set<string>(),
        encoded: new Set<string>(),
      };
      addWaterFluidSharedGraph({
        graph: builder,
        waterFluid: render,
        waterInfoPublication: undefined,
        resolveShallowFoamSource: (candidate) => {
          const foam = fields.get(names.foam);
          const mapping = fields.get(names.mapping);
          return candidate.viewIdentity === 'main' && foam !== undefined && mapping !== undefined
            ? { foam, mapping }
            : undefined;
        },
      }).unwrap();
      const graph = builder
        .compile({
          device,
          surfaceSize: { width: 16, height: 16 },
          ...(previous === undefined ? {} : { reuseResourcesFrom: previous }),
        })
        .unwrap();
      if (produced) {
        const passes = graph.inspect().passes.map((pass) => pass.name);
        expect(passes.indexOf('shallow-foam-producer')).toBeLessThan(
          passes.indexOf('water-fluid-shallow-foam-merge0'),
        );
      }
      const encoder = device.createCommandEncoder().unwrap();
      const runtime = {
        device,
        immediateShaderModuleFactory: {
          createShaderModule: (desc: Parameters<typeof rhi.createShaderModuleImmediate>[1]) =>
            rhi.createShaderModuleImmediate(device, desc),
        },
      };
      graph.execute({ encoder, runtime }).unwrap();
      const output = graph.getColorTargetTexture('water-fluid-foam-final');
      if (output === undefined) throw new Error('Missing submitted composed foam output');
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 16 },
        { width: 16, height: 16, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      graph.commitExecution();
      expect([...render.required].every((pass) => render.encoded.has(pass))).toBe(true);
      const mapped = (await readback.mapAsync(1)).unwrap();
      const bytes = new DataView(mapped.getMappedRange().unwrap());
      const pixel = halfFloat.f16ToF32(bytes.getUint16(8 * 256 + 5 * 8, true));
      if (frame === 0)
        expect(halfFloat.f16ToF32(bytes.getUint16(8 * 256 + 4 * 8, true))).toBeCloseTo(0.375, 3);
      mapped.unmap();
      if (frame === 0) {
        firstPixel = pixel;
        expect(pixel).toBeCloseTo(0.75, 3);
      }
      const decayed = firstPixel * Math.exp((-options.decayPerSecond * frame) / 60);
      expect(pixel).toBeGreaterThan(decayed * 0.97);
      expect(pixel).toBeLessThanOrEqual(decayed + 0.001);
      submitted = foam;
      if (previous !== undefined) (await previous.retire()).unwrap();
      previous = graph;
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    if (previous !== undefined) (await previous.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
    native.destroy();
  }
});
