import {
  type GraphBuffer,
  type GraphTexture,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  RenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
} from '@forgeax/engine-rhi';
import {
  deriveTextureLayout,
  err,
  ok,
  type Result,
  type SampledTextureAsset,
  type WaterFluidTarget,
  type WaterFluidTargetSource,
} from '@forgeax/engine-types';
import {
  type WaterFluidFrame,
  type WaterFluidStep,
  type WaterWaveUploadBody,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { resolvedGraphBuffer, resolvedGraphView } from '../compute-graph-state';
import type { SharedGraphTextureExport } from '../features/shared-graph-textures';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineBuildContext, RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import type { WaterAdvancedShallowFoamSource } from './advanced-feature';
import { type WaterFluidRenderFrame, waterFluidSimulationKey } from './fluid-feature';
import {
  WATER_FLUID_FOAM_EVENT_CAPACITY,
  WATER_FLUID_FOAM_EVENT_STRIDE_BYTES,
  waterFluidFoamContactStrength,
  waterFluidFoamOwnerKey,
} from './fluid-foam';
import { type WaterFluidStage, waterFluidShader } from './fluid-shaders';
import type { WaterInfoDescriptorRow, WaterInfoFramePublication } from './water-info-feature';

export interface WaterFluidGraphFrame extends RenderGraphFrame {
  readonly runtime: Pick<RenderSystemInternals, 'device'>;
}
interface WaterFluidRasterFrame extends WaterFluidGraphFrame {
  readonly runtime: Pick<
    RenderSystemInternals,
    'device' | 'immediateShaderModuleFactory' | 'shaderModuleFactory'
  >;
}
export interface WaterFluidNoiseBinding {
  readonly texture: Texture;
  readonly asset: SampledTextureAsset;
}

type SharedContext = Pick<
  RenderPipelineBuildContext<RenderPipelineFrame>,
  'viewIdentity' | 'getFeatureGraphTextureBinding'
> & {
  readonly graph: RenderGraphBuilder<WaterFluidGraphFrame>;
  readonly waterFluid: WaterFluidRenderFrame;
  readonly heldSimulations?: ReadonlySet<string>;
  readonly waterInfoPublication: WaterInfoFramePublication | undefined;
  readonly resolveShallowFoamSource?: (source: WaterAdvancedShallowFoamSource) =>
    | Readonly<{
        foam: Readonly<{ view: GraphTextureView; format: TextureFormat }>;
        mapping: Readonly<{ view: GraphTextureView; format: TextureFormat }>;
      }>
    | undefined;
  readonly resolveImpulseNoise?: (
    entry: WaterFluidRenderFrame['simulations'][number],
  ) => WaterFluidNoiseBinding | undefined;
};

interface FluidSource {
  view: GraphTextureView;
  descriptor: {
    readonly format: TextureFormat;
    readonly filter: 'linear' | 'nearest';
    readonly address: 'repeat' | 'clamp-to-edge';
  };
}
interface FluidTexture extends FluidSource {
  texture: GraphTexture;
}
interface FluidTarget extends FluidTexture {
  descriptor: WaterFluidTargetSource;
  resolution: readonly [number, number];
}
export interface WaterFluidGraphInputs {
  readonly fields: GraphTextureView;
  readonly descriptors: GraphBuffer;
  readonly foam?: GraphTextureView;
  readonly inspectBodyDescriptor: WaterFluidBodyDescriptorReader;
}
export interface WaterFluidMaterialPublication {
  readonly render: WaterFluidRenderFrame;
  readonly waterInfo: WaterInfoFramePublication | undefined;
}
export type WaterFluidMaterialTopology = readonly [
  bodyCapacity: number,
  simulations: number,
  hasFoam: boolean,
  deviceGeneration: number,
  hasWaterInfo: boolean,
];

function waterFluidBodyCapacity(publication: WaterFluidMaterialPublication): number {
  return Math.max(1, publication.waterInfo?.waveUploadPlan.bodyData.length ?? 0);
}

export function waterFluidMaterialTopology(
  publication: WaterFluidMaterialPublication | undefined,
): WaterFluidMaterialTopology | undefined {
  if (publication === undefined) return undefined;
  const { render, waterInfo } = publication;
  return [
    waterFluidBodyCapacity(publication),
    render.simulations.length,
    render.contactFoam !== undefined,
    render.deviceGeneration,
    waterInfo !== undefined,
  ];
}

export function matchesWaterFluidMaterialTopology(
  shape: WaterFluidMaterialTopology | undefined,
  publication: WaterFluidMaterialPublication | undefined,
): boolean {
  if (shape === undefined || publication === undefined)
    return shape === undefined && publication === undefined;
  const { render, waterInfo } = publication;
  return (
    shape[0] === waterFluidBodyCapacity(publication) &&
    shape[1] === render.simulations.length &&
    shape[2] === (render.contactFoam !== undefined) &&
    shape[3] === render.deviceGeneration &&
    shape[4] === (waterInfo !== undefined)
  );
}
export interface WaterFluidBodyDescriptorInspection {
  readonly viewIdentity: string;
  readonly frameId: number | undefined;
  readonly deviceGeneration: number | undefined;
  readonly resource: string;
  readonly bodyIndex: number;
  readonly sharedFoam: boolean;
}
export type WaterFluidBodyDescriptorReader = (
  owner: NonNullable<RenderableSnapshot['waterOwner']>,
) => WaterFluidBodyDescriptorInspection | undefined;
interface SimulationProjection {
  id: string;
  frame: WaterFluidFrame;
  worldIndex: number;
  worldIdentity: string;
  fields: readonly FluidTarget[];
}
const pipelines = new WeakMap<
  object,
  Map<string, { pipeline: RenderPipeline; layout: BindGroupLayout; sampler?: Sampler }>
>();
const viewProjections = new WeakMap<object, Map<string, WaterFluidGraphInputs>>();
/** The installed graph retains readers of its exact descriptor upload, without a second registry. */
export function waterFluidBodyDescriptorReader(
  graph: object,
): WaterFluidBodyDescriptorReader | undefined {
  const views = viewProjections.get(graph);
  return views === undefined
    ? undefined
    : (owner) => {
        for (const inputs of views.values()) {
          const descriptor = inputs.inspectBodyDescriptor(owner);
          if (descriptor !== undefined) return descriptor;
        }
        return undefined;
      };
}
const STRIDE_FLOATS = 32;
const CLEAR_DESCRIPTOR: WaterFluidTargetSource = {
  format: 'rgba32float',
  filter: 'linear',
  address: 'clamp-to-edge',
  origin: 'top-left',
  channels: 'normal-xz-height-m',
  clear: [0, 0, 0, 0],
};

function invalid(field: string): Result<never, RenderGraphError> {
  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `same-generation Water fluid ${field}`,
      hint: 'repair the recipe or WaterInfo producer and retry without advancing the simulation',
      detail: {
        resourceLabel: 'water-fluid',
        field,
        expected: 'complete producer inputs',
        actual: 'unavailable',
      },
    }),
  );
}

