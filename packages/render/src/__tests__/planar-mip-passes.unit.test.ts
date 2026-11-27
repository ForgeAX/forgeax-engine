import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { addGraphColorMipPasses } from '../graph-color-mips';
import type { RenderPipelineFrame } from '../render-pipeline';

it.each([
  'webgpu',
  'wgpu-native',
  'wgpu-webgl2',
] as const)('keeps planar mip dependencies and avoids unnecessary copies (%s)', async (backendKind) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder<RenderPipelineFrame>();
  const descriptor = {
    shape: '2d',
    width: 17,
    height: 5,
    format: 'rgba16float',
    sampleCount: 1,
    mipLevels: 'full',
    sampled: true,
    readback: false,
  } as const;
  const physical = device
    .createTexture({
      size: { width: 17, height: 5 },
      format: descriptor.format,
      mipLevelCount: 5,
      usage: 23,
    })
    .unwrap();
  const texture = builder
    .importTexture(
      'mirror',
      {
        size: { width: 17, height: 5 },
        format: descriptor.format,
        mipLevelCount: 5,
        usage: 23,
      },
      () => physical,
    )
    .unwrap();
  expect(
    addGraphColorMipPasses(
      builder,
      'mirror',
      texture,
      descriptor,
      5,
      () => {},
      undefined,
      backendKind,
    ).ok,
  ).toBe(true);
  const graph = builder.compile({ device, surfaceSize: { width: 17, height: 5 } }).unwrap();
  try {
    const info = graph.inspect();
    const scratch = backendKind === 'wgpu-webgl2';
    expect(info.passes.filter((p) => p.kind === 'raster')).toHaveLength(4);
    expect(info.passes.filter((p) => p.kind === 'copy')).toHaveLength(scratch ? 4 : 0);
    expect(
      info.resources.filter((r) => r.origin === 'created' && r.kind === 'texture'),
    ).toHaveLength(scratch ? 1 : 0);
    for (let mip = 2; mip < 5; mip++) {
      const pass = info.passes.find((p) => p.name === `mirror-mip-${mip}`);
      expect(pass?.dependencies).toContain(
        scratch ? `mirror-mip-copy-${mip - 1}` : `mirror-mip-${mip - 1}`,
      );
    }
  } finally {
    (await graph.retire()).unwrap();
    device.destroyTexture(physical).unwrap();
  }
});
