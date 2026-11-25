import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { OutlineSnapshot } from '../../components/outline';
import type { WaterInfoGraphTargets } from '../../pipeline/standard-build-context';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../../render-pipeline';
import { COLOR_PASS_SELECTOR } from '../../systems/pass-selector';
import { addTypedFullscreenPass, addTypedScenePass } from '../../typed-render-graph-primitives';

function outlineParams(outline: OutlineSnapshot | undefined): Uint8Array {
  const values = new Float32Array(8);
  if (outline !== undefined) {
    values.set(outline.visibleColor, 0);
    values[3] = outline.width;
    values.set(outline.hiddenColor, 4);
    values[7] = outline.occlusion;
  }
  return new Uint8Array(values.buffer);
}

function addOutlineSelection(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: (name: string) => string,
  size: GraphTextureDescriptor['size'],
  sampleCount: 1 | 4,
  selection: ((frame: RenderPipelineFrame) => OutlineSnapshot | undefined) | undefined,
  waterInfoTargets?: WaterInfoGraphTargets,
): Result<{ coverage: RenderPipelineTarget; depth: RenderPipelineTarget }, RenderGraphError> {
  const coverage = createRenderPipelineTarget(graph, label('outline-coverage'), {
    format: sampleCount === 4 ? 'r8unorm' : 'rgba16float',
    size,
    sampleCount,
  });
  if (!coverage.ok) return coverage;
  const selectedDepth = createRenderPipelineTarget(graph, label('outline-depth'), {
    format: 'depth32float-stencil8',
    size,
    sampleCount,
  });
  if (!selectedDepth.ok) return selectedDepth;
  const selected = addTypedScenePass(graph, {
    name: label('outline-selection'),
    color: coverage.value,
    depth: selectedDepth.value,
    ...(waterInfoTargets === undefined || waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    selector: COLOR_PASS_SELECTOR,
    passKind: 'temporal',
    coverageOnly: true,
    clearColor: [0, 0, 0, 0],
    ...(selection === undefined
      ? { selection: 'camera-outline' as const }
      : {
          selectEntities: (frame: RenderPipelineFrame) => ({
            entities: selection(frame)?.entities ?? [],
          }),
        }),
  });
  return selected.ok ? ok({ coverage: coverage.value, depth: selectedDepth.value }) : selected;
}

/** Selected coverage reuses material deformation/cutout, then the shared scene depth. */
export function addOutlinePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  internalSize: GraphTextureDescriptor['size'],
  options: {
    readonly premultipliedScene?: true;
    readonly prefix?: string;
    readonly programPrefix?: string;
    readonly selection?: (frame: RenderPipelineFrame) => OutlineSnapshot | undefined;
  } = {},
  waterInfoTargets?: WaterInfoGraphTargets,
): Result<RenderPipelineTarget, RenderGraphError> {
  const label = (name: string) => name.replace(/^outline/, options.prefix ?? 'outline');
  const selection =
    options.selection ??
    ((frame: RenderPipelineFrame) =>
      frame.camera.outline?.distanceField ? undefined : frame.camera.outline);
  const params = (_previous: Uint8Array | undefined, frame: RenderPipelineFrame) =>
    outlineParams(selection(frame));
  const program = (name: string) =>
    name.replace('forgeax.outline', options.programPrefix ?? 'forgeax.outline');
  const make = (name: string) =>
    createRenderPipelineTarget(graph, label(name), {
      format: 'rgba16float',
      size: 'surface',
    });
  const msaa = depth.sampleCount === 4;
  const selectionSize = msaa ? internalSize : 'surface';
  const selected = addOutlineSelection(
    graph,
    label,
    selectionSize,
    depth.sampleCount,
    options.selection,
    waterInfoTargets,
  );
  if (!selected.ok) return selected;
  const packed = createRenderPipelineTarget(graph, label('outline-selected-depth'), {
    format: msaa ? 'rgba32float' : 'rgba16float',
    size: selectionSize,
  });
  if (!packed.ok) return packed;
  const packedPass = addTypedFullscreenPass(graph, {
    name: label('outline-depth-copy'),
    shader: program(msaa ? 'forgeax.outline.depth.msaa' : 'forgeax.outline.depth'),
    input: msaa ? input : selected.value.coverage,
    outputs: [packed.value],
    depth: selected.value.depth,
    paramsTransform: params,
  });
  if (!packedPass.ok) return packedPass;
  const mask = make('outline-mask');
  if (!mask.ok) return mask;
  const classified = addTypedFullscreenPass(graph, {
    name: label('outline-classify'),
    shader: program(msaa ? 'forgeax.outline.classify.msaa' : 'forgeax.outline.classify'),
    input: packed.value,
    outputs: [mask.value],
    depth,
    paramsTransform: params,
  });
  if (!classified.ok) return classified;
  const horizontal = make('outline-expanded');
  if (!horizontal.ok) return horizontal;
  const expanded = addTypedFullscreenPass(graph, {
    name: label('outline-horizontal'),
    shader: program('forgeax.outline.horizontal'),
    input: mask.value,
    outputs: [horizontal.value],
    paramsTransform: params,
  });
  if (!expanded.ok) return expanded;
  const output = createRenderPipelineTarget(graph, label('outline-color'), {
    format: 'rgba16float',
    size: 'surface',
    domain: options.premultipliedScene ? 'linear-hdr' : 'linear-ldr',
  });
  if (!output.ok) return output;
  const composite = addTypedFullscreenPass(graph, {
    name: label('outline-composite'),
    shader: program(
      options.premultipliedScene
        ? 'forgeax.outline.composite.premultiplied'
        : 'forgeax.outline.composite',
    ),
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
