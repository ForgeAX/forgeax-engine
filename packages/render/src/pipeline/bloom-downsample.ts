import { ok } from '@forgeax/engine-types';
import {
  type ComputeState,
  computeBindGroup,
  computePipelineError,
  createComputeStateForModule,
  resolvedGraphView,
} from '../compute-graph-state';
import { registerScenePipelinePreparation } from '../record/scene-pipeline-preparation';
import type {
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
} from '../render-pipeline';
import { addPostSceneColorHalf, declarePostSceneColorHalf } from './post-scene-color';

type Extent = { readonly width: number; readonly height: number };
const TILE_SIZE = 8;
const BLOOM_DOWNSAMPLE_PASS = 'bloom-downsample';

/** Every group owns an aligned 8x8 tile of the first reduction and its descendants. */
function bloomDownsampleSource(levelCount: number) {
  const levels = Array.from({ length: levelCount }, (_, i) => i + 1);
  return /* wgsl */ `
@group(0) @binding(0) var scene: texture_2d<f32>;
${levels
  .map(
    (level) =>
      `@group(0) @binding(${level}) var level${level}: texture_storage_2d<rgba16float, write>;`,
  )
  .join('\n')}
var<workgroup> tile: array<vec4<f32>, 64>;

fn bloomMipPrecision(value: vec4<f32>) -> vec4<f32> {
  // Texture stores can preserve binary16 subnormals when quantizeToF16 flushes
  // them. Round that range explicitly so a fused level sees the stored color.
  const stepsPerUnit = 16777216.0;
  let subnormal = round(value * stepsPerUnit) / stepsPerUnit;
  return select(quantizeToF16(value), subnormal, abs(value) < vec4<f32>(1.0 / 16384.0));
}

@compute @workgroup_size(8, 8)
fn reduce_bloom(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  if (all(id.xy < textureDimensions(level1))) {
    let p = vec2<i32>(id.xy * 2u);
    let edge = vec2<i32>(textureDimensions(scene)) - 1;
    let color = (textureLoad(scene, p, 0) +
      textureLoad(scene, min(p + vec2<i32>(1, 0), edge), 0) +
      textureLoad(scene, min(p + vec2<i32>(0, 1), edge), 0) +
      textureLoad(scene, min(p + 1, edge), 0)) * 0.25;
    tile[lane] = bloomMipPrecision(color);
    textureStore(level1, vec2<i32>(id.xy), color);
  }
  ${levels
    .slice(1)
    .map((level) => {
      const size = 2 ** (level - 1);
      const priorSize = size >> 1;
      return /* wgsl */ `
  workgroupBarrier();
  if (all(local.xy % ${size}u == vec2<u32>(0u))) {
    let pixel = id.xy / ${size}u;
    if (all(pixel < textureDimensions(level${level}))) {
      let prior = textureDimensions(level${level - 1});
      let x = select(0u, ${priorSize}u, pixel.x * 2u + 1u < prior.x);
      let y = select(0u, ${TILE_SIZE * priorSize}u, pixel.y * 2u + 1u < prior.y);
      let color = (tile[lane] + tile[lane + x] + tile[lane + y] + tile[lane + x + y]) * 0.25;
      ${level === levelCount ? '' : 'tile[lane] = bloomMipPrecision(color);'}
      textureStore(level${level}, vec2<i32>(pixel), color);
    }
  }`;
    })
    .join('\n')}
}
`;
}

export function addBloomDownsampleChain(
  graph: RenderPipelineBuildContext<RenderPipelineFrame>['graph'],
  seed: RenderPipelineTarget,
  levels: readonly Extent[],
  compute: boolean,
) {
  const sources = [seed];
  for (const [index, extent] of levels.slice(0, -1).entries()) {
    const label = `bloom-downsample-${index + 1}`;
    const prior = sources.at(-1) ?? seed;
    const reduced = compute
      ? declarePostSceneColorHalf(graph, extent, label)
      : addPostSceneColorHalf(graph, extent, prior, label);
    if (!reduced.ok) return reduced;
    sources.push(reduced.value);
  }
  const quarter = levels[1];
  if (compute && quarter !== undefined) {
    const name = BLOOM_DOWNSAMPLE_PASS;
    const outputs = sources.slice(1);
    const source = bloomDownsampleSource(outputs.length);
    const layout = [
      {
        binding: 0,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      ...outputs.map((_, slot) => ({
        binding: slot + 1,
        visibility: 4,
        storageTexture: { access: 'write-only', viewDimension: '2d', format: 'rgba16float' },
      })),
    ];
    let state: ComputeState | undefined;
    const program = (frame: RenderPipelineFrame) => {
      if (state !== undefined) return state;
      const { runtime } = frame;
      const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
      if (factory === undefined) throw computePipelineError(name);
      const module = factory.createShaderModule({ code: source, label: name }).unwrap();
      state = createComputeStateForModule(runtime.device, module, name, layout, 'reduce_bloom');
      return state;
    };
    registerScenePipelinePreparation(
      graph,
      (frame) => {
        program(frame);
        return false;
      },
      'utility',
    );
    const pass = graph.addComputePass(name, {
      accesses: [
        { resource: seed.view, usage: 'sampled-read' },
        ...outputs.map((target) => ({ resource: target.view, usage: 'storage-write' as const })),
      ],
      encodeDirect(encoder, frame, resources) {
        const state = program(frame);
        encoder.setPipeline(state.pipeline);
        encoder.setBindGroup(
          0,
          computeBindGroup(
            frame,
            state,
            sources.map((target, binding) => ({
              binding,
              resource: { kind: 'textureView', value: resolvedGraphView(resources, target.view) },
            })),
          ),
        );
        encoder.dispatchWorkgroups(
          Math.ceil(quarter.width / TILE_SIZE),
          Math.ceil(quarter.height / TILE_SIZE),
          1,
        );
      },
    });
    if (!pass.ok) return pass;
  }
  return ok(sources);
}