function upload<Frame extends WaterFluidGraphFrame>(
  graph: RenderGraphBuilder<Frame>,
  name: string,
  data: Float32Array,
  capacityBytes = data.byteLength,
): Result<GraphBuffer, RenderGraphError> {
  const buffer = graph.createBuffer(name, { size: Math.max(16, capacityBytes) });
  if (!buffer.ok) return buffer;
  const added = graph.addCopyPass(`${name}-upload`, {
    accesses: [{ resource: buffer.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      frame.runtime.device.queue
        .writeBuffer(resolvedGraphBuffer(resources, buffer.value), 0, data)
        .unwrap();
    },
  });
  return added.ok ? ok(buffer.value) : added;
}

function params(
  frame: WaterFluidFrame,
  step: WaterFluidStep | undefined,
  info: WaterInfoDescriptorRow | undefined,
  width: number,
  height: number,
  clear: readonly number[],
  waveBody?: WaterWaveUploadBody,
  domain: 'solver' | 'wave-foam' = 'solver',
): Float32Array {
  const recipe = frame.instance.recipe;
  const p = recipe.parameters;
  const foam = domain === 'wave-foam';
  const current = foam ? frame.waveFoamCenterM : (step?.centerM ?? frame.previousCenterM);
  const previous = foam
    ? frame.previousWaveFoamCenterM
    : (step?.previousCenterM ?? frame.previousFrameCenterM);
  const previous2 = foam
    ? frame.previous2WaveFoamCenterM
    : (step?.previous2CenterM ?? frame.previous2CenterM);
  const extent = foam
    ? ([recipe.waveFoam.gridExtentM, recipe.waveFoam.gridExtentM] as const)
    : recipe.gridExtentM;
  const values = new Float32Array(80);
  values.set(
    [
      width,
      height,
      step?.dt ?? 1 / recipe.virtualFps,
      step?.impulses.length ?? frame.impulses.length,
    ],
    0,
  );
  values.set([current[0], current[2], ...extent], 4);
  values.set([previous[0], previous[2], 0, 0], 8);
  values.set([previous2[0], previous2[2], 0, 0], 12);
  values.set(
    [p.travelSpeed, p.rippleDamping, p.fluidDampingPerSecond, p.gravityMPerSecSquared],
    16,
  );
  values.set(
    [p.constantWaterDepthM, p.evaporationMPerSecond, p.normalHeightScale, p.maskThreshold],
    20,
  );
  values.set([p.waveNormalAmount, p.foamFadePerFrame, p.foamDiffusion, p.waveEdgeFalloff], 24);
  values.set(
    [
      recipe.solverMode === 'shallow' ? 1 : 0,
      current[1],
      recipe.terrainMode === 'water-info' ? 1 : 0,
      recipe.shallowFoamEnabled ? 1 : 0,
    ],
    28,
  );
  if (info !== undefined && recipe.terrainMode === 'water-info') {
    const c = info.context;
    values.set([...c.centerXZ, info.slice, 1], 32);
    values.set([...c.extentXZ, c.waterYMinM, c.waterYMaxM], 36);
    values.set([c.groundYMinM, 0, 0, 0], 40);
  }
  values.set(clear, 44);
  values.set(recipe.targets.forces.clear, 48);
  values.set(
    [p.foamEdgeFalloff, p.foamWetPerMeter, p.foamWetFadePerFrame, p.foamToneMapDensity],
    52,
  );
  values.set(
    [
      (current[0] - previous[0]) / extent[0],
      (current[2] - previous[2]) / extent[1],
      recipe.configurationVersion,
      0,
    ],
    56,
  );
  values.set(
    [
      p.shallowEdgeLengthM,
      p.shallowFadingBackPerSecond,
      p.terrainUseWaterDepthOnly,
      p.shallowNormalHeightScale,
    ],
    60,
  );
  values.set(
    [
      p.shallowFoamFadePerSecond,
      p.shallowFoamInjection,
      p.shallowVelocityForFoamMPerSecond,
      p.shallowFoamSlopeMinimum,
    ],
    64,
  );
  values.set(
    [p.shallowFoamSlopeRange, p.waveNormalBias, p.waveMinimumHeightM, p.waveHeightDivisorM],
    68,
  );
  values.set(
    [p.normalDefaultDepthM, p.normalFoamAmount, p.normalFoamHeightScale, p.normalEdgeFalloff],
    72,
  );
  values.set(
    [
      waveBody?.supportsWaves ? waveBody.waveSet.waves.length : 0,
      (waveBody?.timeSeconds ?? frame.timeSeconds) + p.waveTimeBiasSeconds,
      p.rippleFoamDamping,
      p.rippleFoamErasure,
    ],
    76,
  );
  return values;
}

function target<Frame extends WaterFluidGraphFrame>(
  graph: RenderGraphBuilder<Frame>,
  label: string,
  descriptor: WaterFluidTargetSource,
  resolution: readonly [number, number],
  layers = 1,
  lifetime: 'persistent' | 'transient' = 'persistent',
): Result<FluidTarget, RenderGraphError> {
  const texture = graph.createTexture(label, {
    format: descriptor.format,
    size: {
      width: resolution[0],
      height: resolution[1],
      depthOrArrayLayers: layers,
    },
    lifetime,
    usage: 0x01 | 0x04 | 0x10,
  });
  if (!texture.ok) return texture;
  const view = graph.view(texture.value, {
    dimension: layers === 1 ? '2d' : '2d-array',
    arrayLayerCount: layers,
    label: `${label}.view`,
  });
  return view.ok ? ok({ texture: texture.value, view: view.value, descriptor, resolution }) : view;
}

function clearTarget<Frame extends WaterFluidGraphFrame>(
  graph: RenderGraphBuilder<Frame>,
  label: string,
  destination: FluidTarget,
  record?: { render: WaterFluidRenderFrame; id: string },
): Result<void, RenderGraphError> {
  record?.render.required.add(record.id);
  const c = destination.descriptor.clear;
  return graph.addRasterPass(label, {
    accesses: [{ resource: destination.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: destination.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: c[0], g: c[1], b: c[2], a: c[3] },
      },
    ],
    encodeDirect: () => {
      record?.render.encoded.add(record.id);
    },
  });
}

