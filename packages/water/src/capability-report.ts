import type { PhysicsCapabilities } from '@forgeax/engine-physics';

export type WaterQuality = 'Q0' | 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type WaterConfiguration =
  | 'surface'
  | 'gpu-mesh'
  | 'surface-without-ssr'
  | 'async-buoyancy'
  | 'fluid-simulation'
  | 'advanced-simulation';
export type WaterCapabilityStatus = 'supported' | 'unsupported' | 'unavailable';
export type WaterSubfeature =
  | 'gpu-mesh'
  | 'async-buoyancy'
  | 'fluid-simulation'
  | 'advanced-shallow'
  | 'river-bake'
  | 'ocean-fft';
export type WaterCapabilitySelection =
  | Readonly<{ quality: 'Q0' | 'Q1' | 'Q3'; configuration: 'surface'; subfeature?: never }>
  | Readonly<{ quality: 'Q2'; configuration: 'surface-without-ssr'; subfeature?: never }>
  | Readonly<{ quality: 'Q4'; configuration: null; subfeature?: never }>
  | Readonly<{ quality: null; configuration: 'gpu-mesh'; subfeature: 'gpu-mesh' }>
  | Readonly<{ quality: null; configuration: 'async-buoyancy'; subfeature: 'async-buoyancy' }>
  | Readonly<{ quality: null; configuration: 'fluid-simulation'; subfeature: 'fluid-simulation' }>
  | Readonly<{
      quality: null;
      configuration: 'advanced-simulation';
      subfeature: 'advanced-shallow' | 'river-bake' | 'ocean-fft';
    }>;
export interface WaterDeviceFacts {
  readonly version: 2;
  readonly compute: WaterCapabilityStatus;
  readonly storageBuffer: WaterCapabilityStatus;
  readonly indirectDraw: WaterCapabilityStatus;
  readonly formats: Readonly<{
    rgba16float: Readonly<{
      renderSample: WaterCapabilityStatus;
      arrayRenderSample: WaterCapabilityStatus;
      storageSample: WaterCapabilityStatus;
    }>;
    rgba32float: Readonly<{
      renderSample: WaterCapabilityStatus;
      arrayRenderSample: WaterCapabilityStatus;
      storageSample: WaterCapabilityStatus;
    }>;
    depth32float: Readonly<{ renderSample: WaterCapabilityStatus }>;
    rg16float: Readonly<{ renderSample: WaterCapabilityStatus }>;
  }>;
  readonly limits: Readonly<Record<string, number>>;
}

export interface WaterRendererFacts {
  readonly version: 2;
  readonly deviceGeneration: number;
  readonly frameId: number;
  readonly ready: boolean;
  readonly noWaterSceneCopy: boolean;
  readonly singleLayerOptics: boolean;
  readonly waterSurfaceDepthNormalVelocity: boolean;
  readonly waterSurfaceSsr: boolean;
  readonly captureSky: boolean;
  readonly captureReflection?: boolean;
  readonly skyReflection?: boolean;
  readonly underwater: Readonly<{
    available: boolean;
    active: boolean;
    execution: 'executed' | 'inactive';
  }>;
  readonly waterInfo: Readonly<{
    available: boolean;
    active: boolean;
    execution: 'produced' | 'retained' | 'inactive';
  }>;
  readonly gpuMesh: boolean;
  readonly cpuMesh: boolean | 'unavailable';
  readonly deferredLighting: boolean;
  readonly fluidSimulation?: boolean;
  readonly advancedShallow?: boolean;
  readonly oceanFft?: boolean;
  readonly riverBake?: boolean | 'unavailable';
  readonly appearanceAdapter?: Readonly<{
    kind: 'flat-transparent' | 'cpu-field';
    composed: boolean;
    sourceVersion: string;
  }>;
  readonly passes: readonly string[];
}

