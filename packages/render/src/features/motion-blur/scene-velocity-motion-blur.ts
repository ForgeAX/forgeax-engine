import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import {
  MOTION_BLUR_SCENE_VELOCITY_WGSL,
  SCENE_VELOCITY_RECONSTRUCTION_WGSL,
} from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import {
  computeBindGroup,
  computePipelineError,
  createComputeStatePreparation,
} from '../../compute-graph-state';
import { createRasterState, type RasterState } from '../../raster-graph-state';
import { registerScenePipelinePreparation } from '../../record/scene-pipeline-preparation';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import type { SceneVelocityInputs } from '../../temporal/default-gbuffer-velocity';
import { recordMotionBlurDispatch } from './motion-blur-execution';
import {
  addMotionBlurPass,
  MOTION_BLUR_COMPUTE_WGSL,
  MOTION_BLUR_FEATURE_IDENTITY,
} from './motion-blur-feature';
import { MOTION_BLUR_PARAMS_BYTE_SIZE } from './motion-blur-params';

export const sceneVelocityComputeSource = () =>
  [
    SCENE_VELOCITY_RECONSTRUCTION_WGSL,
    '@group(0) @binding(5) var velocityDepth : texture_depth_2d;',
    '@group(0) @binding(6) var<uniform> velocityView : View;',
    MOTION_BLUR_COMPUTE_WGSL.replace('flags : u32,', 'flags : u32,\n  jitterUv : vec2<f32>,')
      .replace('var sceneTemporal : texture_2d<f32>;', 'var sceneTemporal : texture_2d<u32>;')
      .replace(
        'let dimensions = textureDimensions(sceneTemporal);',
        'let dimensions = textureDimensions(currentColor);',
      )
      .replace(
        'let samplePixel = clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));',
        `let size = vec2<i32>(textureDimensions(sceneTemporal));
      let uv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(dimensions) + params.jitterUv;
      let samplePixel = clamp(vec2<i32>(floor(uv * vec2<f32>(size))), vec2<i32>(0), size - vec2<i32>(1));`,
      )
      .replace(
        'textureLoad(sceneTemporal, samplePixel, 0)',
        'sceneTemporalFromVelocity(samplePixel, velocityDepth, sceneTemporal, velocityView)',
      ),
  ].join('\n');

