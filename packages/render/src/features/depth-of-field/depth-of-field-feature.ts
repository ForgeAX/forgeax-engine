import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { DepthOfFieldSide } from '../../components/depth-of-field';
import type { RenderExtent } from '../../pipeline/render-extent';
import { renderExtentSize } from '../../pipeline/render-extent';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import type { DepthOfFieldParams } from './depth-of-field-params';

export const DEPTH_OF_FIELD_COC_ID = 'forgeax.dof.coc';
export const DEPTH_OF_FIELD_PREFILTER_ID = 'forgeax.dof.prefilter';
export const DEPTH_OF_FIELD_PREFILTER_METADATA_ID = 'forgeax.dof.prefilter.metadata';
export const DEPTH_OF_FIELD_GATHER_ID = 'forgeax.dof.gather';
export const DEPTH_OF_FIELD_COMPOSITE_ID = 'forgeax.dof.composite';

/** All declarations are registered together so the build catalog is finite. */
export const DEPTH_OF_FIELD_POST_PROCESS_IDS = Object.freeze([
  DEPTH_OF_FIELD_COC_ID,
  DEPTH_OF_FIELD_PREFILTER_ID,
  DEPTH_OF_FIELD_PREFILTER_METADATA_ID,
  DEPTH_OF_FIELD_GATHER_ID,
  DEPTH_OF_FIELD_COMPOSITE_ID,
] as const);
export const DEPTH_OF_FIELD_MSAA_POST_PROCESS_IDS = Object.freeze(
  DEPTH_OF_FIELD_POST_PROCESS_IDS.map((id) => `${id}.msaa` as const),
);

export function depthOfFieldPostProcessId(id: string, multisampled: boolean): string {
  return multisampled ? `${id}.msaa` : id;
}

export interface DepthOfFieldTopology {
  readonly blurSide: DepthOfFieldSide;
  readonly useNear: boolean;
  readonly useFar: boolean;
}

export function depthOfFieldTopology(
  params: DepthOfFieldParams | undefined,
): DepthOfFieldTopology | undefined {
  if (params === undefined || params.maxRadiusPixels <= 0) return undefined;
  return {
    blurSide: params.blurSide,
    useNear: params.blurSide === 'near' || params.blurSide === 'both',
    useFar: params.blurSide === 'far' || params.blurSide === 'both',
  };
}

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: Parameters<RenderGraphBuilder<RenderPipelineFrame>['createTexture']>[1],
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function addPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  options: Parameters<typeof addTypedFullscreenPass>[1],
): Result<void, RenderGraphError> {
  return addTypedFullscreenPass(graph, options);
}

/**
 * Project the built-in spatial DoF graph after the shared temporal/metering
 * seam. The graph owns every intermediate; the renderer only supplies UBO
 * bytes and the manifest-backed fullscreen programs at record time.
 */
