import {
  type GraphAccess,
  type GraphBuffer,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type BindGroupLayoutEntry,
  type Buffer,
  type RenderPipeline,
  type RhiDevice,
  RhiError,
  type Sampler,
  type ShaderModule,
  type TextureView,
} from '@forgeax/engine-rhi';
import { STANDARD_OUTPUT_V2_PARAMS_LAYOUT } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../../device/device-scope';
import { postProcessShaderModuleLabel } from '../../fullscreen-post-process-pass';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../../gpu-usage';
import { OUTPUT_GAMUT_CODE } from '../../output-color-space';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import { registerScenePipelinePreparation } from '../../record/scene-pipeline-preparation';
import { STANDARD_OUTPUT_V2_FEATURE_ID } from '../../render-contract';
import {
  frameOutputDither,
  type OutputDither,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../../render-pipeline';
import { markPipelinePreparationPending } from '../../render-system-presentation';
import { recordContext } from '../../world/view-record-context';
import type { StandardLutGraphProjection } from './lut-gpu';
import { createStandardOutputV2ParameterWriter, type GradeParameters } from './native-params';
import { ensureStandardOutputParameters } from './resources';

interface NativeOutputProgram {
  readonly device: RhiDevice;
  readonly factory: object;
  readonly createModule: unknown;
  readonly module: ShaderModule;
  readonly source: string;
  readonly fragment: string;
  readonly format: string;
  readonly lutLayout: BindGroupLayout | undefined;
  readonly layout: BindGroupLayout;
  readonly sampler: Sampler;
  readonly pipeline: RenderPipeline;
}

interface NativeOutputBindings {
  readonly program: NativeOutputProgram;
  readonly input: TextureView;
  readonly parameters: Buffer;
  readonly exposure: Buffer;
  readonly secondary: TextureView | undefined;
  readonly group: BindGroup;
}

function nativeOutputBindingsChanged(
  retained: NativeOutputBindings | undefined,
  program: NativeOutputProgram,
  input: TextureView,
  parameters: Buffer,
  exposure: Buffer,
  secondary: TextureView | undefined,
): boolean {
  return (
    retained?.program !== program ||
    retained.input !== input ||
    retained.parameters !== parameters ||
    retained.exposure !== exposure ||
    retained.secondary !== secondary
  );
}

const programsByScope = new WeakMap<DeviceScope, NativeOutputProgram[]>();
function programsFor(scope: DeviceScope): NativeOutputProgram[] {
  let programs = programsByScope.get(scope);
  if (programs === undefined) {
    programs = [];
    programsByScope.set(scope, programs);
    const owned = programs;
    scope._adopt('post-effect', owned, () => {
      programsByScope.delete(scope);
      owned.length = 0;
    });
  }
  return programs;
}

/** The one physical stage being declared, not a secondary shader assembly language. */
export type NativeOutputStage =
  | {
      readonly kind: 'grade';
      readonly exposure?: GraphBuffer | undefined;
      readonly bloom?: RenderPipelineTarget | undefined;
      readonly lut?: StandardLutGraphProjection | undefined;
    }
  | { readonly kind: 'final'; readonly fxaa: boolean }
  | { readonly kind: 'encode'; readonly smaaWeights?: RenderPipelineTarget | undefined };

export interface NativeOutputParameterPolicy extends GradeParameters {
  readonly lut?: StandardLutGraphProjection | undefined;
  readonly dither: OutputDither;
}

/** One upload node per graph imports its view-owned Grade/Final parameter buffer. */
export function addNativeOutputParameters(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  policy: NativeOutputParameterPolicy,
): Result<GraphBuffer, RenderGraphError> {
  const parameters = graph.importBuffer(
    'standard-output-parameters',
    {
      size: STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    },
    (frame) => {
      const c = frame as _InternalRenderPipelineContext;
      return ensureStandardOutputParameters(c.frameState, c.runtime.device).unwrap();
    },
  );
  if (!parameters.ok) return parameters;
  const write = createStandardOutputV2ParameterWriter(policy);
  const uploaded = graph.addCopyPass('standard-output-prepare', {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      const c = frame as _InternalRenderPipelineContext;
      const bytes = write(
        c.camera,
        OUTPUT_GAMUT_CODE[recordContext(c.runtime).outputColorSpace?.report.effective ?? 'srgb'],
        policy.lut?.bind(frame).strength ?? policy.lut?.strength ?? 0,
        frameOutputDither(policy.dither, frame),
      );
      c.runtime.device.queue
        .writeBuffer(resources.buffer(parameters.value).unwrap(), 0, bytes)
        .unwrap();
    },
  });
  return uploaded.ok ? parameters : uploaded;
}

