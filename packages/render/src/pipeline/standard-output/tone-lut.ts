import type {
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RhiDevice,
  Sampler,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../../device/device-scope';
import { postProcessShaderModuleLabel } from '../../fullscreen-post-process-pass';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../../render-contract';
import {
  frameOutputDither,
  type OutputDither,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../../render-pipeline';
import { recordContext } from '../../world/view-record-context';
import type { StandardLutGraphProjection } from './lut-gpu';

interface ToneLutProgram {
  readonly device: RhiDevice;
  readonly factory: object;
  readonly createModule: unknown;
  readonly module: ShaderModule;
  readonly source: string;
  readonly format: string;
  readonly sampleCount: number;
  readonly lutLayout: BindGroupLayout;
  readonly fragment: string;
  readonly inputLayout: BindGroupLayout;
  readonly sampler: Sampler;
  readonly pipeline: RenderPipeline;
}

const programsByScope = new WeakMap<DeviceScope, ToneLutProgram[]>();

function programsFor(scope: DeviceScope): ToneLutProgram[] {
  let programs = programsByScope.get(scope);
  if (programs === undefined) {
    programs = [];
    programsByScope.set(scope, programs);
    const owned = programs;
    scope._adopt('post-effect', programs, () => {
      programsByScope.delete(scope);
      owned.length = 0;
    });
  }
  return programs;
}

function unavailable(expected: string): never {
  throw new RhiError({
    code: 'rhi-not-available',
    expected,
    hint: 'prepare the Standard output transform and its resident LUT before encoding',
  });
}

/** Adjacent tone/LUT/encoding stages, with both original binary16 stores retained. */
export function addStandardToneLutPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  lut: StandardLutGraphProjection,
  dither: OutputDither,
  glare?: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  // Unscoped test/backends may retain this graph's objects only.
  const localPrograms: ToneLutProgram[] = [];
  const fragment = glare === undefined ? 'fs_tone_lut_encode' : 'fs_tone_lut_glare_encode';
  const payload = new Uint8Array(TONEMAP_PARAMS_LAYOUT.byteSize);
  const values = new DataView(payload.buffer);
  let retainedBinding:
    | {
        program: ToneLutProgram;
        input: TextureView;
        glare: TextureView | undefined;
        params: Buffer;
        group: BindGroup;
      }
    | undefined;
  const bindSource = (
    program: ToneLutProgram,
    resources: GraphResourceResolver,
    paramsBuffer: Buffer,
  ) => {
    const device = program.device;
    const inputView = resources.textureView(input.view);
    if (!inputView.ok) throw inputView.error;
    const glareView = glare === undefined ? undefined : resources.textureView(glare.view).unwrap();
    if (
      retainedBinding?.program !== program ||
      retainedBinding.input !== inputView.value ||
      retainedBinding.glare !== glareView ||
      retainedBinding.params !== paramsBuffer
    ) {
      const bindings = device.createBindGroup({
        layout: program.inputLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: inputView.value } },
          { binding: 1, resource: { kind: 'sampler', value: program.sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: paramsBuffer } } },
          ...(glareView === undefined
            ? []
            : [
                {
                  binding: 3,
                  resource: { kind: 'textureView' as const, value: glareView },
                },
              ]),
        ],
      });
      if (!bindings.ok) throw bindings.error;
      retainedBinding = {
        program,
        input: inputView.value,
        glare: glareView,
        params: paramsBuffer,
        group: bindings.value,
      };
    }
    return retainedBinding.group;
  };
  const added = graph.addRasterPass('standard-tone-lut-output', {
    accesses: [
      { resource: input.view, usage: 'sampled-read' },
      ...(glare === undefined ? [] : [{ resource: glare.view, usage: 'sampled-read' as const }]),
      { resource: lut.view, usage: 'sampled-read' },
      { resource: output.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const { runtime } = frame as _InternalRenderPipelineContext;
      const device = runtime.device;
      const binding = lut.bind(frame);
      const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
      const entry = runtime.lookupPostProcess?.(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
      const params = frame.postProcessParams.get(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
      const paramsBuffer = runtime.getPostProcessParamsBuffer?.(
        STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
        'write',
      );
      if (
        factory === undefined ||
        entry === undefined ||
        paramsBuffer === undefined ||
        params?.byteLength !== TONEMAP_PARAMS_LAYOUT.byteSize
      ) {
        return unavailable(
          'the composed Standard tone/LUT module and 32-byte params are available',
        );
      }
      const source = factory.createShaderModule({
        code: entry.source,
        label: postProcessShaderModuleLabel(entry),
      });
      if (!source.ok) throw source.error;
      const scope = recordContext(runtime).deviceScope;
      const programs =
        scope === undefined ? localPrograms : scope.isAlive() ? programsFor(scope) : undefined;
      let program = programs?.find(
        (cached) =>
          cached.device === device &&
          cached.factory === factory &&
          cached.createModule === factory.createShaderModule &&
          cached.module === source.value &&
          cached.source === entry.source &&
          cached.format === output.format &&
          cached.sampleCount === output.sampleCount &&
          cached.lutLayout === binding.bindGroupLayout &&
          cached.fragment === fragment,
      );
      if (program === undefined) {
        const empty = device.createBindGroupLayout({ entries: [] });
        if (!empty.ok) throw empty.error;
        const inputLayout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
            { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
            { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
            ...(glare === undefined
              ? []
              : [
                  {
                    binding: 3,
                    visibility: 2,
                    texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
                  },
                ]),
          ],
        });
        if (!inputLayout.ok) throw inputLayout.error;
        const layout = device.createPipelineLayout({
          bindGroupLayouts: [empty.value, inputLayout.value, binding.bindGroupLayout],
        });
        if (!layout.ok) throw layout.error;
        const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
        if (!sampler.ok) throw sampler.error;
        const pipeline = device.createRenderPipeline({
          label: 'standard-tone-lut-output',
          layout: layout.value,
          vertex: { module: source.value, entryPoint: 'vs_main', buffers: [] },
          fragment: {
            module: source.value,
            entryPoint: fragment,
            targets: [{ format: output.format as GPUTextureFormat }],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: output.sampleCount },
        });
        if (!pipeline.ok) throw pipeline.error;
        program = {
          device,
          factory,
          createModule: factory.createShaderModule,
          module: source.value,
          source: entry.source,
          format: output.format,
          sampleCount: output.sampleCount,
          lutLayout: binding.bindGroupLayout,
          fragment,
          inputLayout: inputLayout.value,
          sampler: sampler.value,
          pipeline: pipeline.value,
        };
        if (programs !== undefined && (scope === undefined || scope.isAlive())) {
          if (programs.length === 8) programs.shift();
          programs.push(program);
        }
      }
      const extent = resources.textureViewExtent(output.view);
      if (!extent.ok) throw extent.error;
      payload.set(params);
      values.setFloat32(
        TONEMAP_PARAMS_LAYOUT.ditherOffset,
        frameOutputDither(dither, frame) ? 1 : 0,
        true,
      );
      values.setFloat32(
        TONEMAP_PARAMS_LAYOUT.outputGamutOffset + 4,
        binding.strength ?? lut.strength,
        true,
      );
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputWidthOffset, extent.value.width, true);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputHeightOffset, extent.value.height, true);
      const written = device.queue.writeBuffer(paramsBuffer, 0, payload);
      if (!written.ok) throw written.error;
      const sourceGroup = bindSource(program, resources, paramsBuffer);
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(1, sourceGroup);
      pass.setBindGroup(2, binding.bindGroup);
      pass.draw(3, 1, 0, 0);
    },
  });
  return added.ok ? ok(undefined) : added;
}
