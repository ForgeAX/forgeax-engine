import {
  runtimeAssetReference,
  runtimeAssetRegistry,
} from '@forgeax/engine-assets-runtime/internal';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import {
  ok,
  type TextureAsset,
  WATER_ADVANCED_DEBUG_WRITER_ORDER,
  type WaterAdvancedShallowStage,
  type WaterVisualNormalDetailFftConfig,
} from '@forgeax/engine-types';
import {
  WATER_SYSTEM_RESOURCE,
  type WaterAdvancedBody,
  type WaterAdvancedError,
  type WaterAdvancedFrame,
  type WaterAdvancedRecipe,
  type WaterAdvancedSimulation,
  type WaterOceanPatch,
  type WaterOceanPatchFrame,
  type WaterResidualQueryReceiver,
  type WaterSystem,
  waterAdvancedOutputNames,
  waterOceanPatchOutputNames,
} from '@forgeax/engine-water';
import { viewSharedFeatureGraphPassName } from '../features/frame-plan';
import type { RenderFeaturePlanExecution } from '../features/host';
import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
} from '../features/plan';
import { captureFeatureSourceAssetVersion } from '../features/source';
import { isRenderFeatureTargetHandle, type RenderFeatureTargetHandle } from '../features/targets';
import type {
  RenderFeature,
  RenderFeatureExtractContext,
  RenderFeatureProfileGraphPass,
  RenderFeatureSubmission,
} from '../features/types';
import type { SdfSceneFieldPayload } from '../raytracing/sdf-query';
import { identityOrdinal } from '../scene/generational-weak-map';
import {
  type AdvancedCollisionCapture,
  AdvancedCollisionMeshOwner,
  type AdvancedCollisionSnapshot,
  advancedCollisionHistory,
  captureAdvancedCollisions,
  captureDispersiveCollisions,
} from './advanced-collisions';
import { advancedFftShader } from './advanced-fft-shader';
import {
  buffer,
  compute,
  initializedBuffer,
  program,
  read,
  storage,
  texture,
  view,
  write,
} from './advanced-graph';
import { ADVANCED_GRID_VERTEX_STRIDE } from './advanced-grid-mesh';
import { advancedShallowShader } from './advanced-shallow-shader';
import {
  appendDispersiveOcean,
  dispersiveExternalSources,
  dispersiveQueryPrefix,
  dispersiveSourceBudget,
  dispersiveSourceIdentity,
  dispersiveSourceRequiresReseed,
  dispersiveStateResources,
} from './dispersive-ocean';
import { DISPERSIVE_QUERY_SHADER } from './dispersive-ocean-shader';
import { waterInfoFramePublicationForRenderer } from './water-info-feature';

export const WATER_ADVANCED_FEATURE_IDENTITY = 'water-advanced-producer';
export interface WaterAdvancedShallowFoamSource {
  readonly worldIdentity: string;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly recipeGuid: string;
  readonly simulationGeneration: number;
  readonly viewIdentity: string;
}

/** Only a current publish intent may feed another persistent history owner. */
export function waterAdvancedShallowFoamTargets(
  source: WaterAdvancedShallowFoamSource,
  executions: readonly RenderFeaturePlanExecution[],
) {
  const names = waterAdvancedOutputNames(source.recipeGuid, source.bodyGuid, source.worldIdentity);
  const publications = executions
    .filter(
      (execution) =>
        execution.featureIdentity === WATER_ADVANCED_FEATURE_IDENTITY &&
        execution.scope === `view:${source.viewIdentity}`,
    )
    .flatMap((execution) => execution.passes)
    .filter((pass) => pass.name === `${names.prefix}-publish-shallow` && pass.enabled !== false);
  if (publications.length !== 1) return;
  const targets = publications[0]?.resolvedGpuCompute?.storageTargets ?? [];
  const target = (name: string) =>
    targets.find(
      (value): value is RenderFeatureTargetHandle =>
        isRenderFeatureTargetHandle(value) &&
        value.name === name &&
        value.allocationKey === `${name}-b${source.bodyGeneration}-g${source.simulationGeneration}`,
    );
  const foam = target(names.foam);
  const mapping = target(names.mapping);
  return foam === undefined || mapping === undefined ? undefined : { foam, mapping };
}
interface Row extends PendingShallow {
  readonly frame: WaterAdvancedFrame;
  readonly collisions: AdvancedCollisionCapture;
}
interface PendingShallow {
  readonly key: string;
  readonly worldIdentity: string;
  readonly recipe: WaterAdvancedSimulation['recipe'];
  readonly body: WaterAdvancedBody;
  readonly generation: number;
  readonly active: boolean;
  readonly viewIdentity: string;
}
interface OceanRow {
  readonly key: string;
  readonly worldIdentity: string;
  readonly recipe: WaterOceanPatch['recipe'];
  readonly generation: number;
  readonly active: boolean;
  readonly viewIdentity: string;
  readonly frame?: WaterOceanPatchFrame;
  readonly size: number;
  readonly allocation: boolean;
  readonly noise?: Readonly<{ revision: number; asset: TextureAsset }>;
  readonly visualChild?: Readonly<{ revision: number; noiseRevision: number | null }>;
  readonly collisions?: AdvancedCollisionCapture;
}
interface AdvancedFrame {
  readonly sourceFrameNumber: number;
  readonly rows: readonly Row[];
  readonly pending: readonly PendingShallow[];
  readonly oceans: readonly OceanRow[];
}
interface SourceFrame {
  readonly shallow: ReadonlyMap<string, WaterAdvancedSimulation>;
  readonly oceans: ReadonlyMap<
    string,
    Readonly<{
      owner: WaterOceanPatch;
      world: RenderFeatureExtractContext['world'];
    }>
  >;
  readonly sdfFieldInitializations: WeakMap<
    AdvancedCollisionSnapshot,
    SdfSceneFieldPayload['initialization']
  >;
}
interface SubmittedOceanProfileFacts {
  readonly owner: WaterOceanPatch;
  readonly world: RenderFeatureExtractContext['world'];
  readonly recipe: WaterOceanPatch['recipe'];
  readonly worldIdentity: string;
  readonly generation: number;
  readonly viewIdentity: string;
  readonly size: number;
  readonly deviceGeneration: number;
}
interface AdvancedFeedback {
  readonly kind: 'water-advanced-submission';
  readonly sourceFrameNumber: number;
  readonly deviceGeneration: number;
  readonly localReadbacks: boolean;
  readonly shallow: readonly Readonly<{
    key: string;
    generation: number;
    sequence: number;
    error?: WaterAdvancedError;
  }>[];
  readonly oceans: readonly Readonly<{
    key: string;
    generation: number;
    sequence: number;
    error?: WaterAdvancedError;
    visualError?: WaterAdvancedError;
    size: number;
    allocation: boolean;
    reset: boolean;
    captureStages: boolean;
    requiredPasses?: readonly Readonly<{ name: string; kind: 'compute' | 'copy' }>[];
  }>[];
}
type SubmittedSequence =
  | Readonly<{
      kind: 'shallow';
      generation: number;
      sequence: number;
      timeSeconds: number;
      collisions: AdvancedCollisionSnapshot;
    }>
  | Readonly<{
      kind: 'ocean';
      generation: number;
      deviceGeneration: number;
      sequence: number;
      timeSeconds: number;
      profile?: SubmittedOceanProfileFacts;
      nativeSourceStep: number | undefined;
      sourceIdentity?: string;
      collisions?: AdvancedCollisionSnapshot;
      sourceRevision: number;
      waveImpulseSequence?: number;
      captureRequest: number;
      querySources?: readonly ReceiverSourceState[];
    }>;
interface ReceiverSourceState {
  readonly receiver: WaterResidualQueryReceiver;
  readonly sourceIdentity: string;
  readonly hasHistory: boolean;
}
type InitializedOcean = Readonly<{
  generation: number;
  size: number;
  querySources?: readonly ReceiverSourceState[];
  visualOutput?: Readonly<{
    generation: number;
    revision: number;
    noiseRevision: number | null;
    size: number;
    deviceGeneration: number;
  }>;
}>;

function receiverSourceStates(
  row: OceanRow,
  previous: readonly ReceiverSourceState[] = [],
): ReceiverSourceState[] {
  if (row.collisions?.kind !== 'ready') return [];
  const collisions = row.collisions.value;
  return (row.frame?.queryReceivers ?? []).map((receiver) => {
    const source = dispersiveExternalSources(collisions, receiver);
    const prior = previous.find(
      (value) =>
        value.receiver.entity === receiver.entity &&
        value.receiver.generation === receiver.generation,
    );
    return {
      receiver,
      sourceIdentity: dispersiveSourceIdentity(source),
      hasHistory:
        source.roster.length > 0 ||
        prior?.hasHistory === true ||
        (row.frame?.waveImpulses?.some(
          (impulse) =>
            impulse.sourceReceiver?.entity !== receiver.entity ||
            impulse.sourceReceiver?.generation !== receiver.generation,
        ) ??
          false),
    };
  });
}

function acceptedQueryReceiversMatch(
  submitted: readonly ReceiverSourceState[] | undefined,
  current: readonly WaterResidualQueryReceiver[],
): boolean {
  return (
    submitted !== undefined &&
    submitted.length === current.length &&
    submitted.length <= 32 &&
    submitted.every(
      (row, index) =>
        row.receiver.entity === current[index]?.entity &&
        row.receiver.generation === current[index]?.generation,
    )
  );
}