function raster<Frame extends WaterFluidRasterFrame>(
  graph: RenderGraphBuilder<Frame>,
  label: string,
  stage: WaterFluidStage,
  sources: readonly FluidSource[],
  destination: FluidTarget,
  parameterBuffer: GraphBuffer,
  forces: GraphBuffer,
  info: GraphTextureView | undefined,
  width: number,
  height: number,
  record?: { render: WaterFluidRenderFrame; id: string },
): Result<void, RenderGraphError> {
  if (sources.some((source) => 'texture' in source && source.texture === destination.texture))
    return invalid(`${label} non-aliasing source and attachment`);
  const source = waterFluidShader(
    stage,
    sources.length,
    sources.map((item) => item.descriptor.filter === 'linear'),
    info !== undefined,
    sources.map((item) => item.descriptor.address === 'repeat'),
  );
  const entries = [
    ...sources.map((texture, binding) => ({
      binding,
      visibility: 2,
      texture: {
        sampleType:
          texture.descriptor.format === 'rgba32float' || texture.descriptor.format === 'rg32float'
            ? ('unfilterable-float' as const)
            : ('float' as const),
        viewDimension: '2d' as const,
      },
    })),
    { binding: sources.length, visibility: 2, buffer: { type: 'read-only-storage' as const } },
    { binding: sources.length + 1, visibility: 2, buffer: { type: 'read-only-storage' as const } },
    ...(info === undefined
      ? []
      : [
          {
            binding: sources.length + 2,
            visibility: 2,
            texture: {
              sampleType: 'unfilterable-float' as const,
              viewDimension: '2d-array' as const,
            },
          },
        ]),
    ...(stage === 'forces'
      ? [{ binding: sources.length + 2, visibility: 2, sampler: { type: 'filtering' as const } }]
      : []),
  ];
  record?.render.required.add(record.id);
  return graph.addRasterPass(label, {
    accesses: [
      ...sources.map((texture) => ({ resource: texture.view, usage: 'sampled-read' as const })),
      { resource: parameterBuffer, usage: 'storage-read' },
      { resource: forces, usage: 'storage-read' },
      ...(info === undefined ? [] : [{ resource: info, usage: 'sampled-read' as const }]),
      { resource: destination.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: destination.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const device = frame.runtime.device;
      let cache = pipelines.get(device);
      if (cache === undefined) {
        cache = new Map();
        pipelines.set(device, cache);
      }
      const key = `${destination.descriptor.format}:${source}`;
      let state = cache.get(key);
      if (state === undefined) {
        const factory =
          frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
        if (factory === undefined) return invalid(`${label} shader module factory`).unwrap();
        const module = factory
          .createShaderModule({ code: source, label: `water-fluid-${stage}` })
          .unwrap();
        const layout = device.createBindGroupLayout({ entries }).unwrap();
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: `water-fluid-${stage}-${destination.descriptor.format}`,
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main', buffers: [] },
            fragment: {
              module,
              entryPoint: 'fs_main',
              targets: [{ format: destination.descriptor.format }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
          })
          .unwrap();
        state = {
          pipeline,
          layout,
          ...(stage === 'forces'
            ? {
                sampler: device
                  .createSampler({
                    addressModeU: 'repeat',
                    addressModeV: 'repeat',
                    magFilter: 'linear',
                    minFilter: 'linear',
                    mipmapFilter: 'nearest',
                  })
                  .unwrap(),
              }
            : {}),
        };
        cache.set(key, state);
      }
      const bindGroup = device
        .createBindGroup({
          layout: state.layout,
          entries: [
            ...sources.map((texture, binding) => ({
              binding,
              resource: {
                kind: 'textureView' as const,
                value: resolvedGraphView(resources, texture.view),
              },
            })),
            {
              binding: sources.length,
              resource: {
                kind: 'buffer',
                value: { buffer: resolvedGraphBuffer(resources, parameterBuffer) },
              },
            },
            {
              binding: sources.length + 1,
              resource: {
                kind: 'buffer',
                value: { buffer: resolvedGraphBuffer(resources, forces) },
              },
            },
            ...(info === undefined
              ? []
              : [
                  {
                    binding: sources.length + 2,
                    resource: {
                      kind: 'textureView' as const,
                      value: resolvedGraphView(resources, info),
                    },
                  },
                ]),
            ...(state.sampler === undefined
              ? []
              : [
                  {
                    binding: sources.length + 2,
                    resource: { kind: 'sampler' as const, value: state.sampler },
                  },
                ]),
          ],
        })
        .unwrap();
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, width, height, 0, 1);
      pass.draw(3);
      record?.render.encoded.add(record.id);
    },
  });
}

function infoRow(
  publication: WaterInfoFramePublication | undefined,
  worldIndex: number,
  worldIdentity: string,
  frame: WaterFluidFrame,
): WaterInfoDescriptorRow | undefined {
  return [...(publication?.rows.values() ?? [])].find(
    (row) =>
      row.worldId === worldIndex &&
      row.worldIdentity === worldIdentity &&
      row.bodyGuid === frame.instance.bodyGuid &&
      row.bodyGeneration === frame.instance.bodyGeneration &&
      row.deviceGeneration === frame.deviceGeneration,
  );
}