export type WaterCapabilityRequest = WaterCapabilitySelection & {
  readonly parameterIdentity: string;
  readonly format: 'rgba16float' | 'rgba32float';
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly reflectionMode?: 'ssr' | 'capture-only' | 'disabled';
  readonly solverExecution?: 'inline-solver' | 'worker-solver';
  readonly device: WaterDeviceFacts;
  readonly renderer: WaterRendererFacts;
  readonly physics: PhysicsCapabilities;
};

export interface WaterCapabilityReport {
  readonly version: 2;
  readonly quality: WaterQuality | null;
  readonly configuration: WaterConfiguration | null;
  readonly subfeature: WaterSubfeature | null;
  readonly parameterIdentity: string;
  readonly implementation: WaterCapabilityStatus;
  readonly requirements: readonly Readonly<{
    owner: 'rhi' | 'render' | 'physics' | 'water';
    name: string;
    status: WaterCapabilityStatus;
  }>[];
  readonly source: Readonly<{ deviceGeneration: number; frameId: number }>;
  readonly activity: Readonly<Pick<WaterRendererFacts, 'underwater' | 'waterInfo'>>;
}

/** No backend-name inference, cross-configuration evidence reuse, or implicit mechanism fallback. */
export function createWaterCapabilityReport(input: WaterCapabilityRequest): WaterCapabilityReport {
  const requirements: {
    owner: 'rhi' | 'render' | 'physics' | 'water';
    name: string;
    status: WaterCapabilityStatus;
  }[] = [];
  const add = (
    owner: (typeof requirements)[number]['owner'],
    name: string,
    value: boolean | WaterCapabilityStatus,
  ) =>
    requirements.push({
      owner,
      name,
      status: typeof value === 'boolean' ? (value ? 'supported' : 'unsupported') : value,
    });
  const qualityConfiguration = validWaterQualityConfiguration(input);
  add('water', 'quality-configuration', qualityConfiguration);
  add('water', 'parameter-identity', input.parameterIdentity.length > 0);
  if (input.quality === 'Q4') {
    const adapter = input.renderer.appearanceAdapter;
    add(
      'render',
      'appearance-adapter',
      adapter?.composed === true && adapter.sourceVersion.length > 0 && input.renderer.ready,
    );
    return {
      version: 2,
      quality: input.quality,
      configuration: input.configuration,
      subfeature: null,
      parameterIdentity: input.parameterIdentity,
      implementation: requirements.every((row) => row.status === 'supported')
        ? 'supported'
        : 'unsupported',
      requirements,
      source: {
        deviceGeneration: input.renderer.deviceGeneration,
        frameId: input.renderer.frameId,
      },
      activity: { underwater: input.renderer.underwater, waterInfo: input.renderer.waterInfo },
    };
  }
  appendWaterRenderRequirements(input, add);
  appendWaterQualityRequirements(input, add);
  appendWaterBranchRequirements(input, add);
  const implementation = requirements.some((row) => row.status === 'unsupported')
    ? 'unsupported'
    : requirements.some((row) => row.status === 'unavailable')
      ? 'unavailable'
      : 'supported';
  return {
    version: 2,
    quality: input.quality,
    configuration: input.configuration,
    subfeature: input.subfeature ?? null,
    parameterIdentity: input.parameterIdentity,
    implementation,
    requirements,
    source: { deviceGeneration: input.renderer.deviceGeneration, frameId: input.renderer.frameId },
    activity: { underwater: input.renderer.underwater, waterInfo: input.renderer.waterInfo },
  };
}