function waterOceanPatchQueryPassNames(recipeGuid: string, worldIdentity: string) {
  const prefix = `${waterOceanPatchOutputNames(recipeGuid, worldIdentity).prefix}-query`;
  return Object.freeze({
    prefix,
    receiver: (index: number) => `${prefix}-receiver-${index}`,
    sample: `${prefix}-sample`,
    readback: `${prefix}-readback`,
  });
}
type OceanPassPlan = Readonly<{
  row: OceanRow;
  requiredPasses: NonNullable<AdvancedFeedback['oceans'][number]['requiredPasses']>;
  deviceGeneration: number;
}>;
type AdvancedFormatSupport = (
  format: 'rgba16float' | 'rgba32float',
  dimensions: readonly number[],
) => boolean;
type PlannedAdvancedRow = Readonly<{
  work: RenderFeatureWork;
  feedback?: AdvancedFeedback['shallow'][number];
}>;
const STAGES: readonly WaterAdvancedShallowStage[] = [
  'Create Vertices',
  'Create Triangles',
  'Init',
  'Init Foam',
  'Pre Sim',
  'River Source and Sink',
  'Distribute Overlap Volume',
  'Extrapolate Velocities',
  'Advect Water',
  'Extrapolate Height',
  'Update Velocity',
  'Update Depth',
  'Post Sim',
  'Compute Normals',
  'Prep Debug',
  'Prep Debug Beauty',
  'Foam',
  'Live Sim - Blur Normals',
];
interface OutputHistory {
  readonly current: string;
  readonly previous: string;
  readonly format: 'rgba16float' | 'rgba32float';
  readonly width: number;
  readonly height: number;
}
function copyOutputHistory(
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
  prefix: string,
  outputs: readonly OutputHistory[],
): void {
  const name = `${prefix}-copy-history`,
    programName = `${name}-program`;
  const source =
    outputs
      .map(
        (output, index) =>
          `@group(0) @binding(${index * 2}) var input${index}:texture_2d<f32>;
@group(0) @binding(${index * 2 + 1}) var output${index}:texture_storage_2d<${output.format},write>;`,
      )
      .join('\n') +
    `
@compute @workgroup_size(8,8) fn copyHistory(@builtin(global_invocation_id) id:vec3<u32>){
${outputs.map((_output, index) => `if(all(id.xy<textureDimensions(output${index}))){textureStore(output${index},vec2<i32>(id.xy),textureLoad(input${index},vec2<i32>(id.xy),0));}`).join('\n')}
}`;
  resources.push(
    program(
      programName,
      source,
      'copyHistory',
      outputs.flatMap((output, index) => [read(index * 2), write(index * 2 + 1, output.format)]),
    ),
  );
  compute(
    resources,
    passes,
    name,
    programName,
    'copyHistory',
    outputs.flatMap((output, index) => [
      { binding: index * 2, resource: `${output.current}-view` },
      { binding: index * 2 + 1, resource: `${output.previous}-view` },
    ]),
    Math.max(...outputs.map((output) => output.width)),
    Math.max(...outputs.map((output) => output.height)),
  );
}
function shallowOutputHistory(row: PendingShallow): readonly OutputHistory[] {
  const config = row.recipe.asset.shallowStageConfig,
    [width, height] = config.gridResolution;
  const names = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity);
  return [
    { current: names.grid, previous: names.previousGrid, format: 'rgba16float', width, height },
    {
      current: names.normal,
      previous: names.previousNormal,
      format: config.normalRtFormat,
      width,
      height,
    },
    {
      current: names.mapping,
      previous: names.previousMapping,
      format: 'rgba32float',
      width: 2,
      height: 1,
    },
  ];
}
function parameters(
  frame: WaterAdvancedFrame,
  stage: number,
  dt: number,
  collisionCount = 0,
  collisionDeltaSeconds = 0,
  previousTransform = frame.previousTransform,
): Float32Array {
  const config = frame.recipe.asset.shallowStageConfig;
  const info = frame.waterInfo;
  const out = new Float32Array(25 * 4);
  const row = (index: number, values: readonly number[]) => out.set(values, index * 4);
  row(0, [stage, ...config.gridResolution, dt]);
  row(1, [...frame.transform.centerXZ, ...frame.transform.extentM]);
  row(2, [frame.transform.yawRadians, config.baseHeightM, config.initialDepthM, config.dryDepthM]);
  row(3, [
    ...previousTransform.centerXZ,
    previousTransform.yawRadians,
    Number(config.stageProfile === 'river-shallow/2'),
  ]);
  if (info.status === 'ready') {
    row(4, [...info.centerXZ, ...info.extentM]);
    row(5, [
      info.waterHeightRangeM[0],
      info.waterHeightRangeM[1],
      info.groundHeightRangeM[0],
      info.slice,
    ]);
  }
  row(6, [
    frame.impacts.length,
    frame.sourceSinks.filter((source) => source.enabled).length,
    config.gravityMPerSec2,
    config.frictionPerSecond,
  ]);
  row(7, [
    Number(config.advection === 'cubic'),
    config.advectionVelocityMultiplier,
    Number(config.complexUpwind),
    Number(config.depthLimiter),
  ]);
  row(8, [
    config.overlapRadiusCells,
    config.overlapVolumeMultiplier,
    config.integrationDepthMax,
    config.collisionFalloff,
  ]);
  row(9, [
    config.velocityDissipationPerSecond,
    config.maximumVelocityMPerSec,
    config.thinFilmDepthM,
    config.thinFilmDampingPerSecond,
  ]);
  row(10, [
    config.postSimVelocityBlurRadiusCells,
    config.normalSmoothingRadiusCells,
    config.startFadeSeconds,
    frame.secondsUntilDestroyed,
  ]);
  row(11, [
    Number(config.upwind),
    config.maximumDepthM,
    Number(config.keepWaterDepthInsideColliders),
    Number(config.edgeDissipationEnabled),
  ]);
  row(12, [
    ...(frame.recipe.asset.riverBakeConfig?.bakeExtentM ?? frame.transform.extentM),
    frame.transform.heightOriginM,
    Number(frame.reset),
  ]);
  row(13, [frame.deltaSeconds, 1, 1, -0.01]);
  row(14, [
    config.foam.advectionVelocityMultiplier,
    config.foam.dissipationRatePerSecond,
    config.foam.dissipationSubtractionPerSecond,
    config.foam.minimum,
  ]);
  row(15, [config.foam.maximum, config.foam.emission.multiplier, config.foam.emission.maximum, 0]);
  for (const [index, criterion] of [
    config.foam.emission.vorticity,
    config.foam.emission.curvature,
    config.foam.emission.speed,
    config.foam.emission.depthDifference,
  ].entries())
    row(16 + index, [...criterion.range, criterion.multiplier, 0]);
  row(20, [
    ...config.foam.emission.depthRestrictionRangeM,
    ...config.foam.emission.speedRestrictionRangeMPerSec,
  ]);
  row(21, [
    ...WATER_ADVANCED_DEBUG_WRITER_ORDER[config.stageProfile].map((kind) =>
      Number(config.debug.writers.some((writer) => writer.kind === kind)),
    ),
    Number(config.debug.foamEmission),
  ]);
  const stateWriter = config.debug.writers.find(
    (writer) => writer.kind === 'height-collider-speed',
  );
  row(22, [
    stateWriter?.kind === 'height-collider-speed' ? stateWriter.speedMultiplier : 0,
    ...config.normalFoamRange,
    info.status === 'ready' ? info.maxVelocityMPerSec : 0,
  ]);
  const rigid = config.rigidMeshCollisions;
  if (rigid.kind !== 'disabled') {
    row(23, [
      collisionCount,
      Number(rigid.accurate),
      rigid.collisionOffsetCells,
      rigid.softCollisionFalloffM,
    ]);
    row(24, [
      Number(rigid.kind === 'distance-field'),
      collisionDeltaSeconds,
      Number(rigid.useWaterHeightForCollision),
      0,
    ]);
  }
  return out;
}
function impulseData(frame: WaterAdvancedFrame): Float32Array {
  const data: number[] = [];
  for (const impact of frame.impacts)
    data.push(
      impact.positionM[0],
      impact.positionM[2],
      impact.radiusM,
      impact.positionM[1],
      impact.velocityMPerSec[0],
      impact.velocityMPerSec[2],
      impact.velocityMPerSec[1],
      impact.timeSeconds,
    );
  for (const source of frame.sourceSinks)
    if (source.enabled)
      data.push(
        source.positionM[0],
        source.positionM[2],
        source.yawRadians,
        Number(source.kind === 'source'),
        source.extentM[0],
        source.extentM[2],
        source.positionM[1] + source.extentM[1] * 0.5,
        source.extentM[1],
        source.velocityMPerSec[0],
        source.velocityMPerSec[2],
        Number(source.additiveVelocity),
        source.sinkDissipationPerSecond,
        source.positionM[1],
        source.velocityMPerSec[1],
        0,
        0,
      );
  return new Float32Array(data.length > 0 ? data : [0, 0, 0, 0]);
}
function shallowOutputs(
  row: PendingShallow,
  generation: number,
): RenderFeatureResourceDeclaration[] {
  const config = row.recipe.asset.shallowStageConfig;
  const [width, height] = config.gridResolution;
  const names = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity);
  return [
    ...(
      [
        [names.grid, 'rgba16float'],
        [names.normal, config.normalRtFormat],
        [names.foam, config.normalRtFormat],
        [names.previousGrid, 'rgba16float'],
        [names.previousNormal, config.normalRtFormat],
        [names.materialGrid, 'rgba32float'],
        [names.materialNormal, config.normalRtFormat],
      ] as const
    ).flatMap(([name, format]) => [
      texture(
        name,
        width,
        height * (name === names.materialGrid || name === names.materialNormal ? 2 : 1),
        format,
        `${name}-b${row.body.generation}-g${generation}`,
        true,
        true,
      ),
      view(`${name}-view`, name),
    ]),
    texture(
      names.mapping,
      2,
      2,
      'rgba32float',
      `${names.mapping}-b${row.body.generation}-g${generation}`,
      true,
      true,
    ),
    view(`${names.mapping}-view`, names.mapping),
    texture(
      names.previousMapping,
      2,
      1,
      'rgba32float',
      `${names.previousMapping}-b${row.body.generation}-g${generation}`,
      true,
    ),
    view(`${names.previousMapping}-view`, names.previousMapping),
  ];
}
function shallowStateResources(
  row: PendingShallow,
  generation: number,
  sides: readonly ('a' | 'b' | 'state')[] = ['a', 'b', 'state'],
): RenderFeatureResourceDeclaration[] {
  const config = row.recipe.asset.shallowStageConfig;
  const [width, height] = config.gridResolution;
  const prefix = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity).prefix;
  return (['grid', 'field', 'foam', 'normals'] as const).flatMap((kind) =>
    sides.flatMap((side) => {
      const name = `${prefix}-${kind}-${side}`;
      return [
        texture(
          name,
          width,
          height,
          kind === 'normals' ? config.normalRtFormat : 'rgba32float',
          `${name}-b${row.body.generation}-g${generation}`,
          side === 'state',
        ),
        view(`${name}-view`, name),
      ];
    }),
  );
}
function publishOutputHistory(
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
  prefix: string,
  outputs: readonly (OutputHistory & { readonly target: string; readonly worldHeight?: boolean })[],
  reset: boolean,
  heightOriginM = 0,
): void {
  const name = `${prefix}-publish-material-history`,
    paramsBinding = outputs.length * 3;
  resources.push(
    program(
      `${name}-program`,
      `
${outputs
  .map(
    (output, index) => `@group(0) @binding(${index * 3}) var current${index}:texture_2d<f32>;
@group(0) @binding(${index * 3 + 1}) var previous${index}:texture_2d<f32>;
@group(0) @binding(${index * 3 + 2}) var output${index}:texture_storage_2d<${output.format},write>;`,
  )
  .join('\n')}
@group(0) @binding(${paramsBinding}) var<storage,read> params:vec4<f32>;
@compute @workgroup_size(8,8) fn publishMaterial(@builtin(global_invocation_id) id:vec3<u32>){
  let index=vec2<i32>(id.xy);
${outputs
  .map(
    (output, index) => `if(all(id.xy<textureDimensions(current${index}))){
  var current=textureLoad(current${index},index,0);
  var previous=current;
  if(params.x<0.5){previous=textureLoad(previous${index},index,0);}
  ${output.worldHeight ? 'current.x+=params.y;previous.x+=params.y;' : ''}
  textureStore(output${index},index,current);
  textureStore(output${index},index+vec2<i32>(0,i32(textureDimensions(current${index}).y)),previous);
}`,
  )
  .join('\n')}
}`,
      'publishMaterial',
      [
        ...outputs.flatMap((output, index) => [
          read(index * 3),
          read(index * 3 + 1),
          write(index * 3 + 2, output.format),
        ]),
        storage(paramsBinding),
      ],
    ),
    buffer(`${name}-params`, new Float32Array([Number(reset), heightOriginM, 0, 0])),
  );
  compute(
    resources,
    passes,
    name,
    `${name}-program`,
    'publishMaterial',
    [
      ...outputs.flatMap((output, index) => [
        { binding: index * 3, resource: `${output.current}-view` },
        { binding: index * 3 + 1, resource: `${output.previous}-view` },
        { binding: index * 3 + 2, resource: `${output.target}-view` },
      ]),
      { binding: paramsBinding, resource: `${name}-params` },
    ],
    Math.max(...outputs.map((output) => output.width)),
    Math.max(...outputs.map((output) => output.height)),
  );
}
function publishShallowMaterial(
  row: PendingShallow,
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
  reset: boolean,
): void {
  const names = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity);
  const config = row.recipe.asset.shallowStageConfig;
  const [width, height] = config.gridResolution;
  publishOutputHistory(
    resources,
    passes,
    names.prefix,
    [
      {
        current: names.grid,
        previous: names.previousGrid,
        target: names.materialGrid,
        format: 'rgba32float',
        worldHeight: true,
        width,
        height,
      },
      {
        current: names.normal,
        previous: names.previousNormal,
        target: names.materialNormal,
        format: config.normalRtFormat,
        width,
        height,
      },
    ],
    reset,
    config.baseHeightM,
  );
}
function pendingShallowWork(
  row: PendingShallow,
  generation: number | undefined,
): RenderFeatureWork {
  const names = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity);
  const outputs = [
    names.grid,
    names.normal,
    names.materialGrid,
    names.materialNormal,
    names.foam,
    names.mapping,
    names.previousGrid,
    names.previousNormal,
    names.previousMapping,
  ];
  const resources =
    generation === undefined
      ? outputs.map((name) =>
          texture(name, 1, 1, 'rgba8unorm', `${name}-neutral-b${row.body.generation}`, true, true),
        )
      : [
          ...shallowOutputs(row, generation),
          ...shallowStateResources(row, generation, ['state']),
          ...shallowMeshResources(row, generation),
        ];
  const passes: RenderFeaturePassDeclaration[] =
    generation === undefined
      ? outputs.map((target) => ({
          kind: 'raster',
          name: `${target}-neutral`,
          colorAttachments: [{ target, loadOp: 'clear', storeOp: 'store' }],
          draws: [],
        }))
      : [];
  if (generation !== undefined) {
    const retained = ['grid', 'field', 'foam', 'normals'].map(
      (kind) => `${names.prefix}-${kind}-state`,
    );
    const retain = `${names.prefix}-retain-state`;
    resources.push(
      program(
        `${retain}-program`,
        `${retained.map((_state, index) => `@group(0) @binding(${index}) var state${index}:texture_2d<f32>;`).join('\n')}
@compute @workgroup_size(1) fn retainState(){}`,
        'retainState',
        retained.map((_state, binding) => read(binding)),
      ),
      {
        kind: 'compute-bindings',
        name: `${retain}-bindings`,
        program: `${retain}-program`,
        entries: retained.map((state, binding) => ({ binding, resource: `${state}-view` })),
      },
    );
    // The held graph retains initialized solver state without dispatching a step.
    passes.push({
      kind: 'compute',
      name: retain,
      enabled: false,
      program: `${retain}-program`,
      bindings: `${retain}-bindings`,
      dispatches: [{ kind: 'direct', entryPoint: 'retainState', workgroups: [1, 1, 1] }],
    });
    copyOutputHistory(resources, passes, names.prefix, shallowOutputHistory(row));
    const name = `${names.prefix}-hold-outputs`;
    const history = shallowOutputHistory(row).filter((output) => output.current === names.mapping);
    resources.push(
      program(
        `${name}-program`,
        `
${history
  .map(
    (output, index) => `@group(0) @binding(${index * 2}) var input${index}:texture_2d<f32>;
@group(0) @binding(${index * 2 + 1}) var output${index}:texture_storage_2d<${output.format},write>;`,
  )
  .join('\n')}
@compute @workgroup_size(8,8) fn holdOutputs(@builtin(global_invocation_id) id:vec3<u32>){
${history
  .map(
    (_output, index) => `if(all(id.xy<textureDimensions(input${index}))){
  let value=textureLoad(input${index},vec2<i32>(id.xy),0);
  textureStore(output${index},vec2<i32>(id.xy),value);
  textureStore(output${index},vec2<i32>(id.xy)+vec2<i32>(0,i32(textureDimensions(input${index}).y)),value);
}`,
  )
  .join('\n')}
}`,
        'holdOutputs',
        history.flatMap((output, index) => [read(index * 2), write(index * 2 + 1, output.format)]),
      ),
    );
    compute(
      resources,
      passes,
      name,
      `${name}-program`,
      'holdOutputs',
      history.flatMap((output, index) => [
        { binding: index * 2, resource: `${output.previous}-view` },
        { binding: index * 2 + 1, resource: `${output.current}-view` },
      ]),
      Math.max(...history.map((output) => output.width)),
      Math.max(...history.map((output) => output.height)),
    );
    publishShallowMaterial(row, resources, passes, false);
  }
  return { scope: { view: row.viewIdentity }, resources, passes };
}
function shallowMeshResources(
  row: PendingShallow,
  generation: number,
): RenderFeatureResourceDeclaration[] {
  const [width, height] = row.recipe.asset.shallowStageConfig.gridResolution;
  const prefix = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity).prefix;
  return [
    {
      kind: 'buffer',
      name: `${prefix}-mesh-b${row.body.generation}-g${generation}-vertices`,
      size: (width + 1) * (height + 1) * ADVANCED_GRID_VERTEX_STRIDE,
      usage: ['storage', 'vertex', 'copy-src'],
    },
    {
      kind: 'buffer',
      name: `${prefix}-mesh-b${row.body.generation}-g${generation}-triangles`,
      size: width * height * 6 * 4,
      usage: ['storage', 'index', 'copy-src'],
    },
  ];
}
function pendingOceanWork(
  row: OceanRow,
  previous: InitializedOcean | undefined,
  retainVisualOutput: boolean,
): RenderFeatureWork {
  const config = row.recipe.asset.oceanPatchConfig;
  const names = waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity);
  const outputs: string[] = [
    names.normal,
    names.previousNormal,
    names.materialNormal,
    ...(config.algorithm === 'mode-projected-gravity/1'
      ? [names.grid, names.previousGrid, names.materialGrid, names.foam, names.mapping]
      : []),
  ];
  if (
    retainVisualOutput ||
    (config.algorithm === 'mode-projected-gravity/1' && 'visualNormalDetailFft' in config)
  )
    outputs.push(names.visualNormal);
  const normalOutputs = new Set<string>([names.normal, names.previousNormal, names.materialNormal]);
  const passes: RenderFeaturePassDeclaration[] =
    previous === undefined
      ? outputs.map((name) => ({
          kind: 'raster',
          name: `${name}-neutral`,
          colorAttachments: [{ target: name, loadOp: 'clear', storeOp: 'store' }],
          draws: [],
        }))
      : [];
  const resources: RenderFeatureResourceDeclaration[] = outputs
    .filter(
      (name) => previous === undefined || normalOutputs.has(name) || name === names.visualNormal,
    )
    .flatMap((name) => {
      if (previous === undefined)
        return [
          texture(name, 1, 1, 'rgba8unorm', `${name}-neutral`, true, true),
          view(`${name}-view`, name),
        ];
      if (name === names.visualNormal) {
        if (
          config.algorithm !== 'mode-projected-gravity/1' ||
          !('visualNormalDetailFft' in config) ||
          previous.visualOutput === undefined
        )
          return [
            texture(name, 1, 1, 'rgba8unorm', `${name}-neutral`, true, true),
            view(`${name}-view`, name),
          ];
        const output = previous.visualOutput;
        return [
          texture(
            name,
            output.size,
            output.size,
            config.visualNormalDetailFft.normalRtFormat,
            `${name}-g${output.generation}-r${output.revision}-s${output.size}`,
            true,
            true,
          ),
          view(`${name}-view`, name),
        ];
      }
      return [
        texture(
          name,
          previous.size,
          previous.size * (name === names.materialNormal ? 2 : 1),
          config.normalRtFormat,
          `${name}-g${previous.generation}-s${previous.size}`,
          true,
          true,
        ),
        view(`${name}-view`, name),
      ];
    });
  resources.push(...(previous ? oceanMeshResources(row) : []));
  if (config.algorithm === 'mode-projected-gravity/1' && previous) {
    resources.push(
      ...dispersiveOutputResources(row, previous.size),
      ...dispersiveStateResources(`${names.prefix}-dispersive`, previous.size, previous.generation),
    );
    for (const source of previous.querySources ?? []) {
      if (!source.hasHistory) continue;
      const prefix = dispersiveQueryPrefix(names.prefix, source.receiver);
      resources.push(
        ...dispersiveStateResources(prefix, previous.size, previous.generation),
        program(
          `${prefix}-hold-program`,
          `@group(0) @binding(0) var wave:texture_2d<f32>;
@group(0) @binding(1) var source:texture_2d<f32>;
@compute @workgroup_size(1) fn hold(){}`,
          'hold',
          [read(0), read(1)],
        ),
        {
          kind: 'compute-bindings',
          name: `${prefix}-hold-bindings`,
          program: `${prefix}-hold-program`,
          entries: [
            { binding: 0, resource: `${prefix}-state-view` },
            { binding: 1, resource: `${prefix}-source-state-view` },
          ],
        },
      );
      passes.push({
        kind: 'compute',
        name: `${prefix}-hold`,
        enabled: false,
        program: `${prefix}-hold-program`,
        bindings: `${prefix}-hold-bindings`,
        dispatches: [{ kind: 'direct', entryPoint: 'hold', workgroups: [1, 1, 1] }],
      });
    }
  }
  if (previous) {
    const history = {
      current: names.normal,
      previous: names.previousNormal,
      format: config.normalRtFormat,
      width: previous.size,
      height: previous.size,
    };
    const histories =
      config.algorithm === 'mode-projected-gravity/1'
        ? [
            history,
            {
              current: names.grid,
              previous: names.previousGrid,
              format: 'rgba32float' as const,
              width: previous.size,
              height: previous.size,
            },
          ]
        : [history];
    copyOutputHistory(resources, passes, `${names.prefix}-fft`, histories);
    publishOutputHistory(
      resources,
      passes,
      `${names.prefix}-fft`,
      histories.map((item) => ({
        ...item,
        target: item.current === names.normal ? names.materialNormal : names.materialGrid,
      })),
      false,
    );
    if (config.algorithm === 'mode-projected-gravity/1') {
      const prefix = `${names.prefix}-dispersive`,
        hold = `${prefix}-hold-state`;
      resources.push(
        program(
          `${hold}-program`,
          `@group(0) @binding(0) var wave:texture_2d<f32>;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var foam:texture_2d<f32>;
@group(0) @binding(3) var mapping:texture_2d<f32>;
@compute @workgroup_size(1) fn hold(){}`,
          'hold',
          [read(0), read(1), read(2), read(3)],
        ),
        {
          kind: 'compute-bindings',
          name: `${hold}-bindings`,
          program: `${hold}-program`,
          entries: [
            { binding: 0, resource: `${prefix}-state-view` },
            { binding: 1, resource: `${prefix}-source-state-view` },
            { binding: 2, resource: `${names.foam}-view` },
            { binding: 3, resource: `${names.mapping}-view` },
          ],
        },
      );
      passes.push({
        kind: 'compute',
        name: hold,
        enabled: false,
        program: `${hold}-program`,
        bindings: `${hold}-bindings`,
        dispatches: [{ kind: 'direct', entryPoint: 'hold', workgroups: [1, 1, 1] }],
      });
    }
  }
  return { scope: { view: row.viewIdentity }, resources, passes };
}
function dispersiveOutputResources(
  row: OceanRow,
  size = row.size,
): RenderFeatureResourceDeclaration[] {
  const names = waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity);
  return [names.grid, names.previousGrid, names.materialGrid, names.foam, names.mapping].flatMap(
    (name) => [
      texture(
        name,
        name === names.mapping ? 2 : size,
        name === names.mapping ? 2 : size * (name === names.materialGrid ? 2 : 1),
        'rgba32float',
        `${name}-g${row.generation}-s${size}`,
        true,
        true,
      ),
      view(`${name}-view`, name),
    ],
  );
}

