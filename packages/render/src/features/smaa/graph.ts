import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { Texture } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../../render-pipeline';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import { smaaLookupData } from './lookup-data';

/** All targets and retirement belong to the compiled graph, including lookup textures. */
export function addSmaaPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderGraphError> {
  const area = createRenderPipelineTarget(graph, 'smaa-area', {
    format: 'rg8unorm',
    size: { width: 80, height: 80 },
  });
  if (!area.ok) return area;
  const search = createRenderPipelineTarget(graph, 'smaa-search', {
    format: 'r8unorm',
    size: { width: 66, height: 33 },
  });
  if (!search.ok) return search;
  const data = smaaLookupData();
  for (const lookup of [
    { target: area.value, bytes: data.area, width: 80, height: 80, stride: 160 },
    { target: search.value, bytes: data.search, width: 66, height: 33, stride: 66 },
  ]) {
    let initialized: Texture | undefined;
    const upload = graph.addCopyPass(
      `${lookup.target === area.value ? 'smaa-area' : 'smaa-search'}-upload`,
      {
        accesses: [{ resource: lookup.target.view, usage: 'copy-dst' }],
        encode: ({ frame, resources }) => {
          const texture = resources.texture(lookup.target.texture).unwrap();
          if (texture === initialized) return;
          frame.runtime.device.queue
            .writeTexture(
              { texture },
              lookup.bytes,
              { bytesPerRow: lookup.stride, rowsPerImage: lookup.height },
              { width: lookup.width, height: lookup.height, depthOrArrayLayers: 1 },
            )
            .unwrap();
          initialized = texture;
        },
      },
    );
    if (!upload.ok) return upload;
  }
  const edges = createRenderPipelineTarget(graph, 'smaa-edges', {
    format: 'rg8unorm',
    size: 'surface',
  });
  if (!edges.ok) return edges;
  const weights = createRenderPipelineTarget(graph, 'smaa-weights', {
    format: 'rgba8unorm',
    size: 'surface',
  });
  if (!weights.ok) return weights;
  const output = createRenderPipelineTarget(graph, 'smaa-color', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!output.ok) return output;
  const detected = addTypedFullscreenPass(graph, {
    name: 'smaa-edges',
    shader: 'forgeax.smaa.edges',
    clearColor: [0, 0, 0, 0],
    input,
    outputs: [edges.value],
  });
  if (!detected.ok) return detected;
  const calculated = addTypedFullscreenPass(graph, {
    name: 'smaa-weights',
    shader: 'forgeax.smaa.weights',
    clearColor: [0, 0, 0, 0],
    input: edges.value,
    outputs: [weights.value],
    additionalReads: [
      { key: 'smaa-area', target: area.value },
      { key: 'smaa-search', target: search.value },
    ],
  });
  if (!calculated.ok) return calculated;
  const blended = addTypedFullscreenPass(graph, {
    name: 'smaa-blend',
    shader: 'forgeax.smaa.blend',
    input,
    outputs: [output.value],
    additionalReads: [{ key: 'smaa-weights', target: weights.value }],
  });
  return blended.ok ? ok(output.value) : blended;
}