type AppendWaterRequirement = (
  owner: WaterCapabilityReport['requirements'][number]['owner'],
  name: string,
  value: boolean | WaterCapabilityStatus,
) => void;
function appendWaterRenderRequirements(
  input: WaterCapabilityRequest,
  add: AppendWaterRequirement,
): void {
  const dimensions = [input.width, input.height, input.layers];
  add(
    'rhi',
    'texture-limits',
    dimensions.every((value) => Number.isSafeInteger(value) && value > 0) &&
      input.width <= (input.device.limits.maxTextureDimension2D ?? 0) &&
      input.height <= (input.device.limits.maxTextureDimension2D ?? 0) &&
      input.layers <= (input.device.limits.maxTextureArrayLayers ?? 0),
  );
  add(
    'rhi',
    `${input.format}-array-render-sample`,
    input.device.formats[input.format].arrayRenderSample,
  );
  // The current WaterInfo producer owns a compute finalize path, including CPU WaterMesh modes.
  add('rhi', 'water-info-compute', input.device.compute);
  add('rhi', 'water-info-storage', input.device.formats[input.format].storageSample);
  add('rhi', 'sampled-depth', input.device.formats.depth32float.renderSample);
  add('rhi', 'velocity-attachment', input.device.formats.rg16float.renderSample);
  for (const name of [
    'ready',
    'noWaterSceneCopy',
    'singleLayerOptics',
    'waterSurfaceDepthNormalVelocity',
    'captureSky',
    'deferredLighting',
  ] as const)
    add('render', name, input.renderer[name]);
  for (const name of ['underwater', 'waterInfo'] as const)
    add('render', `${name}-available`, input.renderer[name].available);
  if (input.quality !== 'Q2') add('render', 'waterSurfaceSsr', input.renderer.waterSurfaceSsr);
  if (input.quality === 'Q3')
    add('render', 'cpu-mesh', input.renderer.gpuMesh ? false : input.renderer.cpuMesh);
}
function appendWaterQualityRequirements(
  input: WaterCapabilityRequest,
  add: AppendWaterRequirement,
): void {
  if (input.quality === 'Q2') {
    add(
      'water',
      'explicit-reflection-mode',
      input.reflectionMode === 'capture-only' || input.reflectionMode === 'disabled',
    );
    if (input.reflectionMode === 'capture-only')
      add('render', 'capture-reflection', input.renderer.captureReflection === true);
  }
}
function appendWaterBranchRequirements(
  input: WaterCapabilityRequest,
  add: AppendWaterRequirement,
): void {
  if (input.configuration === 'gpu-mesh') {
    add('rhi', 'gpu-mesh-compute', input.device.compute);
    add('rhi', 'gpu-mesh-storage', input.device.storageBuffer);
    add('rhi', 'gpu-mesh-indirect', input.device.indirectDraw);
    add('render', 'gpu-mesh', input.renderer.gpuMesh);
  }
  if (input.configuration === 'async-buoyancy') {
    add('physics', 'solver-participant', input.physics.solverParticipant);
    add('physics', 'solver-clock', input.physics.solverClock);
    add('physics', 'worker-solver', input.solverExecution === 'worker-solver');
  }
  if (input.configuration === 'fluid-simulation')
    add('render', 'fluid-simulation', input.renderer.fluidSimulation === true);
  if (input.configuration === 'advanced-simulation') {
    const enabled =
      input.subfeature === 'advanced-shallow'
        ? input.renderer.advancedShallow
        : input.subfeature === 'river-bake'
          ? input.renderer.riverBake
          : input.renderer.oceanFft;
    add('render', input.subfeature, enabled === 'unavailable' ? enabled : enabled === true);
  }
  for (const name of ['pointForce', 'bodyDynamics', 'sphereSweepAll', 'sensorOverlap'] as const)
    add('physics', name, input.physics[name]);
}

function validWaterQualityConfiguration(input: WaterCapabilityRequest): boolean {
  const branches = {
    'gpu-mesh': ['gpu-mesh'],
    'async-buoyancy': ['async-buoyancy'],
    'fluid-simulation': ['fluid-simulation'],
    'advanced-simulation': ['advanced-shallow', 'river-bake', 'ocean-fft'],
  } as const;
  return input.quality === null
    ? input.configuration !== null &&
        input.configuration in branches &&
        input.subfeature !== undefined &&
        (branches[input.configuration as keyof typeof branches] as readonly string[]).includes(
          input.subfeature,
        )
    : input.subfeature === undefined &&
        (input.quality === 'Q2'
          ? input.configuration === 'surface-without-ssr'
          : input.quality === 'Q4'
            ? input.configuration === null
            : input.configuration === 'surface');
}