function dispersiveOceanWork(
  row: OceanRow & { readonly frame: WaterOceanPatchFrame },
  prior: SubmittedSequence | undefined,
  fieldInitialization?: SdfSceneFieldPayload['initialization'],
  visualNoise?: NonNullable<OceanRow['noise']>,
): RenderFeatureWork {
  const config = row.recipe.asset.oceanPatchConfig;
  if (config.algorithm !== 'mode-projected-gravity/1' || row.collisions?.kind !== 'ready')
    throw new Error('Dispersive work requires its admitted configuration and accepted source');
  const names = waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity);
  const resources: RenderFeatureResourceDeclaration[] = dispersiveOutputResources(row);
  const passes: RenderFeaturePassDeclaration[] = [];
  for (const name of [names.normal, names.previousNormal, names.materialNormal])
    resources.push(
      texture(
        name,
        row.size,
        row.size * (name === names.materialNormal ? 2 : 1),
        config.normalRtFormat,
        `${name}-g${row.generation}-s${row.size}`,
        true,
        true,
      ),
      view(`${name}-view`, name),
    );
  const reset = row.allocation || row.frame.reset;
  const history = [
    {
      current: names.normal,
      previous: names.previousNormal,
      format: config.normalRtFormat,
      width: row.size,
      height: row.size,
    },
    {
      current: names.grid,
      previous: names.previousGrid,
      format: 'rgba32float' as const,
      width: row.size,
      height: row.size,
    },
  ];
  if (!reset) copyOutputHistory(resources, passes, `${names.prefix}-fft`, history);
  const previousOceanSequence = () => {
    return prior?.kind === 'ocean' && prior.generation === row.generation ? prior : undefined;
  };
  const previous = previousOceanSequence();
  appendDispersiveOcean(
    {
      prefix: `${names.prefix}-dispersive`,
      size: row.size,
      generation: row.generation,
      frame: row.frame,
      config,
      collisions: row.collisions.value,
      ...(fieldInitialization === undefined ? {} : { fieldInitialization }),
      outputs: names,
      reset,
      deltaSeconds:
        reset || row.frame.reseedSource || previous === undefined
          ? 0
          : row.frame.timeSeconds - previous.timeSeconds,
      reseedSource:
        reset ||
        row.frame.reseedSource ||
        (previous?.sourceIdentity !== undefined &&
          dispersiveSourceRequiresReseed(
            previous.sourceIdentity,
            dispersiveSourceIdentity(row.collisions.value),
          )),
    },
    resources,
    passes,
  );
  const visualConfig = 'visualNormalDetailFft' in config ? config.visualNormalDetailFft : undefined;
  if (visualConfig && visualNoise && row.frame.visualNormalDetailFft)
    appendVisualNormalDetailFft(
      row,
      visualConfig,
      visualNoise,
      row.frame.visualNormalDetailFft,
      names,
      resources,
      passes,
    );
  const querySources = receiverSourceStates(row, previous?.querySources);
  const appendReceiverQuerySources = (
    row: OceanRow & {
      readonly frame: WaterOceanPatchFrame;
      readonly collisions: Extract<NonNullable<OceanRow['collisions']>, { kind: 'ready' }>;
    },
    receiverConfig: Extract<typeof config, { algorithm: 'mode-projected-gravity/1' }>,
  ) => {
    for (const source of querySources) {
      if (!source.hasHistory) continue;
      const prior = previous?.querySources?.find(
        (item) =>
          item.receiver.entity === source.receiver.entity &&
          item.receiver.generation === source.receiver.generation,
      );
      appendDispersiveOcean(
        {
          prefix: dispersiveQueryPrefix(names.prefix, source.receiver),
          size: row.size,
          generation: row.generation,
          frame: {
            ...row.frame,
            captureStages: false,
            waveImpulses: (row.frame.waveImpulses ?? []).filter(
              (impulse) =>
                impulse.sourceReceiver?.entity !== source.receiver.entity ||
                impulse.sourceReceiver?.generation !== source.receiver.generation,
            ),
          },
          config: receiverConfig,
          collisions: dispersiveExternalSources(row.collisions.value, source.receiver),
          ...(fieldInitialization === undefined ? {} : { fieldInitialization }),
          outputs: names,
          queryOnly: true,
          reset: reset || !prior?.hasHistory,
          deltaSeconds:
            reset || row.frame.reseedSource || previous === undefined
              ? 0
              : row.frame.timeSeconds - previous.timeSeconds,
          reseedSource:
            reset ||
            row.frame.reseedSource ||
            prior === undefined ||
            dispersiveSourceRequiresReseed(prior.sourceIdentity, source.sourceIdentity),
        },
        resources,
        passes,
      );
    }
  };
  appendReceiverQuerySources(
    row as OceanRow & {
      readonly frame: WaterOceanPatchFrame;
      readonly collisions: Extract<NonNullable<OceanRow['collisions']>, { kind: 'ready' }>;
    },
    config,
  );
  if (reset) copyOutputHistory(resources, passes, `${names.prefix}-fft`, history);
  const publishDispersiveOutputHistory = () => {
    publishOutputHistory(
      resources,
      passes,
      `${names.prefix}-fft`,
      history.map((item) => ({
        ...item,
        target: item.current === names.normal ? names.materialNormal : names.materialGrid,
      })),
      reset,
    );
  };
  publishDispersiveOutputHistory();
  const appendDispersiveQueryFeedback = (
    row: OceanRow & { readonly frame: WaterOceanPatchFrame },
    receiverConfig: Extract<typeof config, { algorithm: 'mode-projected-gravity/1' }>,
  ) => {
    if (row.frame.queryFeedback && row.size === receiverConfig.fftResolution) {
      const query = row.frame.queryFeedback;
      const queryPassNames = waterOceanPatchQueryPassNames(row.recipe.guid, row.worldIdentity);
      const queryPrefix = queryPassNames.prefix;
      resources.push(
        texture(
          names.queryHeight,
          query.size[0],
          query.size[1] * (1 + (query.receivers?.length ?? 0)),
          'r32float',
          `${names.queryHeight}-g${row.generation}-s${query.size[0]}-${query.size[1]}-p${1 + (query.receivers?.length ?? 0)}`,
          false,
        ),
        view(`${names.queryHeight}-view`, names.queryHeight),
        buffer(
          `${queryPrefix}-params`,
          new Float32Array([...query.offset, row.size, 0, ...query.size, 0, 0]),
        ),
        program(`${queryPrefix}-program`, DISPERSIVE_QUERY_SHADER, 'sampleQuery', [
          read(0),
          write(1, 'r32float'),
          storage(2),
        ]),
        program(`${queryPrefix}-clear-program`, DISPERSIVE_QUERY_SHADER, 'clearQuery', [
          write(1, 'r32float'),
          storage(2),
        ]),
      );
      for (const [index, receiver] of (query.receivers ?? []).entries()) {
        const source = querySources.find(
          (item) =>
            item.receiver.entity === receiver.entity &&
            item.receiver.generation === receiver.generation,
        );
        const params = `${queryPrefix}-receiver-${index}-params`;
        resources.push(
          buffer(
            params,
            new Float32Array([
              ...query.offset,
              row.size,
              (index + 1) * query.size[1],
              ...query.size,
              0,
              0,
            ]),
          ),
        );
        compute(
          resources,
          passes,
          queryPassNames.receiver(index),
          source?.hasHistory ? `${queryPrefix}-program` : `${queryPrefix}-clear-program`,
          source?.hasHistory ? 'sampleQuery' : 'clearQuery',
          [
            ...(source?.hasHistory
              ? [
                  {
                    binding: 0,
                    resource: `${dispersiveQueryPrefix(names.prefix, receiver)}-state-view`,
                  },
                ]
              : []),
            { binding: 1, resource: `${names.queryHeight}-view` },
            { binding: 2, resource: params },
          ],
          query.size[0],
          query.size[1],
        );
      }
      compute(
        resources,
        passes,
        queryPassNames.sample,
        `${queryPrefix}-program`,
        'sampleQuery',
        [
          { binding: 0, resource: `${names.prefix}-dispersive-state-view` },
          { binding: 1, resource: `${names.queryHeight}-view` },
          { binding: 2, resource: `${queryPrefix}-params` },
        ],
        query.size[0],
        query.size[1],
      );
      passes.push({
        kind: 'copy',
        name: queryPassNames.readback,
        copies: [],
        textureReadbacks: [{ name: names.queryHeight, target: names.queryHeight }],
      });
    }
  };
  appendDispersiveQueryFeedback(row as OceanRow & { readonly frame: WaterOceanPatchFrame }, config);
  if (row.frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${names.prefix}-dispersive-output-capture`,
      copies: [],
      textureReadbacks: [
        names.normal,
        names.grid,
        names.materialNormal,
        names.materialGrid,
        names.mapping,
        names.foam,
      ].map((name) => ({ name, target: name })),
    });
  return { scope: { view: row.viewIdentity }, resources, passes };
}

function appendVisualNormalDetailFft(
  row: OceanRow & { readonly frame: WaterOceanPatchFrame },
  config: WaterVisualNormalDetailFftConfig,
  noise: NonNullable<OceanRow['noise']>,
  child: NonNullable<WaterOceanPatchFrame['visualNormalDetailFft']>,
  names: ReturnType<typeof waterOceanPatchOutputNames>,
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
): void {
  const size = config.fftResolution,
    prefix = `${names.prefix}-visual-fft`,
    revisionPrefix = `${prefix}-g${row.generation}-r${child.revision}-s${size}`,
    shader = advancedFftShader(config.normalRtFormat),
    initialParams = `${revisionPrefix}-initial-params`,
    noiseName = `${revisionPrefix}-noise`;
  const params = new Float32Array([
    size,
    config.domainLengthM,
    row.frame.timeSeconds,
    0,
    config.windAngleDegrees,
    config.windSpeedMPerSec,
    config.gravityMPerSec2,
    config.windAlignment,
    config.phillipsAmplitude,
    config.timeScale,
    config.slosh,
    config.normalDomainSizeM,
    noise.asset.shape.extent.width,
    noise.asset.shape.extent.height,
    0,
    0,
  ]);
  // V2 clamps the authored continuous wind exponent directly; v1 keeps its existing integer path.
  params[15] = 1;
  const noisePixels = new Float32Array(noise.asset.data.length);
  for (const [index, value] of noise.asset.data.entries()) noisePixels[index] = value / 255;
  resources.push(buffer(noiseName, noisePixels), buffer(initialParams, params));
  for (const side of ['a', 'b'] as const) {
    const target = `${revisionPrefix}-${side}`;
    resources.push(
      texture(target, size, size, 'rgba32float', `${target}-target`),
      view(`${target}-view`, target),
    );
  }
  resources.push(
    texture(
      names.visualNormal,
      size,
      size,
      config.normalRtFormat,
      `${names.visualNormal}-g${row.generation}-r${child.revision}-s${size}`,
      true,
      true,
    ),
    view(`${names.visualNormal}-view`, names.visualNormal),
  );
  resources.push(
    program(`${revisionPrefix}-spectrum-program`, shader, 'spectrum', [
      write(1, 'rgba32float'),
      storage(2),
      storage(3),
    ]),
    program(`${revisionPrefix}-butterfly-program`, shader, 'butterfly', [
      read(0),
      write(1, 'rgba32float'),
      storage(2),
    ]),
    program(`${revisionPrefix}-publish-program`, shader, 'publishVisualNormalDetail', [
      read(0),
      storage(2),
      write(7, config.normalRtFormat),
    ]),
  );
  compute(
    resources,
    passes,
    `${revisionPrefix}-spectrum`,
    `${revisionPrefix}-spectrum-program`,
    'spectrum',
    [
      { binding: 1, resource: `${revisionPrefix}-a-view` },
      { binding: 2, resource: initialParams },
      { binding: 3, resource: noiseName },
    ],
    size,
    size,
  );
  if (row.frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${revisionPrefix}-spectrum-capture`,
      copies: [],
      textureReadbacks: [{ name: `${revisionPrefix}-spectrum`, target: `${revisionPrefix}-a` }],
    });
  let previous: 'a' | 'b' = 'a';
  for (const axis of [0, 1] as const)
    for (let span = 1; span < size; span *= 2) {
      const next: 'a' | 'b' = previous === 'a' ? 'b' : 'a';
      const passName = `${revisionPrefix}-${axis === 0 ? 'x' : 'z'}-radix-${span}`;
      const stageParams = params.slice();
      stageParams[14] = axis;
      stageParams[15] = span;
      const stageParamsName = `${passName}-params`;
      resources.push(buffer(stageParamsName, stageParams));
      compute(
        resources,
        passes,
        passName,
        `${revisionPrefix}-butterfly-program`,
        'butterfly',
        [
          { binding: 0, resource: `${revisionPrefix}-${previous}-view` },
          { binding: 1, resource: `${revisionPrefix}-${next}-view` },
          { binding: 2, resource: stageParamsName },
        ],
        size,
        size,
      );
      if (row.frame.captureStages)
        passes.push({
          kind: 'copy',
          name: `${passName}-capture`,
          copies: [],
          textureReadbacks: [{ name: `${passName}-complex`, target: `${revisionPrefix}-${next}` }],
        });
      previous = next;
    }
  compute(
    resources,
    passes,
    `${revisionPrefix}-publish`,
    `${revisionPrefix}-publish-program`,
    'publishVisualNormalDetail',
    [
      { binding: 0, resource: `${revisionPrefix}-${previous}-view` },
      { binding: 2, resource: initialParams },
      { binding: 7, resource: `${names.visualNormal}-view` },
    ],
    size,
    size,
  );
  if (row.frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${revisionPrefix}-publish-capture`,
      copies: [],
      textureReadbacks: [{ name: names.visualNormal, target: names.visualNormal }],
    });
}

function oceanMeshResources(row: OceanRow): RenderFeatureResourceDeclaration[] {
  const config = row.recipe.asset.oceanPatchConfig;
  if (config.gridMesh === null) return [];
  const names = waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity),
    size = config.fftResolution;
  return [
    {
      kind: 'buffer',
      name: `${names.gridMeshVertices}-g${row.generation}`,
      size: (size + 1) ** 2 * ADVANCED_GRID_VERTEX_STRIDE,
      usage: ['storage', 'vertex', 'copy-src'],
    },
    {
      kind: 'buffer',
      name: `${names.gridMeshTriangles}-g${row.generation}`,
      size: size ** 2 * 6 * 4,
      usage: ['storage', 'index', 'copy-src'],
    },
  ];
}

function appendShallowStageOutputs(
  frame: WaterAdvancedFrame,
  task: WaterAdvancedFrame['stages'][number],
  names: ReturnType<typeof waterAdvancedOutputNames>,
  next: string,
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
): void {
  const config = frame.recipe.asset.shallowStageConfig,
    [width, height] = config.gridResolution;
  const prefix = names.prefix,
    passName = `${prefix}-shallow-${task.ordinal}-${task.stage.toLowerCase().replaceAll(' ', '-')}`;
  const params = `${passName}-params`;
  if (task.stage === 'Post Sim')
    compute(
      resources,
      passes,
      `${passName}-output`,
      `${prefix}-post-sim-program`,
      'postSim',
      [
        { binding: 0, resource: `${prefix}-grid-${next}-view` },
        { binding: 1, resource: `${prefix}-field-${next}-view` },
        { binding: 2, resource: `${prefix}-foam-${next}-view` },
        { binding: 6, resource: params },
        { binding: 12, resource: `${names.grid}-view` },
      ],
      width,
      height,
    );
  if (task.stage === 'Prep Debug' && config.stageProfile === 'river-shallow/2')
    compute(
      resources,
      passes,
      `${passName}-output`,
      `${prefix}-debug-output-program`,
      'debugOutput',
      [
        { binding: 0, resource: `${prefix}-grid-${next}-view` },
        { binding: 1, resource: `${prefix}-field-${next}-view` },
        { binding: 6, resource: params },
        ...(frame.waterInfo.status === 'ready'
          ? [{ binding: 10, resource: `${prefix}-water-info` }]
          : []),
        { binding: 12, resource: `${names.grid}-view` },
        { binding: 15, resource: `${prefix}-normals-${next}-view` },
      ],
      width,
      height,
    );
  if (task.stage === 'Foam' && config.debug.foamEmission)
    compute(
      resources,
      passes,
      `${passName}-debug-output`,
      `${prefix}-foam-debug-output-program`,
      'foamDebugOutput',
      [
        { binding: 0, resource: `${prefix}-grid-${next}-view` },
        { binding: 6, resource: params },
        { binding: 12, resource: `${names.grid}-view` },
        { binding: 15, resource: `${prefix}-normals-${next}-view` },
      ],
      width,
      height,
    );
  if (frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${passName}-capture`,
      copies: [],
      textureReadbacks: [
        ...['grid', 'field', 'foam'].map((kind) => ({
          name: `${passName}-${kind}`,
          target: `${prefix}-${kind}-${next}`,
        })),
        { name: `${passName}-normal`, target: `${prefix}-normals-${next}` },
        ...(['Post Sim', 'Prep Debug', 'Foam'].includes(task.stage) &&
        (!frame.reset || (task.stage === 'Foam' && config.debug.foamEmission))
          ? [{ name: `${passName}-render-grid`, target: names.grid }]
          : []),
      ],
    });
}

