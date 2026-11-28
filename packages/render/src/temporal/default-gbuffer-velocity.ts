import type {
  GraphBuffer,
  GraphTextureDescriptor,
  GraphTextureView,
} from '@forgeax/engine-render-graph';
import { SCENE_VELOCITY_RECONSTRUCTION_WGSL } from '@forgeax/engine-shader';
import { computeBindGroup } from '../compute-graph-state';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { PREDEPTH_FRAGMENT_ENTRY } from '../predepth-coverage';
import { createRasterState, type RasterState } from '../raster-graph-state';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineGpuDrivenProjection,
  type RenderPipelineTarget,
} from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { CapturedSceneTransform } from '../scene/captured-transform';
import { COLOR_PASS_SELECTOR } from '../systems/pass-selector';
import { addTypedScenePass } from '../typed-render-graph-primitives';

export interface SceneVelocityInputs {
  readonly depth: GraphTextureView;
  readonly view: GraphBuffer;
}

type Graph = Parameters<typeof createRenderPipelineTarget>[0];

/** The two prepass draw sets are complements of the same accepted motion facts. */
function writesVelocity(source: RenderableSnapshot): boolean {
  const temporal = source.temporal;
  // Extended velocity retains previous-depth and responsiveness information
  // for reactive or newly seeded surfaces, even with a stationary matrix.
  if (temporal?.motionValid === false || temporal?.reactive === true) return true;
  if (temporal === undefined) return false;
  // Skin poses and LOD crossfades can move while the object matrix is unchanged.
  if (
    source.skinBinding !== undefined ||
    source.morph !== undefined ||
    (source.lods?.length ?? 0) > 1 ||
    source.spriteInstances !== undefined
  )
    return true;
  if (CapturedSceneTransform.differs(source.transform, temporal.previousTransform, 0.0001))
    return true;
  const previous = temporal.previousInstances;
  const instances = source.instances;
  return (
    instances !== undefined &&
    (previous === undefined ||
      instances.transforms.length !== previous.transforms.length ||
      instances.transforms.some(
        (value, index) => Math.abs(value - (previous.transforms[index] ?? value)) > 0.0001,
      ) ||
      instances.generations?.some(
        (generation, index) => generation !== previous.generations?.[index],
      ) === true)
  );
}

function selectVelocityWriters(
  frame: RenderPipelineFrame,
  writes: boolean,
  nativeForward: boolean,
) {
  const context = frame as _InternalRenderPipelineContext;
  const entities: number[] = [];
  for (const { source } of context.validatedOrdered) {
    // An indirect batch may contain both still and moving instances. Keep its
    // one GPU-selected roster in the depth-and-velocity stage.
    const nativeWriter =
      nativeForward &&
      source.gpuDrivenDraws?.some(
        (draw, index) =>
          context.gpuDrivenSelection?.owns(
            source,
            draw,
            index,
            'temporal',
            'opaque-depth-velocity',
          ) === true,
      ) === true;
    if ((nativeWriter || writesVelocity(source)) === writes) entities.push(source.entityKey);
  }
  return { entities };
}

/** Separate raster attachment; the material GBuffer keeps the same attachment roster. */
export function createDefaultVelocityTarget(
  graph: Graph,
  size: GraphTextureDescriptor['size'],
  withPreviousDepth: boolean,
) {
  return createRenderPipelineTarget(graph, 'scene-velocity', {
    format: withPreviousDepth ? 'rg32uint' : 'r32uint',
    size,
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
}

export function addDefaultDepthPrepass(
  graph: Graph,
  depth: RenderPipelineTarget,
  nativeForward = false,
) {
  return addTypedScenePass(graph, {
    name: 'standard-depth-prepass',
    depth,
    selector: COLOR_PASS_SELECTOR,
    recordMode: 'opaque-depth',
    fragmentEntryPoint: PREDEPTH_FRAGMENT_ENTRY,
    selectEntities: (frame) => selectVelocityWriters(frame, false, nativeForward),
  });
}

export function addDefaultDepthVelocity(
  graph: Graph,
  depth: RenderPipelineTarget,
  velocity: RenderPipelineTarget,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  phase: 'early' | 'late' | 'forward' = 'early',
) {
  const late = phase === 'late';
  const nativeForward = phase === 'forward' && gpuDriven !== undefined;
  return addTypedScenePass(graph, {
    name: late ? 'standard-depth-velocity-late' : 'standard-depth-velocity',
    depth,
    color: velocity,
    selector: COLOR_PASS_SELECTOR,
    passKind: 'temporal',
    fragmentEntryPoint: 'fs_scene_velocity',
    recordMode: 'opaque-depth',
    gpuDrivenFilter: nativeForward ? 'opaque-depth-velocity' : 'opaque',
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
    ...(late
      ? { gpuDrivenPhase: 'late' }
      : {
          selectEntities: (frame: RenderPipelineFrame) =>
            selectVelocityWriters(frame, true, nativeForward),
        }),
    colorLoadOp: late ? 'load' : 'clear',
    depthLoadOp: 'load',
    clearColor: [0, 0, 0, 0],
  });
}

export const SCENE_VELOCITY_TEMPORAL_LABEL = 'scene-velocity-temporal';
export const SCENE_VELOCITY_TEMPORAL_WGSL = `
${SCENE_VELOCITY_RECONSTRUCTION_WGSL}
@group(0) @binding(0) var sceneDepth : texture_depth_2d;
@group(0) @binding(1) var velocity : texture_2d<u32>;
@group(0) @binding(2) var<uniform> view : View;

@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32(index & 1u) * 2.0, f32(index & 2u));
  return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  return sceneTemporalFromVelocity(vec2<i32>(position.xy), sceneDepth, velocity, view);
}
`;

/** Supply temporal-v1 to screen-space effects that consume the packed metadata. */
export function addDefaultVelocityTemporalProjection(
  graph: Graph,
  velocity: RenderPipelineTarget,
  source: SceneVelocityInputs,
  size: GraphTextureDescriptor['size'],
  label: 'ssr-scene-temporal' | 'standard-scene-temporal' = 'ssr-scene-temporal',
) {
  const target = createRenderPipelineTarget(graph, label, {
    format: 'rgba16float',
    size,
  });
  if (!target.ok) return target;
  const output = target.value;
  let program: RasterState | undefined;
  const passName = label === 'standard-scene-temporal' ? 'standard-scene-data' : label;
  const added = graph.addRasterPass(passName, {
    accesses: [
      { resource: source.depth, usage: 'sampled-read' },
      { resource: velocity.view, usage: 'sampled-read' },
      { resource: source.view, usage: 'uniform-read' },
      { resource: output.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
    encodeDirect(pass, frame, resources) {
      program ??= createRasterState(
        frame,
        SCENE_VELOCITY_TEMPORAL_WGSL,
        SCENE_VELOCITY_TEMPORAL_LABEL,
        [
          { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
          { binding: 1, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
          { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
        ],
        'vs_main',
        'fs_main',
        [output.format],
      );
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(
        0,
        computeBindGroup(frame, program, [
          {
            binding: 0,
            resource: { kind: 'textureView', value: resources.textureView(source.depth).unwrap() },
          },
          {
            binding: 1,
            resource: { kind: 'textureView', value: resources.textureView(velocity.view).unwrap() },
          },
          {
            binding: 2,
            resource: {
              kind: 'buffer',
              value: { buffer: resources.buffer(source.view).unwrap(), size: VIEW_UNIFORM_BYTES },
            },
          },
        ]),
      );
      pass.draw(3);
    },
  });
  return added.ok ? target : added;
}