export function addDepthOfFieldPasses(
  context: {
    readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
    readonly camera: {
      readonly depthOfField?: DepthOfFieldParams | undefined;
    };
    readonly temporalTaa: boolean;
    readonly msaaActive?: boolean;
    /** Shared Standard pixel domains. DoF never invents a second extent. */
    readonly extent?: RenderExtent;
  },
  input: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  temporal?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderGraphError> {
  const params = context.camera.depthOfField;
  const topology = depthOfFieldTopology(params);
  if (params === undefined || topology === undefined) return ok(input);

  // The graph texture is the contract. Never select the multisampled shader
  // from a camera flag while the bound depth target is single-sample.
  const multisampled = depth.sampleCount === 4;
  const graph = context.graph;
  const extentSize =
    context.extent === undefined
      ? undefined
      : renderExtentSize(context.extent, context.temporalTaa ? 'output' : 'internal');
  const fullSize = extentSize ?? ('surface' as const);
  const halfSize =
    extentSize === undefined
      ? ('half-surface' as const)
      : {
          width: Math.max(1, Math.ceil(extentSize.width / 2)),
          height: Math.max(1, Math.ceil(extentSize.height / 2)),
        };
  const coc = target(graph, 'dof-coc', {
    format: 'rgba16float',
    size: fullSize,
    domain: 'linear-hdr',
  });
  if (!coc.ok) return coc;
  const cocPass = addPass(graph, {
    name: 'dof-coc',
    shader: depthOfFieldPostProcessId(DEPTH_OF_FIELD_COC_ID, multisampled),
    fragmentEntryPoint: 'fs_coc',
    input,
    depth,
    outputs: [coc.value],
    additionalReads: [
      {
        key: 'scene-temporal',
        // No-TAA DoF deliberately aliases this optional input to current color;
        // only the TAA route consumes the matching resolved temporal attachment.
        target: context.temporalTaa && temporal !== undefined ? temporal : input,
      },
    ],
  });
  if (!cocPass.ok) return cocPass;

  const near = topology.useNear
    ? target(graph, 'dof-near', { format: 'rgba16float', size: halfSize })
    : undefined;
  if (near !== undefined && !near.ok) return near;
  const far = topology.useFar
    ? target(graph, 'dof-far', { format: 'rgba16float', size: halfSize })
    : undefined;
  if (far !== undefined && !far.ok) return far;
  const background = topology.useNear
    ? target(graph, 'dof-background', { format: 'rgba16float', size: halfSize })
    : undefined;
  if (background !== undefined && !background.ok) return background;

  const sources = new Map<
    'near' | 'far',
    { color: RenderPipelineTarget; metadata: RenderPipelineTarget }
  >();
  for (const side of ['near', 'far'] as const) {
    const enabled = side === 'near' ? topology.useNear : topology.useFar;
    if (!enabled) continue;
    const prefilter = target(graph, `dof-prefilter-${side}`, {
      format: 'rgba16float',
      size: halfSize,
    });
    if (!prefilter.ok) return prefilter;
    const prefilterPass = addPass(graph, {
      name: `dof-prefilter-${side}`,
      shader: depthOfFieldPostProcessId(DEPTH_OF_FIELD_PREFILTER_ID, multisampled),
      fragmentEntryPoint: side === 'near' ? 'fs_prefilter_near' : 'fs_prefilter_far',
      input,
      depth,
      outputs: [prefilter.value],
      additionalReads: [{ key: 'dof-coc', target: coc.value }],
    });
    if (!prefilterPass.ok) return prefilterPass;
    const prefilterMetadata = target(graph, `dof-prefilter-${side}-metadata`, {
      format: 'rgba16float',
      size: halfSize,
    });
    if (!prefilterMetadata.ok) return prefilterMetadata;
    const metadataPass = addPass(graph, {
      name: `dof-prefilter-${side}-metadata`,
      shader: depthOfFieldPostProcessId(DEPTH_OF_FIELD_PREFILTER_METADATA_ID, multisampled),
      fragmentEntryPoint:
        side === 'near' ? 'fs_prefilter_metadata_near' : 'fs_prefilter_metadata_far',
      input,
      depth,
      outputs: [prefilterMetadata.value],
      additionalReads: [
        {
          key: 'scene-temporal',
          target: context.temporalTaa && temporal !== undefined ? temporal : input,
        },
        { key: 'dof-coc', target: coc.value },
      ],
    });
    if (!metadataPass.ok) return metadataPass;
    sources.set(side, { color: prefilter.value, metadata: prefilterMetadata.value });
  }

  const nearInput = near?.ok === true ? near.value : input;
  const farInput = far?.ok === true ? far.value : input;
  const backgroundInput = background?.ok === true ? background.value : input;
  const outputs: [RenderPipelineTarget, ...RenderPipelineTarget[]] = topology.useNear
    ? [nearInput, ...(topology.useFar ? [farInput] : []), backgroundInput]
    : [farInput];
  const gatherPass = addPass(graph, {
    name: `dof-gather-${topology.blurSide}`,
    shader: depthOfFieldPostProcessId(DEPTH_OF_FIELD_GATHER_ID, multisampled),
    fragmentEntryPoint: `fs_gather_${topology.blurSide}`,
    input: sources.get('near')?.color ?? input,
    depth,
    outputs,
    additionalReads: [
      {
        key: 'scene-temporal',
        target: context.temporalTaa && temporal !== undefined ? temporal : input,
      },
      { key: 'dof-coc', target: coc.value },
      { key: 'dof-near-metadata', target: sources.get('near')?.metadata ?? input },
      { key: 'dof-far-metadata', target: sources.get('far')?.metadata ?? input },
      { key: 'dof-prefilter-far', target: sources.get('far')?.color ?? input },
      { key: 'scene-color', target: input },
    ],
  });
  if (!gatherPass.ok) return gatherPass;

  const composite = target(graph, 'dof-composite', {
    format: input.format,
    size: fullSize,
    domain: input.domain,
  });
  if (!composite.ok) return composite;
  const compositePass = addPass(graph, {
    name: 'dof-composite',
    shader: depthOfFieldPostProcessId(DEPTH_OF_FIELD_COMPOSITE_ID, multisampled),
    fragmentEntryPoint: 'fs_composite',
    input,
    depth,
    outputs: [composite.value],
    additionalReads: [
      {
        key: 'scene-temporal',
        // The composite shader always owns the temporal-depth slot. Without
        // TAA, the current input is the explicit alias for that slot.
        target: context.temporalTaa && temporal !== undefined ? temporal : input,
      },
      { key: 'dof-coc', target: coc.value },
      // Disabled sides alias the original input so their resources and gathers
      // are absent while the fixed composite binding contract stays valid.
      { key: 'dof-near', target: nearInput },
      { key: 'dof-far', target: farInput },
      { key: 'dof-background', target: backgroundInput },
    ],
  });
  if (!compositePass.ok) return compositePass;
  return ok(composite.value);
}

/** Return the bound pass names expected from an admitted DoF topology. */
export function depthOfFieldPassNames(topology: DepthOfFieldTopology): readonly string[] {
  const names = ['dof-coc'];
  if (topology.useNear) names.push('dof-prefilter-near', 'dof-prefilter-near-metadata');
  if (topology.useFar) names.push('dof-prefilter-far', 'dof-prefilter-far-metadata');
  names.push(`dof-gather-${topology.blurSide}`, 'dof-composite');
  return Object.freeze(names);
}
