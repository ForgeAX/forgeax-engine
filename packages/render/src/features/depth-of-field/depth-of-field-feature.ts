import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { DEPTH_OF_FIELD_TILES_WGSL } from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import type { DepthOfFieldSide } from '../../components/depth-of-field';
import {
  computeBindGroup,
  computePipelineError,
  createComputeStatePreparation,
} from '../../compute-graph-state';
import { registerScenePipelinePreparation } from '../../record/scene-pipeline-preparation';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import type { DepthOfFieldParams } from './depth-of-field-params';

const DEPTH_OF_FIELD_COC_ID = 'forgeax.dof.coc';
const DEPTH_OF_FIELD_TILES_ID = 'forgeax.dof.tiles';
const DEPTH_OF_FIELD_PREFILTER_ID = 'forgeax.dof.prefilter';
const DEPTH_OF_FIELD_GATHER_ID = 'forgeax.dof.gather';
const DEPTH_OF_FIELD_COMPOSITE_ID = 'forgeax.dof.composite';
const TILE_SIZE = 16;
export const DEPTH_OF_FIELD_TILE_PASSES = ['dof-tile-radius', 'dof-tile-influence'] as const;
export const DEPTH_OF_FIELD_COMPUTE_TILE_PASS = 'dof-tiles';

/** All declarations are registered together so the build catalog is finite. */
export const DEPTH_OF_FIELD_DEPTH_POST_PROCESS_IDS = Object.freeze([
  DEPTH_OF_FIELD_COC_ID,
  DEPTH_OF_FIELD_PREFILTER_ID,
  DEPTH_OF_FIELD_GATHER_ID,
  DEPTH_OF_FIELD_COMPOSITE_ID,
] as const);
export const DEPTH_OF_FIELD_POST_PROCESS_IDS = Object.freeze([
  ...DEPTH_OF_FIELD_DEPTH_POST_PROCESS_IDS,
  DEPTH_OF_FIELD_TILES_ID,
] as const);
export const DEPTH_OF_FIELD_MSAA_POST_PROCESS_IDS = Object.freeze(
  DEPTH_OF_FIELD_DEPTH_POST_PROCESS_IDS.map((id) => `${id}.msaa` as const),
);

function depthOfFieldPostProcessId(id: string, multisampled: boolean): string {
  return multisampled ? `${id}.msaa` : id;
}

interface DepthOfFieldTopology {
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

function addDepthOfFieldTilePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  coc: RenderPipelineTarget,
  size: { readonly width: number; readonly height: number },
  compute: boolean,
): Result<RenderPipelineTarget, RenderGraphError> {
  const tileSize = {
    width: Math.ceil(size.width / TILE_SIZE),
    height: Math.ceil(size.height / TILE_SIZE),
  };
  const descriptor = {
    size: tileSize,
    format: compute ? 'rgba8unorm' : 'rg8unorm',
    lifetime: 'pass-local',
  } as const;
  const radius = target(graph, DEPTH_OF_FIELD_TILE_PASSES[0], descriptor);
  if (!radius.ok) return radius;
  const influence = target(graph, DEPTH_OF_FIELD_TILE_PASSES[1], descriptor);
  if (!influence.ok) return influence;
  if (compute) {
    const pass = addDepthOfFieldComputeTiles(graph, coc, radius.value, influence.value, tileSize);
    return pass.ok ? influence : pass;
  }
  for (const [name, input, output, fragmentEntryPoint] of [
    [DEPTH_OF_FIELD_TILE_PASSES[0], coc, radius.value, 'fs_tile_radius'],
    [DEPTH_OF_FIELD_TILE_PASSES[1], radius.value, influence.value, 'fs_tile_influence'],
  ] as const) {
    const pass = addPass(graph, {
      name,
      shader: DEPTH_OF_FIELD_TILES_ID,
      fragmentEntryPoint,
      input,
      outputs: [output],
    });
    if (!pass.ok) return pass;
  }
  return influence;
}

