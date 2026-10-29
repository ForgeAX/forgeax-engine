import { RenderGraphBuilder, type RenderGraphFrame } from '@forgeax/engine-render-graph';
import * as nullRhi from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import { RaySceneRefit } from '../../raytracing/scene-refit';
import { prepareRayRecordingFixture } from './path-tracer.commands';
import { plane, settings } from './path-tracer.fixture';

it('records 16 deep MASK samples with the graph usage boundaries and every dispatch intact', async () => {
  const fixture = await prepareRayRecordingFixture();
  const material = fixture.material;
  const device = (await (await nullRhi.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  if (!(device instanceof nullRhi.RhiNullDevice)) throw new Error('expected structural backend');
  const textureDescriptor = {
    size: { width: 2, height: 1 },
    format: 'rgba8unorm' as const,
    usage: 6,
  };
  const texture = device.createTexture(textureDescriptor).unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const tracer = (
    await createRayPathTracer(device, nullRhi.createShaderModule, {
      kernel: fixture.kernel,
      scene: buildRaySurfaceScene(
        Array.from({ length: 25 }, (_, id) => ({ ...plane(id), instanceId: id })),
      ).unwrap(),
      materials: Array.from({ length: 25 }, (_, id) => ({ ...material, id })),
      lights: [],
      settings: { ...settings, maxBounces: 8 },
      resolveTexture: () => ok({ view, sampler }),
    })
  ).unwrap();
  const graph = new RenderGraphBuilder<RenderGraphFrame>();
  const imported = graph.importTexture('coverage', textureDescriptor, () => texture).unwrap();
  const graphView = graph.importView(imported, {}, () => view).unwrap();
  tracer
    .addSampleToGraph(graph, {
      label: 'deep-mask',
      buffers: new Map(),
      textures: new Map([[view, graphView]]),
      reset: false,
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
  try {
    const graphPasses = compiled.inspect().passes.filter((pass) => pass.kind === 'compute').length;
    const beforeDispatches = device.totalDispatchCount;
    const beforePasses = device.framePassNames.length;
    const encoder = device.createCommandEncoder({}).unwrap();
    for (let sample = 0; sample < 16; sample++) tracer.recordSample(encoder).unwrap();
    expect(device.totalDispatchCount - beforeDispatches).toBe(16 * tracer.dispatchCount);
    expect(device.framePassNames.length - beforePasses).toBe(16 * graphPasses);
    expect(graphPasses).toBeLessThan(tracer.dispatchCount);
  } finally {
    await compiled.retire();
    tracer.dispose();
    device.destroyTexture(texture).unwrap();
  }
}, 120000);

it('admits the LUT ray kernel with an explicit graph texture and preserves a borrowed scope until retirement', async () => {
  const fixture = await prepareRayRecordingFixture('lut');
  const device = (await (await nullRhi.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const scope = DeviceScope.create(1, 'ray-dfg-test');
  if (fixture.kernelLut === undefined) throw new Error('LUT fixture requires its compiled kernel');
  const input = {
    kernel: fixture.kernel,
    scene: buildRaySurfaceScene([plane(0)]).unwrap(),
    materials: [{ ...fixture.material, id: 0 }],
    lights: [],
    settings: { ...settings, maxBounces: 1 },
    deviceScope: scope,
  };
  const upload = vi.spyOn(device.queue, 'writeTexture');
  const missing = await createRayPathTracer(device, nullRhi.createShaderModule, input);
  expect(missing).toMatchObject({ ok: false, error: { code: 'ray-reference-invalid' } });
  expect(upload).not.toHaveBeenCalled();
  const tracer = (
    await createRayPathTracer(device, nullRhi.createShaderModule, {
      ...input,
      kernelLut: fixture.kernelLut,
    })
  ).unwrap();
  expect(upload).toHaveBeenCalledTimes(1);
  const graph = new RenderGraphBuilder<RenderGraphFrame>();
  tracer
    .addSampleToGraph(graph, {
      label: 'lut-path',
      buffers: new Map(),
      textures: new Map(),
      reset: false,
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
  expect(
    compiled
      .inspect()
      .passes.some((pass) => pass.accesses.some((access) => access.usage === 'sampled-read')),
  ).toBe(true);
  await compiled.retire();
  tracer.dispose();
  expect(scope.resourceDelta()).toBe(1);
  const next = (
    await createRayPathTracer(device, nullRhi.createShaderModule, {
      ...input,
      kernelLut: fixture.kernelLut,
    })
  ).unwrap();
  expect(upload).toHaveBeenCalledTimes(1);
  next.dispose();
  scope.dispose();
  expect(scope.resourceDelta()).toBe(0);
}, 120000);

it.each([
  16, 512,
])('uploads only D=1 refit rows without compiling or allocating at N=%i', async (count) => {
  const fixture = await prepareRayRecordingFixture();
  const device = (await (await nullRhi.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 }).unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const compile = vi.fn(nullRhi.createShaderModule);
  const upload = vi.spyOn(device.queue, 'writeBuffer');
  const instances = Array.from({ length: count }, (_, index) => ({
    ...plane(),
    instanceId: index + 1,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 100, 0, 0, 1],
  }));
  const scene = buildRaySurfaceScene(instances).unwrap();
  const tracer = (
    await createRayPathTracer(device, compile, {
      kernel: fixture.kernel,
      scene,
      materials: [{ ...fixture.material, id: 0 }],
      lights: [],
      settings,
      resolveTexture: () => ok({ view, sampler }),
    })
  ).unwrap();
  const records = new Uint32Array(count * 16);
  for (let index = 0; index < count; index++) records[index * 16] = index;
  const refit = new RaySceneRefit(scene, records);
  const first = instances[0];
  if (first === undefined) throw new Error('fixture row');
  const local = buildRaySurfaceScene([
    { ...first, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -100, 0, 0, 1] },
  ]).unwrap();
  const patch = refit.patch(0, local, [0]);
  if (patch === undefined) throw new Error('stable fixture shape');
  const edit = refit.apply([patch]);
  compile.mockClear();
  upload.mockClear();
  const allocate = vi.spyOn(device, 'createBuffer');
  tracer.updateScene(scene, edit).unwrap();
  expect(compile).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
  expect(edit.triangles).toHaveLength(2);
  expect(edit.nodes.length).toBeLessThan(20);
  expect(upload).toHaveBeenCalledTimes(4 + edit.nodes.length);
  const attributes = upload.mock.calls.filter(([buffer]) => buffer === tracer.buffers.attributes);
  expect(attributes.reduce((bytes, [, , data]) => bytes + data.byteLength, 0)).toBe(2 * 384);
  const triangles = upload.mock.calls.filter(([buffer]) => buffer === tracer.buffers.triangles);
  expect(triangles.reduce((bytes, [, , data]) => bytes + data.byteLength, 0)).toBe(2 * 80);
  for (const [, offset, data] of attributes) {
    const actual = new Uint8Array(
      data instanceof ArrayBuffer ? data : data.buffer,
      data instanceof ArrayBuffer ? 0 : data.byteOffset,
      data.byteLength,
    );
    expect(actual).toEqual(scene.attributes.subarray(offset, offset + data.byteLength));
  }
  upload.mockClear();
  expect(tracer.updateScene(scene, { triangles: [scene.triangleCount], nodes: [] }).ok).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  tracer.dispose();
  expect(tracer.updateScene(scene, edit).ok).toBe(false);
  allocate.mockRestore();
  upload.mockRestore();
  device.destroyTexture(texture).unwrap();
}, 120000);
