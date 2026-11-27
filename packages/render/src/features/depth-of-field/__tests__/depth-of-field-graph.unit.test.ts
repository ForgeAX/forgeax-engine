import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../../render-pipeline';
import { addDepthOfFieldPasses, depthOfFieldTopology } from '../depth-of-field-feature';
import { inspectDepthOfFieldGraph } from '../depth-of-field-inspection';
import { DEFAULT_DEPTH_OF_FIELD_PARAMS } from '../depth-of-field-params';

const sides = ['near', 'far', 'both'] as const;
const formats = ['rg16float', 'rgba16float'] as const;

it.each(
  sides.flatMap((blurSide) =>
    formats.flatMap((format) => [false, true].map((compute) => ({ blurSide, format, compute }))),
  ),
)('declares paired prefilter outputs for $blurSide with $format CoC (compute tiles: $compute)', async ({
  blurSide,
  format,
  compute,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const imported = (label: string, format: TextureFormat): RenderPipelineTarget => {
    const texture = graph
      .importTexture(
        label,
        { format, size: 'surface', usage: 0x04 },
        (frame) => frame.outputTarget().texture,
      )
      .unwrap();
    return { texture, view: graph.view(texture).unwrap(), format, sampleCount: 1 };
  };
  const color = imported('color', 'rgba16float');
  const depth = imported('depth', 'depth32float');
  const params = { ...DEFAULT_DEPTH_OF_FIELD_PARAMS, blurSide };
  addDepthOfFieldPasses(graph, params, { width: 129, height: 73 }, color, depth, format, {
    compute,
    storageTexture: compute,
  }).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 129, height: 73 } }).unwrap();
  try {
    const info = compiled.inspect();
    const coc = info.resources.find((resource) => resource.label === 'dof-coc');
    expect(coc?.descriptor).toMatchObject({ format, width: 129, height: 73 });
    const gather = info.passes.find((pass) => pass.name === `dof-gather-${blurSide}`);
    for (const name of ['dof-tile-radius', 'dof-tile-influence']) {
      const tile = info.resources.find((resource) => resource.label === name);
      expect(tile?.descriptor).toMatchObject({
        format: compute ? 'rgba8unorm' : 'rg8unorm',
        width: 9,
        height: 5,
      });
    }
    if (compute) {
      const tiles = info.passes.find((pass) => pass.name === 'dof-tiles');
      expect(tiles?.dependencies).toContain('dof-coc');
      expect(tiles?.accesses).toContainEqual(
        expect.objectContaining({
          resource: 'dof-tile-radius',
          usage: 'sampled-storage-write',
        }),
      );
      expect(gather?.dependencies).toContain('dof-tiles');
    } else {
      expect(info.passes.find((pass) => pass.name === 'dof-tile-radius')?.dependencies).toContain(
        'dof-coc',
      );
      expect(
        info.passes.find((pass) => pass.name === 'dof-tile-influence')?.dependencies,
      ).toContain('dof-tile-radius');
      expect(gather?.dependencies).toContain('dof-tile-influence');
    }
    const writes = gather?.accesses
      .filter((access) => access.usage === 'color-attachment')
      .map((access) => access.resource);
    expect(writes).toEqual(
      blurSide === 'both'
        ? ['dof-near', 'dof-far', 'dof-background']
        : blurSide === 'near'
          ? ['dof-near', 'dof-background']
          : ['dof-far'],
    );
    for (const side of ['near', 'far'] as const) {
      const name = `dof-prefilter-${side}`;
      const prefilter = info.passes.find((pass) => pass.name === name);
      expect(info.passes.some((pass) => pass.name === `${name}-metadata`)).toBe(false);
      if (blurSide === 'both' || blurSide === side) {
        const attachments = prefilter?.accesses
          .filter((access) => access.usage === 'color-attachment')
          .map((access) => access.resource);
        expect(attachments).toEqual([name, `${name}-metadata`]);
        expect(gather?.dependencies).toContain(name);
      } else {
        expect(prefilter).toBeUndefined();
        expect(info.resources.some((resource) => resource.label.startsWith(name))).toBe(false);
      }
    }
    const shape = depthOfFieldTopology(params);
    if (shape === undefined) throw new Error('expected an active DoF aperture');
    const inspect = vi.spyOn(compiled, 'inspect');
    const cocBytesPerPixel = format === 'rg16float' ? 4 : 8;
    const halfTargets = blurSide === 'both' ? 7 : blurSide === 'near' ? 4 : 3;
    expect(inspectDepthOfFieldGraph(compiled, shape)).toMatchObject({
      status: 'active',
      passCount: (blurSide === 'both' ? 7 : 6) - Number(compute),
      textureBytes:
        129 * 73 * (8 + cocBytesPerPixel) +
        65 * 37 * 8 * halfTargets +
        2 * 9 * 5 * (compute ? 4 : 2),
      outputExtent: { width: 129, height: 73 },
      workExtent: { width: 65, height: 37 },
    });
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    (await compiled.retire()).unwrap();
  }
});