/** Own the stock blur kernels with either resolved temporal metadata or packed velocity. */
export function addNativeMotionBlur(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  temporal: RenderPipelineTarget,
  source: SceneVelocityInputs | undefined,
  output: RenderPipelineTarget,
  width: number,
  height: number,
  compute: boolean,
): Result<void, RenderGraphError> {
  if (source === undefined && !compute) return addMotionBlurPass(graph, input, temporal, output);
  const summaryGroups = [Math.ceil(width / 16), Math.ceil(height / 16), 1] as const;
  const reconstructGroups = [Math.ceil(width / 8), Math.ceil(height / 8), 1] as const;
  const tiles = compute
    ? graph.createBuffer('motion-blur-tile-summary', {
        size: summaryGroups[0] * summaryGroups[1] * 32,
      })
    : ok(undefined);
  if (!tiles.ok) return tiles;
  const bytes = new Uint8Array(source === undefined ? MOTION_BLUR_PARAMS_BYTE_SIZE : 48);
  const jitterValues = source === undefined ? undefined : new Float32Array(bytes.buffer, 32, 2);
  const params = graph.createBuffer('motion-blur-params', { size: bytes.byteLength });
  if (!params.ok) return params;
  const upload = graph.addCopyPass('motion-blur-params', {
    accesses: [{ resource: params.value, usage: 'copy-dst' }],
    encodeDirect(_encoder, frame, resources) {
      bytes.fill(0);
      const parameters = frame.postProcessParams.get(MOTION_BLUR_FEATURE_IDENTITY);
      if (parameters !== undefined) bytes.set(parameters);
      const jitter = frame.camera.temporal?.currentJitterUv;
      if (jitter !== undefined) jitterValues?.set(jitter);
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(params.value).unwrap(), 0, bytes)
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  const reads = [
    { resource: input.view, usage: 'sampled-read' },
    { resource: temporal.view, usage: 'sampled-read' },
    ...(source === undefined
      ? []
      : [
          { resource: source.depth, usage: 'sampled-read' as const },
          { resource: source.view, usage: 'uniform-read' as const },
        ]),
    { resource: params.value, usage: 'uniform-read' },
  ] as const;
  const sampled = (
    binding: number,
    visibility: number,
    sampleType: 'uint' | 'depth' | 'float',
  ) => ({ binding, visibility, texture: { sampleType, viewDimension: '2d' as const } });
  const uniform = (binding: number, visibility: number) => ({
    binding,
    visibility,
    buffer: { type: 'uniform' as const },
  });
  const buffer = (binding: number, value: import('@forgeax/engine-rhi').Buffer, size?: number) => ({
    binding,
    resource: {
      kind: 'buffer' as const,
      value: { buffer: value, ...(size === undefined ? {} : { size }) },
    },
  });
  const texture = (binding: number, value: import('@forgeax/engine-rhi').TextureView) => ({
    binding,
    resource: { kind: 'textureView' as const, value },
  });

  const tileBuffer = tiles.value;
  if (tileBuffer === undefined && source !== undefined) {
    let program: RasterState | undefined;
    let sampler: import('@forgeax/engine-rhi').Sampler | undefined;
    return graph.addRasterPass('motion-blur', {
      accesses: [...reads, { resource: output.view, usage: 'color-attachment' }],
      colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
      encodeDirect(pass, frame, resources) {
        program ??= createRasterState(
          frame,
          MOTION_BLUR_SCENE_VELOCITY_WGSL,
          'motion-blur',
          [
            sampled(0, 2, 'float'),
            { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
            uniform(2, 2),
            sampled(3, 2, 'uint'),
            sampled(4, 2, 'depth'),
            uniform(5, 2),
          ],
          'vs_main',
          'fs_main',
          [output.format],
        );
        sampler ??= frame.runtime.device
          .createSampler({ magFilter: 'linear', minFilter: 'linear' })
          .unwrap();
        pass.setPipeline(program.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, program, [
            texture(0, resources.textureView(input.view).unwrap()),
            { binding: 1, resource: { kind: 'sampler', value: sampler } },
            buffer(2, resources.buffer(params.value).unwrap()),
            texture(3, resources.textureView(temporal.view).unwrap()),
            texture(4, resources.textureView(source.depth).unwrap()),
            buffer(5, resources.buffer(source.view).unwrap(), VIEW_UNIFORM_BYTES),
          ]),
        );
        pass.draw(3);
      },
    });
  }
  if (tileBuffer === undefined) return ok(undefined);
  const sourceWgsl = source === undefined ? MOTION_BLUR_COMPUTE_WGSL : sceneVelocityComputeSource();
  for (const [entryPoint, name, workgroups] of [
    ['tile_summary', 'motion-blur-tile-summary', summaryGroups],
    ['reconstruct', 'motion-blur', reconstructGroups],
  ] as const) {
    const prepare = createComputeStatePreparation(
      () => sourceWgsl,
      name,
      [
        sampled(0, 4, 'float'),
        sampled(1, 4, source === undefined ? 'float' : 'uint'),
        { binding: 2, visibility: 4, buffer: { type: 'storage' } },
        {
          binding: 3,
          visibility: 4,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
        uniform(4, 4),
        ...(source === undefined ? [] : [sampled(5, 4, 'depth'), uniform(6, 4)]),
      ],
      entryPoint,
    );
    registerScenePipelinePreparation(
      graph,
      (frame) => {
        prepare(frame);
        return false;
      },
      'utility',
    );
    const added = graph.addComputePass(name, {
      accesses: [
        ...reads,
        // The compute layout includes the storage output in both entrypoints.
        { resource: output.view, usage: 'storage-write' },
        {
          resource: tileBuffer,
          usage: entryPoint === 'tile_summary' ? 'storage-write' : 'storage-read',
        },
      ],
      encodeDirect(pass, frame, resources) {
        const program = prepare(frame);
        if (program === undefined) throw computePipelineError(name);
        pass.setPipeline(program.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, program, [
            texture(0, resources.textureView(input.view).unwrap()),
            texture(1, resources.textureView(temporal.view).unwrap()),
            buffer(2, resources.buffer(tileBuffer).unwrap()),
            texture(3, resources.textureView(output.view).unwrap()),
            buffer(4, resources.buffer(params.value).unwrap()),
            ...(source === undefined
              ? []
              : [
                  texture(5, resources.textureView(source.depth).unwrap()),
                  buffer(6, resources.buffer(source.view).unwrap(), VIEW_UNIFORM_BYTES),
                ]),
          ]),
        );
        pass.dispatchWorkgroups(...workgroups);
        recordMotionBlurDispatch(frame, entryPoint, workgroups);
      },
    });
    if (!added.ok) return added;
  }
  return ok(undefined);
}