function simulate(
  graph: RenderGraphBuilder<WaterFluidGraphFrame>,
  render: WaterFluidRenderFrame,
  entry: WaterFluidRenderFrame['simulations'][number],
  publication: WaterInfoFramePublication | undefined,
  context: SharedContext,
): Result<SimulationProjection, RenderGraphError> {
  const { frame, worldIndex } = entry;
  const recipe = frame.instance.recipe;
  const foamResolution = [recipe.waveFoam.resolution, recipe.waveFoam.resolution] as const;
  const id = waterFluidSimulationKey(entry);
  const label = `water-fluid-${id}-${frame.simulationGeneration}-device${frame.deviceGeneration}`;
  const rt = new Map<string, FluidTarget>();
  const make = (name: string, kind: WaterFluidTarget): Result<FluidTarget, RenderGraphError> => {
    const result = target(
      graph,
      `${label}-${name}`,
      recipe.targets[kind],
      kind === 'wave' || kind === 'foam' ? foamResolution : recipe.resolution,
    );
    if (result.ok) rt.set(name, result.value);
    return result;
  };
  const physical =
    recipe.solverMode === 'ripple'
      ? ([
          ['height0', 'height'],
          ['height1', 'height'],
          ['height2', 'height'],
        ] as const)
      : ([
          ['height0', 'height'],
          ['height1', 'height'],
          ['velocity0', 'velocity'],
          ['velocity1', 'velocity'],
        ] as const);
  const createFluidTargets = () => {
    for (const [name, kind] of [
      ...physical,
      ['forces', 'forces'],
      ['velocity-forces', 'velocityForces'],
      ['normal-height', 'normalHeight'],
      ['normal-previous', 'normalHeight'],
      ...(recipe.foamEnabled
        ? [
            ['wave', 'wave'],
            ['foam0', 'foam'],
            ['foam1', 'foam'],
            ['foam-output', 'foam'],
          ]
        : [['foam-neutral', 'foam']]),
    ] as readonly (readonly [string, WaterFluidTarget])[]) {
      const created = make(name, kind);
      if (!created.ok) return created;
    }
    if (recipe.solverMode === 'ripple') {
      const black = target(graph, `${label}-wave-shallow-black`, CLEAR_DESCRIPTOR, [1, 1]);
      if (!black.ok) return black;
      rt.set('wave-shallow-black', black.value);
    }
    return undefined;
  };
  const targetFailure = createFluidTargets();
  if (targetFailure !== undefined) return targetFailure;
  const get = (name: string): FluidTarget => {
    const value = rt.get(name);
    return value === undefined ? invalid(`${label} target ${name}`).unwrap() : value;
  };
  const projectFields = (): Result<SimulationProjection, RenderGraphError> => {
    // A held simulation retains the same physical usages and material fields.
    // It emits no submitted-step markers, so pending impulses stay queued.
    for (const [name, retained] of rt) {
      const keep = graph.addComputePass(`${label}-retain-${name}`, {
        accesses: [{ resource: retained.view, usage: 'sampled-read' }],
        encodeDirect: () => {},
      });
      if (!keep.ok) return keep;
    }
    return ok({
      id,
      frame,
      worldIndex,
      worldIdentity: entry.worldIdentity,
      fields: [
        get('normal-height'),
        recipe.solverMode === 'shallow'
          ? get(`velocity${frame.roles.velocityReadSide}`)
          : get('velocity-forces'),
        get('forces'),
        get(recipe.foamEnabled ? 'foam-output' : 'foam-neutral'),
        get('normal-previous'),
      ],
    });
  };
  if (context.heldSimulations?.has(id)) return projectFields();
  const row = infoRow(publication, worldIndex, entry.worldIdentity, frame);
  const captureFluidWaveInputs = () => {
    const waveBody = publication?.waveBodies.find(
      (body) =>
        body.worldIdentity === entry.worldIdentity &&
        body.worldId === worldIndex &&
        body.bodyGuid === frame.instance.bodyGuid &&
        body.bodyGeneration === frame.instance.bodyGeneration,
    );
    if (
      row !== undefined &&
      (row.worldIdentity !== entry.worldIdentity ||
        row.frameGeneration !== render.frameNumber ||
        publication?.viewIdentity !== render.waterInfoViewIdentity ||
        publication?.frameGeneration !== render.frameNumber ||
        publication?.deviceGeneration !== render.deviceGeneration)
    )
      return invalid(`${id} WaterInfo closure`);
    if (recipe.foamEnabled && (waveBody === undefined || waveBody.waveSet.waves.length > 32))
      return invalid(`${id} legacy wave input (at most 32 waves)`);
    const uploadLegacyWaveInputs = () => {
      const waveValues = new Float32Array(Math.max(4, (waveBody?.waveSet.waves.length ?? 0) * 8));
      waveBody?.waveSet.waves.forEach((wave, index) => {
        waveValues.set(
          [
            ...wave.directionXZ,
            wave.amplitudeM,
            wave.wavelengthM,
            wave.steepness,
            wave.kPerM,
            wave.omegaPerSec,
            wave.gpuQ,
          ],
          index * 8,
        );
      });
      const waveInputs = recipe.foamEnabled
        ? upload(graph, `${label}-legacy-waves`, waveValues)
        : undefined;
      if (waveInputs !== undefined && !waveInputs.ok) return waveInputs;
      return ok(waveInputs);
    };
    const uploaded = uploadLegacyWaveInputs();
    if (!uploaded.ok) return uploaded;
    const waveInputs = uploaded.value;
    const terrain =
      recipe.terrainMode === 'water-info' && row !== undefined
        ? context.getFeatureGraphTextureBinding?.(
            row.targetName,
            render.waterInfoViewIdentity ?? context.viewIdentity ?? 'camera:0',
          )?.view
        : undefined;
    if (recipe.terrainMode === 'water-info' && terrain === undefined)
      return invalid(`${id} WaterInfo closure`);
    return ok({ waveBody, waveInputs, terrain });
  };
  const waveResult = captureFluidWaveInputs();
  if (!waveResult.ok) return waveResult;
  const { waveBody, waveInputs, terrain } = waveResult.value;
  const emptyForces = upload(graph, `${label}-empty-forces`, new Float32Array(4));
  if (!emptyForces.ok) return emptyForces;
  const initializeFluidTargets = () => {
    if (frame.initialize)
      for (const [name, destination] of rt) {
        if (name === 'foam-neutral') continue;
        const record = { render, id: `${id}/initialize/${name}` };
        if (name.startsWith('height') && recipe.solverMode === 'shallow' && terrain !== undefined) {
          const values = upload(
            graph,
            `${label}-initialize-${name}-parameters`,
            params(frame, undefined, row, ...recipe.resolution, destination.descriptor.clear),
          );
          if (!values.ok) return values;
          const pass = raster(
            graph,
            `${label}-initialize-${name}`,
            'initialize',
            [],
            destination,
            values.value,
            emptyForces.value,
            terrain,
            ...recipe.resolution,
            record,
          );
          if (!pass.ok) return pass;
        } else {
          const cleared = clearTarget(graph, `${label}-initialize-${name}`, destination, record);
          if (!cleared.ok) return cleared;
        }
      }
    return undefined;
  };
  const initializationFailure = initializeFluidTargets();
  if (initializationFailure !== undefined) return initializationFailure;
  const historyValues = upload(
    graph,
    `${label}-history-parameters`,
    params(frame, undefined, row, ...recipe.resolution, recipe.targets.normalHeight.clear),
  );
  if (!historyValues.ok) return historyValues;
  const history = raster(
    graph,
    `${label}-preserve-material-history`,
    'atlas',
    [get('normal-height')],
    get('normal-previous'),
    historyValues.value,
    emptyForces.value,
    undefined,
    ...recipe.resolution,
    { render, id: `${id}/preserve-material-history` },
  );
  if (!history.ok) return history;
  const forceData = new Float32Array(Math.max(4, frame.impulses.length * 12));
  frame.impulses.forEach((impulse, index) => {
    forceData.set(
      [
        impulse.positionM[0],
        impulse.positionM[2],
        impulse.radiusM,
        impulse.heightDeltaM,
        impulse.foamStrength,
        impulse.positionM[1],
        impulse.sequence,
        0,
        0,
        0,
        0,
        0,
      ],
      index * 12,
    );
  });
  const batch = upload(graph, `${label}-force-snapshot`, forceData);
  if (!batch.ok) return batch;
  const drawFluidForceCanvas = () => {
    {
      const forceValues = params(
        frame,
        undefined,
        row,
        ...recipe.resolution,
        recipe.targets.forces.clear,
      );
      // The force canvas is drawn before this Tick's solver callbacks move the grid.
      forceValues.set([frame.previousFrameCenterM[0], frame.previousFrameCenterM[2]], 4);
      const forceParameters = upload(graph, `${label}-force-parameters`, forceValues);
      if (!forceParameters.ok) return forceParameters;
      for (const [stage, destination] of [
        ['forces', get('forces')],
        ['velocity-forces', get('velocity-forces')],
      ] as const) {
        const record = { render, id: `${id}/tick-${stage}` };
        let sources: FluidTexture[] = [];
        if (stage === 'forces' && frame.impulses.length > 0) {
          const noise = context.resolveImpulseNoise?.(entry);
          if (noise === undefined) return invalid(`${id} default impulse noise residency`);
          const texture = graph.importTexture(
            `${label}-impulse-noise-${entry.impulseNoise?.revision}`,
            {
              format: noise.asset.format,
              size: {
                width: noise.asset.shape.extent.width,
                height: noise.asset.shape.extent.height,
                depthOrArrayLayers: 1,
              },
              mipLevelCount: deriveTextureLayout(noise.asset).unwrap().levels.length,
              usage: 0x04,
            },
            () => noise.texture,
          );
          if (!texture.ok) return texture;
          const view = graph.view(texture.value, { dimension: '2d' });
          if (!view.ok) return view;
          sources = [
            {
              texture: texture.value,
              view: view.value,
              descriptor: { format: noise.asset.format, filter: 'linear', address: 'repeat' },
            },
          ];
        }
        const written =
          stage === 'velocity-forces' || frame.impulses.length === 0
            ? clearTarget(graph, `${label}-tick-${stage}`, destination, record)
            : raster(
                graph,
                `${label}-tick-${stage}`,
                stage,
                sources,
                destination,
                forceParameters.value,
                batch.value,
                undefined,
                ...recipe.resolution,
                record,
              );
        if (!written.ok) return written;
      }
    }
    return undefined;
  };
  const forceFailure = drawFluidForceCanvas();
  if (forceFailure !== undefined) return forceFailure;
  const addFluidSolverSteps = () => {
    for (const step of frame.steps) {
      const values = upload(
        graph,
        `${label}-step${step.fixedStep}-parameters`,
        params(frame, step, row, ...recipe.resolution, recipe.targets.height.clear, waveBody),
      );
      if (!values.ok) return values;
      const add = (
        stage: WaterFluidStage,
        sources: readonly FluidTarget[],
        destination: FluidTarget,
        withTerrain = false,
      ) =>
        raster(
          graph,
          `${label}-step${step.fixedStep}-${stage}`,
          stage,
          sources,
          destination,
          values.value,
          stage === 'wave' && waveInputs?.ok ? waveInputs.value : batch.value,
          withTerrain ? terrain : undefined,
          ...recipe.resolution,
          { render, id: `${id}/step${step.fixedStep}/${stage}` },
        );
      let added: Result<void, RenderGraphError>;
      if (recipe.solverMode === 'ripple') {
        added = add(
          'ripple',
          [
            get(`height${step.before.current}`),
            get(`height${step.before.previous}`),
            get('forces'),
          ],
          get(`height${step.after.current}`),
          true,
        );
        if (!added.ok) return added;
      } else {
        const h0 = get(`height${step.before.heightReadSide}`),
          h1 = get(`height${1 - step.before.heightReadSide}`);
        const v0 = get(`velocity${step.before.velocityReadSide}`),
          v1 = get(`velocity${1 - step.before.velocityReadSide}`);
        added = add('advect-height', [h0, v0, get('forces')], h1, true);
        if (!added.ok) return added;
        added = add('advect-velocity', [v0], v1);
        if (!added.ok) return added;
        added = add('height-divergence', [h1, v1], h0);
        if (!added.ok) return added;
        added = add('gravity', [h0, v1], v0);
        if (!added.ok) return added;
      }
    }
    return undefined;
  };
  const solverFailure = addFluidSolverSteps();
  if (solverFailure !== undefined) return solverFailure;
  const frameValues = upload(
    graph,
    `${label}-tick-parameters`,
    params(frame, undefined, row, ...recipe.resolution, recipe.targets.height.clear, waveBody),
  );
  if (!frameValues.ok) return frameValues;
  const addFrame = (
    stage: WaterFluidStage,
    sources: readonly FluidTarget[],
    destination: FluidTarget,
  ) =>
    raster(
      graph,
      `${label}-tick-${stage}`,
      stage,
      sources,
      destination,
      frameValues.value,
      stage === 'wave' && waveInputs?.ok ? waveInputs.value : batch.value,
      undefined,
      ...recipe.resolution,
      { render, id: `${id}/tick-${stage}` },
    );
  const height = get(
    `height${recipe.solverMode === 'ripple' ? frame.roles.current : frame.roles.heightReadSide}`,
  );
  const normal = addFrame('normal-height', [height], get('normal-height'));
  if (!normal.ok) return normal;
  const addFluidFoamStages = () => {
    if (recipe.foamEnabled) {
      const foamValues = upload(
        graph,
        `${label}-tick-wave-foam-parameters`,
        params(
          frame,
          undefined,
          row,
          ...foamResolution,
          recipe.targets.foam.clear,
          waveBody,
          'wave-foam',
        ),
      );
      if (!foamValues.ok) return foamValues;
      const addFoam = (
        stage: WaterFluidStage,
        sources: readonly FluidTarget[],
        destination: FluidTarget,
      ) =>
        raster(
          graph,
          `${label}-tick-${stage}`,
          stage,
          sources,
          destination,
          foamValues.value,
          stage === 'wave' && waveInputs?.ok ? waveInputs.value : batch.value,
          undefined,
          ...foamResolution,
          { render, id: `${id}/tick-${stage}` },
        );
      const wave = addFoam(
        'wave',
        [recipe.solverMode === 'shallow' ? height : get('wave-shallow-black')],
        get('wave'),
      );
      if (!wave.ok) return wave;
      const foam = addFoam(
        'foam-diffuse',
        [get(`foam${1 - frame.roles.foamReadSide}`), get('wave')],
        get(`foam${frame.roles.foamReadSide}`),
      );
      if (!foam.ok) return foam;
      const toneMap = addFoam(
        'foam-tonemap',
        [get(`foam${frame.roles.foamReadSide}`)],
        get('foam-output'),
      );
      if (!toneMap.ok) return toneMap;
    }
    return undefined;
  };
  const foamFailure = addFluidFoamStages();
  if (foamFailure !== undefined) return foamFailure;
  if (!recipe.foamEnabled) {
    const cleared = clearTarget(graph, `${label}-foam-neutral-clear`, get('foam-neutral'));
    if (!cleared.ok) return cleared;
  }
  return projectFields();
}

