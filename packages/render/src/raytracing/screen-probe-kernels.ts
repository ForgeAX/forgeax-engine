import {
  type BindGroup,
  type BindGroupLayout,
  type Buffer,
  type RhiComputePassEncoder,
  type RhiDevice,
  RhiError,
  type ShaderModule,
  type TextureView,
  type Tlas,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GlobalSdfQueryStatus } from './global-sdf-query';
import {
  type Binding,
  createComputeLayout,
  createIrradianceFieldSampleLayout,
  type IrradianceFieldKernelInput,
  kernelResource,
  linearDispatch,
} from './irradiance-field';
import { ScreenProbeRayStatus } from './screen-probe-plan';
import {
  WORLD_CARD_RADIANCE_WGSL,
  WORLD_TRAVERSAL_ROSTER,
  type WorldTraversal,
  worldTraversalWgsl,
} from './world-traversal';

/** Named group-0 resources of `forgeax_ray::screen_probe`; the binding index is the SSOT in WGSL. */
export const SCREEN_PROBE_BINDINGS = {
  frame: [0, 'uniform'],
  view: [1, 'uniform'],
  depth: [2, 'depth'],
  normal: [3, 'uint'],
  depthPyramid: [4, 'float'],
  scene: [5, 'float'],
  probes: [6, 'storage'],
  probesIn: [7, 'read'],
  adaptiveCount: [8, 'storage'],
  adaptiveCountIn: [9, 'read'],
  tileAdaptive: [10, 'storage'],
  tileAdaptiveIn: [11, 'read'],
  rays: [12, 'storage'],
  raysIn: [13, 'read'],
  previousScene: [14, 'read'],
  previousSceneOut: [15, 'storage'],
  radianceIn: [16, 'read'],
  radianceOut: [17, 'storage'],
  probeRadiance: [19, 'read'],
  integratedOut: [20, 'storage'],
  integrated: [21, 'read'],
  historyIn: [22, 'read'],
  historyOut: [23, 'storage'],
  metaIn: [24, 'read'],
  metaOut: [25, 'storage'],
  probeHistoryIn: [26, 'read'],
  probeHistoryOut: [27, 'storage'],
} as const satisfies Record<string, readonly [number, Binding]>;
export type ScreenProbeSlot = keyof typeof SCREEN_PROBE_BINDINGS;

/** Published entry -> its binding roster and dispatch shape. */
export const SCREEN_PROBE_STAGES = {
  placeUniformProbes: {
    slots: ['frame', 'view', 'depth', 'normal', 'probes', 'adaptiveCount', 'tileAdaptive'],
    dispatch: 'threads',
  },
  placeAdaptiveProbes: {
    slots: ['frame', 'view', 'depth', 'normal', 'probes', 'adaptiveCount', 'tileAdaptive'],
    dispatch: 'threads',
  },
  compactAdaptiveProbes: {
    slots: ['frame', 'view', 'depth', 'normal', 'probes', 'adaptiveCount', 'tileAdaptive'],
    dispatch: 'threads',
  },
  generateProbeRays: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'rays'],
    dispatch: 'probes',
  },
  traceScreenProbes: {
    slots: [
      'frame',
      'view',
      'depth',
      'normal',
      'depthPyramid',
      'probesIn',
      'rays',
      'previousScene',
    ],
    dispatch: 'threads',
  },
  resolveProbeRays: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'raysIn', 'radianceOut'],
    dispatch: 'probes',
  },
  temporalProbeRadiance: {
    slots: ['frame', 'probesIn', 'radianceIn', 'radianceOut', 'probeHistoryIn', 'probeHistoryOut'],
    dispatch: 'probes',
  },
  filterProbeRadiance: {
    slots: ['frame', 'probesIn', 'adaptiveCountIn', 'radianceIn', 'radianceOut'],
    dispatch: 'probes',
  },
  integrateScreenProbes: {
    slots: [
      'frame',
      'view',
      'depth',
      'normal',
      'probesIn',
      'adaptiveCountIn',
      'tileAdaptiveIn',
      'probeRadiance',
      'integratedOut',
    ],
    dispatch: 'threads',
  },
  temporalScreenProbes: {
    slots: [
      'frame',
      'view',
      'depth',
      'normal',
      'integrated',
      'historyIn',
      'historyOut',
      'metaIn',
      'metaOut',
    ],
    dispatch: 'threads',
  },
  copySceneHistory: { slots: ['frame', 'scene', 'previousSceneOut'], dispatch: 'threads' },
} as const satisfies Record<
  string,
  { readonly slots: readonly ScreenProbeSlot[]; readonly dispatch: 'threads' | 'probes' }
