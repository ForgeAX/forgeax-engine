import { err, type RhiDevice, RhiError, type Texture } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { CompiledRenderGraph, RenderGraphFrame } from '../types';

function stages(
  device: RhiDevice,
  previous?: CompiledRenderGraph<RenderGraphFrame>,
  retain = false,
  extraTarget = false,
) {
  const builder = new RenderGraphBuilder();
  const observed: Texture[] = [];
  const output = (name: string, format: 'rgba8unorm' | 'rgba16float' = 'rgba8unorm') => {
    const texture = builder
      .createTexture(name, { format, size: 'surface', lifetime: 'pass-local' })
      .unwrap();
    return { texture, view: builder.view(texture).unwrap() };
  };
  // Declaration order deliberately differs from pass order.
  const last = output('last');
  const first = output('first');
  const overlap = output('overlap');
  const wider = output('wider', 'rgba16float');
  const draw = (name: string, targets: (typeof first)[]) =>
    builder
      .addRasterPass(name, {
        accesses: targets.map(({ view }) => ({ resource: view, usage: 'color-attachment' })),
        colorAttachments: targets.map(({ view }) => ({ view, loadOp: 'clear', storeOp: 'store' })),
        encode: ({ resources }) => {
          for (const { texture } of targets) observed.push(resources.texture(texture).unwrap());
        },
      })
      .unwrap();
  draw('start', [first]);
  draw('simultaneous', [first, overlap]);
  draw('finish', extraTarget ? [last, wider, output('extra', 'rgba16float')] : [last, wider]);
  const graph = builder
    .compile({
      device,
      surfaceSize: { width: 4, height: 4 },
      reuseResourcesFrom: previous,
      retainPassLocalTargets: retain,
    })
    .unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  graph.execute({ encoder }).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  return { graph, observed };
}

it('leases one physical texture per overlapping lifetime and compatible descriptor, including graph replacement', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const destroy = vi.spyOn(device, 'destroyTexture');
  const a = stages(device);
  expect(a.observed[0]).toBe(a.observed[1]);
  expect(a.observed[0]).not.toBe(a.observed[2]);
  expect(a.observed.slice(0, 3)).toContain(a.observed[3]);
  expect(a.observed.slice(0, 4)).not.toContain(a.observed[4]);
  expect(a.graph.getColorTargetTexture('last')).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(3);
  const b = stages(device, a.graph);
  expect(b.observed).toEqual(a.observed);
  expect(create).toHaveBeenCalledTimes(3);
  (await a.graph.retire()).unwrap();
  expect(destroy).not.toHaveBeenCalled();
  (await b.graph.retire()).unwrap();
  expect(destroy).toHaveBeenCalledTimes(3);
});

it('pins each logical target separately for an externally observed frame', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const { graph, observed } = stages(device, undefined, true);
  expect(new Set(observed).size).toBe(4);
  expect(graph.getColorTargetTexture('last')).toBe(observed[3]);
  (await graph.retire()).unwrap();
});

it('respects extra physical usage when handing one attachment slot to a later pass', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder<RenderGraphFrame>();
  const seen: Texture[] = [];
  for (const [index, usage] of [0x10, 0x18, 0x11, 0x10].entries()) {
    const name = `color-${index}`;
    const texture = builder
      .createTexture(name, { format: 'rgba8unorm', size: 'surface', lifetime: 'pass-local', usage })
      .unwrap();
    const view = builder.view(texture).unwrap();
    builder
      .addRasterPass(name, {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: ({ resources }) => {
          seen.push(resources.texture(texture).unwrap());
        },
      })
      .unwrap();
  }
  const graph = builder.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  graph.execute({ encoder }).unwrap();
  expect(seen[0]).toBe(seen[3]);
  expect(new Set(seen).size).toBe(3);
  expect(graph.getColorTargetTexture('color-2')).toBe(seen[2]);
  (await graph.retire()).unwrap();
});

