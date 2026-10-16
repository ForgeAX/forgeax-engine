import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  RenderPipeline,
  RhiDevice,
  Sampler,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { TONEMAP_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../../device/device-scope';
import { postProcessShaderModuleLabel } from '../../fullscreen-post-process-pass';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../../render-contract';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
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
  dither: boolean,
): Result<void, RenderGraphError> {
  // Unscoped test/backends may retain this graph's objects only.
  const localPrograms: ToneLutProgram[] = [];
  const added = graph.addRasterPass('standard-tone-lut-output', {
    accesses: [
      { resource: input.view, usage: 'sampled-read' },
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
    encode: ({ frame, pass, resources }) => {
      const { runtime } = frame as _InternalRenderPipelineContext;
      const device = runtime.device;
      const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
      const entry = runtime.lookupPostProcess?.(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
      const params = frame.postProcessParams.get(STANDARD_OUTPUT_TRANSFORM_FEATURE_ID);
      const paramsBuffer = runtime.getPostProcessParamsBuffer?.(
        STANDARD_OUTPUT_TRANSFORM_FEATURE_ID,
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
        label: postProcessShaderModuleLabel(entry.source),
      });
      if (!source.ok) throw source.error;
      const scope = runtime.deviceScope;
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
          cached.lutLayout === lut.bindGroupLayout,
      );
      if (program === undefined) {
        const empty = device.createBindGroupLayout({ entries: [] });
        if (!empty.ok) throw empty.error;
        const inputLayout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
            { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
            { binding: 2, visibility: 2, buffer: { type: 'uniform' } },
          ],
        });
        if (!inputLayout.ok) throw inputLayout.error;
        const layout = device.createPipelineLayout({
          bindGroupLayouts: [empty.value, inputLayout.value, lut.bindGroupLayout],
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
            entryPoint: 'fs_tone_lut_encode',
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
          lutLayout: lut.bindGroupLayout,
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
      const payload = params.slice();
      const values = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.ditherOffset, dither ? 1 : 0, true);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputGamutOffset + 4, lut.strength, true);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputWidthOffset, extent.value.width, true);
      values.setFloat32(TONEMAP_PARAMS_LAYOUT.outputHeightOffset, extent.value.height, true);
      const written = device.queue.writeBuffer(paramsBuffer, 0, payload);
      if (!written.ok) throw written.error;
      const inputView = resources.textureView(input.view);
      if (!inputView.ok) throw inputView.error;
      const bindings = device.createBindGroup({
        layout: program.inputLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: inputView.value } },
          { binding: 1, resource: { kind: 'sampler', value: program.sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: paramsBuffer } } },
        ],
      });
      if (!bindings.ok) throw bindings.error;
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(1, bindings.value);
      pass.setBindGroup(2, lut.bindGroup);
      pass.draw(3, 1, 0, 0);
    },
  });
  return added.ok ? ok(undefined) : added;
}
