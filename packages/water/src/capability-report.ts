import type { PhysicsCapabilities } from '@forgeax/engine-physics';

export type WaterQuality = 'Q0' | 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type WaterUeConfiguration =
  | 'UE-R0'
  | 'UE-R1'
  | 'UE-R2'
  | 'UE-R3'
  | 'UE-R4'
  | 'UE-R5'
  | 'UE-R6'
  | 'UE-R7';
export type WaterFidelity = 'faithful' | 'appearance-only' | 'unsupported';
export type WaterComparison = 'matched' | 'deviation' | 'unvalidated' | 'unsupported';
export type WaterCapabilityStatus = 'supported' | 'unsupported' | 'unvalidated';
export type WaterSubfeature =
  | 'gpu-mesh'
  | 'async-buoyancy'
  | 'fluid-simulation'
  | 'advanced-shallow'
  | 'river-bake'
  | 'ocean-fft';
export type WaterCapabilitySelection =
  | Readonly<{ quality: 'Q0' | 'Q1' | 'Q3'; configuration: 'UE-R0'; subfeature?: never }>
  | Readonly<{ quality: 'Q2'; configuration: 'UE-R2'; subfeature?: never }>
  | Readonly<{ quality: 'Q4'; configuration: null; subfeature?: never }>
  | Readonly<{ quality: null; configuration: 'UE-R1'; subfeature: 'gpu-mesh' }>
  | Readonly<{ quality: null; configuration: 'UE-R5'; subfeature: 'async-buoyancy' }>
  | Readonly<{ quality: null; configuration: 'UE-R6'; subfeature: 'fluid-simulation' }>
  | Readonly<{
      quality: null;
      configuration: 'UE-R7';
      subfeature: 'advanced-shallow' | 'river-bake' | 'ocean-fft';
    }>
  | Readonly<{ quality: null; configuration: 'UE-R3' | 'UE-R4'; subfeature?: never }>;
export type WaterValidationId =
  `V-${'01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12' | '13' | '14' | '15' | '16'}`;

export interface WaterDeviceFacts {
  readonly version: 1;
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
  readonly version: 1;
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
  readonly cpuMesh: boolean | 'unvalidated';
  readonly deferredLighting: boolean;
  readonly fluidSimulation?: boolean;
  readonly advancedShallow?: boolean;
  readonly oceanFft?: boolean;
  readonly riverBake?: boolean | 'unvalidated';
  readonly appearanceAdapter?: Readonly<{
    kind: 'flat-transparent' | 'cpu-field';
    composed: boolean;
    sourceVersion: string;
  }>;
  readonly passes: readonly string[];
}

export interface WaterValidationEvidence {
  readonly id: WaterValidationId;
  readonly configuration: WaterUeConfiguration;
  readonly subfeature?: WaterSubfeature;
  /** Identifies the complete authored inputs, including Q1's matching UE parameters. */
  readonly parameterIdentity: string;
  readonly comparison: WaterComparison;
  readonly artifact: string;
}

export type WaterCapabilityRequest = WaterCapabilitySelection & {
  readonly parameterIdentity: string;
  readonly format: 'rgba16float' | 'rgba32float';
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly basicDiOrBeachFoam: boolean;
  readonly reflectionMode?: 'ssr' | 'capture-only' | 'disabled';
  readonly solverExecution?: 'inline-solver' | 'worker-solver';
  readonly device: WaterDeviceFacts;
  readonly renderer: WaterRendererFacts;
  readonly physics: PhysicsCapabilities;
  readonly evidence: readonly WaterValidationEvidence[];
};

export interface WaterCapabilityReport {
  readonly version: 1;
  readonly quality: WaterQuality | null;
  readonly configuration: WaterUeConfiguration | null;
  readonly subfeature: WaterSubfeature | null;
  readonly parameterIdentity: string;
  readonly implementation: WaterCapabilityStatus;
  readonly fidelity: WaterFidelity;
  readonly comparison: WaterComparison;
  readonly requirements: readonly Readonly<{
    owner: 'rhi' | 'render' | 'physics' | 'water';
    name: string;
    status: WaterCapabilityStatus;
  }>[];
  readonly validation: readonly Readonly<{
    id: WaterValidationId;
    comparison: WaterComparison;
    artifact?: string;
  }>[];
  readonly source: Readonly<{ deviceGeneration: number; frameId: number }>;
  readonly activity: Readonly<Pick<WaterRendererFacts, 'underwater' | 'waterInfo'>>;
}

