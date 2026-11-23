import type { RenderPassDescriptor, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';

async function fixture(
  options: {
    readAfterOpaque?: boolean;
    imported?: boolean;
    conditional?: boolean;
    aliasRead?: boolean;
    childBoundary?: boolean;
  } = {},
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder; transparent: boolean }>();
  const color = graph
    .createTexture('color-msaa', {
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      sampleCount: 4,
    })
    .unwrap();
  const imported = options.imported
    ? device
        .createTexture({ size: { width: 4, height: 4 }, format: 'rgba8unorm', usage: 0x11 })
        .unwrap()
    : undefined;
  const resolved =
    imported === undefined
      ? graph
          .createTexture('color-resolved', { size: { width: 4, height: 4 }, format: 'rgba8unorm' })
          .unwrap()
      : graph
          .importTexture(
            'color-resolved',
            { size: { width: 4, height: 4 }, format: 'rgba8unorm', usage: 0x11 },
            () => imported,
          )
          .unwrap();
  const colorView = graph.view(color).unwrap();
  const resolvedView = graph.view(resolved).unwrap();
  const child = options.childBoundary
    ? new RenderGraphBuilder<{ encoder: RhiCommandEncoder; transparent: boolean }>()
        .compile({ device, surfaceSize: { width: 4, height: 4 } })
        .unwrap()
    : undefined;
  for (const [index, name] of ['sky', 'opaque', 'transparent'].entries()) {
    graph
      .addRasterPass(name, {
        accesses: [
          { resource: colorView, usage: 'color-attachment' },
          { resource: resolvedView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          {
            view: colorView,
            resolveTarget: resolvedView,
            loadOp: index === 0 ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
        ...(index === 2 && options.conditional
          ? { executeIf: (frame: { transparent: boolean }) => frame.transparent }
          : {}),
        encodeDirect() {},
      })
      .unwrap();
    if (index === 1 && child !== undefined)
      graph.addSubgraphPass('child', { accesses: [], child: () => child }).unwrap();
    if (index === 1 && options.readAfterOpaque) {
      const sampled = options.aliasRead ? graph.view(resolved).unwrap() : resolvedView;
      graph
        .addCopyPass('opaque-observer', {
          accesses: [{ resource: sampled, usage: 'copy-src' }],
          encodeDirect(_encoder, _frame, resources) {
            expect(resources.textureView(sampled).ok).toBe(true);
          },
        })
        .unwrap();
    }
  }
  const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  const begin = vi.spyOn(encoder, 'beginRenderPass');
  const run = (transparent = true) => {
    compiled.execute({ encoder, transparent }).unwrap();
    return begin.mock.calls.map(([descriptor]) => {
      const first = Array.from((descriptor as RenderPassDescriptor).colorAttachments)[0];
      return first?.resolveTarget !== undefined;
    });
  };
  return {
    run,
    async dispose() {
      await compiled.retire();
      await child?.retire();
      if (imported !== undefined) device.destroyTexture(imported).unwrap();
    },
  };
}

describe('native color resolve placement', () => {
  it('resolves an unobserved MSAA color chain only after its last writer', async () => {
    const f = await fixture();
    try {
      expect(f.run()).toEqual([true]);
    } finally {
      await f.dispose();
    }
  });
  it.each([
    false,
    true,
  ])('retains the opaque result for an intermediate reader (alias=%s)', async (aliasRead) => {
    const f = await fixture({ readAfterOpaque: true, aliasRead });
    try {
      expect(f.run()).toEqual([true, true]);
    } finally {
      await f.dispose();
    }
  });
  it('keeps the preceding resolve when a child graph separates two writers', async () => {
    const f = await fixture({ childBoundary: true });
    try {
      expect(f.run()).toEqual([true, true]);
    } finally {
      await f.dispose();
    }
  });
  it('preserves the preceding result when the final writer is conditional', async () => {
    const f = await fixture({ conditional: true });
    try {
      expect(f.run(false)).toEqual([true]);
    } finally {
      await f.dispose();
    }
  });
  it('retains resolve publication to imported textures', async () => {
    const f = await fixture({ imported: true });
    try {
      expect(f.run()).toEqual([true, true, true]);
    } finally {
      await f.dispose();
    }
  });
});

it('places each resolve and store independently when one of three outputs is observed', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  const targets = [0, 1, 2].map((index) => {
    const samples = graph
      .createTexture(`samples-${index}`, {
        size: 'surface',
        format: 'rgba8unorm',
        sampleCount: 4,
      })
      .unwrap();
    const resolved = graph
      .createTexture(`resolved-${index}`, {
        size: 'surface',
        format: 'rgba8unorm',
      })
      .unwrap();
    return { view: graph.view(samples).unwrap(), resolveTarget: graph.view(resolved).unwrap() };
  });
  const observed = targets[2];
  if (observed === undefined) throw new Error('Missing observed output');
  for (const loadOp of ['clear', 'load'] as const) {
    if (loadOp === 'load')
      graph
        .addCopyPass('observe-third', {
          accesses: [{ resource: observed.resolveTarget, usage: 'copy-src' }],
          encodeDirect() {},
        })
        .unwrap();
    graph
      .addRasterPass(loadOp, {
        accesses: targets.flatMap(({ view, resolveTarget }) => [
          { resource: view, usage: 'color-attachment' as const },
          { resource: resolveTarget, usage: 'color-attachment' as const },
        ]),
        colorAttachments: targets.map((views) => ({ ...views, loadOp, storeOp: 'auto' })),
        encodeDirect() {},
      })
      .unwrap();
  }
  const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const begin = vi.spyOn(encoder, 'beginRenderPass');
    compiled.execute({ encoder }).unwrap();
    expect(
      begin.mock.calls.map(([descriptor]) =>
        Array.from((descriptor as RenderPassDescriptor).colorAttachments, (color) => [
          color?.resolveTarget !== undefined,
          color?.storeOp,
        ]),
      ),
    ).toEqual([
      [
        [false, 'store'],
        [false, 'store'],
        [true, 'store'],
      ],
      [
        [true, 'discard'],
        [true, 'discard'],
        [true, 'discard'],
      ],
    ]);
  } finally {
    (await compiled.retire()).unwrap();
  }
});