function addContactFoam(
  context: SharedContext,
): Result<SharedGraphTextureExport | undefined, RenderGraphError> {
  const render = context.waterFluid;
  const foam = render.contactFoam;
  if (foam === undefined) return ok(undefined);
  const graph = context.graph;
  const resolution = [foam.options.resolution, foam.options.resolution] as const;
  const descriptor: WaterFluidTargetSource = {
    format: 'rgba16float',
    filter: 'linear',
    address: 'clamp-to-edge',
    origin: 'top-left',
    channels: 'foam',
    clear: [0, 0, 0, 1],
  };
  const makeHistory = (side: 0 | 1) =>
    target(
      graph,
      `water-fluid-contact-${foam.generation}-device${foam.deviceGeneration}-history${side}`,
      descriptor,
      resolution,
    );
  const first = makeHistory(0);
  if (!first.ok) return first;
  const second = makeHistory(1);
  if (!second.ok) return second;
  const read = foam.readSide === 0 ? second.value : first.value;
  const write = foam.readSide === 0 ? first.value : second.value;
  const initializeFoamHistory = () => {
    if (foam.initialize) {
      for (const [side, destination] of [read, write].entries()) {
        const cleared = clearTarget(graph, `water-fluid-contact-initialize${side}`, destination, {
          render,
          id: `contact-foam/initialize${side}`,
        });
        if (!cleared.ok) return cleared;
      }
    }
    return undefined;
  };
  const initializeFoamHistoryFailure = initializeFoamHistory();
  if (initializeFoamHistoryFailure !== undefined) return initializeFoamHistoryFailure;
  const values = new Float32Array(80);
  values.set([...resolution, foam.deltaSeconds, foam.events.length], 0);
  values.set([...foam.mapping.centerXZ, foam.mapping.extentM, foam.mapping.extentM], 4);
  values.set([foam.options.decayPerSecond, 0, 0, 0], 8);
  const events = new Float32Array(Math.max(4, foam.events.length * 8));
  const captureFoamContactEvents = () => {
    for (const [index, entry] of foam.events.entries()) {
      const contact = entry.event.contact;
      if (contact.kind !== 'water-plane-intersection') return invalid('contact footprint');
      events.set(
        [
          contact.positionM[0],
          contact.positionM[2],
          contact.radiusM,
          Math.max(
            'coverage' in entry.event ? entry.event.coverage : 0,
            waterFluidFoamContactStrength(contact.relativeVelocityMps, foam.options.strengthPerMps),
          ),
          contact.relativeVelocityMps[0],
          contact.relativeVelocityMps[2],
          Math.max(0, foam.timeSeconds - entry.event.queryTimeSeconds),
          'kind' in entry.event && entry.event.kind === 'visual-probe' ? 1 : 0,
        ],
        index * 8,
      );
    }
    return undefined;
  };
  const eventFailure = captureFoamContactEvents();
  if (eventFailure !== undefined) return eventFailure;
  const parameters = upload(graph, 'water-fluid-contact-parameters', values);
  if (!parameters.ok) return parameters;
  const brushes = upload(
    graph,
    'water-fluid-contact-events',
    events,
    WATER_FLUID_FOAM_EVENT_CAPACITY * WATER_FLUID_FOAM_EVENT_STRIDE_BYTES,
  );
  if (!brushes.ok) return brushes;
  const sources: { foam: FluidSource; mapping: FluidSource }[] = [];
  const captureShallowFoamSources = () => {
    for (const source of render.shallowFoamSources ?? []) {
      if (
        !foam.owners.some(
          (owner) => waterFluidFoamOwnerKey(owner) === waterFluidFoamOwnerKey(source),
        )
      )
        return invalid('shallow foam Body generation');
      const resolved = context.resolveShallowFoamSource?.(source);
      if (resolved === undefined) continue;
      const { foam: field, mapping } = resolved;
      sources.push({
        foam: {
          view: field.view,
          descriptor: { format: field.format, filter: 'linear', address: 'clamp-to-edge' },
        },
        mapping: {
          view: mapping.view,
          descriptor: { format: mapping.format, filter: 'nearest', address: 'clamp-to-edge' },
        },
      });
    }
    return undefined;
  };
  const sourceFailure = captureShallowFoamSources();
  if (sourceFailure !== undefined) return sourceFailure;
  const scratch: FluidTarget[] = [];
  for (let index = 0; index < sources.length; index++) {
    const created = target(
      graph,
      `water-fluid-shallow-foam-merge${index}`,
      descriptor,
      resolution,
      1,
      'transient',
    );
    if (!created.ok) return created;
    scratch.push(created.value);
  }
  const stamped = raster(
    graph,
    'water-fluid-contact-stamp',
    'contact-foam',
    [read],
    scratch[0] ?? write,
    parameters.value,
    brushes.value,
    undefined,
    ...resolution,
    { render, id: 'contact-foam/stamp' },
  );
  if (!stamped.ok) return stamped;
  const mergeShallowFoamFields = () => {
    for (const [index, source] of sources.entries()) {
      const input = scratch[index];
      if (input === undefined) return invalid('shallow foam intermediate');
      const merged = raster(
        graph,
        `water-fluid-shallow-foam-merge${index}`,
        'shallow-foam',
        [input, source.foam, source.mapping],
        scratch[index + 1] ?? write,
        parameters.value,
        brushes.value,
        undefined,
        ...resolution,
        { render, id: `contact-foam/shallow${index}` },
      );
      if (!merged.ok) return merged;
    }
    return undefined;
  };
  const mergeFailure = mergeShallowFoamFields();
  if (mergeFailure !== undefined) return mergeFailure;
  const output = target(graph, 'water-fluid-foam-final', descriptor, resolution);
  if (!output.ok) return output;
  const copied = raster(
    graph,
    'water-fluid-foam-final-write',
    'atlas',
    [write],
    output.value,
    parameters.value,
    brushes.value,
    undefined,
    ...resolution,
    { render, id: 'contact-foam/final' },
  );
  if (!copied.ok) return copied;
  const retainContactFoamHistory = () => {
    // Both ping-pong sides belong to the shared graph across view recreation.
    for (const [side, retained] of [read, write].entries()) {
      const kept = graph.addComputePass(`water-fluid-contact-retain${side}`, {
        accesses: [{ resource: retained.view, usage: 'sampled-read' }],
        encodeDirect: () => {},
      });
      if (!kept.ok) return kept;
    }
    return undefined;
  };
  const historyFailure = retainContactFoamHistory();
  if (historyFailure !== undefined) return historyFailure;
  return ok({
    name: 'water-fluid-foam',
    label: 'water-fluid-foam-final',
    scope: 'frame',
    descriptor: {
      format: 'rgba16float',
      size: { width: resolution[0], height: resolution[1] },
      lifetime: 'persistent',
      usage: 0x01 | 0x04 | 0x10,
    },
    view: { dimension: '2d' },
  });
}

