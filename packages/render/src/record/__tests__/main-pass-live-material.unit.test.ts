import { DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import type { BindGroup, BindGroupDescriptor, Buffer, TextureView } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok, type ParamSchemaEntry, ParamSchemaProjectionOwner } from '@forgeax/engine-types';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { viewAndSceneDepthLayoutEntries } from '../../assembly/material-shader-policy';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { retainViewLayout } from '../../environment/bindings';
import { GPU_TEXTURE_USAGE_TEXTURE_BINDING } from '../../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../../gpu-usage';
import { createSkylightFallback, skylightBindGroupResources } from '../../ibl/skylight-bind-group';
import { DeviceScope } from '../../lifecycle';
import { appendInjection, buildPbrMaterialUserRegionEntries } from '../../pbr-pipeline';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { CanvasTexture, canvasTextureState } from '../../textures/canvas-texture';
import { encodeMainPass } from '../main-pass';
import { MaterialBgAssemblyCache } from '../material-bg-assembly-cache';
import { materialUniformSlot } from '../material-uniforms';
import { MATERIAL_PER_ENTITY_STRIDE } from '../render-context';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

const shader = 'test::live-material';
const stride = MATERIAL_PER_ENTITY_STRIDE;

async function fixture(schemaEntries: readonly ParamSchemaEntry[], drawCount: number) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const { c } = f;
  const fallback = createSkylightFallback(device, device.queue);
  const skylightResources = skylightBindGroupResources(fallback);
  const canvasStore = new DynamicTextureStore();
  const store = new GpuResidencyCache();
  canvasStore.configureGpuDevice(device);
  store.configureGpuDevice(device, undefined, device.caps);
  const cache = new MaterialBgAssemblyCache();
  const schema = new ParamSchemaProjectionOwner().admit({
    ownerId: shader,
    revision: 1,
    schema: schemaEntries,
  });
  const user =
    schema.schema.length === 0
      ? []
      : buildPbrMaterialUserRegionEntries(schema.schema, [], [], true);
  const layout = device
    .createBindGroupLayout({
      entries: [...user, ...appendInjection(user, 'ibl')],
    })
    .unwrap();
  const viewEntries = viewAndSceneDepthLayoutEntries(false);
  const viewLayout = device.createBindGroupLayout({ entries: viewEntries }).unwrap();
  retainViewLayout(viewLayout, viewEntries);
  const pipeline = f.createPipeline(module, viewLayout, false, layout);
  Object.assign(pipeline, {
    getBindGroupLayout: (group: number) => (group === 0 ? viewLayout : layout),
  });
  const depth = device
    .createTexture({
      format: 'depth32float',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const depthView = device
    .createTextureView(depth, { aspect: 'depth-only', dimension: '2d' })
    .unwrap();
  const first = f.add({ entity: 1, submeshes: 1 });
  first.source.material.adopt({
    ...first.source.material.snapshot,
    materialShaderId: shader,
    materialParamSchema: schema.schema,
  });
  for (let entity = 2; entity <= drawCount; entity++) {
    const entry = f.add({ entity, submeshes: 1 });
    Object.assign(entry.source, {
      material: first.source.material,
      materials: first.source.materials,
    });
  }
  const accept = () => {
    f.acceptMaterials();
    Object.assign(c, {
      materialSlots: [first.source.material.snapshot],
      materialSlotIndices: f.entries.map(() => [0]),
    });
  };
  accept();
  const deviceScope = DeviceScope.create(1, 'main-pass-live-material-test');
  Object.assign(c.runtime, {
    deviceScope,
    dynamicTextureStore: canvasStore,
    shaderRegistry: {
      findMaterialArtifact: () =>
        ok({ program: {}, receipt: { bindings: 'render-lit-material-and-scene-depth' } }),
      materialArtifactDeclaration: () => undefined,
      materialShaderManifestEntry: () => undefined,
    },
    getMaterialBindGroupLayout: () => layout,
    lookupMaterialBindGroupLayout: () => layout,
    getMaterialShaderPipelineEntry: () => ({ pipeline, group2Contract: 'mesh' }),
  });
  Object.assign(c.pipelineState, {
    skylightFallback: fallback,
    defaultSampler: fallback.sampler,
    defaultWhiteTextureView: fallback.brdfLutView,
    materialBindGroupLayout: layout,
    viewUniformBuffer: f.meshUniformBuffer,
    perPassResources: { shadowSampler: fallback.sampler },
    shadowArrayFallbackTextureView: depthView,
    shadowAtlasFallbackTextureView: depthView,
    shadowParamsBuffer: f.meshUniformBuffer,
    shadowCasterCascadeBuffer: f.meshUniformBuffer,
    extendedLightingAvailable: false,
    projectorAvailable: false,
  });
  Object.assign(c.frameState, { viewBindGroupCache: new WeakMap() });
  Object.assign(c, {
    store,
    meshBindGroup: f.meshGroup,
    materialBindings: [{ material: first.source.material, resourceClass: '' }],
    materialSlotCount: 1,
    materialBgAssemblyCache: cache,
    dispatch: [],
  });
  const groupDescriptors = new Map<BindGroup, BindGroupDescriptor>();
  const createGroup = device.createBindGroup.bind(device);
  const onGroupIssued = vi.fn();
  vi.spyOn(device, 'createBindGroup').mockImplementation((descriptor) => {
    const result = createGroup(descriptor);
    if (result.ok && descriptor.layout === layout) {
      groupDescriptors.set(result.value, descriptor);
      onGroupIssued(descriptor);
    }
    return result;
  });
  const buffer = (size: number) => {
    const usage = GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST;
    const allocation = device.createBuffer({ size, usage }).unwrap();
    onTestFinished(() => device.destroyBuffer(allocation).unwrap());
    return allocation;
  };
  onTestFinished(() => {
    canvasStore.destroyAll();
    store.destroyAll();
    for (const buffer of [fallback.skySh, fallback.intensityBuffer])
      device.destroyBuffer(buffer).unwrap();
    for (const texture of [
      fallback.irradianceTexture,
      fallback.prefilterTexture,
      fallback.brdfLutTexture,
    ])
      device.destroyTexture(texture).unwrap();
    device.destroyTexture(depth).unwrap();
    deviceScope.dispose();
    f.dispose();
  });
  const run = (afterDraw?: (index: number) => void) => {
    const commands = device.createCommandEncoder().unwrap();
    const pass = commands.beginRenderPass({ colorAttachments: [] });
    const draws: { group: BindGroup; offsets: number[] }[] = [];
    let active: (typeof draws)[number] | undefined;
    const bind = pass.setBindGroup.bind(pass);
    vi.spyOn(pass, 'setBindGroup').mockImplementation((index, group, offsets, start, length) => {
      if (index === 1) {
        const values = Array.from(offsets ?? []);
        const first = start ?? 0;
        active = {
          group,
          offsets: values.slice(first, length === undefined ? undefined : first + length),
        };
      }
      bind(index, group, offsets, start, length);
    });
    const draw = pass.drawIndexed.bind(pass);
    vi.spyOn(pass, 'drawIndexed').mockImplementation((...args) => {
      draw(...args);
      assert(active, 'Every native draw must have a material bind group');
      draws.push(active);
      afterDraw?.(draws.length - 1);
    });
    try {
      encodeMainPass(c, pass, undefined, {
        colorFormats: ['rgba8unorm'],
        materialSceneDepth: depthView,
        preparedSkylight: { skylightResources, activeViews: undefined },
      });
      expect(f.errors).toEqual([]);
    } finally {
      pass.end();
      device.queue.submit([commands.finish().unwrap()]).unwrap();
    }
    return draws;
  };
  const binding = (group: BindGroup, index: number) => {
    const descriptor = groupDescriptors.get(group);
    assert(descriptor, 'Expected an issued material group');
    return Array.from(descriptor.entries).find((entry) => entry.binding === index)?.resource;
  };
  return {
    c,
    device,
    cache,
    canvasStore,
    fallback,
    first,
    accept,
    run,
    buffer,
    binding,
    onGroupIssued,
  };
}

it('reuses the actual main-pass Canvas group after painting and replaces it after resize', async () => {
  const f = await fixture([{ name: 'surfaceMap', type: 'texture2d' }], 4);
  const canvas = { width: 4, height: 4 } as OffscreenCanvas;
  const texture = new CanvasTexture(canvas);
  onTestFinished(() => texture.dispose());
  f.first.source.material.adopt({
    ...f.first.source.material.snapshot,
    textureSources: new Map([['surfaceMap', texture.source]]),
  });
  f.accept();
  const copy = vi.spyOn(f.device.queue, 'copyExternalImageToTexture');
  const source = canvasTextureState(texture.source);
  assert(source);
  const uploadedViews: (TextureView | undefined)[] = [];
  const draws = f.run((index) => {
    uploadedViews.push(f.canvasStore.getView(source));
    if (index === 0) texture.update();
    if (index === 1) {
      canvas.width = 8;
      texture.update();
    }
  });
  expect(draws).toHaveLength(4);
  const [initial, painted, resized, repeated] = draws;
  assert(initial && painted && resized && repeated);
  expect(
    copy.mock.calls.map(([, , size]) => ('width' in size ? size.width : Array.from(size)[0])),
  ).toEqual([4, 4, 8]);
  expect(copy.mock.calls[0]?.[1].texture).toBe(copy.mock.calls[1]?.[1].texture);
  expect(copy.mock.calls[2]?.[1].texture).not.toBe(copy.mock.calls[0]?.[1].texture);
  expect(painted.group).toBe(initial.group);
  expect(resized.group).not.toBe(initial.group);
  expect(repeated.group).toBe(resized.group);
  const originalView = f.binding(initial.group, 2);
  const currentView = f.binding(resized.group, 2);
  expect(originalView?.kind).toBe('textureView');
  expect(currentView?.kind).toBe('textureView');
  expect(originalView?.value).toBe(uploadedViews[0]);
  expect(originalView?.value).toBe(uploadedViews[1]);
  expect(currentView?.value).toBe(uploadedViews[2]);
  expect(currentView?.value).toBe(uploadedViews[3]);
  expect(currentView?.value).not.toBe(originalView?.value);
  expect(f.onGroupIssued).toHaveBeenCalledTimes(2);
});

it.each([
  'queue write',
  'bind group creation',
] as const)('pairs the uniform page and its local offset across reentry during %s', async (operation) => {
  const f = await fixture([{ name: 'roughness', type: 'f32' }], 1);
  for (const handle of [200, 201, 202])
    materialUniformSlot(f.c.runtime, defaultMaterialSnapshot(handle));
  const storage = f.c.pipelineState.materialUniformBuffer;
  const oldPage = f.buffer(2 * stride);
  const newPage = f.buffer(4 * stride);
  Object.assign(storage, {
    buffer: null,
    sizeInBytes: 4 * stride,
    pages: {
      byteStride: 2 * stride,
      byteSize: 2 * stride,
      buffers: [f.buffer(2 * stride), oldPage],
    },
  });
  let changes = 0;
  const replace = () => {
    changes++;
    storage.pages = { byteStride: 4 * stride, byteSize: 4 * stride, buffers: [newPage] };
  };
  const write = f.device.queue.writeBuffer.bind(f.device.queue);
  const writes: { buffer: Buffer; offset: number }[] = [];
  vi.spyOn(f.device.queue, 'writeBuffer').mockImplementation((...args) => {
    const result = write(...args);
    assert(result.ok);
    if (args[0] === oldPage || args[0] === newPage) {
      writes.push({ buffer: args[0], offset: args[1] });
      if (changes === 0 && operation === 'queue write') replace();
    }
    return result;
  });
  if (operation === 'bind group creation') f.onGroupIssued.mockImplementationOnce(replace);

  const [outer] = f.run();
  assert(outer);
  expect(changes).toBe(1);
  expect(writes[0]).toEqual({ buffer: oldPage, offset: stride });
  expect(outer.offsets).toHaveLength(1);
  const uniform = f.binding(outer.group, 0);
  assert(uniform?.kind === 'buffer');
  expect(
    writes.some(
      ({ buffer, offset }) => buffer === uniform.value.buffer && offset === outer.offsets[0],
    ),
  ).toBe(true);
  if (operation === 'bind group creation') {
    expect(uniform.value.buffer).toBe(oldPage);
    expect(outer.offsets).toEqual([stride]);
  }
  f.cache.finishRecording();
  const [next] = f.run();
  assert(next);
  const nextUniform = f.binding(next.group, 0);
  assert(nextUniform?.kind === 'buffer');
  expect(nextUniform.value.buffer).toBe(newPage);
  expect(next.offsets).toEqual([3 * stride]);
  expect(writes).toContainEqual({ buffer: newPage, offset: 3 * stride });
});

it('uses zero dynamic offsets for a snapshot-owned empty lit schema on cold and retained draws', async () => {
  const f = await fixture([], 1);
  const uniformWrites = vi.spyOn(f.device.queue, 'writeBuffer');
  const storage = f.c.pipelineState.materialUniformBuffer;
  const [cold] = f.run();
  assert(cold);
  const firstBinding = f.binding(cold.group, 0);
  assert(firstBinding?.kind === 'buffer');
  expect(firstBinding.value.buffer).toBe(f.fallback.skySh);
  expect(cold.offsets).toEqual([]);
  expect(f.onGroupIssued).toHaveBeenCalledOnce();
  const [assembly] = f.cache.values();
  assert(assembly);
  expect(assembly.bindGroup).toBe(cold.group);
  expect(assembly.materialBuffer).toBeUndefined();
  expect(assembly.uniformResources).toBeUndefined();
  expect(f.c.frameState.materialUboCounters).toBeUndefined();
  const original = storage.buffer;
  Object.assign(storage, { buffer: f.buffer(4 * stride) });
  f.cache.finishRecording();

  const [retained] = f.run();
  assert(retained);
  expect(retained.group).toBe(cold.group);
  expect(retained.offsets).toEqual([]);
  expect(f.cache.values().next().value).toBe(assembly);
  expect(f.c.frameState.materialUboCounters).toBeUndefined();
  expect(
    uniformWrites.mock.calls.some(([buffer]) => buffer === storage.buffer || buffer === original),
  ).toBe(false);
  expect(f.onGroupIssued).toHaveBeenCalledOnce();
});