function shallowWork(
  row: Row,
  collisions: AdvancedCollisionSnapshot,
  collisionDeltaSeconds: number,
  fieldInitialization?: SdfSceneFieldPayload['initialization'],
): RenderFeatureWork {
  const { frame } = row;
  const config = frame.recipe.asset.shallowStageConfig;
  const [width, height] = config.gridResolution;
  const names = waterAdvancedOutputNames(frame.recipe.guid, frame.body.guid, row.worldIdentity);
  const prefix = names.prefix;
  const resources: RenderFeatureResourceDeclaration[] = [];
  const passes: RenderFeaturePassDeclaration[] = [];
  const hasInfo = frame.waterInfo.status === 'ready';
  const hasRigid = config.rigidMeshCollisions.kind !== 'disabled';
  const source = advancedShallowShader(
    config.normalRtFormat,
    hasInfo,
    hasRigid,
    frame.reset ? 'seed' : 'retained',
  );
  const stageProgram = `${prefix}-shallow-program`;
  const publishProgram = `${prefix}-shallow-publish-program`;
  const declareShallowPrograms = () => {
    resources.push(
      program(stageProgram, source, 'stage', [
        read(0),
        read(1),
        read(2),
        write(3, 'rgba32float'),
        write(4, 'rgba32float'),
        write(5, 'rgba32float'),
        storage(6),
        storage(7),
        storage(8, true),
        storage(9, true),
        ...(hasInfo ? [read(10, '2d-array')] : []),
        write(11, config.normalRtFormat),
        read(15),
        ...(hasRigid ? [storage(17), storage(18), storage(19)] : []),
      ]),
      program(publishProgram, source, 'publish', [
        read(0),
        read(2),
        storage(6),
        write(11, config.normalRtFormat),
        write(12, 'rgba16float'),
        write(13, config.normalRtFormat),
        write(14, 'rgba32float'),
        read(15),
        ...(!frame.reset ? [read(16)] : []),
      ]),
      program(`${prefix}-post-sim-program`, source, 'postSim', [
        read(0),
        read(1),
        read(2),
        storage(6),
        write(12, 'rgba16float'),
      ]),
      program(`${prefix}-debug-output-program`, source, 'debugOutput', [
        read(0),
        read(1),
        storage(6),
        ...(hasInfo ? [read(10, '2d-array')] : []),
        write(12, 'rgba16float'),
        read(15),
      ]),
      program(`${prefix}-foam-debug-output-program`, source, 'foamDebugOutput', [
        read(0),
        storage(6),
        write(12, 'rgba16float'),
        read(15),
      ]),
    );
  };
  declareShallowPrograms();
  const impulses = `${prefix}-impulses`,
    vertices = `${prefix}-mesh-b${frame.body.generation}-g${frame.generation}-vertices`,
    triangles = `${prefix}-mesh-b${frame.body.generation}-g${frame.generation}-triangles`;
  const declareShallowMeshInputs = () => {
    resources.push(
      buffer(impulses, impulseData(frame)),
      ...shallowMeshResources(row, frame.generation),
      ...(hasRigid
        ? [
            buffer(`${prefix}-rigid-primitives`, collisions.primitives),
            buffer(`${prefix}-rigid-sdf-instances`, collisions.sdfInstances),
            ...(fieldInitialization === undefined
              ? [buffer(`${prefix}-rigid-sdf-fields`, collisions.sdfFields)]
              : [initializedBuffer(`${prefix}-rigid-sdf-fields`, fieldInitialization)]),
          ]
        : []),
    );
  };
  declareShallowMeshInputs();
  resources.push(...shallowStateResources(row, frame.generation));
  resources.push(...shallowOutputs(row, frame.generation));
  if (!frame.reset) copyOutputHistory(resources, passes, prefix, shallowOutputHistory(row));
  const infoName = `${prefix}-water-info`;
  if (frame.waterInfo.status === 'ready')
    resources.push({
      kind: 'prepared-gpu-resource',
      name: infoName,
      resource: { kind: 'texture-view', value: undefined },
      logicalTarget: {
        kind: 'feature-texture',
        featureIdentity: 'water-info-producer',
        name: frame.waterInfo.targetName,
        viewIdentity: row.viewIdentity,
        format: frame.waterInfo.targetFormat,
        sampleCount: 1,
      },
    });
  if (frame.reset) {
    const name = `${prefix}-initialize-state`;
    resources.push(
      program(`${name}-program`, source, 'initialize', [
        write(3, 'rgba32float'),
        write(4, 'rgba32float'),
        write(5, 'rgba32float'),
        storage(6),
        write(11, config.normalRtFormat),
      ]),
      buffer(`${name}-params`, parameters(frame, 99, 0)),
    );
    compute(
      resources,
      passes,
      name,
      `${name}-program`,
      'initialize',
      [
        ...(['grid', 'field', 'foam'] as const).map((kind, index) => ({
          binding: index + 3,
          resource: `${prefix}-${kind}-state-view`,
        })),
        { binding: 6, resource: `${name}-params` },
        { binding: 11, resource: `${prefix}-normals-state-view` },
      ],
      width,
      height,
    );
  }
  let previous = 'state';
  for (const task of frame.stages) {
    const next = task.ordinal % 2 === 0 ? 'a' : 'b';
    const passName = `${prefix}-shallow-${task.ordinal}-${task.stage.toLowerCase().replaceAll(' ', '-')}`;
    const params = `${passName}-params`;
    resources.push(
      buffer(
        params,
        parameters(
          frame,
          STAGES.indexOf(task.stage),
          task.deltaSeconds,
          collisions.roster.length,
          collisionDeltaSeconds,
          task.substep === 0 ? frame.previousTransform : frame.transform,
        ),
      ),
    );
    compute(
      resources,
      passes,
      passName,
      stageProgram,
      'stage',
      [
        ...(['grid', 'field', 'foam'] as const).map((kind, binding) => ({
          binding,
          resource: `${prefix}-${kind}-${previous}-view`,
        })),
        ...(['grid', 'field', 'foam'] as const).map((kind, index) => ({
          binding: index + 3,
          resource: `${prefix}-${kind}-${next}-view`,
        })),
        { binding: 6, resource: params },
        { binding: 7, resource: impulses },
        { binding: 8, resource: vertices },
        { binding: 9, resource: triangles },
        ...(hasInfo ? [{ binding: 10, resource: infoName }] : []),
        { binding: 11, resource: `${prefix}-normals-${next}-view` },
        { binding: 15, resource: `${prefix}-normals-${previous}-view` },
        ...(hasRigid
          ? [
              { binding: 17, resource: `${prefix}-rigid-primitives` },
              { binding: 18, resource: `${prefix}-rigid-sdf-instances` },
              { binding: 19, resource: `${prefix}-rigid-sdf-fields` },
            ]
          : []),
      ],
      width + Number(task.stage === 'Create Vertices'),
      height + Number(task.stage === 'Create Vertices'),
    );
    appendShallowStageOutputs(frame, task, names, next, resources, passes);
    previous = next;
  }
  const publishParams = `${prefix}-publish-params`;
  resources.push(buffer(publishParams, parameters(frame, 99, 0)));
  compute(
    resources,
    passes,
    `${prefix}-publish-shallow`,
    publishProgram,
    'publish',
    [
      { binding: 0, resource: `${prefix}-grid-${previous}-view` },
      { binding: 2, resource: `${prefix}-foam-${previous}-view` },
      { binding: 6, resource: publishParams },
      { binding: 11, resource: `${names.normal}-view` },
      { binding: 12, resource: `${names.grid}-view` },
      { binding: 13, resource: `${names.foam}-view` },
      { binding: 14, resource: `${names.mapping}-view` },
      { binding: 15, resource: `${prefix}-normals-${previous}-view` },
      ...(!frame.reset ? [{ binding: 16, resource: `${names.previousMapping}-view` }] : []),
    ],
    width,
    height,
  );
  compute(
    resources,
    passes,
    `${prefix}-commit-shallow-step`,
    stageProgram,
    'stage',
    [
      ...(['grid', 'field', 'foam'] as const).map((kind, binding) => ({
        binding,
        resource: `${prefix}-${kind}-${previous}-view`,
      })),
      ...(['grid', 'field', 'foam'] as const).map((kind, index) => ({
        binding: index + 3,
        resource: `${prefix}-${kind}-state-view`,
      })),
      { binding: 6, resource: publishParams },
      { binding: 7, resource: impulses },
      { binding: 8, resource: vertices },
      { binding: 9, resource: triangles },
      ...(hasInfo ? [{ binding: 10, resource: infoName }] : []),
      { binding: 11, resource: `${prefix}-normals-state-view` },
      { binding: 15, resource: `${prefix}-normals-${previous}-view` },
      ...(hasRigid
        ? [
            { binding: 17, resource: `${prefix}-rigid-primitives` },
            { binding: 18, resource: `${prefix}-rigid-sdf-instances` },
            { binding: 19, resource: `${prefix}-rigid-sdf-fields` },
          ]
        : []),
    ],
    width,
    height,
  );
  if (frame.reset) copyOutputHistory(resources, passes, prefix, shallowOutputHistory(row));
  publishShallowMaterial(row, resources, passes, frame.reset);
  if (frame.bakeRequest !== null) {
    const bakeProgram = `${prefix}-bake-program`;
    resources.push(
      program(bakeProgram, source, 'bake', [read(0), write(12, 'rgba16float')]),
      texture(
        names.bake,
        width,
        height,
        'rgba16float',
        `${names.bake}-request-${frame.bakeRequest}`,
      ),
      view(`${names.bake}-view`, names.bake),
    );
    compute(
      resources,
      passes,
      `${prefix}-river-bake`,
      bakeProgram,
      'bake',
      [
        { binding: 0, resource: `${names.grid}-view` },
        { binding: 12, resource: `${names.bake}-view` },
      ],
      width,
      height,
    );
    passes.push({
      kind: 'copy',
      name: `${prefix}-river-bake-readback`,
      copies: [],
      textureReadbacks: [
        { name: names.bake, target: names.bake },
        { name: `${prefix}-river-bake-normal`, target: names.normal },
      ],
    });
  }
  if (frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${prefix}-output-capture`,
      copies: [],
      textureReadbacks: [
        names.grid,
        names.normal,
        names.materialGrid,
        names.materialNormal,
        names.foam,
        names.mapping,
        names.previousGrid,
        names.previousNormal,
        names.previousMapping,
      ].map((name) => ({
        name,
        target: name,
      })),
    });
  return { scope: { view: row.viewIdentity }, resources, passes };
}

function appendOceanWaves(
  row: OceanRow & { readonly frame: WaterOceanPatchFrame },
  names: ReturnType<typeof waterOceanPatchOutputNames>,
  baseParams: Float32Array,
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
): void {
  const { frame, size } = row,
    prefix = `${names.prefix}-fft`,
    initialParams = `${prefix}-initial-params`;
  compute(
    resources,
    passes,
    `${prefix}-waves-pt1-spectrum`,
    `${prefix}-spectrum-program`,
    'spectrum',
    [
      { binding: 1, resource: `${prefix}-a-view` },
      { binding: 2, resource: initialParams },
      { binding: 3, resource: `${prefix}-noise` },
    ],
    size,
    size,
  );
  if (frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${prefix}-spectrum-capture`,
      copies: [],
      textureReadbacks: [{ name: `${prefix}-frequency-complex`, target: `${prefix}-a` }],
    });
  let previous = 'a';
  for (const axis of [0, 1] as const)
    for (let span = 1; span < size; span *= 2) {
      const next = previous === 'a' ? 'b' : 'a',
        name = `${prefix}-waves-pt${axis + 1}-${axis === 0 ? 'x' : 'y'}-radix-${span}`;
      const params = baseParams.slice();
      params[14] = axis;
      params[15] = span;
      resources.push(buffer(`${name}-params`, params));
      compute(
        resources,
        passes,
        name,
        `${prefix}-butterfly-program`,
        'butterfly',
        [
          { binding: 0, resource: `${prefix}-${previous}-view` },
          { binding: 1, resource: `${prefix}-${next}-view` },
          { binding: 2, resource: `${name}-params` },
        ],
        size,
        size,
      );
      if (frame.captureStages)
        passes.push({
          kind: 'copy',
          name: `${name}-capture`,
          copies: [],
          textureReadbacks: [{ name: `${name}-complex`, target: `${prefix}-${next}` }],
        });
      previous = next;
    }
  compute(
    resources,
    passes,
    `${prefix}-set-render-target`,
    `${prefix}-publish-program`,
    'publish',
    [
      { binding: 0, resource: `${prefix}-${previous}-view` },
      { binding: 2, resource: initialParams },
      { binding: 4, resource: `${names.normal}-view` },
    ],
    size,
    size,
  );
}

