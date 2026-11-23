import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupEntry,
  type Buffer,
  ok,
  type Result,
  type RhiDevice,
  type Sampler,
  type TextureView,
} from '@forgeax/engine-rhi';
import { SkyShPass } from '../record/gpu-pass-timing/sky-pass-names';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import { recordContext } from '../world/view-record-context';
import {
  bufferEntry,
  getKernels,
  group,
  PACKED_VECTORS,
  publishRasterCoefficients,
  REDUCE_WIDTH,
  SKY_SH_BYTES,
  TILE_COUNT,
} from './sky-sh';

/** Record sky SH in the same graph as the changing radiance cube and its consumers. */
export function addSkyShProjection(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: GraphTextureView,
  coefficients: GraphBuffer,
  compute: boolean,
  dirty: (frame: RenderPipelineFrame) => boolean,
): Result<void, RenderGraphError> {
  const parameters = graph.createBuffer('sky-sh-parameters', {
    size: 16,
  });
  if (!parameters.ok) return parameters;
  const zero = new Uint32Array(4);
  const initialized = graph.addCopyPass(SkyShPass.prepare, {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    executeIf: dirty,
    encodeDirect: (_encoder, frame, resources) => {
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(parameters.value).unwrap(), 0, zero)
        .unwrap();
    },
  });
  if (!initialized.ok) return initialized;
  const state = (frame: RenderPipelineFrame) => {
    const { runtime } = frame;
    const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
    if (factory === undefined)
      throw new Error('Sky SH requires the renderer shader module factory');
    return getKernels(
      runtime.device,
      recordContext(runtime as RenderSystemInternals).deviceScope,
      (desc) => factory.createShaderModule(desc),
      compute,
    );
  };
  const projectAccesses = [
    { resource: source, usage: 'sampled-read' as const },
    { resource: parameters.value, usage: 'uniform-read' as const },
  ];
  const samplers = new WeakMap<RhiDevice, Sampler>();
  const inputs = (device: RhiDevice, view: TextureView, params: Buffer): BindGroupEntry[] => {
    let sampler = samplers.get(device);
    if (sampler === undefined) {
      sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' }).unwrap();
      samplers.set(device, sampler);
    }
    return [
      { binding: 0, resource: { kind: 'textureView', value: view } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
      bufferEntry(2, params),
    ];
  };
  if (compute) {
    const partial = graph.createBuffer('sky-sh-partials', {
      size: SKY_SH_BYTES * TILE_COUNT,
    });
    if (!partial.ok) return partial;
    const project = graph.addComputePass(SkyShPass.project, {
      accesses: [...projectAccesses, { resource: partial.value, usage: 'storage-write' }],
      executeIf: dirty,
      encodeDirect: (pass, frame, resources) => {
        const kernels = state(frame);
        if (kernels.kind !== 'compute') throw new Error('Expected Sky SH compute kernels');
        const device = frame.runtime.device;
        pass.setPipeline(kernels.project.pipeline);
        pass.setBindGroup(
          0,
          group(device, SkyShPass.project, kernels.project, [
            ...inputs(
              device,
              resources.textureView(source).unwrap(),
              resources.buffer(parameters.value).unwrap(),
            ),
            bufferEntry(4, resources.buffer(partial.value).unwrap()),
          ]),
        );
        pass.dispatchWorkgroups(Math.ceil((PACKED_VECTORS * TILE_COUNT) / 64));
      },
    });
    if (!project.ok) return project;
    return graph.addComputePass(SkyShPass.computeReduce, {
      accesses: [
        { resource: partial.value, usage: 'storage-read-write' },
        { resource: coefficients, usage: 'storage-write' },
      ],
      executeIf: dirty,
      encodeDirect: (pass, frame, resources) => {
        const kernels = state(frame);
        if (kernels.kind !== 'compute') throw new Error('Expected Sky SH compute kernels');
        pass.setPipeline(kernels.reduce.pipeline);
        pass.setBindGroup(
          0,
          group(frame.runtime.device, SkyShPass.computeReduce, kernels.reduce, [
            bufferEntry(4, resources.buffer(partial.value).unwrap()),
            bufferEntry(5, resources.buffer(coefficients).unwrap()),
          ]),
        );
        pass.dispatchWorkgroups(1);
      },
    });
  }

  let previous: GraphTextureView | undefined;
  for (const [label, stage, height] of [
    [SkyShPass.project, 'project', TILE_COUNT],
    [SkyShPass.rasterReduce, 'reduce', Math.ceil(TILE_COUNT / REDUCE_WIDTH)],
    [SkyShPass.rasterFinalize, 'finish', 1],
  ] as const) {
    const texture = graph.createTexture(label, {
      size: { width: PACKED_VECTORS, height },
      format: 'rgba32float',
    });
    if (!texture.ok) return texture;
    const view = graph.view(texture.value);
    if (!view.ok) return view;
    const input = previous;
    const pass = graph.addRasterPass(label, {
      accesses: [
        ...(input === undefined
          ? projectAccesses
          : [{ resource: input, usage: 'sampled-read' as const }]),
        { resource: view.value, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
      executeIf: dirty,
      encodeDirect: (pass, frame, resources) => {
        const kernels = state(frame);
        if (kernels.kind !== 'raster') throw new Error('Expected Sky SH raster kernels');
        const device = frame.runtime.device;
        const kernel = kernels[stage];
        const entries =
          input === undefined
            ? inputs(
                device,
                resources.textureView(source).unwrap(),
                resources.buffer(parameters.value).unwrap(),
              )
            : [
                {
                  binding: 3,
                  resource: {
                    kind: 'textureView' as const,
                    value: resources.textureView(input).unwrap(),
                  },
                },
              ];
        pass.setPipeline(kernel.pipeline);
        pass.setBindGroup(0, group(device, label, kernel, entries));
        pass.draw(3);
      },
    });
    if (!pass.ok) return pass;
    if (stage === 'finish') {
      const copied = graph.addCopyPass(SkyShPass.publish, {
        accesses: [
          { resource: view.value, usage: 'copy-src' },
          { resource: coefficients, usage: 'copy-dst' },
        ],
        executeIf: dirty,
        encodeDirect: (encoder, _frame, resources) => {
          publishRasterCoefficients(
            encoder,
            resources.texture(texture.value).unwrap(),
            resources.buffer(coefficients).unwrap(),
          );
        },
      });
      if (!copied.ok) return copied;
    }
    previous = view.value;
  }
  return ok(undefined);
}
