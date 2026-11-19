import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type { GraphTextureView } from '../types.js';

function fixtureDepthAttachment(depth: GraphTextureView, i: number, boundary: string | undefined) {
  if (i === 1 && boundary === 'depth-read-only')
    return { view: depth, depthReadOnly: true } as const;
  return {
    view: depth,
    depthLoadOp: i === 0 || (i === 1 && boundary === 'depth-clear') ? 'clear' : 'load',
    depthStoreOp: 'store',
    depthClearValue: 0,
  } as const;
}

async function fixture(
  boundary?:
    | 'copy'
    | 'conditional'
    | 'clear'
    | 'query'
    | 'storage'
    | 'depth-clear'
    | 'depth-read-only',
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  const texture = graph
    .createTexture('color', {
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      sampleCount: 4,
    })
    .unwrap();
  const resolved = graph
    .createTexture('resolved', {
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
    })
    .unwrap();
  const view = graph.view(texture).unwrap();
  const resolve = graph.view(resolved).unwrap();
  const depth = graph
    .view(
      graph
        .createTexture('depth', {
          size: { width: 4, height: 4 },
          format: 'depth32float',
          sampleCount: 4,
        })
        .unwrap(),
    )
    .unwrap();
  const buffer = graph.createBuffer('private', { size: 16 }).unwrap();
  graph
    .addCopyPass('initialize', {
      accesses: [{ resource: buffer, usage: 'copy-dst' }],
      encodeDirect() {},
    })
    .unwrap();
  const encoded: string[] = [];
  const query =
    boundary === 'query'
      ? device.createQuerySet({ type: 'occlusion', count: 1 }).unwrap()
      : undefined;
  for (const [i, name] of ['sky', 'opaque', 'transparent'].entries()) {
    const depthReadOnly = i === 1 && boundary === 'depth-read-only';
    const storageWrite = i === 1 && boundary === 'storage';
    graph
      .addRasterPass(name, {
        accesses: [
          { resource: view, usage: 'color-attachment' },
          { resource: resolve, usage: 'color-attachment' },
          {
            resource: depth,
            usage: depthReadOnly ? 'depth-stencil-read' : 'depth-stencil-write',
          },
          ...(i === 0 ? [{ resource: buffer, usage: 'uniform-read' as const }] : []),
          ...(storageWrite ? [{ resource: buffer, usage: 'storage-write' as const }] : []),
        ],
        colorAttachments: [
          {
            view,
            resolveTarget: resolve,
            loadOp: i === 0 || (boundary === 'clear' && i === 1) ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: fixtureDepthAttachment(depth, i, boundary),
        ...(i === 1 && boundary === 'conditional' ? { executeIf: () => true } : {}),
        ...(i === 1 && query !== undefined ? { occlusionQuerySet: query } : {}),
        encodeDirect(pass, _frame, resources) {
          encoded.push(name);
          expect(resources.buffer(buffer).ok).toBe(i === 0 || storageWrite);
          if (i === 0) pass.setScissorRect(0, 0, 1, 1);
        },
      })
      .unwrap();
    if (i === 1 && boundary === 'copy')
      graph
        .addCopyPass('observe', {
          accesses: [{ resource: resolve, usage: 'copy-src' }],
          encodeDirect() {},
        })
        .unwrap();
  }
  const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  const nativeBegin = encoder.beginRenderPass.bind(encoder);
  const begin = vi.spyOn(encoder, 'beginRenderPass');
  return {
    compiled,
    encoder,
    begin,
    nativeBegin,
    encoded,
    async dispose() {
      await compiled.retire();
      if (query !== undefined) device.destroyQuerySet(query).unwrap();
    },
  };
}

describe('native raster batching', () => {
  it('shares one native pass, preserves logical callbacks and scopes resources per member', async () => {
    const f = await fixture();
    const logical: string[] = [],
      physical: string[] = [];
    try {
      f.compiled
        .execute(
          { encoder: f.encoder },
          (pass, encode) => {
            logical.push(pass.name);
            if (pass.kind === 'raster')
              expect(pass.resolvedDepthStencilAttachmentView).toBeDefined();
            encode();
          },
          {
            begin(pass) {
              physical.push(pass.name);
              return undefined;
            },
          },
        )
        .unwrap();
      expect(f.begin).toHaveBeenCalledTimes(1);
      expect(f.encoded).toEqual(['sky', 'opaque', 'transparent']);
      expect(logical).toEqual(['initialize', ...f.encoded]);
      expect(physical).toEqual(['initialize', 'sky + opaque + transparent']);
      expect(
        f.compiled
          .inspect()
          .passes.slice(1)
          .map((p) => p.rasterBatch),
      ).toEqual([f.encoded, f.encoded, f.encoded]);
    } finally {
      await f.dispose();
    }
  });
  it('materializes only explicitly requested native observation boundaries', async () => {
    const f = await fixture();
    const runner = Object.assign((_pass: unknown, encode: () => void) => encode(), {
      requiresPassBoundary: (name: string) => name === 'opaque',
    });
    try {
      f.compiled.execute({ encoder: f.encoder }, runner).unwrap();
      expect(f.begin).toHaveBeenCalledTimes(3);
      expect(f.encoded).toEqual(['sky', 'opaque', 'transparent']);
    } finally {
      await f.dispose();
    }
  });
  it('restores native labels and resolve descriptors when an observation splits a retained batch', async () => {
    const f = await fixture();
    const runner = Object.assign((_pass: unknown, encode: () => void) => encode(), {
      requiresPassBoundary: (name: string) => name === 'opaque',
    });
    try {
      for (const split of [false, true, false]) {
        f.begin.mockClear();
        f.compiled.execute({ encoder: f.encoder }, split ? runner : undefined).unwrap();
        expect(f.begin.mock.calls.map(([descriptor]) => descriptor.label)).toEqual(
          split ? ['sky', 'opaque', 'transparent'] : ['sky + opaque + transparent'],
        );
        expect(
          f.begin.mock.calls.map(
            ([descriptor]) =>
              Array.from(descriptor.colorAttachments)[0]?.resolveTarget !== undefined,
          ),
        ).toEqual(split ? [false, false, true] : [true]);
      }
    } finally {
      await f.dispose();
    }
  });
  it.each([
    ['copy', 2],
    ['conditional', 3],
    ['clear', 2],
    ['query', 3],
    ['storage', 3],
    ['depth-clear', 2],
    ['depth-read-only', 3],
  ] as const)('retains the %s boundary', async (boundary, count) => {
    const f = await fixture(boundary);
    try {
      f.compiled.execute({ encoder: f.encoder }).unwrap();
      expect(f.begin).toHaveBeenCalledTimes(count);
    } finally {
      await f.dispose();
    }
  });
  it('closes a failed batch, names the failing logical owner and retries with a fresh frame', async () => {
    const f = await fixture();
    const ended = vi.fn();
    f.begin.mockImplementation((descriptor) => {
      const pass = f.nativeBegin(descriptor),
        end = pass.end.bind(pass);
      vi.spyOn(pass, 'end').mockImplementation(() => {
        ended();
        end();
      });
      return pass;
    });
    try {
      const failed = f.compiled.execute({ encoder: f.encoder }, (pass, encode) => {
        if (pass.name === 'opaque') throw new Error('batch recovery witness');
        encode();
      });
      expect(failed.ok).toBe(false);
      if (!failed.ok)
        expect(failed.error).toMatchObject({
          code: 'pass-encode-failed',
          detail: { passName: 'opaque' },
        });
      expect(ended).toHaveBeenCalledTimes(1);
      f.compiled.execute({ encoder: f.encoder }).unwrap();
      expect(ended).toHaveBeenCalledTimes(2);
      expect(f.encoded).toEqual(['sky', 'sky', 'opaque', 'transparent']);
    } finally {
      await f.dispose();
    }
  });
  it('keeps a sampled alias of the next resolve allocation outside the native usage scope', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    const color = graph
      .view(
        graph
          .createTexture('msaa', {
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            sampleCount: 4,
          })
          .unwrap(),
      )
      .unwrap();
    const texture = graph
      .createTexture('resolved', {
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
      })
      .unwrap();
    const resolve = graph.view(texture).unwrap(),
      alias = graph.view(texture).unwrap();
    graph
      .addCopyPass('initialize', {
        accesses: [{ resource: resolve, usage: 'copy-dst' }],
        encodeDirect() {},
      })
      .unwrap();
    graph
      .addRasterPass('sample', {
        accesses: [
          { resource: color, usage: 'color-attachment' },
          { resource: alias, usage: 'sampled-read' },
        ],
        colorAttachments: [{ view: color, loadOp: 'clear', storeOp: 'store' }],
        encodeDirect() {},
      })
      .unwrap();
    graph
      .addRasterPass('resolve', {
        accesses: [
          { resource: color, usage: 'color-attachment' },
          { resource: resolve, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: color, resolveTarget: resolve, loadOp: 'load', storeOp: 'store' },
        ],
        encodeDirect() {},
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap(),
        begin = vi.spyOn(encoder, 'beginRenderPass');
      compiled.execute({ encoder }).unwrap();
      expect(begin).toHaveBeenCalledTimes(2);
    } finally {
      (await compiled.retire()).unwrap();
    }
  });
});