function oceanWork(
  row: OceanRow & {
    readonly frame: WaterOceanPatchFrame;
    readonly noise: NonNullable<OceanRow['noise']>;
  },
): RenderFeatureWork {
  const { frame, size, noise } = row;
  const config = frame.recipe.asset.oceanPatchConfig;
  if (config.algorithm !== 'ocean-spectrum-fft/2')
    throw new Error('Spectral FFT work requires its own recipe variant');
  const names = waterOceanPatchOutputNames(frame.recipe.guid, row.worldIdentity),
    prefix = `${names.prefix}-fft`;
  const source = advancedFftShader(config.normalRtFormat);
  const resources: RenderFeatureResourceDeclaration[] = [],
    passes: RenderFeaturePassDeclaration[] = [];
  const normalName = names.normal;
  const baseParams = new Float32Array([
    size,
    config.domainLengthM,
    frame.timeSeconds,
    0,
    config.windAngleDegrees,
    config.windSpeedMPerSec,
    config.gravityMPerSec2,
    config.windAlignment,
    config.phillipsAmplitude,
    config.timeScale,
    config.slosh,
    config.normalDomainSizeM,
    noise.asset.shape.extent.width,
    noise.asset.shape.extent.height,
    0,
    0,
  ]);
  const noisePixels = new Float32Array(noise.asset.data.length);
  for (const [index, value] of noise.asset.data.entries()) noisePixels[index] = value / 255;
  resources.push(buffer(`${prefix}-noise`, noisePixels));
  resources.push(...oceanMeshResources(row));
  for (const side of ['a', 'b'] as const) {
    const name = `${prefix}-${side}`;
    resources.push(
      texture(name, size, size, 'rgba32float', `${name}-g${frame.generation}-s${size}`),
      view(`${name}-view`, name),
    );
  }
  for (const name of [normalName, names.previousNormal, names.materialNormal])
    resources.push(
      texture(
        name,
        size,
        size * (name === names.materialNormal ? 2 : 1),
        config.normalRtFormat,
        `${name}-g${frame.generation}-s${size}`,
        true,
        true,
      ),
      view(`${name}-view`, name),
    );
  const history = [
    {
      current: normalName,
      previous: names.previousNormal,
      format: config.normalRtFormat,
      width: size,
      height: size,
    },
  ] as const;
  if (!row.allocation && !frame.reset) copyOutputHistory(resources, passes, prefix, history);
  for (const [entry, entries] of [
    ['init', [write(1, 'rgba32float'), storage(2), write(4, config.normalRtFormat)]],
    ['spectrum', [write(1, 'rgba32float'), storage(2), storage(3)]],
    ['butterfly', [read(0), write(1, 'rgba32float'), storage(2)]],
    ['publish', [read(0), storage(2), write(4, config.normalRtFormat)]],
    ['retain', [read(0), write(1, 'rgba32float')]],
  ] as const)
    resources.push(program(`${prefix}-${entry}-program`, source, entry, entries));
  const initialParams = `${prefix}-initial-params`;
  resources.push(buffer(initialParams, baseParams));
  if (config.gridMesh !== null && frame.reset) {
    const meshParams = `${prefix}-mesh-params`;
    resources.push(
      buffer(meshParams, new Float32Array([config.fftResolution, ...config.gridMesh.extentM, 0])),
    );
    for (const [entry, suffix, binding, target] of [
      ['createVertices', 'create-vertices', 5, names.gridMeshVertices],
      ['createTriangles', 'create-triangles', 6, names.gridMeshTriangles],
    ] as const) {
      const name = `${prefix}-${suffix}`;
      resources.push(
        program(`${name}-program`, source, entry, [storage(2), storage(binding, true)]),
      );
      const cells = config.fftResolution + Number(entry === 'createVertices');
      compute(
        resources,
        passes,
        name,
        `${name}-program`,
        entry,
        [
          { binding: 2, resource: meshParams },
          { binding, resource: `${target}-g${frame.generation}` },
        ],
        cells,
        cells,
      );
    }
  }
  if (row.allocation || frame.reset)
    compute(
      resources,
      passes,
      `${prefix}-init-grid-channels`,
      `${prefix}-init-program`,
      'init',
      [
        { binding: 1, resource: `${prefix}-a-view` },
        { binding: 2, resource: initialParams },
        { binding: 4, resource: `${normalName}-view` },
      ],
      size,
      size,
    );
  else if (frame.paused)
    compute(
      resources,
      passes,
      `${prefix}-retain-paused-normal`,
      `${prefix}-retain-program`,
      'retain',
      [
        { binding: 0, resource: `${normalName}-view` },
        { binding: 1, resource: `${prefix}-a-view` },
      ],
      1,
      1,
    );
  else appendOceanWaves(row, names, baseParams, resources, passes);
  if (row.allocation || frame.reset) copyOutputHistory(resources, passes, prefix, history);
  publishOutputHistory(
    resources,
    passes,
    prefix,
    [{ ...history[0], target: names.materialNormal }],
    row.allocation || frame.reset,
  );
  if (frame.captureStages)
    passes.push({
      kind: 'copy',
      name: `${prefix}-normal-capture`,
      copies: [],
      textureReadbacks: [normalName, names.previousNormal, names.materialNormal].map((name) => ({
        name,
        target: name,
      })),
    });
  return { scope: { view: row.viewIdentity }, resources, passes };
}

function failure(
  row: { readonly recipe: WaterAdvancedRecipe; readonly generation: number },
  code: WaterAdvancedError['code'],
  expected: string,
  cause?: unknown,
): WaterAdvancedError {
  return {
    code,
    expected,
    hint: 'inspect the exact recipe, capabilities and submitted stage roster before resetting',
    detail: {
      recipeGuid: row.recipe.guid,
      generation: row.generation,
      ...(cause === undefined ? {} : { cause }),
    },
  };
}
function hasCompute(submission: RenderFeatureSubmission | undefined, name: string): boolean {
  return (
    submission?.works.some((work) =>
      work.passes.some(
        (pass) =>
          pass.name === name &&
          (pass.resolvedGpuComputeDispatchCount ??
            pass.resolvedGpuCompute?.dispatches.length ??
            0) > 0,
      ),
    ) === true
  );
}
function shallowSubmitted(row: Row, submission: RenderFeatureSubmission | undefined): boolean {
  const prefix = waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity).prefix;
  return (
    row.frame.stages.every((task) =>
      hasCompute(
        submission,
        `${prefix}-shallow-${task.ordinal}-${task.stage.toLowerCase().replaceAll(' ', '-')}`,
      ),
    ) &&
    row.frame.stages.every(
      (task) =>
        (task.stage !== 'Post Sim' ||
          hasCompute(submission, `${prefix}-shallow-${task.ordinal}-post-sim-output`)) &&
        (task.stage !== 'Prep Debug' ||
          row.recipe.asset.shallowStageConfig.stageProfile !== 'river-shallow/2' ||
          hasCompute(submission, `${prefix}-shallow-${task.ordinal}-prep-debug-output`)) &&
        (task.stage !== 'Foam' ||
          !row.recipe.asset.shallowStageConfig.debug.foamEmission ||
          hasCompute(submission, `${prefix}-shallow-${task.ordinal}-foam-debug-output`)),
    ) &&
    (!row.frame.reset || hasCompute(submission, `${prefix}-initialize-state`)) &&
    hasCompute(submission, `${prefix}-publish-shallow`) &&
    hasCompute(submission, `${prefix}-commit-shallow-step`) &&
    hasCompute(submission, `${prefix}-copy-history`) &&
    hasCompute(submission, `${prefix}-publish-material-history`) &&
    (row.frame.bakeRequest === null || hasCompute(submission, `${prefix}-river-bake`))
  );
}
function oceanSubmitted(
  row: OceanRow,
  submission: RenderFeatureSubmission | undefined,
  requiredPasses?: AdvancedFeedback['oceans'][number]['requiredPasses'],
): boolean {
  const frame = row.frame;
  if (!frame) return false;
  const prefix = `${waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity).prefix}-fft`;
  if (requiredPasses !== undefined) {
    return (
      requiredPasses.length > 0 &&
      requiredPasses.every((pass) =>
        pass.kind === 'compute'
          ? hasCompute(submission, pass.name)
          : submission?.works.some((work) =>
              work.passes.some((actual) => actual.name === pass.name),
            ) === true,
      )
    );
  }
  if (row.recipe.asset.oceanPatchConfig.algorithm === 'mode-projected-gravity/1') return false;
  if (
    frame.reset &&
    row.recipe.asset.oceanPatchConfig.gridMesh !== null &&
    (!hasCompute(submission, `${prefix}-create-vertices`) ||
      !hasCompute(submission, `${prefix}-create-triangles`))
  )
    return false;
  if (!hasCompute(submission, `${prefix}-copy-history`)) return false;
  if (!hasCompute(submission, `${prefix}-publish-material-history`)) return false;
  if (row.allocation || frame.reset) return hasCompute(submission, `${prefix}-init-grid-channels`);
  if (frame.paused) return hasCompute(submission, `${prefix}-retain-paused-normal`);
  if (
    !hasCompute(submission, `${prefix}-waves-pt1-spectrum`) ||
    !hasCompute(submission, `${prefix}-set-render-target`)
  )
    return false;
  for (const axis of ['x', 'y'] as const)
    for (let span = 1; span < row.size; span *= 2)
      if (
        !hasCompute(submission, `${prefix}-waves-pt${axis === 'x' ? 1 : 2}-${axis}-radix-${span}`)
      )
        return false;
  return true;
}