>;
export type ScreenProbeStage = keyof typeof SCREEN_PROBE_STAGES;

export type ScreenProbeResource =
  | { readonly buffer: Buffer; readonly size?: number }
  | TextureView
  | Tlas;

export interface ScreenProbeKernel {
  /** The group-0 roster the graph declares as accesses. */
  readonly bindings: readonly (readonly [number, Binding, string])[];
  /** `work` is threads for per-thread entries and probes for per-probe entries. */
  record(
    pass: RhiComputePassEncoder,
    resolve: (slot: string) => ScreenProbeResource,
    sample: BindGroup | undefined,
    work: number,
  ): Result<void, RhiError>;
}

function createKernel(
  device: RhiDevice,
  module: ShaderModule,
  label: string,
  entryPoint: string,
  roster: readonly (readonly [number, Binding, string])[],
  sampleLayout: BindGroupLayout | undefined,
  perProbe: boolean,
): Result<ScreenProbeKernel, RhiError> {
  const layout = createComputeLayout(
    device,
    roster.map(([binding, kind]) => [binding, kind] as const),
  );
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: sampleLayout === undefined ? [layout.value] : [layout.value, sampleLayout],
  });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label,
    layout: pipelineLayout.value,
    compute: { module, entryPoint },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    bindings: roster,
    record(pass, resolve, sample, work) {
      const group = device.createBindGroup({
        layout: layout.value,
        entries: roster.map(([binding, kind, name]) =>
          kernelResource(binding, kind, resolve(name)),
        ),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      if (sampleLayout !== undefined) {
        if (sample === undefined) return err(missingSample(label));
        pass.setBindGroup(1, sample);
      }
      const units = Math.max(1, work);
      if (perProbe) {
        const max = device.limits.maxComputeWorkgroupsPerDimension;
        const x = Math.min(units, max);
        pass.dispatchWorkgroups(x, Math.ceil(units / x));
      } else {
        const [x, y] = linearDispatch(device, units);
        pass.dispatchWorkgroups(x, y);
      }
      return ok(undefined);
    },
  });
}

/** One pipeline per published entry; group(1) is the Irradiance Field sample ABI. */
export function createScreenProbeKernels(device: RhiDevice, module: ShaderModule) {
  const sampleLayout = createIrradianceFieldSampleLayout(device, 'live');
  if (!sampleLayout.ok) return sampleLayout;
  const kernels = {} as Record<ScreenProbeStage, ScreenProbeKernel>;
  for (const stage of Object.keys(SCREEN_PROBE_STAGES) as ScreenProbeStage[]) {
    const spec = SCREEN_PROBE_STAGES[stage];
    const roster = spec.slots.map((slot) => {
      const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
      return [binding, kind, slot] as const;
    });
    const kernel = createKernel(
      device,
      module,
      `screen-probe.${stage}`,
      stage,
      roster,
      sampleLayout.value,
      spec.dispatch === 'probes',
    );
    if (!kernel.ok) return kernel;
    kernels[stage] = kernel.value;
  }
  return ok({ sampleLayout: sampleLayout.value, kernels });
}

function missingSample(label: string): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: `${label} requires the Irradiance Field sample group`,
    hint: 'bind the current field sample group before recording screen-probe stages',
    detail: { error: { code: 'screen-probe-sample-missing', message: label } },
  });
}

/** World trace for rays the screen trace left unresolved (UE
 * ScreenProbeTraceVoxels/MeshSDF -> Card radiance), mirroring the Irradiance
 * Field probe trace through the same world traversal: hit -> lit Card
 * texels; miss -> environment;
 * backface -> zero; budget/field failures -> field fallback. */