/** All views share physical simulation fields; only their Body row projection differs. */
export function addWaterFluidSharedGraph(
  context: SharedContext,
): Result<readonly SharedGraphTextureExport[], RenderGraphError> {
  const graph = context.graph;
  const render = context.waterFluid;
  const publication = context.waterInfoPublication;
  const simulations: SimulationProjection[] = [];
  for (const entry of render.simulations) {
    const simulated = simulate(graph, render, entry, publication, context);
    if (!simulated.ok) return simulated;
    simulations.push(simulated.value);
  }
  const width = Math.max(
    1,
    ...simulations.flatMap((item) => item.fields.map((field) => field.resolution[0])),
  );
  const height = Math.max(
    1,
    ...simulations.flatMap((item) => item.fields.map((field) => field.resolution[1])),
  );
  const layers = Math.max(1, simulations.length * 5);
  const array = target(
    graph,
    'water-fluid-material-fields',
    CLEAR_DESCRIPTOR,
    [width, height],
    layers,
  );
  if (!array.ok) return array;
  if (simulations.length === 0) {
    const cleared = clearTarget(graph, 'water-fluid-material-fields-disabled', array.value);
    if (!cleared.ok) return cleared;
  }
  for (const [index, item] of simulations.entries()) {
    const values = upload(
      graph,
      `water-fluid-atlas${index}-parameters`,
      params(item.frame, undefined, undefined, width, height, [0, 0, 0, 0]),
    );
    if (!values.ok) return values;
    const forces = upload(graph, `water-fluid-atlas${index}-empty-forces`, new Float32Array(4));
    if (!forces.ok) return forces;
    for (const [field, source] of item.fields.entries()) {
      const view = graph.view(array.value.texture, {
        dimension: '2d',
        baseArrayLayer: index * 5 + field,
        arrayLayerCount: 1,
      });
      if (!view.ok) return view;
      const destination = { ...array.value, view: view.value };
      const copied = raster(
        graph,
        `water-fluid-atlas${index}-field${field}`,
        'atlas',
        [source],
        destination,
        values.value,
        forces.value,
        undefined,
        width,
        height,
        context.heldSimulations?.has(item.id)
          ? undefined
          : { render, id: `${item.id}/material-field${field}` },
      );
      if (!copied.ok) return copied;
    }
  }
  const fields: SharedGraphTextureExport = {
    name: 'water-fluid-material-fields',
    label: 'water-fluid-material-fields',
    scope: 'frame',
    descriptor: {
      format: 'rgba32float',
      size: { width, height, depthOrArrayLayers: layers },
      usage: 0x01 | 0x04 | 0x10,
      lifetime: 'persistent',
    },
    view: { dimension: '2d-array', arrayLayerCount: layers },
  };
  const foam = addContactFoam(context);
  return foam.ok ? ok(foam.value === undefined ? [fields] : [fields, foam.value]) : foam;
}

