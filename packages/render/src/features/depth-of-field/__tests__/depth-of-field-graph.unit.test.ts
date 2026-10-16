import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../../render-pipeline';
import { addDepthOfFieldPasses } from '../depth-of-field-feature';
import { inspectDepthOfFieldGraph } from '../depth-of-field-inspection';
import { DEFAULT_DEPTH_OF_FIELD_PARAMS } from '../depth-of-field-params';

it.each([
  'near',
  'far',
  'both',
] as const)('declares all shared gather dependencies and only the enabled %s outputs', async (blurSide) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const imported = (label: string, format: TextureFormat): RenderPipelineTarget => {
    const texture = graph
      .importTexture(
        label,
        { format, size: 'surface', usage: 0x04 },
        (frame) => frame.currentTexture,
      )
      .unwrap();
    return { texture, view: graph.view(texture).unwrap(), format, sampleCount: 1 };
  };
  const color = imported('color', 'rgba16float');
  const depth = imported('depth', 'depth32float');
  const params = { ...DEFAULT_DEPTH_OF_FIELD_PARAMS, blurSide };
  addDepthOfFieldPasses(
    { graph, camera: { depthOfField: params }, temporalTaa: false },
    color,
    depth,
  ).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 129, height: 73 } }).unwrap();
  try {
    const info = compiled.inspect();
    const gather = info.passes.find((pass) => pass.name === `dof-gather-${blurSide}`);
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
      if (blurSide === 'both' || blurSide === side) {
        expect(gather?.dependencies).toEqual(
          expect.arrayContaining([`dof-prefilter-${side}`, `dof-prefilter-${side}-metadata`]),
        );
      } else {
        expect(info.resources.some((resource) => resource.label === `dof-prefilter-${side}`)).toBe(
          false,
        );
      }
    }
    expect(inspectDepthOfFieldGraph(info, params)).toMatchObject({
      status: 'active',
      passCount: blurSide === 'both' ? 7 : 5,
      outputExtent: { width: 129, height: 73 },
      workExtent: { width: 65, height: 37 },
    });
  } finally {
    (await compiled.retire()).unwrap();
  }
});