export const screenProbeWorldWgsl = (traversal: WorldTraversal) => `${worldTraversalWgsl(traversal)}
struct ScreenProbeFrame { extent: vec4u, probes: vec4u, control: vec4u, environment: vec4f, tuning: vec4f, query: vec4u }
struct ScreenProbe { position: vec3f, distance: f32, normal: vec3f, pixel: u32 }
struct ProbeRay { direction: vec3f, info: u32, radiance: vec3f, hitDistance: f32 }
@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
@group(0) @binding(7) var<storage,read_write> rays: array<ProbeRay>;
@group(0) @binding(8) var<storage,read> probesIn: array<ScreenProbe>;
@group(0) @binding(9) var<uniform> probeFrame: ScreenProbeFrame;
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;
${WORLD_CARD_RADIANCE_WGSL}
fn withStatus(info: u32, status: u32) -> u32 { return (info & ~(7u << 12u)) | (status << 12u); }
@compute @workgroup_size(64) fn traceWorldProbes(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let i=gid.x+gid.y*groups.x*64u;
 if(i>=(probeFrame.probes.x+probeFrame.probes.y)*64u){return;}
 var ray=rays[i];
 if(((ray.info>>12u)&7u)!=${ScreenProbeRayStatus.world}u){return;}
 ray.hitDistance=-1.0;
 let probe=probesIn[i/64u];
 let tMax=probeFrame.environment.w;
 if(tMax<=0.0){ray.radiance=probeFrame.environment.xyz;ray.info=withStatus(ray.info,${ScreenProbeRayStatus.resolved}u);rays[i]=ray;return;}
 // Screen misses do not prove empty world space, especially at subpixel walls.
 let origin=worldSurfaceOrigin(probe.position,probe.normal,probeFrame.tuning.z);
 let hit=traceWorld(Ray(origin,0.0,ray.direction,tMax,vec4u(1u,0u,0u,0u)),probeFrame.query.x,bitcast<f32>(probeFrame.query.y));
 let status=hit.state.x;
 if(status==${GlobalSdfQueryStatus.missingField}u){
  ray.radiance=vec3f(0.0);ray.info=withStatus(ray.info,${ScreenProbeRayStatus.incomplete}u);rays[i]=ray;return;
 }
 var resolved=true;
 if(status==${GlobalSdfQueryStatus.miss}u||status==${GlobalSdfQueryStatus.outsideRegion}u){
  ray.radiance=probeFrame.environment.xyz;
  ray.hitDistance=tMax;
 } else if(status==${GlobalSdfQueryStatus.negativeStart}u||(status==${GlobalSdfQueryStatus.hit}u&&dot(ray.direction,hit.normal.xyz)>0.0)){
  ray.radiance=vec3f(0.0);
  ray.hitDistance=select(length(hit.position.xyz-probe.position),0.0,status==${GlobalSdfQueryStatus.negativeStart}u);
 } else if(status==${GlobalSdfQueryStatus.hit}u){
   let card=worldCardRadiance(hit,probeFrame.tuning.w,true);
   ray.radiance=max(card.xyz,vec3f(0));resolved=card.w>=0.0;
   if(resolved){ray.hitDistance=length(hit.position.xyz-probe.position);}
 } else { resolved=false; }
 ray.info=withStatus(ray.info,select(${ScreenProbeRayStatus.fallback}u,${ScreenProbeRayStatus.resolved}u,resolved));
 rays[i]=ray;
}
`;

/** Irradiance Field resources plus the screen-probe frame/probes/rays the world kernel reads. */
export type ScreenProbeWorldInput =
  | Exclude<
      IrradianceFieldKernelInput,
      'lights' | 'field' | 'surfaces' | 'probeRays' | 'irradiance' | 'moments' | 'meta' | 'frame'
    >
  | 'rays'
  | 'probesIn'
  | 'probeFrame';

export const screenProbeWorldRoster = (
  traversal: WorldTraversal,
): readonly (readonly [number, Binding, ScreenProbeWorldInput])[] => [
  ...WORLD_TRAVERSAL_ROSTER[traversal],
  [5, 'read', 'cards'],
  [6, 'read', 'cardLit'],
  [7, 'storage', 'rays'],
  [8, 'read', 'probesIn'],
  [9, 'uniform', 'probeFrame'],
  [10, 'uniform', 'cardSettings'],
  [11, 'float', 'albedoRoughness'],
  [12, 'float', 'normals'],
  [13, 'float', 'emissionMetallic'],
  [14, 'float', 'f0Validity'],
  [15, 'depth', 'depth'],
];

/** The world trace already binds eight storage buffers (the WebGPU default
 * per-stage limit), so it carries no field sample group. */
export function createScreenProbeWorldKernel(
  device: RhiDevice,
  module: ShaderModule,
  traversal: WorldTraversal,
) {
  return createKernel(
    device,
    module,
    'screen-probe.traceWorldProbes',
    'traceWorldProbes',
    screenProbeWorldRoster(traversal),
    undefined,
    false,
  );
}
