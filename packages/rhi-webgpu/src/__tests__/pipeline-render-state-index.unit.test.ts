import type { PipelineRecipeState, RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { pipelineDescriptorState } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import { createShaderModuleImmediate } from '../index';
import { PipelineResourceIndex } from '../pipeline-resource-index';
import { createMockGpu } from './__mocks__/gpu-device';

async function fixture() {
  const gpu = createMockGpu(),
    adapter = await gpu.requestAdapter();
  const raw = (await adapter?.requestDevice()) as unknown as GPUDevice;
  Object.assign(raw, {
    createRenderPipelineAsync: vi.fn(async () => ({}) as GPURenderPipeline),
    destroy: vi.fn(),
  });
  const device = makeRhiDevice(raw).device;
  const library = device.pipelineLibrary;
  if (library?.findRenderState === undefined) throw new Error('Missing findRenderState');
  const layout = device
    .createPipelineLayout({
      bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }).unwrap()],
    })
    .unwrap();
  const module = (code: string) =>
    createShaderModuleImmediate(device, { code, label: code }).unwrap();
  const descriptor = (
    vertex: ReturnType<typeof module>,
    fragment: ReturnType<typeof module> | undefined,
    format: GPUTextureFormat,
  ): RenderPipelineDescriptor => ({
    label: 'indexed',
    layout,
    vertex: { module: vertex, entryPoint: 'vs', buffers: [] },
    ...(fragment === undefined
      ? {}
      : { fragment: { module: fragment, entryPoint: 'fs', targets: [{ format }] } }),
    primitive: { topology: 'triangle-list' },
  });
  return { device, library, layout, module, descriptor, findRenderState: library.findRenderState };
}

it('visits only records sharing the requested layout and stage modules', async () => {
  const f = await fixture();
  const a = f.module('module a'),
    b = f.module('module b');
  // Two states on module a, one on module b, one vertex-only on module a.
  for (const d of [
    f.descriptor(a, a, 'rgba8unorm'),
    f.descriptor(a, a, 'rgba16float'),
    f.descriptor(b, b, 'rgba8unorm'),
    f.descriptor(a, undefined, 'rgba8unorm'),
  ])
    await f.device.createRenderPipelineAsync?.(d);

  const visited: PipelineRecipeState[] = [];
  const target = pipelineDescriptorState(
    'render',
    f.descriptor(a, a, 'rgba16float') as unknown as Record<string, unknown>,
  );
  const found = f.findRenderState.call(
    f.library,
    { layout: f.layout, vertex: a, fragment: a },
    (state) => {
      visited.push(state);
      return state.key === target.key;
    },
  );
  expect(found?.key).toBe(target.key);
  // Insertion order is preserved: the first module-a state is visited before the match.
  expect(visited).toHaveLength(2);

  const vertexOnly: PipelineRecipeState[] = [];
  f.findRenderState.call(f.library, { layout: f.layout, vertex: a }, (state) => {
    vertexOnly.push(state);
    return false;
  });
  expect(vertexOnly).toHaveLength(1);

  const other: PipelineRecipeState[] = [];
  expect(
    f.findRenderState.call(f.library, { layout: f.layout, vertex: b, fragment: b }, (state) => {
      other.push(state);
      return true;
    }),
  ).toBe(other[0]);
  expect(other).toHaveLength(1);

  // Unknown modules and released libraries find nothing.
  const unknown = f.module('module c');
  const none = vi.fn(() => true);
  expect(
    f.findRenderState.call(
      f.library,
      { layout: f.layout, vertex: unknown, fragment: unknown },
      none,
    ),
  ).toBeUndefined();
  expect(none).not.toHaveBeenCalled();
});

it('groups weak records and forgets them on clear', () => {
  const index = new PipelineResourceIndex<{ name: string }>();
  const one = { name: 'one' },
    two = { name: 'two' },
    three = { name: 'three' };
  index.add('g:1', one, 'g');
  index.add('h:2', two, 'h');
  index.add('g:3', three, 'g');
  expect([...index.grouped('g')]).toEqual([one, three]);
  expect([...index.grouped('h')]).toEqual([two]);
  expect([...index.grouped('missing')]).toEqual([]);
  expect(index.find('g:3')).toBe(three);
  index.clear();
  expect([...index.grouped('g')]).toEqual([]);
  expect(index.find('g:1')).toBeUndefined();
});
