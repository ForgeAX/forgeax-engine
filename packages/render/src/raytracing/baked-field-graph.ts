import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RayDiffuseTargets } from './diffuse-graph';
import { addFieldGatherPasses, viewUniform } from './irradiance-field-graph';
import type { BakedFieldExtent, PreparedBakedField } from './renderer-baked-field';

/** Graph identity: the volume generation and the view extent. */
export function bakedFieldGraphShape(prepared: PreparedBakedField) {
  const extent = prepared.extent();
  return [prepared.generation, extent.width, extent.height, extent.upsampled !== undefined];
}

/** Baked diffuse GI: view gather (-> upsample) of the resident Catalog volume
 * -> the shared additive diffuse composite. No pass traces or updates probes. */
export function addBakedFieldPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedBakedField,
  target: RayDiffuseTargets,
): Result<void, RenderGraphError> {
  const current = () => {
    if (prepared.fence.currentGeneration() !== prepared.generation)
      throw new Error('stale baked field graph; prepare the current volume');
    return prepared;
  };
  const b = prepared.buffers;
  const imported = (name: keyof typeof b, uniform = false) =>
    graph
      .importBuffer(
        `baked-field.${name}`,
        { size: b[name].size, usage: (uniform ? 64 : 128) | 12 },
        () => current().buffers[name].buffer,
      )
      .unwrap();
  const extentBuffer = (
    name: string,
    size: number,
    pick: (value: BakedFieldExtent) => Buffer | undefined,
  ) =>
    graph
      .importBuffer(`baked-field.${name}`, { size, usage: 128 | 12 }, () => {
        const value = pick(current().extent());
        if (value === undefined) throw new Error(`baked field lost its ${name} buffer`);
        return value;
      })
      .unwrap();
  return addFieldGatherPasses({
    label: 'baked-field',
    graph,
    current,
    target,
    extent: prepared.extent(),
    handles: {
      frame: imported('frame', true),
      field: imported('field', true),
      irradiance: imported('irradiance'),
      moments: imported('moments'),
      meta: imported('meta'),
    },
    extentBuffer,
    view: viewUniform(graph, 'baked-field'),
  });
}