function submittedVisualNormalDetailFft(
  row: OceanRow,
  submission: RenderFeatureSubmission | undefined,
): Readonly<{ size: number }> | undefined {
  const frame = row.frame;
  const config = row.recipe.asset.oceanPatchConfig;
  const child = frame?.visualNormalDetailFft;
  if (
    !frame ||
    !child ||
    frame.recipe.asset.configurationVersion !== 2 ||
    config.algorithm !== 'mode-projected-gravity/1' ||
    !('visualNormalDetailFft' in config)
  )
    return undefined;
  const size = config.visualNormalDetailFft.fftResolution;
  const prefix = `${waterOceanPatchOutputNames(frame.recipe.guid, row.worldIdentity).prefix}-visual-fft-g${frame.generation}-r${child.revision}-s${size}`;
  const passes = [
    `${prefix}-spectrum`,
    ...([0, 1] as const).flatMap((axis) =>
      Array.from(
        { length: Math.log2(size) },
        (_, layer) => `${prefix}-${axis === 0 ? 'x' : 'z'}-radix-${2 ** layer}`,
      ),
    ),
    `${prefix}-publish`,
  ];
  return passes.every((name) => hasCompute(submission, name)) ? { size } : undefined;
}
function isFeedback(value: unknown): value is AdvancedFeedback {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<AdvancedFeedback>;
  return (
    row.kind === 'water-advanced-submission' &&
    Number.isSafeInteger(row.sourceFrameNumber) &&
    Number.isSafeInteger(row.deviceGeneration) &&
    typeof row.localReadbacks === 'boolean' &&
    Array.isArray(row.shallow) &&
    Array.isArray(row.oceans)
  );
}

function captureOceanRow(
  context: RenderFeatureExtractContext,
  worldIndex: number,
  world: RenderFeatureExtractContext['world'],
  ocean: WaterOceanPatch,
  viewIdentity: string,
  collisionMeshes: AdvancedCollisionMeshOwner,
): OceanRow {
  const config = ocean.recipe.asset.oceanPatchConfig;
  const noiseGuid =
    config.algorithm === 'ocean-spectrum-fft/2'
      ? config.noiseTextureGuid
      : 'visualNormalDetailFft' in config
        ? config.visualNormalDetailFft.noiseTextureGuid
        : undefined;
  const noiseHandle =
    world.assets === undefined || noiseGuid === undefined
      ? undefined
      : runtimeAssetReference(runtimeAssetRegistry(world.assets), noiseGuid);
  const captured =
    noiseHandle === undefined ? undefined : captureFeatureSourceAssetVersion(context, noiseHandle);
  const noise =
    captured?.ok && captured.value.value.kind === 'texture'
      ? { revision: captured.value.revision, asset: captured.value.value }
      : undefined;
  const bindOceanSourceRevision = () => {
    if (config.algorithm === 'ocean-spectrum-fft/2')
      ocean.bindNoiseRevision(noise?.revision ?? null);
    else {
      if ('visualNormalDetailFft' in config)
        ocean.bindVisualNormalDetailNoiseRevision(noise?.revision ?? null);
      const physics = world.hasResource(PhysicsWorldResource)
        ? world.getResource<PhysicsWorld>(PhysicsWorldResource)
        : undefined;
      const clock = physics?.getSolverClock?.();
      if (physics && clock) {
        const accepted = ocean.bindNativeSourceTime(
          physics,
          clock.simulationTimeSeconds,
          clock.completedStep,
        );
        if (!accepted.ok) ocean.fail(accepted.error);
      } else
        ocean.fail(
          ocean.failure(
            'water-advanced-unsupported',
            'an installed PhysicsWorld with a completed native simulation clock',
          ),
        );
    }
  };
  bindOceanSourceRevision();
  const inspection = ocean.inspect(),
    state = inspection.state;
  const key = JSON.stringify([
    world.identity,
    identityOrdinal(ocean),
    ocean.recipe.guid,
    ocean.recipe.contentVersion,
  ]);
  let frame = ocean.frame();
  if (frame?.queryFeedback && frame.queryFeedback.binding.worldIdentity !== world.identity) {
    ocean.fail(
      ocean.failure(
        'water-advanced-invalid-input',
        'query feedback bound to the extracting World identity',
      ),
    );
    frame = undefined;
  }
  if (frame) ocean.retain(frame);
  return {
    key,
    worldIdentity: world.identity,
    recipe: ocean.recipe,
    generation: inspection.generation,
    active: state.status !== 'disabled' && state.status !== 'retired',
    viewIdentity,
    ...(frame ? { frame } : {}),
    size:
      state.status === 'initializing' && state.allocation === 'initial-1x1'
        ? 1
        : ocean.recipe.asset.oceanPatchConfig.fftResolution,
    allocation: state.status === 'initializing',
    ...(noise ? { noise } : {}),
    ...(inspection.visualNormalDetailFft
      ? {
          visualChild: {
            revision: inspection.visualNormalDetailFft.revision,
            noiseRevision: inspection.visualNormalDetailFft.noiseRevision,
          },
        }
      : {}),
    ...(frame && config.algorithm === 'mode-projected-gravity/1'
      ? { collisions: captureDispersiveCollisions(context, worldIndex, frame, collisionMeshes) }
      : {}),
  };
}

function planShallowRow(
  row: Row,
  prior: SubmittedSequence | undefined,
  initialized: number | undefined,
  supported: AdvancedFormatSupport,
  fieldInitialization?: SdfSceneFieldPayload['initialization'],
): PlannedAdvancedRow {
  const retain = () =>
    pendingShallowWork(row, row.active && initialized === row.generation ? initialized : undefined);
  if (prior?.generation === row.generation && prior.sequence >= row.frame.sequence)
    return { work: retain() };
  if (row.collisions.kind === 'pending') return { work: retain() };
  const config = row.recipe.asset.shallowStageConfig;
  const error = supported(config.normalRtFormat, [
    config.gridResolution[0],
    config.gridResolution[1] * 2,
  ])
    ? row.collisions.kind === 'failed'
      ? row.collisions.error
      : undefined
    : failure(
        row,
        'water-advanced-unsupported',
        'compute, storage buffers, selected float formats and measured maxTextureDimension2D',
      );
  const feedback = {
    key: row.key,
    generation: row.generation,
    sequence: row.frame.sequence,
    ...(error ? { error } : {}),
  };
  if (error || row.collisions.kind !== 'ready') return { work: retain(), feedback };
  const previous =
    prior?.kind === 'shallow' &&
    prior.generation === row.generation &&
    !row.frame.reset &&
    prior.collisions.nativeSourceIdentity === row.collisions.value.nativeSourceIdentity
      ? prior
      : undefined;
  const delta =
    previous === undefined
      ? 0
      : (row.collisions.value.nativeSourceTimeSeconds ?? row.frame.timeSeconds) -
        previous.timeSeconds;
  if (!Number.isFinite(delta) || delta < 0)
    return {
      work: retain(),
      feedback: {
        ...feedback,
        error: failure(
          row,
          'water-advanced-invalid-input',
          'a full nondecreasing accepted native source interval',
        ),
      },
    };
  return {
    work: shallowWork(
      row,
      advancedCollisionHistory(row.collisions.value, previous?.collisions),
      delta,
      fieldInitialization,
    ),
    feedback,
  };
}

function validOceanNoise(row: OceanRow): boolean {
  const noise = row.noise;
  const expectedRevision =
    row.frame?.visualNormalDetailFft?.noiseRevision ??
    row.visualChild?.noiseRevision ??
    row.frame?.noiseRevision;
  return (
    noise !== undefined &&
    noise.revision === expectedRevision &&
    noise.asset.shape.viewDimension === '2d' &&
    noise.asset.encoding === undefined &&
    noise.asset.format === 'rgba8unorm' &&
    noise.asset.colorSpace === 'linear' &&
    noise.asset.data.length === noise.asset.shape.extent.width * noise.asset.shape.extent.height * 4
  );
}

function retainsCurrentVisualOutput(
  row: OceanRow,
  initialized: InitializedOcean | undefined,
  supported: AdvancedFormatSupport,
  deviceGeneration: number,
): boolean {
  const config = row.recipe.asset.oceanPatchConfig;
  const child = row.frame?.visualNormalDetailFft ?? row.visualChild;
  const output = initialized?.visualOutput;
  if (
    !row.active ||
    config.algorithm !== 'mode-projected-gravity/1' ||
    !('visualNormalDetailFft' in config) ||
    !child ||
    !output
  )
    return false;
  const size = config.visualNormalDetailFft.fftResolution;
  return (
    initialized.generation === row.generation &&
    output.generation === row.generation &&
    output.revision === child.revision &&
    output.noiseRevision === child.noiseRevision &&
    output.size === size &&
    output.deviceGeneration === deviceGeneration &&
    validOceanNoise(row) &&
    supported(config.visualNormalDetailFft.normalRtFormat, [size, size])
  );
}

function planOceanRow(
  row: OceanRow,
  prior: SubmittedSequence | undefined,
  initialized: InitializedOcean | undefined,
  supported: AdvancedFormatSupport,
  deviceGeneration: number,
  fieldInitialization?: SdfSceneFieldPayload['initialization'],
): Readonly<{
  work: RenderFeatureWork;
  row?: OceanRow;
  feedback?: AdvancedFeedback['oceans'][number];
}> {
  const retain = () =>
    pendingOceanWork(
      row,
      row.active && initialized?.generation === row.generation ? initialized : undefined,
      retainsCurrentVisualOutput(row, initialized, supported, deviceGeneration),
    );
  if (!row.frame) return { work: retain() };
  if (prior?.generation === row.generation && prior.sequence >= row.frame.sequence)
    return { work: retain() };
  if (row.collisions?.kind === 'pending') return { work: retain() };
  const previous =
    prior?.kind === 'ocean' && prior.generation === row.generation ? prior : undefined;
  const current = initialized?.generation === row.generation ? initialized : undefined;
  const size = current === undefined ? row.size : row.recipe.asset.oceanPatchConfig.fftResolution;
  const reset = current === undefined || current.size !== size;
  row = {
    ...row,
    size,
    allocation: reset,
    frame: {
      ...row.frame,
      waveImpulses: (row.frame.waveImpulses ?? []).filter(
        (impulse) => impulse.sequence > (previous?.waveImpulseSequence ?? 0),
      ),
      reset,
      reseedSource: previous?.sourceRevision !== row.frame.sourceRevision,
      captureStages:
        row.frame.captureRequest !== null &&
        row.frame.captureRequest > (previous?.captureRequest ?? 0),
    },
  };
  const frame = row.frame;
  if (!frame) return { work: retain() };
  const facts = { size, allocation: reset, reset, captureStages: frame.captureStages };
  if (row.recipe.asset.oceanPatchConfig.algorithm === 'mode-projected-gravity/1') {
    const planDispersiveOceanRow = (
      row: OceanRow,
      config: Extract<
        OceanRow['recipe']['asset']['oceanPatchConfig'],
        { algorithm: 'mode-projected-gravity/1' }
      >,
    ) => {
      const visualConfig =
        'visualNormalDetailFft' in config ? config.visualNormalDetailFft : undefined;
      const delta =
        reset || previous === undefined || frame.reseedSource
          ? 0
          : frame.timeSeconds - previous.timeSeconds;
      const budget =
        row.collisions?.kind === 'ready'
          ? dispersiveSourceBudget(config, row.collisions.value)
          : undefined;
      const validateDispersiveOceanRow = () => {
        const error = !supported(config.normalRtFormat, [row.size, row.size * 2])
          ? failure(
              row,
              'water-advanced-unsupported',
              'compute and selected float targets within actual device dimensions',
            )
          : row.collisions?.kind === 'failed'
            ? row.collisions.error
            : budget
              ? failure(row, 'water-advanced-unsupported', budget)
              : delta < 0 || delta > config.maximumIntervalSeconds
                ? failure(
                    row,
                    'water-advanced-invalid-input',
                    `a full native source interval in [0, ${config.maximumIntervalSeconds}] seconds`,
                    {
                      deltaSeconds: delta,
                      maximumIntervalSeconds: config.maximumIntervalSeconds,
                      currentTimeSeconds: frame.timeSeconds,
                      priorTimeSeconds: previous?.timeSeconds,
                      currentSequence: frame.sequence,
                      priorSequence: previous?.sequence,
                      currentNativeStep: frame.nativeSourceStep,
                      priorNativeStep: previous?.nativeSourceStep,
                      captureRequested: frame.captureStages,
                      sourceRevision: frame.sourceRevision,
                      priorSourceRevision: previous?.sourceRevision,
                    },
                  )
                : undefined;
        return error;
      };
      const error = validateDispersiveOceanRow();
      const validateOceanVisualOutput = () => {
        const visualError = visualConfig
          ? !supported(visualConfig.normalRtFormat, [
              visualConfig.fftResolution,
              visualConfig.fftResolution,
            ])
            ? failure(
                row,
                'water-advanced-unsupported',
                'the visual FFT resolution and selected float target within actual device dimensions',
              )
            : !validOceanNoise(row)
              ? failure(
                  row,
                  'water-advanced-invalid-input',
                  'an accepted native linear RGBA8 texture for the visual FFT child revision',
                )
              : undefined
          : undefined;
        return visualError;
      };
      const visualError = validateOceanVisualOutput();
      const retainDispersiveOceanFrame = () => {
        const held =
          (frame.paused &&
            !frame.captureStages &&
            !frame.queryFeedback &&
            !frame.waveImpulses?.length &&
            !frame.reset &&
            !frame.visualNormalDetailFft?.reset) ||
          (previous !== undefined &&
            delta === 0 &&
            !frame.captureStages &&
            !frame.queryFeedback &&
            !frame.waveImpulses?.length &&
            !frame.reset &&
            !row.allocation &&
            row.collisions?.kind === 'ready' &&
            previous.sourceIdentity === dispersiveSourceIdentity(row.collisions.value) &&
            !frame.reseedSource &&
            !frame.visualNormalDetailFft?.reset &&
            !visualError);
        return held;
      };
      const held = retainDispersiveOceanFrame();
      return {
        row,
        work:
          error || held || row.collisions?.kind !== 'ready'
            ? retain()
            : dispersiveOceanWork(
                { ...row, frame },
                prior,
                fieldInitialization,
                visualConfig && row.noise && !visualError ? row.noise : undefined,
              ),
        ...(!held || visualError
          ? {
              feedback: {
                key: row.key,
                generation: row.generation,
                sequence: frame.sequence,
                ...facts,
                ...(error ? { error } : {}),
                ...(!error && visualError ? { visualError } : {}),
              },
            }
          : {}),
      };
    };
    return planDispersiveOceanRow(row, row.recipe.asset.oceanPatchConfig);
  }
  const error = !supported(row.recipe.asset.oceanPatchConfig.normalRtFormat, [
    row.size,
    row.size * 2,
  ])
    ? failure(
        row,
        'water-advanced-unsupported',
        'compute, storage buffers, selected float formats and measured maxTextureDimension2D',
      )
    : !validOceanNoise(row)
      ? failure(
          row,
          'water-advanced-invalid-input',
          'an accepted native linear RGBA8 noise snapshot for the exact recipe GUID and frame revision',
        )
      : undefined;
  return {
    row,
    work: error || !row.noise ? retain() : oceanWork({ ...row, frame, noise: row.noise }),
    feedback: {
      key: row.key,
      generation: row.generation,
      sequence: frame.sequence,
      ...facts,
      ...(error ? { error } : {}),
    },
  };
}

