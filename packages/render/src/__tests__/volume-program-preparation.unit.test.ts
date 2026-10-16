import type {
  ComputePipelineDescriptor,
  RenderPipelineDescriptor,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import { constructRendererHost } from '../construct-renderer';
import { DeviceScope } from '../device/device-scope';
import {
  prepareVolumePrograms,
  volumeCompositeState,
  volumeComputeState,
} from '../volume/programs';
import { standardPbrManifestRow } from './shader-manifest-fixture';

const sources = {
  inject: 'fn volume_inject() {}',
  integrate: 'fn volume_integrate() {}',
  temporal: 'fn volume_temporal() {}',
  composite: 'fn volume_fs() {}',
};
async function fixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const factory = makeShaderDeviceAdapter(
    device,
    {} as never,
    undefined,
    (d, desc) => rhi.createShaderModuleImmediate(d, desc),
    'immediate',
  );
  const scope = DeviceScope.create(0, 'volume-program-preparation');
  const compute = vi.spyOn(device, 'createComputePipeline');
  const render = vi.spyOn(device, 'createRenderPipeline');
  const groups = vi.spyOn(device, 'createBindGroup');
  const textures = vi.spyOn(device, 'createTexture');
  const buffers = vi.spyOn(device, 'createBuffer');
  const encoders = vi.spyOn(device, 'createCommandEncoder');
  return {
    device,
    factory,
    scope,
    compute,
    render,
    groups,
    textures,
    buffers,
    encoders,
    context: { device, deviceScope: scope, shaderModuleFactory: factory },
  };
}
function defer(device: RhiDevice) {
  const releases: Array<() => void> = [];
  const gate = () =>
    new Promise<void>((resolve) => {
      releases.push(resolve);
    });
  const compute = vi.fn(async (desc: ComputePipelineDescriptor) => {
    await gate();
    return device.createComputePipeline(desc);
  });
  const render = vi.fn(async (desc: RenderPipelineDescriptor) => {
    await gate();
    return device.createRenderPipeline(desc);
  });
  device.createComputePipelineAsync = compute;
  device.createRenderPipelineAsync = render;
  return {
    releases,
    compute,
    render,
    release: () =>
      releases.splice(0).forEach((resolve) => {
        resolve();
      }),
  };
}

it('prepares canonical four stages without resources or work and retains all bounded quality variants', async () => {
  const f = await fixture();
  const gate = defer(f.device);
  let ready = false;
  const preparation = prepareVolumePrograms(f.context, sources, 'rgba16float').then(() => {
    ready = true;
  });
  expect(gate.compute).toHaveBeenCalledTimes(3);
  expect(gate.render).toHaveBeenCalledTimes(3);
  expect(ready).toBe(false);
  expect(() => volumeComputeState(f.context, sources.inject, 'volume_inject')).toThrow('pending');
  for (const spy of [f.groups, f.textures, f.buffers, f.encoders])
    expect(spy).not.toHaveBeenCalled();
  gate.release();
  await preparation;
  expect(ready).toBe(true);
  for (const [stage, label] of [
    ['inject', 'volume_inject'],
    ['integrate', 'volume_integrate'],
    ['temporal', 'volume_temporal'],
  ] as const)
    expect(volumeComputeState(f.context, sources[stage], label).pipeline).toBe(
      f.compute.mock.results.find((_r, i) => f.compute.mock.calls[i]?.[0].label === label)?.value
        .value,
    );
  for (const neighbors of [2, 4, 8, 2, 8, 4] as const) {
    const state = volumeCompositeState(f.context, sources.composite, 'rgba16float', neighbors);
    const call = f.render.mock.calls.findIndex(
      ([desc]) => desc.fragment?.constants?.VOLUME_COMPOSITE_NEIGHBORS === neighbors,
    );
    expect(state.pipeline).toBe(f.render.mock.results[call]?.value.value);
  }
  expect(f.compute).toHaveBeenCalledTimes(3);
  expect(f.render).toHaveBeenCalledTimes(3);
  expect(
    f.render.mock.calls.every(([desc]) => desc.fragment?.targets[0]?.format === 'rgba16float'),
  ).toBe(true);
  for (const spy of [f.groups, f.textures, f.buffers, f.encoders])
    expect(spy).not.toHaveBeenCalled();
  f.scope.retire();
});