function writeBodyDescriptors(table: Float32Array, source: WaterFluidMaterialPublication): void {
  const publication = source.waterInfo;
  for (const [index, item] of source.render.simulations.entries()) {
    const frame = item.frame;
    const body = publication?.waveBodies.find(
      (row) =>
        row.worldId === item.worldIndex &&
        row.bodyGuid === frame.instance.bodyGuid &&
        row.bodyGeneration === frame.instance.bodyGeneration,
    );
    if (body === undefined || publication === undefined) continue;
    const key = waterBodyOwnerKey(
      body.worldIdentity,
      body.bodyGuid,
      body.bodyGeneration,
      body.zoneGeneration,
    );
    const bodyIndex = publication.waveUploadPlan.bodyIndices.get(key);
    if (bodyIndex === undefined) continue;
    const center = frame.previousCenterM;
    const recipe = frame.instance.recipe;
    const addresses = [
      recipe.targets.normalHeight,
      recipe.solverMode === 'shallow' ? recipe.targets.velocity : recipe.targets.velocityForces,
      recipe.targets.forces,
      recipe.targets.foam,
      recipe.targets.normalHeight,
    ];
    const repeatMask = addresses.reduce(
      (mask, target, field) => mask | (target.address === 'repeat' ? 1 << field : 0),
      0,
    );
    const linearMask = addresses.reduce(
      (mask, target, field) => mask | (target.filter === 'linear' ? 1 << field : 0),
      0,
    );
    table.set(
      [
        center[0],
        center[2],
        ...recipe.gridExtentM,
        index * 5,
        1,
        frame.simulationGeneration,
        frame.steps.at(-1)?.fixedStep ?? frame.baseStep,
        frame.deviceGeneration,
        frame.instance.bodyGeneration,
        frame.instance.recipe.foamEnabled ? 1 : 0,
        0,
        ...recipe.resolution,
        repeatMask,
        linearMask,
        frame.previousFrameCenterM[0],
        frame.previousFrameCenterM[2],
        ...recipe.gridExtentM,
        frame.waveFoamCenterM[0],
        frame.waveFoamCenterM[2],
        recipe.waveFoam.gridExtentM,
        recipe.waveFoam.gridExtentM,
        frame.previousWaveFoamCenterM[0],
        frame.previousWaveFoamCenterM[2],
        recipe.waveFoam.gridExtentM,
        recipe.waveFoam.gridExtentM,
        recipe.waveFoam.resolution,
        recipe.waveFoam.resolution,
        0,
        0,
      ],
      bodyIndex * STRIDE_FLOATS,
    );
  }
  const contactFoam = source.render.contactFoam;
  if (publication !== undefined && contactFoam !== undefined) {
    const owners = new Set(contactFoam.owners.map(waterFluidFoamOwnerKey));
    for (const body of publication.waveBodies) {
      if (
        !owners.has(
          waterFluidFoamOwnerKey({
            worldIdentity: body.worldIdentity,
            bodyGuid: body.bodyGuid,
            bodyGeneration: body.bodyGeneration,
          }),
        )
      )
        continue;
      const key = waterBodyOwnerKey(
        body.worldIdentity,
        body.bodyGuid,
        body.bodyGeneration,
        body.zoneGeneration,
      );
      const index = publication.waveUploadPlan.bodyIndices.get(key);
      if (index === undefined) continue;
      table[index * STRIDE_FLOATS + 11] = 1;
    }
  }
}

