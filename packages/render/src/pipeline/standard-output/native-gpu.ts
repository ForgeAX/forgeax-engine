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
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { markPipelinePreparationPending } from '../../render-system-presentation';
import { recordContext } from '../../world/view-record-context';
import type { StandardLutGraphProjection } from './lut-gpu';
import { createStandardOutputV2ParameterWriter } from './native-params';
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
  readonly bloom: readonly TextureView[];
  readonly group: BindGroup;
}

function nativeOutputBindingsChanged(
  retained: NativeOutputBindings | undefined,
  program: NativeOutputProgram,
  input: TextureView,
  parameters: Buffer,
  exposure: Buffer,
  bloom: readonly TextureView[],
): boolean {
  if (
    retained?.program !== program ||
    retained.input !== input ||
    retained.parameters !== parameters ||
    retained.exposure !== exposure ||
    retained.bloom.length !== bloom.length
  )
    return true;
  for (let level = 0; level < bloom.length; level++)
    if (bloom[level] !== retained.bloom[level]) return true;
  return false;
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
      readonly bloom?: readonly RenderPipelineTarget[] | undefined;
      readonly lut?: StandardLutGraphProjection | undefined;
    }
  | { readonly kind: 'final'; readonly fxaa: boolean }
  | { readonly kind: 'encode' };

export interface NativeOutputParameterPolicy {
  readonly bloom: boolean;
  readonly lutStrength: number;
  readonly sharpen: number;
  readonly dither: boolean;
  readonly finishInGrade: boolean;
  readonly linearGrade?: boolean | undefined;
  readonly chromaticAberration?: boolean | undefined;
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
  const write = createStandardOutputV2ParameterWriter();
  const uploaded = graph.addCopyPass('standard-output-prepare', {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      const c = frame as _InternalRenderPipelineContext;
      const output = c.camera.output;
      const bytes = write({
        camera: c.camera,
        outputGamut:
          OUTPUT_GAMUT_CODE[recordContext(c.runtime).outputColorSpace?.report.effective ?? 'srgb'],
        lens: c.camera.lensEffects,
        whiteBalance: { temperature: output?.temperature ?? 6504, tint: output?.tint ?? 0 },
        bloom: policy.bloom
          ? { intensity: c.camera.bloomIntensity, radius: c.camera.bloomRadius }
          : undefined,
        lutStrength: policy.lutStrength,
        sharpen: policy.sharpen,
        elapsedSeconds: c.camera.temporal?.sampleTimeSeconds ?? 0,
        dither: policy.dither,
        finishInGrade: policy.finishInGrade,
        linearGrade: policy.linearGrade,
        chromaticAberration: policy.chromaticAberration,
      });
      c.runtime.device.queue
        .writeBuffer(resources.buffer(parameters.value).unwrap(), 0, bytes)
        .unwrap();
    },
  });
  return uploaded.ok ? parameters : uploaded;
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
  const lut = stage.kind === 'grade' ? stage.lut : undefined;
  const exposure = stage.kind === 'grade' ? stage.exposure : undefined;
  if (
    input.sampleCount !== 1 ||
    output.sampleCount !== 1 ||
    (bloom !== undefined &&
      (bloom.length !== 5 || bloom.some((target) => target.sampleCount !== 1)))
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected:
          'single-sampled native output targets and exactly five single-sampled Bloom levels when enabled',
        hint: 'resolve scene MSAA before Grade and pass the five declared Bloom filter outputs',
      }),
    );
  }
  const fragment =
    stage.kind === 'encode'
      ? 'fs_encode'
      : stage.kind === 'final'
        ? stage.fxaa
          ? 'fs_final_fxaa'
          : 'fs_final'
        : lut === undefined
          ? bloom === undefined
            ? 'fs_grade'
            : 'fs_grade_bloom'
          : bloom === undefined
            ? 'fs_grade_lut'
            : 'fs_grade_lut_bloom';
  const accesses: GraphAccess[] = [
    { resource: input.view, usage: 'sampled-read' },
    { resource: parameters, usage: 'uniform-read' },
    ...(exposure === undefined ? [] : [{ resource: exposure, usage: 'uniform-read' as const }]),
    ...(bloom ?? []).map((target) => ({ resource: target.view, usage: 'sampled-read' as const })),
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
    if (bloom !== undefined)
      for (let level = 0; level < 5; level++)
        entries.push({
          binding: level + 4,
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
  const levelViews: TextureView[] = [];
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
      levelViews.length = bloom?.length ?? 0;
      for (let level = 0; level < (bloom?.length ?? 0); level++) {
        const target = bloom?.[level];
        if (target !== undefined) levelViews[level] = resources.textureView(target.view).unwrap();
      }
      if (
        retained === undefined ||
        nativeOutputBindingsChanged(retained, program, source, buffer, candidate, levelViews)
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
        levelViews.forEach((view, level) => {
          entries.push({ binding: level + 4, resource: { kind: 'textureView', value: view } });
        });
        retained = {
          program,
          input: source,
          parameters: buffer,
          exposure: candidate,
          bloom: levelViews.slice(),
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