function addDepthOfFieldComputeTiles(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  coc: RenderPipelineTarget,
  radius: RenderPipelineTarget,
  influence: RenderPipelineTarget,
  tileSize: { readonly width: number; readonly height: number },
): Result<void, RenderGraphError> {
  const entries = [
    { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    {
      binding: 1,
      visibility: 4,
      storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
    },
    { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
  ] as const;
  const phases = [
    {
      input: coc,
      output: radius,
      groups: [tileSize.width, tileSize.height] as const,
      entryPoint: 'reduce_tiles',
    },
    {
      input: radius,
      output: influence,
      groups: [Math.ceil(tileSize.width / 8), Math.ceil(tileSize.height / 8)] as const,
      entryPoint: 'expand_tiles',
    },
  ].map((phase) => ({
    ...phase,
    prepare: createComputeStatePreparation(
      () => DEPTH_OF_FIELD_TILES_WGSL,
      `dof-tiles.${phase.entryPoint}`,
      entries,
      phase.entryPoint,
    ),
  }));
  registerScenePipelinePreparation(
    graph,
    (frame) => {
      for (const phase of phases) phase.prepare(frame);
      return false;
    },
    'utility',
  );
  return graph.addComputePass(DEPTH_OF_FIELD_COMPUTE_TILE_PASS, {
    accesses: [
      { resource: coc.view, usage: 'sampled-read' },
      { resource: radius.view, usage: 'sampled-storage-write' },
      { resource: influence.view, usage: 'storage-write' },
    ],
    encodeDirect(pass, frame, resources) {
      const params = frame.runtime.getPostProcessParamsBuffer?.(DEPTH_OF_FIELD_TILES_ID, 'write');
      const optics = frame.postProcessParams.get(DEPTH_OF_FIELD_TILES_ID);
      if (params === undefined || optics === undefined)
        throw computePipelineError('dof-tiles params');
      frame.runtime.device.queue.writeBuffer(params, 0, optics).unwrap();
      for (const { input, output, groups, prepare, entryPoint } of phases) {
        const program = prepare(frame);
        if (program === undefined) throw computePipelineError(entryPoint);
        pass.setPipeline(program.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, program, [
            {
              binding: 0,
              resource: { kind: 'textureView', value: resources.textureView(input.view).unwrap() },
            },
            {
              binding: 1,
              resource: { kind: 'textureView', value: resources.textureView(output.view).unwrap() },
            },
            { binding: 2, resource: { kind: 'buffer', value: { buffer: params } } },
          ]),
        );
        pass.dispatchWorkgroups(...groups);
      }
    },
  });
}

/** Apply spatial DoF to the current scene at the internal render extent. */
export function addDepthOfFieldPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: DepthOfFieldTopology | undefined,
  fullSize: { readonly width: number; readonly height: number },
  input: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  cocFormat: 'rg16float' | 'rgba16float',
  lane: Pick<RenderPipelineTopology['lane'], 'compute' | 'storageTexture'>,
): Result<RenderPipelineTarget, RenderGraphError> {
  if (topology === undefined) return ok(input);

  // The graph texture is the contract. Never select the multisampled shader
  // from a camera flag while the bound depth target is single-sample.
  const multisampled = depth.sampleCount === 4;
  const halfSize = {
    width: Math.ceil(fullSize.width / 2),
    height: Math.ceil(fullSize.height / 2),
  };
  const coc = target(graph, 'dof-coc', {
    format: cocFormat,
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
  });
  if (!cocPass.ok) return cocPass;
  const tileInfluence = addDepthOfFieldTilePasses(
    graph,
    coc.value,
    fullSize,
    lane.compute && lane.storageTexture === true,
  );
  if (!tileInfluence.ok) return tileInfluence;

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
      lifetime: 'pass-local',
      size: halfSize,
    });
    if (!prefilter.ok) return prefilter;
    const prefilterMetadata = target(graph, `dof-prefilter-${side}-metadata`, {
      format: 'rgba16float',
      lifetime: 'pass-local',
      size: halfSize,
    });
    if (!prefilterMetadata.ok) return prefilterMetadata;
    const prefilterPass = addPass(graph, {
      name: `dof-prefilter-${side}`,
      shader: depthOfFieldPostProcessId(DEPTH_OF_FIELD_PREFILTER_ID, multisampled),
      fragmentEntryPoint: side === 'near' ? 'fs_prefilter_near' : 'fs_prefilter_far',
      input,
      depth,
      outputs: [prefilter.value, prefilterMetadata.value],
      clearColor: [0, 0, 0, 0],
      additionalReads: [
        { key: 'dof-coc', target: coc.value },
        { key: 'dof-tile-influence', target: tileInfluence.value },
      ],
    });
    if (!prefilterPass.ok) return prefilterPass;
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
    clearColor: [0, 0, 0, 0],
    additionalReads: [
      { key: 'dof-coc', target: coc.value },
      { key: 'dof-near-metadata', target: sources.get('near')?.metadata ?? input },
      { key: 'dof-far-metadata', target: sources.get('far')?.metadata ?? input },
      { key: 'dof-prefilter-far', target: sources.get('far')?.color ?? input },
      { key: 'scene-color', target: input },
      { key: 'dof-tile-influence', target: tileInfluence.value },
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
      { key: 'dof-coc', target: coc.value },
      // Disabled sides alias the original input so their resources and gathers
      // are absent while the fixed composite binding contract stays valid.
      { key: 'dof-near', target: nearInput },
      { key: 'dof-far', target: farInput },
      { key: 'dof-background', target: backgroundInput },
      { key: 'dof-tile-influence', target: tileInfluence.value },
    ],
  });
  if (!compositePass.ok) return compositePass;
  return ok(composite.value);
}

/** Return the bound pass names expected from an admitted DoF topology. */
export function depthOfFieldPassNames(
  topology: DepthOfFieldTopology,
  computeTiles: boolean,
): readonly string[] {
  const names = [
    'dof-coc',
    ...(computeTiles ? [DEPTH_OF_FIELD_COMPUTE_TILE_PASS] : DEPTH_OF_FIELD_TILE_PASSES),
  ];
  if (topology.useNear) names.push('dof-prefilter-near');
  if (topology.useFar) names.push('dof-prefilter-far');
  names.push(`dof-gather-${topology.blurSide}`, 'dof-composite');
  return Object.freeze(names);
}
