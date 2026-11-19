import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Buffer, RhiCanvasTarget, RhiCommandEncoder, RhiInstance } from '@forgeax/engine-rhi';
import { expect, vi } from 'vitest';

export const FORWARD_RESOLVE_CASES = [
  {
    reader: false,
    empty: true,
    conditional: false,
    imported: false,
    resolves: 1,
    automatic: false,
  },
  {
    reader: true,
    empty: false,
    conditional: false,
    imported: false,
    resolves: 2,
    automatic: false,
  },
  {
    reader: false,
    empty: false,
    conditional: true,
    imported: false,
    resolves: 1,
    automatic: false,
  },
  {
    reader: false,
    empty: false,
    conditional: false,
    imported: true,
    resolves: 3,
    automatic: false,
  },
  { reader: false, empty: true, conditional: false, imported: false, resolves: 1, automatic: true },
  { reader: true, empty: false, conditional: false, imported: false, resolves: 2, automatic: true },
  { reader: false, empty: false, conditional: true, imported: false, resolves: 1, automatic: true },
  { reader: false, empty: false, conditional: false, imported: true, resolves: 3, automatic: true },
] as const;

async function expectResolvedPixels(buffer: Buffer, expected: readonly number[]): Promise<void> {
  const mapped = (await buffer.mapAsync(1)).unwrap();
  try {
    const pixels = new Uint8Array(mapped.getMappedRange().unwrap());
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        expect(Array.from(pixels.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4))).toEqual(expected);
  } finally {
    mapped.unmap();
  }
}

export async function verifyForwardResolvePlacement(
  rhi: RhiInstance,
  options: (typeof FORWARD_RESOLVE_CASES)[number],
  compatibleSurface?: RhiCanvasTarget,
): Promise<void> {
  const device = (
    await (await rhi.requestAdapter(undefined, compatibleSurface)).unwrap().requestDevice()
  ).unwrap();
  const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  const color = graph
    .createTexture('scene-msaa', {
      size: { width: 8, height: 8 },
      format: 'rgba8unorm',
      sampleCount: 4,
    })
    .unwrap();
  const external = options.imported
    ? device
        .createTexture({ size: { width: 8, height: 8 }, format: 'rgba8unorm', usage: 0x11 })
        .unwrap()
    : undefined;
  const resolved =
    external === undefined
      ? graph
          .createTexture('scene-resolved', { size: { width: 8, height: 8 }, format: 'rgba8unorm' })
          .unwrap()
      : graph
          .importTexture(
            'scene-resolved',
            { size: { width: 8, height: 8 }, format: 'rgba8unorm', usage: 0x11 },
            () => external,
          )
          .unwrap();
  const colorView = graph.view(color).unwrap(),
    resolvedView = graph.view(resolved).unwrap();
  const readbacks: { buffer: Buffer; expected: readonly number[] }[] = [];
  const copy = (name: string, expected: readonly number[]) => {
    const buffer = device.createBuffer({ size: 256 * 8, usage: 9 }).unwrap();
    readbacks.push({ buffer, expected });
    const target = graph.importBuffer(name, { size: 256 * 8, usage: 9 }, () => buffer).unwrap();
    graph
      .addCopyPass(name, {
        accesses: [
          { resource: resolvedView, usage: 'copy-src' },
          { resource: target, usage: 'copy-dst' },
        ],
        encodeDirect(encoder, _frame, resources) {
          encoder.copyTextureToBuffer(
            { texture: resources.texture(resolved).unwrap() },
            { buffer, bytesPerRow: 256, rowsPerImage: 8 },
            { width: 8, height: 8, depthOrArrayLayers: 1 },
          );
        },
      })
      .unwrap();
  };
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
            loadOp: index === 2 && options.empty ? 'load' : 'clear',
            storeOp: options.automatic ? 'auto' : 'store',
            clearValue:
              index === 0 ? [1, 0, 0, 1] : index === 1 ? [0.125, 0.25, 0.75, 1] : [0, 1, 0, 1],
          },
        ],
        ...(index === 2 && options.conditional ? { executeIf: () => false } : {}),
        encodeDirect() {},
      })
      .unwrap();
    if (index === 1 && options.reader) copy('opaque-read', [32, 64, 191, 255]);
  }
  copy('final-read', options.empty || options.conditional ? [32, 64, 191, 255] : [0, 255, 0, 255]);
  const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const begin = vi.spyOn(encoder, 'beginRenderPass');
    compiled.execute({ encoder }).unwrap();
    expect(
      begin.mock.calls.reduce(
        (count, [descriptor]) =>
          count +
          Array.from(descriptor.colorAttachments).filter(
            (attachment) => attachment?.resolveTarget !== undefined,
          ).length,
        0,
      ),
    ).toBe(options.resolves);
    const stores = begin.mock.calls.map(
      ([descriptor]) => Array.from(descriptor.colorAttachments)[0]?.storeOp,
    );
    expect(stores).not.toContain('auto');
    expect(stores.at(-1)).toBe(options.automatic && !options.conditional ? 'discard' : 'store');
    expect(stores.slice(0, -1).every((store) => store === 'store')).toBe(true);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    for (const { buffer, expected } of readbacks) await expectResolvedPixels(buffer, expected);
  } finally {
    (await compiled.retire()).unwrap();
    for (const { buffer } of readbacks) device.destroyBuffer(buffer).unwrap();
    if (external !== undefined) device.destroyTexture(external).unwrap();
  }
}