function nativeOutputFragment(stage: NativeOutputStage): string {
  if (stage.kind === 'encode')
    return stage.smaaWeights === undefined ? 'fs_encode' : 'fs_smaa_encode';
  if (stage.kind === 'final') return stage.fxaa ? 'fs_final_fxaa' : 'fs_final';
  if (stage.lut !== undefined)
    return stage.bloom === undefined ? 'fs_grade_lut' : 'fs_grade_lut_bloom';
  return stage.bloom === undefined ? 'fs_grade' : 'fs_grade_bloom';
}

/** Record the native core using one input group and an optional LUT group. */
export function addNativeOutputPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  parameters: GraphBuffer,
  stage: NativeOutputStage,
): Result<void, RenderGraphError> {
  const grade = stage.kind === 'grade';
  const bloom = stage.kind === 'grade' ? stage.bloom : undefined;
  const smaaWeights = stage.kind === 'encode' ? stage.smaaWeights : undefined;
  const secondary = bloom ?? smaaWeights;
  const lut = stage.kind === 'grade' ? stage.lut : undefined;
  const exposure = stage.kind === 'grade' ? stage.exposure : undefined;
  if (
    input.sampleCount !== 1 ||
    output.sampleCount !== 1 ||
    (secondary !== undefined && secondary.sampleCount !== 1)
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected:
          'single-sampled native output targets and a single-sampled accumulated Bloom when enabled',
        hint: 'resolve scene MSAA before Grade and pass the accumulated Bloom target',
      }),
    );
  }
  const fragment = nativeOutputFragment(stage);
  const accesses: GraphAccess[] = [
    { resource: input.view, usage: 'sampled-read' },
    { resource: parameters, usage: 'uniform-read' },
    ...(exposure === undefined ? [] : [{ resource: exposure, usage: 'uniform-read' as const }]),
    ...(secondary === undefined
      ? []
      : [{ resource: secondary.view, usage: 'sampled-read' as const }]),
    ...(lut === undefined ? [] : [{ resource: lut.view, usage: 'sampled-read' as const }]),
    { resource: output.view, usage: 'color-attachment' },
  ];
  const localPrograms: NativeOutputProgram[] = [];
  const prepareModule = (context: _InternalRenderPipelineContext) => {
    const { runtime } = context;
    const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
    const entry = runtime.lookupPostProcess?.(STANDARD_OUTPUT_V2_FEATURE_ID);
    if (factory === undefined || entry === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'the registered native Standard output source and module factory',
        hint: 'prepare forgeax::standard-output-v2 from the Engine manifest before encoding Grade/Final',
      });
    const module = factory.createShaderModule({
      code: entry.source,
      label: postProcessShaderModuleLabel(entry),
    });
    if (!module.ok) {
      if (module.error.code !== 'rhi-not-available') throw module.error;
      markPipelinePreparationPending(context.frameState, { code: 'scene-pipeline-preparation' });
      return undefined;
    }
    return { factory, entry, module: module.value };
  };
  const createProgram = (
    device: RhiDevice,
    prepared: NonNullable<ReturnType<typeof prepareModule>>,
    lutLayout: BindGroupLayout | undefined,
  ): NativeOutputProgram => {
    const { factory, entry, module } = prepared;
    const entries: BindGroupLayoutEntry[] = [
      { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      {
        binding: 2,
        visibility: 2,
        buffer: { type: 'uniform', minBindingSize: STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize },
      },
    ];
    if (grade)
      entries.push({
        binding: 3,
        visibility: 2,
        buffer: { type: 'uniform', minBindingSize: 16 },
      });
    if (secondary !== undefined)
      entries.push({
        binding: 4,
        visibility: 2,
        texture: { sampleType: 'float', viewDimension: '2d' },
      });
    const layout = device.createBindGroupLayout({ entries }).unwrap();
    const pipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: lutLayout === undefined ? [layout] : [layout, lutLayout],
      })
      .unwrap();
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        label: name,
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [] },
        fragment: {
          module,
          entryPoint: fragment,
          targets: [{ format: output.format as GPUTextureFormat }],
        },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    return {
      device,
      factory,
      createModule: factory.createShaderModule,
      module,
      source: entry.source,
      fragment,
      format: output.format,
      lutLayout,
      layout,
      sampler,
      pipeline,
    };
  };
  registerScenePipelinePreparation(
    graph,
    (context) => {
      prepareModule(context);
      return false;
    },
    'utility',
  );
  // Resolver identities may change after resize or history rotation; reuse the comparison scratch.
  let retained: NativeOutputBindings | undefined;
  const added = graph.addRasterPass(name, {
    accesses,
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
      const prepared = prepareModule(frame as _InternalRenderPipelineContext);
      if (prepared === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'native output module preparation completes before encoding',
          hint: 'retry the complete physical frame after preparation',
        });
      const { factory, entry, module } = prepared;
      const binding = lut?.bind(frame);
      const scope = recordContext(runtime).deviceScope;
      const programs =
        scope === undefined ? localPrograms : scope.isAlive() ? programsFor(scope) : undefined;
      let program = programs?.find(
        (cached) =>
          cached.device === device &&
          cached.factory === factory &&
          cached.createModule === factory.createShaderModule &&
          cached.module === module &&
          cached.source === entry.source &&
          cached.fragment === fragment &&
          cached.format === output.format &&
          cached.lutLayout === binding?.bindGroupLayout,
      );
      if (program === undefined) {
        program = createProgram(device, prepared, binding?.bindGroupLayout);
        if (programs !== undefined && (scope === undefined || scope.isAlive())) {
          if (programs.length === 16) programs.shift();
          programs.push(program);
        }
      }
      const source = resources.textureView(input.view).unwrap();
      const buffer = resources.buffer(parameters).unwrap();
      const candidate = exposure === undefined ? buffer : resources.buffer(exposure).unwrap();
      const auxiliaryView =
        secondary === undefined ? undefined : resources.textureView(secondary.view).unwrap();
      if (
        retained === undefined ||
        nativeOutputBindingsChanged(retained, program, source, buffer, candidate, auxiliaryView)
      ) {
        const entries: BindGroupEntry[] = [
          { binding: 0, resource: { kind: 'textureView', value: source } },
          { binding: 1, resource: { kind: 'sampler', value: program.sampler } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer } } },
        ];
        if (grade)
          entries.push({
            binding: 3,
            resource: { kind: 'buffer', value: { buffer: candidate, size: 16 } },
          });
        if (auxiliaryView !== undefined)
          entries.push({ binding: 4, resource: { kind: 'textureView', value: auxiliaryView } });
        retained = {
          program,
          input: source,
          parameters: buffer,
          exposure: candidate,
          secondary: auxiliaryView,
          group: device.createBindGroup({ layout: program.layout, entries }).unwrap(),
        };
      }
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, retained.group);
      if (binding !== undefined) pass.setBindGroup(1, binding.bindGroup);
      pass.draw(3, 1, 0, 0);
    },
  });
  return added.ok ? ok(undefined) : added;
}