function submitShallowSources(
  data: AdvancedFrame,
  source: SourceFrame,
  feedback: AdvancedFeedback,
  submission: RenderFeatureSubmission | undefined,
  devices: WeakMap<WaterAdvancedSimulation | WaterOceanPatch, number>,
): void {
  for (const row of data.rows) {
    const owner = source.shallow.get(row.key),
      receipt = feedback.shallow.find(
        (candidate) =>
          candidate.key === row.key &&
          candidate.generation === row.generation &&
          candidate.sequence === row.frame.sequence,
      );
    if (!owner || !receipt || owner.inspect().generation !== row.generation) continue;
    if (receipt.error) {
      owner.fail(receipt.error);
      continue;
    }
    if (!shallowSubmitted(row, submission)) continue;
    const previousDevice = devices.get(owner);
    if (previousDevice !== undefined && previousDevice !== feedback.deviceGeneration) {
      owner.deviceLost();
      devices.set(owner, feedback.deviceGeneration);
      continue;
    }
    devices.set(owner, feedback.deviceGeneration);
    if (
      owner.submitted(row.frame, row.frame.stages.length).ok &&
      !feedback.localReadbacks &&
      (row.frame.captureStages || row.frame.bakeRequest !== null)
    )
      owner.unavailableReadbacks(row.frame, {
        path: 'published-feature',
        reason:
          'the publication source acknowledgment carries submission facts, not completed observation bytes',
      });
  }
}

function submitOceanSources(
  data: AdvancedFrame,
  source: SourceFrame,
  feedback: AdvancedFeedback,
  submission: RenderFeatureSubmission | undefined,
  devices: WeakMap<WaterAdvancedSimulation | WaterOceanPatch, number>,
): void {
  for (const row of data.oceans) {
    const owner = source.oceans.get(row.key)?.owner,
      frame = row.frame;
    const receipt = feedback.oceans.find(
      (candidate) =>
        candidate.key === row.key &&
        candidate.generation === row.generation &&
        candidate.sequence === frame?.sequence,
    );
    if (!owner || !frame || !receipt || owner.inspect().generation !== row.generation) continue;
    if (receipt.error) {
      owner.fail(receipt.error);
      continue;
    }
    if (!oceanSubmitted(row, submission, receipt.requiredPasses)) continue;
    if (receipt.visualError) owner.unavailableVisualNormalDetailFft(receipt.visualError);
    const previousDevice = devices.get(owner);
    if (previousDevice !== undefined && previousDevice !== feedback.deviceGeneration) {
      owner.deviceLost();
      devices.set(owner, feedback.deviceGeneration);
      continue;
    }
    devices.set(owner, feedback.deviceGeneration);
    if (!owner.submitted(frame, receipt).ok) continue;
    const visualFft = submittedVisualNormalDetailFft(row, submission);
    if (visualFft && !receipt.visualError)
      owner.visualNormalDetailFftSubmitted(frame, visualFft.size, feedback.deviceGeneration);
    if (receipt.allocation) owner.allocated(receipt.size, feedback.deviceGeneration);
    if (!feedback.localReadbacks && receipt.captureStages)
      owner.unavailableReadbacks(frame, {
        path: 'published-feature',
        reason:
          'the publication source acknowledgment carries submission facts, not completed observation bytes',
      });
  }
}

