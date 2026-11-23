import type { GraphTextureDescriptor } from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-types';
import { standardBloomAdmitted } from '../bloom-admission';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import {
  addObservationCapturePass,
  addTypedOutputTransformPass,
} from '../typed-render-graph-primitives';
import type { StandardPipelineBuildContext } from './standard-build-context';
import { buildStandard, standardPipeline } from './standard-pipeline';
import { addStandardBloom } from './standard-post';

/** Replace only Forward's color target and finishing graph; all scene work stays shared. */
export interface StandardForwardOutput {
  readonly format: GraphTextureDescriptor['format'];
  readonly domain: NonNullable<GraphTextureDescriptor['domain']>;
  /** The finishing pass samples this scene color even when only the clear is visible. */
  readonly samplesClearColor?: true;
  build(
    context: RenderPipelineBuildContext<RenderPipelineFrame>,
    topology: RenderPipelineTopology,
    color: RenderPipelineTarget,
    depth: RenderPipelineTarget,
    surface: { readonly display?: RenderPipelineTarget; readonly storage: RenderPipelineTarget },
  ): ReturnType<RenderPipeline['build']>;
}

const standardForwardBuilders = new WeakSet<RenderPipeline['build']>();

/** The registered builder owns scene raster work even when presentation is replaced. */
export function ownsStandardForwardRaster(pipeline: RenderPipeline): boolean {
  return standardForwardBuilders.has(pipeline.build);
}

export function createStandardForwardPipeline(
  output: StandardForwardOutput,
): typeof standardPipeline {
  const build: RenderPipeline['build'] = (context, topology) =>
    buildStandard(
      { ...context, forwardOutput: output },
      // The replaced output exists only on the Forward lane.
      { ...topology, opaque: { ...topology.opaque, lane: 'forward' } },
    );
  standardForwardBuilders.add(build);
  return { identity: standardPipeline.identity, build };
}

/** A renderer-owned premultiplied finishing recipe can select the same current
 * scene and shadow commands as Standard. A caller-supplied build still sees
 * its complete original topology, including every contributor and value. */
export interface PremultipliedForwardOutput extends StandardForwardOutput {
  readonly targetName: string;
  readonly targetKey: string;
}
const premultipliedOutputs = new WeakMap<RenderPipeline, PremultipliedForwardOutput>();

/** Only this built-in finishing operation writes premultiplied linear scene color directly. */
export function premultipliedForwardOutput(
  pipeline: RenderPipeline,
): PremultipliedForwardOutput | undefined {
  return premultipliedOutputs.get(pipeline);
}

export function standardForwardTargetKey(pipeline: RenderPipeline): string | undefined {
  return premultipliedOutputs.get(pipeline)?.targetKey;
}

export function standardViewRecording(pipeline: RenderPipeline): boolean {
  return pipeline === standardPipeline || premultipliedOutputs.has(pipeline);
}

export function buildStandardViewRecording(
  pipeline: RenderPipeline,
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
): ReturnType<RenderPipeline['build']> {
  const output = premultipliedOutputs.get(pipeline);
  if (output === undefined) return buildStandard(context, topology, true);
  return buildStandard(
    { ...context, forwardOutput: output },
    { ...topology, opaque: { ...topology.opaque, lane: 'forward' } },
    true,
  );
}

/** Render premultiplied linear geometry, then present unassociated encoded
 * color. The target name remains available for explicit output observation. */
export function createPremultipliedForwardPipeline(
  format: 'rgba16float' | 'rgba8unorm',
  targetName: string,
): typeof standardPipeline {
  const output: PremultipliedForwardOutput = {
    targetName,
    targetKey: JSON.stringify([format, targetName]),
    samplesClearColor: true,
    format,
    domain: 'linear-hdr',
    build(context, topology, color, _depth, surface) {
      const hdr = addForwardOutputBloom(context, topology, color);
      if (!hdr.ok) return hdr;
      return finishPremultipliedForwardOutput(
        context.graph,
        hdr.value,
        surface.storage,
        targetName,
        (context as StandardPipelineBuildContext).directFinalColor === true,
        context.observationCaptureDomains?.includes('final-display') === true,
      );
    },
  };
  const pipeline = Object.freeze(createStandardForwardPipeline(output));
  premultipliedOutputs.set(pipeline, output);
  return pipeline;
}

/** A requested capture owns a readable encoded image through the observation and present. */
export function finishPremultipliedForwardOutput(
  graph: RenderPipelineBuildContext<RenderPipelineFrame>['graph'],
  color: RenderPipelineTarget,
  storage: RenderPipelineTarget,
  targetName: string,
  direct: boolean,
  capture: boolean,
) {
  if (
    direct &&
    !capture &&
    color.texture !== storage.texture &&
    (storage.format === 'rgba8unorm' || storage.format === 'bgra8unorm')
  ) {
    // The old final sample was a same-size texel copy of an RGBA8 target.
    // The surface performs the identical UNORM conversion on this write.
    return addTypedOutputTransformPass(graph, color, storage, {
      dither: false,
      fragmentEntryPoint: 'fs_premultiplied',
    });
  }
  const display = createRenderPipelineTarget(graph, targetName, {
    format: 'rgba8unorm',
    size: 'surface',
    domain: 'display-encoded',
  });
  if (!display.ok) return display;
  const transformed = addTypedOutputTransformPass(graph, color, display.value, {
    dither: false,
    fragmentEntryPoint: 'fs_premultiplied',
  });
  if (!transformed.ok) return transformed;
  if (capture) {
    const capture = addObservationCapturePass(graph, display.value, 'final-display');
    if (!capture.ok) return capture;
  }
  return addTypedOutputTransformPass(graph, display.value, storage, {
    outputOnly: true,
    fragmentEntryPoint: 'fs_present',
    dither: false,
  });
}

/** Give custom Forward outputs the Standard HDR Bloom stage before output encoding. */
export function addForwardOutputBloom(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
) {
  return standardBloomAdmitted(topology.camera)
    ? addStandardBloom(context, topology, color)
    : ok(color);
}