it('splits a previously shared attachment when a later read extends its lifetime', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const destroy = vi.spyOn(device, 'destroyTexture');
  function build(overlap: boolean, previous?: CompiledRenderGraph<RenderGraphFrame>) {
    const graph = new RenderGraphBuilder<RenderGraphFrame>();
    const textures = ['left', 'right'].map((name) =>
      graph
        .createTexture(name, { size: 'surface', format: 'rgba8unorm', lifetime: 'pass-local' })
        .unwrap(),
    );
    const views = textures.map((texture) => graph.view(texture).unwrap());
    const observed: Texture[] = [];
    for (const [i, index] of (overlap ? [0, 1, 0] : [0, 1]).entries()) {
      const texture = textures[index];
      const view = views[index];
      if (texture === undefined || view === undefined) throw new Error('Missing test attachment');
      graph
        .addRasterPass(`stage-${i}`, {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: i === 2 ? 'load' : 'clear', storeOp: 'store' }],
          encode: ({ resources }) => {
            observed.push(resources.texture(texture).unwrap());
          },
        })
        .unwrap();
    }
    const compiled = graph
      .compile({
        device,
        surfaceSize: { width: 8, height: 8 },
        ...(previous === undefined ? {} : { reuseResourcesFrom: previous }),
      })
      .unwrap();
    compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).unwrap();
    return { compiled, observed };
  }
  const initial = build(false);
  const changed = build(true, initial.compiled);
  expect(initial.observed[0]).toBe(initial.observed[1]);
  expect(changed.observed[0]).toBe(initial.observed[0]);
  expect(changed.observed[2]).toBe(changed.observed[0]);
  expect(changed.observed[1]).not.toBe(changed.observed[0]);
  expect(create).toHaveBeenCalledTimes(2);
  (await initial.compiled.retire()).unwrap();
  expect(destroy).not.toHaveBeenCalled();
  (await changed.compiled.retire()).unwrap();
  expect(destroy).toHaveBeenCalledTimes(2);
});

it('drops a failed replacement lease once while attachment aliases and the previous graph remain live', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const prior = stages(device);
  const destroy = vi.spyOn(device, 'destroyTexture');
  const createView = vi.spyOn(device, 'createTextureView').mockReturnValueOnce(
    err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the new replacement view',
        hint: 'retry with the same declared attachments',
      }),
    ),
  );
  try {
    expect(() => stages(device, prior.graph, false, true)).toThrow(
      expect.objectContaining({ code: 'resource-allocation-failed' }),
    );
    expect(createView).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(prior.observed).not.toContain(destroy.mock.calls[0]?.[0]);
    const replacement = stages(device, prior.graph);
    expect(replacement.observed).toEqual(prior.observed);
    (await replacement.graph.retire()).unwrap();
    expect(destroy).toHaveBeenCalledTimes(1);
  } finally {
    (await prior.graph.retire()).unwrap();
    createView.mockRestore();
  }
  expect(destroy).toHaveBeenCalledTimes(4);
});

it('releases a shared texture when binding fails before its first-pass attachment is visited', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = vi.spyOn(device, 'createTexture');
  const destroy = vi.spyOn(device, 'destroyTexture');
  vi.spyOn(device, 'createBuffer').mockReturnValueOnce(
    err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'a buffer for the next slot',
        hint: 'retry with the same declarations',
      }),
    ),
  );
  const procedure = RenderGraphBuilder.procedure({
    device,
    surfaceSize: { width: 4, height: 4 },
  });
  const { passes } = procedure;
  const target = (label: string) =>
    passes
      .view(
        passes
          .createTexture(label, {
            size: 'surface',
            format: 'rgba8unorm',
            lifetime: 'pass-local',
          })
          .unwrap(),
      )
      .unwrap();
  const last = target('last');
  const buffer = passes.createBuffer('refused', { size: 4 }).unwrap();
  const first = target('first');
  for (const [name, view] of [
    ['first', first],
    ['last', last],
  ] as const)
    passes
      .addRasterPass(name, {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encodeDirect: () => {},
      })
      .unwrap();
  passes
    .addCopyPass('buffer', {
      accesses: [{ resource: buffer, usage: 'copy-dst' }],
      encode: () => {},
    })
    .unwrap();
  expect(procedure.bindResources()).toMatchObject({
    ok: false,
    error: { code: 'resource-allocation-failed', detail: { resourceKey: 'refused' } },
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledExactlyOnceWith(create.mock.results[0]?.value.unwrap());
});