/** Extract publishes detached facts; source-owned controllers are reachable only through this WeakMap. */
export function createWaterAdvancedFeature(waterInfoFeature: object): RenderFeature<AdvancedFrame> {
  const inactiveSourceData: AdvancedFrame = Object.freeze({
    sourceFrameNumber: 0,
    rows: Object.freeze([]),
    pending: Object.freeze([]),
    oceans: Object.freeze([]),
  });
  const collisionMeshes = new AdvancedCollisionMeshOwner();
  const sourceFrames = new WeakMap<AdvancedFrame, SourceFrame>();
  const devices = new WeakMap<WaterAdvancedSimulation | WaterOceanPatch, number>();
  const initializedShallow = new Map<string, number>();
  const initializedOcean = new Map<string, InitializedOcean>();
  const submittedSequences = new Map<string, SubmittedSequence>();
  const plannedOceanPasses = new WeakMap<AdvancedFrame, ReadonlyMap<string, OceanPassPlan>>();
  let receiverDevice: number | undefined;
  let submitted:
    | Readonly<{
        data: AdvancedFrame;
        source: SourceFrame;
        shallow: readonly Row[];
        oceans: readonly OceanRow[];
      }>
    | undefined;
  return {
    identity: WATER_ADVANCED_FEATURE_IDENTITY,
    placement: 'scene',
    profileGraphPasses(viewScopes) {
      if (viewScopes.length === 0) return [];
      const currentScopes = new Set(viewScopes);
      const declarations: RenderFeatureProfileGraphPass[] = [];
      for (const [key, submitted] of submittedSequences) {
        if (submitted.kind !== 'ocean' || submitted.profile === undefined) continue;
        const candidate = submitted.profile;
        if (
          !currentScopes.has(candidate.viewIdentity) ||
          candidate.deviceGeneration !== receiverDevice ||
          submitted.deviceGeneration !== candidate.deviceGeneration
        )
          continue;
        if (
          candidate.world.identity !== candidate.worldIdentity ||
          !candidate.world.hasResource(WATER_SYSTEM_RESOURCE) ||
          candidate.world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE).oceanPatch() !==
            candidate.owner ||
          candidate.recipe !== candidate.owner.recipe
        )
          continue;

        // This is intentionally read only during capture admission: the latest
        // accepted source roster already owns the namespace and generation facts.
        const captureCurrentOceanProfile = () => {
          const current = candidate.owner._queryProfileState();
          const config = candidate.recipe.asset.oceanPatchConfig;
          const initialized = initializedOcean.get(key);
          return { current, config, initialized };
        };
        const { current, config, initialized } = captureCurrentOceanProfile();
        const currentOceanProfileUnavailable = () => {
          if (
            current.generation !== candidate.generation ||
            current.recipeGuid !== candidate.recipe.guid ||
            current.recipeVersion !== candidate.recipe.contentVersion ||
            !current.enabled ||
            current.algorithm !== 'mode-projected-gravity/1' ||
            config.algorithm !== current.algorithm ||
            current.resolution !== config.fftResolution ||
            candidate.size !== current.resolution ||
            current.size !== candidate.size ||
            current.binding === undefined ||
            current.binding?.worldIdentity !== candidate.worldIdentity ||
            submitted.generation !== candidate.generation ||
            !acceptedQueryReceiversMatch(submitted.querySources, current.receivers) ||
            initialized?.generation !== candidate.generation ||
            initialized.size !== candidate.size
          )
            return true;
          return false;
        };
        if (currentOceanProfileUnavailable()) continue;

        const names = waterOceanPatchQueryPassNames(candidate.recipe.guid, candidate.worldIdentity);
        for (const [index] of current.receivers.entries())
          declarations.push({
            view: candidate.viewIdentity,
            name: viewSharedFeatureGraphPassName(candidate.viewIdentity, names.receiver(index)),
            kind: 'compute',
          });
        declarations.push(
          {
            view: candidate.viewIdentity,
            name: viewSharedFeatureGraphPassName(candidate.viewIdentity, names.sample),
            kind: 'compute',
          },
          {
            view: candidate.viewIdentity,
            name: viewSharedFeatureGraphPassName(candidate.viewIdentity, names.readback),
            kind: 'copy',
          },
        );
      }
      return declarations;
    },
    inactiveSourceData,
    extract(context) {
      collisionMeshes.beginFrame();
      const rows: Row[] = [],
        pending: PendingShallow[] = [],
        oceans: OceanRow[] = [];
      const source: SourceFrame = {
        shallow: new Map(),
        oceans: new Map(),
        sdfFieldInitializations: new WeakMap(),
      };
      const shallowOwners = source.shallow as Map<string, WaterAdvancedSimulation>;
      const oceanOwners = source.oceans as Map<
        string,
        Readonly<{
          owner: WaterOceanPatch;
          world: RenderFeatureExtractContext['world'];
        }>
      >;
      const selected = context.views.find((view) => view.render);
      if (selected) {
        const deviceGeneration = selected.frame?.view?.deviceGeneration;
        const publication = waterInfoFramePublicationForRenderer(
          waterInfoFeature,
          selected.identity,
          context.frameNumber,
          deviceGeneration ?? 0,
        );
        const acceptDevice = (owner: WaterAdvancedSimulation | WaterOceanPatch) => {
          if (deviceGeneration === undefined) return;
          const previous = devices.get(owner);
          if (previous !== undefined && previous !== deviceGeneration) owner.deviceLost();
          devices.set(owner, deviceGeneration);
        };
        for (const [worldIndex, world] of [context.world].entries()) {
          if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
          const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
          for (const simulation of system.advancedSimulations()) {
            acceptDevice(simulation);
            const info = [...(publication?.rows.values() ?? [])].find(
              (row) =>
                row.worldIdentity === world.identity &&
                row.bodyGuid === simulation.body.guid &&
                row.bodyGeneration === simulation.body.generation,
            );
            simulation.bindWaterInfo(
              info
                ? {
                    status: 'ready',
                    bodyGeneration: info.bodyGeneration,
                    zoneGeneration: info.zoneGeneration,
                    targetName: info.targetName,
                    targetFormat: info.targetFormat,
                    slice: info.slice,
                    centerXZ: info.context.centerXZ,
                    extentM: info.context.extentXZ,
                    waterHeightRangeM: [info.context.waterYMinM, info.context.waterYMaxM],
                    groundHeightRangeM: [info.context.groundYMinM, info.context.waterYMaxM],
                    maxVelocityMPerSec: info.context.maxVelocityMPerSec,
                  }
                : { status: 'pending', bodyGeneration: simulation.body.generation },
            );
            const state = simulation.inspect();
            const key = JSON.stringify([
              world.identity,
              identityOrdinal(simulation),
              simulation.recipe.guid,
              simulation.body.guid,
              simulation.body.generation,
            ]);
            const common: PendingShallow = {
              key,
              worldIdentity: world.identity,
              recipe: simulation.recipe,
              body: simulation.body,
              generation: state.generation,
              active: state.status !== 'disabled' && state.status !== 'retired',
              viewIdentity: selected.identity,
            };
            shallowOwners.set(key, simulation);
            const frame = simulation.frame();
            if (frame) {
              const collisions = captureAdvancedCollisions(
                context,
                worldIndex,
                frame,
                collisionMeshes,
              );
              if (collisions.kind === 'ready') {
                const initialization = collisionMeshes.fieldInitializationFor(collisions.value);
                if (initialization !== undefined)
                  source.sdfFieldInitializations.set(collisions.value, initialization);
              }
              rows.push({
                ...common,
                frame,
                collisions,
              });
            } else pending.push(common);
          }
          const ocean = system.oceanPatch();
          if (!ocean) continue;
          acceptDevice(ocean);
          const oceanRow = captureOceanRow(
            context,
            worldIndex,
            world,
            ocean,
            selected.identity,
            collisionMeshes,
          );
          if (oceanRow.collisions?.kind === 'ready') {
            const initialization = collisionMeshes.fieldInitializationFor(
              oceanRow.collisions.value,
            );
            if (initialization !== undefined)
              source.sdfFieldInitializations.set(oceanRow.collisions.value, initialization);
          }
          oceans.push(oceanRow);
          oceanOwners.set(oceanRow.key, Object.freeze({ owner: ocean, world }));
        }
      }
      const data: AdvancedFrame = { sourceFrameNumber: context.frameNumber, rows, pending, oceans };
      collisionMeshes.finishFrame();
      if (!context.world.hasResource(WATER_SYSTEM_RESOURCE)) return ok(inactiveSourceData);
      sourceFrames.set(data, source);
      return ok(data);
    },
    requiresPreparation: (data) =>
      data.rows.length > 0 || data.pending.length > 0 || data.oceans.length > 0,
    plan(data, context) {
      const deviceGeneration = context.deviceGeneration ?? 0;
      if (receiverDevice !== deviceGeneration) {
        initializedShallow.clear();
        initializedOcean.clear();
        submittedSequences.clear();
        receiverDevice = deviceGeneration;
      }
      const live = new Set([...data.rows, ...data.pending, ...data.oceans].map((row) => row.key));
      for (const key of submittedSequences.keys())
        if (!live.has(key)) {
          submittedSequences.delete(key);
          initializedShallow.delete(key);
          initializedOcean.delete(key);
        }
      const sourceFrame = sourceFrames.get(data);
      const work: RenderFeatureWork[] = [];
      const oceanPasses = new Map<string, OceanPassPlan>();
      const shallow: AdvancedFeedback['shallow'][number][] = [],
        oceans: AdvancedFeedback['oceans'][number][] = [];
      const caps = context.caps,
        maxDimension = context.limits?.maxTextureDimension2D;
      const supported = (format: 'rgba16float' | 'rgba32float', dimensions: readonly number[]) =>
        caps.compute === true &&
        caps.storageTexture === true &&
        caps.storageBuffer === true &&
        caps.rgba32floatStorage === true &&
        (format !== 'rgba16float' || caps.rgba16floatStorage === true) &&
        maxDimension !== undefined &&
        dimensions.every((size) => size <= maxDimension);
      const retainShallow = (row: PendingShallow) =>
        work.push(
          pendingShallowWork(
            row,
            row.active && initializedShallow.get(row.key) === row.generation
              ? row.generation
              : undefined,
          ),
        );
      for (const row of data.pending) retainShallow(row);
      for (const row of data.rows) {
        const planned = planShallowRow(
          row,
          submittedSequences.get(row.key),
          initializedShallow.get(row.key),
          supported,
          row.collisions.kind === 'ready'
            ? sourceFrame?.sdfFieldInitializations.get(row.collisions.value)
            : undefined,
        );
        work.push(planned.work);
        if (planned.feedback) shallow.push(planned.feedback);
      }
      for (const row of data.oceans) {
        const planned = planOceanRow(
          row,
          submittedSequences.get(row.key),
          initializedOcean.get(row.key),
          supported,
          deviceGeneration,
          row.collisions?.kind === 'ready'
            ? sourceFrame?.sdfFieldInitializations.get(row.collisions.value)
            : undefined,
        );
        work.push(planned.work);
        if (planned.feedback) {
          const declared = planned.work.passes
            .filter(
              (pass) => (pass.kind === 'compute' || pass.kind === 'copy') && pass.enabled !== false,
            )
            .map((pass) => ({ name: pass.name, kind: pass.kind as 'compute' | 'copy' }));
          const requiredPasses =
            planned.feedback.error ||
            (row.recipe.asset.oceanPatchConfig.algorithm === 'mode-projected-gravity/1' &&
              !declared.some((pass) => pass.name.endsWith('-advance-wave')))
              ? []
              : declared;
          if (planned.row)
            oceanPasses.set(row.key, { row: planned.row, requiredPasses, deviceGeneration });
          oceans.push({ ...planned.feedback, requiredPasses });
        }
      }
      plannedOceanPasses.set(data, oceanPasses);
      const sourceFeedback: AdvancedFeedback = {
        kind: 'water-advanced-submission',
        sourceFrameNumber: data.sourceFrameNumber,
        deviceGeneration,
        localReadbacks: sourceFrames.has(data),
        shallow,
        oceans,
      };
      const scopes = new Map<string, RenderFeatureWork[]>();
      for (const item of work) {
        const key = item.scope === 'frame' ? 'frame' : item.scope.view;
        const group = scopes.get(key) ?? [];
        group.push(item);
        scopes.set(key, group);
      }
      return ok({
        work: [...scopes.values()].flatMap((group) => {
          const first = group[0];
          return first === undefined
            ? []
            : [
                {
                  scope: first.scope,
                  resources: group.flatMap((item) => item.resources),
                  passes: group.flatMap((item) => item.passes),
                },
              ];
        }),
        sourceFeedback,
      });
    },
    onFrameSubmitted(data, submission) {
      const source = sourceFrames.get(data);
      const submitOceanQueryReadbacks = () => {
        for (const row of data.oceans) {
          if (!row.frame?.queryFeedback) continue;
          const owner = source?.oceans.get(row.key)?.owner,
            readback = waterOceanPatchQueryPassNames(row.recipe.guid, row.worldIdentity).readback;
          if (submission?.works.some((work) => work.passes.some((pass) => pass.name === readback)))
            owner?.submittedQueryReadback(row.frame);
          else owner?.acceptQueryReadback(row.frame, undefined);
        }
      };
      submitOceanQueryReadbacks();
      const shallow = data.rows.filter((row) => shallowSubmitted(row, submission));
      const oceanPlans = plannedOceanPasses.get(data);
      const oceans = data.oceans.flatMap((original) => {
        const planned = oceanPlans?.get(original.key);
        return original.frame &&
          planned?.row.frame &&
          oceanSubmitted(planned.row, submission, planned.requiredPasses)
          ? [{ ...planned.row, frame: original.frame }]
          : [];
      });
      for (const row of shallow) {
        initializedShallow.set(row.key, row.generation);
        if (row.collisions.kind === 'ready')
          submittedSequences.set(row.key, {
            kind: 'shallow',
            generation: row.generation,
            sequence: row.frame.sequence,
            timeSeconds: row.collisions.value.nativeSourceTimeSeconds ?? row.frame.timeSeconds,
            collisions: row.collisions.value,
          });
      }
      const commitOceanSequences = () => {
        for (const row of oceans) {
          const previous = submittedSequences.get(row.key);
          const sourceOwner = source?.oceans.get(row.key);
          const querySources = receiverSourceStates(
            row,
            previous?.kind === 'ocean' ? previous.querySources : undefined,
          );
          const plan = oceanPlans?.get(row.key);
          const visual = plan ? submittedVisualNormalDetailFft(plan.row, submission) : undefined;
          const child = row.frame?.visualNormalDetailFft;
          initializedOcean.set(row.key, {
            generation: row.generation,
            size: row.size,
            querySources,
            ...(visual && child && plan
              ? {
                  visualOutput: {
                    generation: row.generation,
                    revision: child.revision,
                    noiseRevision: child.noiseRevision,
                    size: visual.size,
                    deviceGeneration: plan.deviceGeneration,
                  },
                }
              : {}),
          });
          submittedSequences.set(row.key, {
            kind: 'ocean',
            generation: row.generation,
            deviceGeneration: receiverDevice ?? 0,
            sequence: row.frame.sequence,
            timeSeconds: row.frame.timeSeconds,
            nativeSourceStep: row.frame.nativeSourceStep,
            ...(sourceOwner === undefined
              ? {}
              : {
                  profile: Object.freeze({
                    owner: sourceOwner.owner,
                    world: sourceOwner.world,
                    recipe: row.recipe,
                    worldIdentity: row.worldIdentity,
                    generation: row.generation,
                    viewIdentity: row.viewIdentity,
                    size: row.size,
                    deviceGeneration: receiverDevice ?? 0,
                  }),
                }),
            sourceRevision: row.frame.sourceRevision,
            waveImpulseSequence: Math.max(
              previous?.kind === 'ocean' && previous.generation === row.generation
                ? (previous.waveImpulseSequence ?? 0)
                : 0,
              ...(row.frame.waveImpulses ?? []).map((impulse) => impulse.sequence),
            ),
            captureRequest: Math.max(
              row.frame.captureRequest ?? 0,
              previous?.kind === 'ocean' && previous.generation === row.generation
                ? previous.captureRequest
                : 0,
            ),
            querySources,
            ...(row.collisions?.kind === 'ready'
              ? {
                  sourceIdentity: dispersiveSourceIdentity(row.collisions.value),
                  collisions: row.collisions.value,
                }
              : {}),
          });
        }
      };
      commitOceanSequences();
      plannedOceanPasses.delete(data);
      submitted = source ? { data, source, shallow, oceans } : undefined;
    },
    onSourceFrameSubmitted(data, feedback, submission) {
      if (!isFeedback(feedback) || feedback.sourceFrameNumber !== data.sourceFrameNumber) return;
      const source = sourceFrames.get(data);
      if (!source) return;
      submitShallowSources(data, source, feedback, submission, devices);
      submitOceanSources(data, source, feedback, submission, devices);
    },
    onSourceFrameCompleted(data, completion, feedback, submission, readbacks) {
      if (isFeedback(feedback) && feedback.localReadbacks) return;
      const source = sourceFrames.get(data);
      sourceFrames.delete(data);
      if (
        !source ||
        !isFeedback(feedback) ||
        feedback.localReadbacks ||
        feedback.sourceFrameNumber !== data.sourceFrameNumber ||
        feedback.deviceGeneration !== completion.deviceGeneration
      )
        return;
      const receipt = { ...completion, graphGeneration: completion.graphGeneration ?? 0 };
      const observations = readbacks?.ok === true ? readbacks.value : undefined;
      const readbackError =
        readbacks?.ok === false
          ? readbacks.error
          : { reason: 'source-frame feature-texture observations were not returned' };
      const pixels = (prefix: string) =>
        (observations ?? []).flatMap((observation) =>
          observation.name.startsWith(prefix) &&
          ['rgba16float', 'rgba32float', 'rgba8unorm'].includes(observation.metadata.format)
            ? [
                {
                  ...observation.metadata,
                  name: observation.name,
                  format: observation.metadata.format as
                    | 'rgba16float'
                    | 'rgba32float'
                    | 'rgba8unorm',
                  bytes: observation.bytes,
                  completion: receipt,
                },
              ]
            : [],
        );
      const completeShallowSourceRows = () => {
        for (const row of data.rows) {
          const owner = source.shallow.get(row.key);
          if (
            !owner ||
            devices.get(owner) !== receipt.deviceGeneration ||
            !shallowSubmitted(row, submission)
          )
            continue;
          const accepted = feedback.shallow.some(
            (candidate) =>
              candidate.key === row.key &&
              candidate.generation === row.generation &&
              candidate.sequence === row.frame.sequence &&
              !candidate.error,
          );
          if (
            accepted &&
            owner.completed(row.frame, receipt).ok &&
            (row.frame.captureStages || row.frame.bakeRequest !== null)
          ) {
            if (observations === undefined) owner.unavailableReadbacks(row.frame, readbackError);
            else
              owner.acceptReadbacks(
                row.frame,
                pixels(
                  waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity)
                    .prefix,
                ),
              );
          }
        }
      };
      completeShallowSourceRows();
      const completeOceanSourceRows = () => {
        for (const row of data.oceans) {
          const owner = source.oceans.get(row.key)?.owner,
            frame = row.frame;
          if (
            !owner ||
            !frame ||
            devices.get(owner) !== receipt.deviceGeneration ||
            !oceanSubmitted(
              row,
              submission,
              feedback.oceans.find(
                (candidate) => candidate.key === row.key && candidate.sequence === frame.sequence,
              )?.requiredPasses,
            )
          )
            continue;
          const acceptedReceipt = feedback.oceans.find(
            (candidate) =>
              candidate.key === row.key &&
              candidate.generation === row.generation &&
              candidate.sequence === frame.sequence &&
              !candidate.error,
          );
          const completed =
            acceptedReceipt &&
            owner.completed(frame, receipt, acceptedReceipt.size, acceptedReceipt.allocation).ok;
          if (frame.queryFeedback) {
            const queryName = waterOceanPatchOutputNames(
              row.recipe.guid,
              row.worldIdentity,
            ).queryHeight;
            const query = observations?.find(
              (observation) =>
                observation.name === queryName && observation.metadata.format === 'r32float',
            );
            owner.acceptQueryReadback(
              frame,
              query ? { ...query.metadata, bytes: query.bytes, completion: receipt } : undefined,
            );
          }
          if (completed && acceptedReceipt?.captureStages) {
            if (observations === undefined) owner.unavailableReadbacks(frame, readbackError);
            else
              owner.acceptReadbacks(
                frame,
                pixels(waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity).prefix),
              );
          }
        }
      };
      completeOceanSourceRows();
    },
    onSourceFrameDiscarded(data) {
      const source = sourceFrames.get(data);
      for (const row of data.oceans)
        if (row.frame) source?.oceans.get(row.key)?.owner.discarded(row.frame);
      sourceFrames.delete(data);
    },
    onFrameAborted(data) {
      const source = sourceFrames.get(data);
      for (const row of data.oceans)
        if (row.frame) source?.oceans.get(row.key)?.owner.discarded(row.frame);
      sourceFrames.delete(data);
      plannedOceanPasses.delete(data);
      if (submitted?.data === data) submitted = undefined;
    },
    onFrameReceipt(receipt, observations) {
      const frame = submitted;
      submitted = undefined;
      if (!frame) return;
      void observations
        .then((result) => {
          const completion = {
            frameId: receipt.frameId,
            deviceGeneration: receipt.deviceGeneration,
            graphGeneration: receipt.graphGeneration ?? 0,
          };
          const pixels = (prefix: string) =>
            result.ok
              ? result.value.flatMap((observation) =>
                  observation.domain === 'feature-texture' &&
                  observation.name.startsWith(prefix) &&
                  ['rgba16float', 'rgba32float', 'rgba8unorm'].includes(observation.metadata.format)
                    ? [
                        {
                          ...observation.metadata,
                          name: observation.name,
                          format: observation.metadata.format as
                            | 'rgba16float'
                            | 'rgba32float'
                            | 'rgba8unorm',
                          bytes: observation.bytes,
                          completion,
                        },
                      ]
                    : [],
                )
              : [];
          for (const row of frame.shallow) {
            const owner = frame.source.shallow.get(row.key);
            if (!owner) continue;
            if (!result.ok) {
              owner.unavailableReadbacks(row.frame, result.error);
              continue;
            }
            if (owner.completed(row.frame, completion).ok)
              owner.acceptReadbacks(
                row.frame,
                pixels(
                  waterAdvancedOutputNames(row.recipe.guid, row.body.guid, row.worldIdentity)
                    .prefix,
                ),
              );
          }
          for (const row of frame.oceans) {
            const owner = frame.source.oceans.get(row.key)?.owner;
            if (!owner || !row.frame) continue;
            if (!result.ok) {
              owner.unavailableReadbacks(row.frame, result.error);
              if (row.frame.queryFeedback) owner.acceptQueryReadback(row.frame, undefined);
              continue;
            }
            if (owner.completed(row.frame, completion, row.size, row.allocation).ok) {
              if (row.frame.queryFeedback) {
                const queryName = waterOceanPatchOutputNames(
                  row.recipe.guid,
                  row.worldIdentity,
                ).queryHeight;
                const query = result.value.find(
                  (observation) =>
                    observation.domain === 'feature-texture' &&
                    observation.name === queryName &&
                    observation.metadata.format === 'r32float',
                );
                owner.acceptQueryReadback(
                  row.frame,
                  query ? { ...query.metadata, bytes: query.bytes, completion } : undefined,
                );
              }
              owner.acceptReadbacks(
                row.frame,
                pixels(waterOceanPatchOutputNames(row.recipe.guid, row.worldIdentity).prefix),
              );
            } else if (row.frame.queryFeedback) owner.acceptQueryReadback(row.frame, undefined);
          }
        })
        .catch((cause: unknown) => {
          for (const row of frame.shallow)
            frame.source.shallow.get(row.key)?.unavailableReadbacks(row.frame, cause);
          for (const row of frame.oceans)
            if (row.frame) {
              const owner = frame.source.oceans.get(row.key);
              const patch = owner?.owner;
              if (row.frame.queryFeedback) patch?.acceptQueryReadback(row.frame, undefined);
              patch?.unavailableReadbacks(row.frame, cause);
            }
        })
        .finally(() => {
          for (const row of frame.data.oceans)
            if (row.frame?.queryFeedback)
              frame.source.oceans.get(row.key)?.owner.acceptQueryReadback(row.frame, undefined);
        });
    },
  };
}
