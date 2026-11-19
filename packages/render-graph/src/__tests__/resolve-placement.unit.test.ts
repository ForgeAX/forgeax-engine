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