it('observes module replacement during async preparation, retries failure, and does not retain retired generations', async () => {
  const f = await fixture();
  const gate = defer(f.device);
  const first = prepareVolumePrograms(f.context, sources, 'rgba16float');
  f.factory.invalidateModule('volume_inject');
  gate.release();
  await expect(first).rejects.toThrow('module changed');
  const retry = prepareVolumePrograms(f.context, sources, 'rgba16float');
  gate.release();
  await retry;
  expect(f.compute).toHaveBeenCalledTimes(4);
  expect(f.render).toHaveBeenCalledTimes(3);
  const differentFormat = volumeCompositeState(f.context, sources.composite, 'rgba8unorm', 2);
  expect(differentFormat.pipeline).not.toBe(f.render.mock.results[0]?.value.value);
  const pending = prepareVolumePrograms(
    f.context,
    { ...sources, temporal: 'new temporal' },
    'rgba16float',
  );
  f.scope.retire();
  gate.release();
  await expect(pending).rejects.toThrow('retired');
  expect(() => volumeComputeState(f.context, sources.inject, 'volume_inject')).toThrow(
    'device scope',
  );
  const recovered = {
    ...f.context,
    deviceScope: DeviceScope.create(1, 'volume-program-preparation'),
  };
  const next = prepareVolumePrograms(recovered, sources, 'rgba16float');
  gate.release();
  await next;
  expect(f.compute).toHaveBeenCalledTimes(8);
  recovered.deviceScope.retire();
});

it('does not cache failed native preparation as ready and permits a subsequent attempt', async () => {
  const f = await fixture();
  const failure = new RhiError({
    code: 'rhi-not-available',
    expected: 'deliberate failed volume PSO',
    hint: 'retry',
  });
  f.device.createComputePipelineAsync = vi.fn(async (desc) =>
    desc.label === 'volume_inject' ? err(failure) : f.device.createComputePipeline(desc),
  );
  await expect(prepareVolumePrograms(f.context, sources, 'rgba16float')).rejects.toBe(failure);
  f.device.createComputePipelineAsync = async (desc) => f.device.createComputePipeline(desc);
  await prepareVolumePrograms(f.context, sources, 'rgba16float');
  expect(f.compute).toHaveBeenCalledTimes(3);
  f.scope.retire();
});

it('holds the actual public Renderer initialization barrier until every volume async PSO settles without an authored volume', async () => {
  const f = await fixture();
  const gate = defer(f.device);
  const manifest = `data:application/json,${encodeURIComponent(
    JSON.stringify({
      entries: [
        { hash: 'pbr', wgsl: 'f_schlick', glsl: '', bindings: '' },
        { hash: 'unlit', wgsl: 'unlit', glsl: '', bindings: '' },
        { hash: 'tonemap', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
        ...Object.entries(sources).map(([hash, wgsl]) => ({ hash, wgsl, glsl: '', bindings: '' })),
      ],
      materialShaders: [standardPbrManifestRow('f_schlick')],
    }),
  )}`;
  let settled = false;
  const assembly = constructRendererHost(
    { width: 640, height: 360, getContext: () => null },
    {
      rhi: {
        ...rhi,
        requestAdapter: async () =>
          ok({
            features: new Set<GPUFeatureName>(),
            limits: {},
            requestDevice: async () => ok(f.device),
          }),
      },
    },
    { shaderManifestUrl: manifest },
  ).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(settled || gate.releases.length === 6).toBe(true));
  expect(gate.releases).toHaveLength(6);
  expect(settled).toBe(false);
  for (const resolve of gate.releases.splice(0, 5)) resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.release();
  const result = await assembly;
  expect(result.ok).toBe(true);
  expect(settled).toBe(true);
  expect(f.compute.mock.calls.filter(([desc]) => desc.label?.startsWith('volume_'))).toHaveLength(
    3,
  );
  expect(f.render.mock.calls.filter(([desc]) => desc.label === 'volume_composite')).toHaveLength(3);
  expect(f.textures.mock.calls.filter(([desc]) => desc.label?.startsWith('volume-'))).toHaveLength(
    0,
  );
  expect(f.groups.mock.calls.filter(([desc]) => desc.label?.startsWith('volume_'))).toHaveLength(0);
  if (result.ok) await result.value.renderer.dispose();
  f.scope.retire();
});