/** Views bind the selected shared output; every encode projects its current Body rows. */
export function addWaterFluidGraph(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
): Result<WaterFluidGraphInputs, RenderGraphError> {
  const graph = context.graph;
  const viewIdentity = context.viewIdentity ?? 'camera:0';
  const cached = viewProjections.get(graph)?.get(viewIdentity);
  if (cached !== undefined) return ok(cached);
  const source = context.waterFluid;
  const initial = source?.publication;
  const read = source?.read;
  const topology = waterFluidMaterialTopology(initial);
  let fields = context.getSharedGraphTextureBinding?.('water-fluid-material-fields')?.view;
  if (fields === undefined) {
    if ((initial?.render.simulations.length ?? 0) > 0)
      return invalid('submitted shared material field producer');
    const neutral = target(graph, `water-fluid-disabled-${viewIdentity}`, CLEAR_DESCRIPTOR, [1, 1]);
    if (!neutral.ok) return neutral;
    const cleared = clearTarget(graph, 'water-fluid-disabled-clear', neutral.value);
    if (!cleared.ok) return cleared;
    const array = graph.view(neutral.value.texture, { dimension: '2d-array', arrayLayerCount: 1 });
    if (!array.ok) return array;
    fields = array.value;
  }
  const count = topology?.[0] ?? 1;
  const table = new Float32Array(count * STRIDE_FLOATS);
  let encoded: WaterFluidMaterialPublication | undefined;
  const descriptorResource = `water-fluid-material-descriptors-${viewIdentity}`;
  const descriptors = graph.createBuffer(descriptorResource, { size: table.byteLength });
  if (!descriptors.ok) return descriptors;
  const uploaded = graph.addCopyPass(`${descriptorResource}-upload`, {
    accesses: [{ resource: descriptors.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      const current = read?.(frame);
      if (
        read !== undefined &&
        (current === undefined ||
          !matchesWaterFluidMaterialTopology(topology, current) ||
          (current.waterInfo !== undefined &&
            (current.waterInfo.frameGeneration !== current.render.frameNumber ||
              current.waterInfo.deviceGeneration !== current.render.deviceGeneration ||
              current.waterInfo.viewIdentity !== viewIdentity)))
      )
        invalid('recording material publication').unwrap();
      encoded = undefined;
      table.fill(0);
      if (current !== undefined) writeBodyDescriptors(table, current);
      frame.runtime.device.queue
        .writeBuffer(resolvedGraphBuffer(resources, descriptors.value), 0, table)
        .unwrap();
      encoded = current;
    },
  });
  if (!uploaded.ok) return uploaded;
  const foam = context.getSharedGraphTextureBinding?.('water-fluid-foam')?.view;
  if (initial?.render.contactFoam !== undefined && foam === undefined)
    return invalid('submitted shared FoamRT producer');
  const value: WaterFluidGraphInputs = {
    fields,
    descriptors: descriptors.value,
    ...(foam === undefined ? {} : { foam }),
    inspectBodyDescriptor: (owner) => {
      if (owner.viewIdentity !== undefined && owner.viewIdentity !== viewIdentity) return undefined;
      const key = waterBodyOwnerKey(
        owner.worldIdentity,
        owner.guid,
        owner.generation,
        owner.zoneGeneration,
      );
      const bodyIndex = encoded?.waterInfo?.waveUploadPlan.bodyIndices.get(key);
      if (bodyIndex === undefined || (bodyIndex + 1) * STRIDE_FLOATS > table.length)
        return undefined;
      return {
        viewIdentity,
        frameId: encoded?.render.frameNumber,
        deviceGeneration: encoded?.render.deviceGeneration,
        resource: descriptorResource,
        bodyIndex,
        sharedFoam: (table[bodyIndex * STRIDE_FLOATS + 11] ?? 0) > 0.5,
      };
    },
  };
  let views = viewProjections.get(graph);
  if (views === undefined) {
    views = new Map();
    viewProjections.set(graph, views);
  }
  views.set(viewIdentity, value);
  return ok(value);
}
