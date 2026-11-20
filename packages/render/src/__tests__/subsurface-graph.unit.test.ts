import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Texture } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { addSubsurfaceDiffusion } from '../subsurface/graph';

it.each([
  17, 129, 2161,
])('owns the same four diffusion stages and indirect arguments at height %i', async (height) => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const size = { width: 128, height };
  const textures: Texture[] = [];
  const target = (label: string, format: GPUTextureFormat) => {
    const texture = device.createTexture({ size, format, usage: 0x1f }).unwrap();
    textures.push(texture);
    const resource = graph
      .importTexture(label, { size, format, usage: 0x1f }, () => texture)
      .unwrap();
    return {
      texture: resource,
      view: graph.view(resource, {}).unwrap(),
      format,
      sampleCount: 1 as const,
    };
  };
  const scene = target('scene', 'rgba16float');
  const diffuse = target('diffuse', 'rgba16float');
  const profiles = target('profiles', 'rg32uint');
  const normal = target('normal', 'rg32uint');
  const depth = target('depth', 'depth32float');
  addSubsurfaceDiffusion(graph, {
    scene,
    diffuse,
    profiles: profiles.view,
    normal: normal.view,
    depth: depth.view,
    size,
    scale: [1, 1],
    quality: 'high',
  }).unwrap();
  const compiled = graph.compile({ device, surfaceSize: size }).unwrap();
  try {
    const inspection = compiled.inspect();
    expect(inspection.passes.map(({ name }) => name)).toEqual([
      'subsurface-prepare',
      'subsurface-setup',
      'subsurface-horizontal',
      'subsurface-vertical',
      'subsurface-compose',
    ]);
    const ordered = inspection.passes.slice(2);
    for (const pass of ordered)
      expect(pass.accesses).toContainEqual({
        resource: 'subsurface-indirect',
        usage: 'indirect-read',
      });
    expect(ordered[2]?.accesses).toContainEqual({
      resource: 'scene',
      usage: 'color-attachment',
    });
    expect(
      ordered.flatMap((pass) => pass.accesses).filter(({ resource }) => resource === 'scene'),
    ).toEqual([{ resource: 'scene', usage: 'color-attachment' }]);
  } finally {
    (await compiled.retire()).unwrap();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
  }
});