// V-06 is deferred optional WaterEditor tooling, outside the R0 runtime contract.
const CORE_GATES: readonly WaterValidationId[] = [
  'V-01',
  'V-02',
  'V-03',
  'V-04',
  'V-05',
  'V-07',
  'V-08',
  'V-09',
  'V-10',
  'V-11',
  'V-15',
];

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
  const branchSupported = input.configuration !== 'UE-R3' && input.configuration !== 'UE-R4';
  const qualityConfiguration = validWaterQualityConfiguration(input);
  add('water', 'quality-configuration', branchSupported && qualityConfiguration);
  add('water', 'parameter-identity', input.parameterIdentity.length > 0);
  if (input.quality === 'Q4') {
    const adapter = input.renderer.appearanceAdapter;
    add(
      'render',
      'appearance-adapter',
      adapter?.composed === true && adapter.sourceVersion.length > 0 && input.renderer.ready,
    );
    return {
      version: 1,
      quality: input.quality,
      configuration: input.configuration,
      subfeature: null,
      parameterIdentity: input.parameterIdentity,
      implementation: requirements.every((row) => row.status === 'supported')
        ? 'supported'
        : 'unsupported',
      fidelity: requirements.every((row) => row.status === 'supported')
        ? 'appearance-only'
        : 'unsupported',
      comparison: requirements.every((row) => row.status === 'supported')
        ? 'deviation'
        : 'unsupported',
      requirements,
      validation: [],
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
  const ids: WaterValidationId[] = waterCapabilityValidationIds(input);
  const validation = ids.map((id) => {
    const evidence = input.evidence.filter(
      (row) =>
        row.id === id &&
        row.configuration === input.configuration &&
        row.subfeature === input.subfeature &&
        row.parameterIdentity === input.parameterIdentity,
    );
    const [candidate] = evidence;
    const row =
      evidence.length === 1 && candidate && candidate.artifact.length > 0 ? candidate : undefined;
    return {
      id,
      comparison: row?.comparison ?? ('unvalidated' as WaterComparison),
      ...(row ? { artifact: row.artifact } : {}),
    };
  });
  const implementation = requirements.some((row) => row.status === 'unsupported')
    ? 'unsupported'
    : requirements.some((row) => row.status === 'unvalidated')
      ? 'unvalidated'
      : 'supported';
  const comparison: WaterComparison =
    implementation === 'unsupported'
      ? 'unsupported'
      : validation.some((row) => row.comparison === 'unsupported')
        ? 'unsupported'
        : validation.some((row) => row.comparison === 'deviation')
          ? 'deviation'
          : validation.every((row) => row.comparison === 'matched')
            ? 'matched'
            : 'unvalidated';
  return {
    version: 1,
    quality: input.quality,
    configuration: input.configuration,
    subfeature: input.subfeature ?? null,
    parameterIdentity: input.parameterIdentity,
    implementation,
    fidelity:
      implementation === 'unsupported'
        ? 'unsupported'
        : implementation === 'supported' && comparison === 'matched'
          ? 'faithful'
          : 'appearance-only',
    comparison,
    requirements,
    validation,
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
      'explicit-R2-reflection-mode',
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
  if (input.configuration === 'UE-R1') {
    add('rhi', 'gpu-mesh-compute', input.device.compute);
    add('rhi', 'gpu-mesh-storage', input.device.storageBuffer);
    add('rhi', 'gpu-mesh-indirect', input.device.indirectDraw);
    add('render', 'gpu-mesh', input.renderer.gpuMesh);
  }
  if (input.configuration === 'UE-R5') {
    add('physics', 'solver-participant', input.physics.solverParticipant);
    add('physics', 'solver-clock', input.physics.solverClock);
    add('physics', 'worker-solver', input.solverExecution === 'worker-solver');
  }
  if (input.configuration === 'UE-R6')
    add('render', 'fluid-simulation', input.renderer.fluidSimulation === true);
  if (input.configuration === 'UE-R7') {
    const enabled =
      input.subfeature === 'advanced-shallow'
        ? input.renderer.advancedShallow
        : input.subfeature === 'river-bake'
          ? input.renderer.riverBake
          : input.renderer.oceanFft;
    add('render', input.subfeature, enabled === 'unvalidated' ? enabled : enabled === true);
  }
  for (const name of ['pointForce', 'bodyDynamics', 'sphereSweepAll', 'sensorOverlap'] as const)
    add('physics', name, input.physics[name]);
}

function validWaterQualityConfiguration(input: WaterCapabilityRequest): boolean {
  const branches = {
    'UE-R1': ['gpu-mesh'],
    'UE-R5': ['async-buoyancy'],
    'UE-R6': ['fluid-simulation'],
    'UE-R7': ['advanced-shallow', 'river-bake', 'ocean-fft'],
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
          ? input.configuration === 'UE-R2'
          : input.quality === 'Q4'
            ? input.configuration === null
            : input.configuration === 'UE-R0');
}

function waterCapabilityValidationIds(input: WaterCapabilityRequest): WaterValidationId[] {
  return [
    ...CORE_GATES,
    ...(input.basicDiOrBeachFoam ? ['V-16' as const] : []),
    ...(input.configuration === 'UE-R6'
      ? ['V-12' as const]
      : input.configuration === 'UE-R7'
        ? [input.subfeature === 'ocean-fft' ? ('V-14' as const) : ('V-13' as const)]
        : []),
  ];
}
