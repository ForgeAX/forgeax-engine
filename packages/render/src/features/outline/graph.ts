import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../../render-pipeline';
import { COLOR_PASS_SELECTOR } from '../../systems/pass-selector';
import { addTypedFullscreenPass, addTypedScenePass } from '../../typed-render-graph-primitives';

function params(_previous: Uint8Array | undefined, frame: RenderPipelineFrame): Uint8Array {
  const outline = frame.camera.outline;
  const values = new Float32Array(8);
  if (outline !== undefined) {
    values.set(outline.visibleColor, 0);
    values[3] = outline.width;
    values.set(outline.hiddenColor, 4);
    values[7] = outline.occlusion;
  }
  return new Uint8Array(values.buffer);
}

/** Selected coverage reuses material deformation/cutout, then the shared scene depth. */
export function addOutlinePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderGraphError> {
  const make = (name: string) =>
    createRenderPipelineTarget(graph, name, {
      format: 'rgba16float',
      size: 'surface',
    });
  const coverage = make('outline-coverage');
  if (!coverage.ok) return coverage;
  const selectedDepth = createRenderPipelineTarget(graph, 'outline-depth', {
    format: 'depth32float-stencil8',
    size: 'surface',
  });
  if (!selectedDepth.ok) return selectedDepth;
  const selected = addTypedScenePass(graph, {
    name: 'outline-selection',
    color: coverage.value,
    depth: selectedDepth.value,
    selector: COLOR_PASS_SELECTOR,
    passKind: 'temporal',
    coverageOnly: true,
    clearColor: [0, 0, 0, 0],
    selectEntities: (frame) => ({
      worldId: frame.camera.worldId ?? 0,
      entities: frame.camera.outline?.entities ?? [],
    }),
  });
  if (!selected.ok) return selected;
  const packed = make('outline-selected-depth');
  if (!packed.ok) return packed;
  const packedPass = addTypedFullscreenPass(graph, {
    name: 'outline-depth-copy',
    shader: 'forgeax.outline.depth',
    input: coverage.value,
    outputs: [packed.value],
    depth: selectedDepth.value,
    paramsTransform: params,
  });
  if (!packedPass.ok) return packedPass;
  const mask = make('outline-mask');
  if (!mask.ok) return mask;
  const classified = addTypedFullscreenPass(graph, {
    name: 'outline-classify',
    shader: depth.sampleCount === 4 ? 'forgeax.outline.classify.msaa' : 'forgeax.outline.classify',
    input: packed.value,
    outputs: [mask.value],
    depth,
    paramsTransform: params,
  });
  if (!classified.ok) return classified;
  const horizontal = make('outline-expanded');
  if (!horizontal.ok) return horizontal;
  const expanded = addTypedFullscreenPass(graph, {
    name: 'outline-horizontal',
    shader: 'forgeax.outline.horizontal',
    input: mask.value,
    outputs: [horizontal.value],
    paramsTransform: params,
  });
  if (!expanded.ok) return expanded;
  const output = createRenderPipelineTarget(graph, 'outline-color', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!output.ok) return output;
  const composite = addTypedFullscreenPass(graph, {
    name: 'outline-composite',
    shader: 'forgeax.outline.composite',
    input,
    outputs: [output.value],
    additionalReads: [
      { key: 'outline-mask', target: mask.value },
      { key: 'outline-expanded', target: horizontal.value },
    ],
    paramsTransform: params,
  });
  return composite.ok ? ok(output.value) : composite;
}
