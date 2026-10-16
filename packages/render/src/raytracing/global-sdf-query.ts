import type {
  Buffer,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { GlobalSdfComposition } from './global-sdf';
import {
  packReferenceRays,
  RAY_INPUT_STRIDE,
  RAY_REFERENCE_LIMIT,
  type RayReferenceError,
  type ReferenceRay,
  rayReferenceFailure,
} from './scene';

/** A frozen world region supplies approximate visibility, never a triangle or Card identity. */
export const GlobalSdfQueryStatus = {
  miss: 0,
  hit: 1,
  negativeStart: 2,
  stepBudget: 3,
  missingField: 4,
  outsideRegion: 5,
} as const;
export const GLOBAL_SDF_HIT_STRIDE = 64;
export interface GlobalSdfQuery {
  readonly rayCount: number;
  /** voxels/grid are borrowed; dispose releases only rays/hits/settings. */
  readonly buffers: Readonly<{
    voxels: Buffer;
    grid: Buffer;
    rays: Buffer;
    hits: Buffer;
    settings: Buffer;
  }>;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError | RhiError>;
  dispose(): void;
}

/** One trilinear sampling rule for traversal and post-trace origin diagnostics. */
export const GLOBAL_SDF_SAMPLE_WGSL = `
struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct Voxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
struct Sample { distance: f32, coverage: f32, status: u32 }
fn sampleGlobal(p: vec3f) -> Sample {
 let dims=grid.dimensionsCount.xyz;
 let q=clamp((p-grid.originSpacing.xyz)/grid.originSpacing.w,vec3f(0),vec3f(dims-vec3u(1u)));
 let cell=vec3u(min(floor(q),vec3f(dims-vec3u(2u))));let f=q-vec3f(cell);
 var result=Sample(0,0,1u);
 for(var z=0u;z<2u;z++){for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
  let offset=vec3u(x,y,z);let w=select(vec3f(1)-f,f,offset>vec3u(0));let weight=w.x*w.y*w.z;
  if(weight>0.0){
   let c=cell+offset;let v=voxels[(c.z*dims.y+c.y)*dims.x+c.x];
   if(v.status!=1u){return Sample(0,0,v.status);}
   result.distance+=v.distance*weight;result.coverage+=v.coverage*weight;
  }
 }}}
 return result;
}
`;

/** Region traversal core. The composing kernel declares `Ray` (the shared
 * 48-byte ray ABI), `grid`, and `voxels`; it owns its bindings and entry points. */
export const GLOBAL_SDF_TRACE_WGSL = `
// state: status, unavailable voxel status, steps, reserved.
// metrics: ray t, surface expansion, first sampled distance, geometry coverage.
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn traceGlobal(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 var result=Hit(vec4u(${GlobalSdfQueryStatus.miss}u,0,0,0),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
 if(ray.mask.x==0u){return result;}
 let h=grid.originSpacing.w*0.5;
 // Keep one stored sample border for hit-normal differences.
 let lo=grid.originSpacing.xyz+vec3f(grid.originSpacing.w);
 let hi=grid.originSpacing.xyz+vec3f(grid.dimensionsCount.xyz-vec3u(2u))*grid.originSpacing.w;
 let start=ray.origin+ray.direction*ray.tMin;
 if(any(start<lo)||any(start>hi)){
  result.state.x=${GlobalSdfQueryStatus.outsideRegion}u;result.metrics.x=ray.tMin;result.position=vec4f(start,1);return result;
 }
 var far=ray.tMax;
 for(var a=0u;a<3u;a++){
  if(ray.direction[a]>0.0){far=min(far,(hi[a]-ray.origin[a])/ray.direction[a]);}
  else if(ray.direction[a]<0.0){far=min(far,(lo[a]-ray.origin[a])/ray.direction[a]);}
 }
 let scale=max(abs(ray.direction.x),max(abs(ray.direction.y),abs(ray.direction.z)));
 let speed=scale*length(ray.direction/scale);
 var t=ray.tMin;var maxDistance=0.0;var expansion=0.0;
 for(var step=0u;step<maxSteps;step++){
  result.state.z=step+1u;let p=ray.origin+ray.direction*t;let sample=sampleGlobal(p);
  result.metrics.x=t;result.position=vec4f(p,1);
  if(sample.status!=1u){result.state.x=${GlobalSdfQueryStatus.missingField}u;result.state.y=sample.status;return result;}
  if(step==0u){result.metrics.z=sample.distance;}
  result.metrics.w=sample.coverage;
  if(step==0u && sample.distance<0.0){result.state.x=${GlobalSdfQueryStatus.negativeStart}u;return result;}
  maxDistance=max(maxDistance,sample.distance);
  expansion=h*clamp(maxDistance/(2.0*h),0.0,1.0);result.metrics.y=expansion;
  if(sample.distance<expansion){
   t=clamp(t+(sample.distance-expansion)/speed,ray.tMin,far);
   let hitPosition=ray.origin+ray.direction*t;
   var gradient=vec3f(0);
   for(var a=0u;a<3u;a++){
    var offset=vec3f(0);offset[a]=h;
    let positive=sampleGlobal(hitPosition+offset);let negative=sampleGlobal(hitPosition-offset);
    if(positive.status!=1u || negative.status!=1u){
     result.state.x=${GlobalSdfQueryStatus.missingField}u;result.state.y=select(negative.status,positive.status,positive.status!=1u);return result;
    }
    gradient[a]=positive.distance-negative.distance;
   }
   result.state.x=${GlobalSdfQueryStatus.hit}u;result.metrics.x=t;result.position=vec4f(hitPosition,1);
   result.normal=vec4f(gradient/max(length(gradient),1e-20),0);return result;
  }
  let next=t+max(sample.distance,h*minStepFactor)/speed;
  if(next<=t){result.state.x=${GlobalSdfQueryStatus.stepBudget}u;return result;}
  if(next>far){
   // Only a fully covered requested interval can report an approximate miss.
   result.state.x=select(${GlobalSdfQueryStatus.outsideRegion}u,${GlobalSdfQueryStatus.miss}u,far==ray.tMax);
   result.metrics.x=far;result.position=vec4f(ray.origin+ray.direction*far,1);return result;
  }
  t=next;
 }
 result.state.x=${GlobalSdfQueryStatus.stepBudget}u;return result;
}
`;

export const GLOBAL_SDF_QUERY_WGSL = `
${GLOBAL_SDF_SAMPLE_WGSL}
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
${GLOBAL_SDF_TRACE_WGSL}
@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage,read> rays: array<Ray>;
@group(0) @binding(3) var<storage,read_write> hits: array<Hit>;
@group(0) @binding(4) var<uniform> settings: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x<arrayLength(&rays)){hits[id.x]=traceGlobal(rays[id.x],settings.x,bitcast<f32>(settings.y));}
}
`;

export interface GlobalSdfQueryOptions {
  readonly maxSteps?: number;
  /** Minimum advance relative to half spacing; lower values sample narrow field minima. */
  readonly minStepFactor?: number;
}

/** Validate and pack the unchanged query settings for either ray producer. */
export function packGlobalSdfQuerySettings(
  grid: GlobalSdfComposition['grid'],
  options: GlobalSdfQueryOptions = {},
) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return rayReferenceFailure('global SDF query options must be an object');
  const maxSteps = options.maxSteps ?? 256;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1024)
    return rayReferenceFailure('global SDF query allows 1..1024 steps', true);
  const minStepFactor = Math.fround(options.minStepFactor ?? 1);
  if (
    !Number.isFinite(minStepFactor) ||
    minStepFactor <= 0 ||
    minStepFactor > 1 ||
    Math.fround(grid.spacing * 0.5 * minStepFactor) < 2 ** -126
  )
    return rayReferenceFailure(
      'global SDF minimum step factor must be in (0, 1] and produce a normal f32 world advance',
    );
  if (grid.dimensions.some((n) => n < 4) || Math.fround(grid.spacing * 0.5) <= 0)
    return rayReferenceFailure(
      'global SDF tracing requires 4..128 centers per axis and a finite positive half spacing',
    );
  const settings = new Uint8Array(16);
  const settingsView = new DataView(settings.buffer);
  settingsView.setUint32(0, maxSteps, true);
  settingsView.setFloat32(4, minStepFactor, true);
  return ok(settings);
}

/** Caller records composition before query, retains its buffers, then retires both after submission. */
export async function createGlobalSdfQuery(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  composition: GlobalSdfComposition,
  rays: readonly ReferenceRay[],
  options: GlobalSdfQueryOptions = {},
): Promise<Result<GlobalSdfQuery, RayReferenceError | RhiError>> {
  const packed = packReferenceRays(rays);
  if (!packed.ok) return packed;
  const querySettings = packGlobalSdfQuerySettings(composition.grid, options);
  if (!querySettings.ok) return querySettings;
  if (
    rays.some(
      (r) =>
        (r.mask !== 0 && r.mask !== 255) ||
        // WGSL may flush subnormals. Validate the rounded inputs, including
        // intermediate products, before they can form an invalid sample position.
        !Number.isFinite(Math.fround(Math.hypot(...r.direction.map(Math.fround)))) ||
        Math.hypot(...r.direction.map(Math.fround)) < 2 ** -126 ||
        r.origin.some((origin, axis) =>
          [r.tMin, r.tMax].some(
            (t) =>
              !Number.isFinite(
                Math.fround(
                  Math.fround(origin) +
                    Math.fround(Math.fround(r.direction[axis] ?? 0) * Math.fround(t)),
                ),
              ),
          ),
        ),
    )
  )
    return rayReferenceFailure(
      'a composed world region requires mask 255 or 0, a finite normal f32 ray length and finite f32 endpoints',
    );
  const owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const buffer of owned) device.destroyBuffer(buffer);
    owned.length = 0;
  };
  const settings = querySettings.value;
  const data = {
    rays: packed.value,
    hits: new Uint8Array(rays.length * GLOBAL_SDF_HIT_STRIDE),
    settings,
  };
  const buffers = {
    voxels: composition.buffers.voxels,
    grid: composition.buffers.settings,
  } as Record<keyof GlobalSdfQuery['buffers'], Buffer>;
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const bytes = data[key];
    const made = device.createBuffer({
      label: `global-sdf.query.${key}`,
      size: bytes.byteLength,
      usage: (key === 'settings' ? 64 : 128) | 12,
    });
    if (!made.ok) {
      dispose();
      return made;
    }
    buffers[key] = made.value;
    owned.push(made.value);
    const wrote = device.queue.writeBuffer(made.value, 0, bytes);
    if (!wrote.ok) {
      dispose();
      return wrote;
    }
  }
  const fail = <T>(result: Result<never, T>) => {
    dispose();
    return result;
  };
  const rayCount = packed.value.byteLength / RAY_INPUT_STRIDE;
  const input: GlobalSdfQueryInputs = {
    voxels: { buffer: buffers.voxels, size: composition.voxelCount * 16 },
    grid: { buffer: buffers.grid, size: 48 },
    rays: { buffer: buffers.rays, size: packed.value.byteLength },
    hits: { buffer: buffers.hits, size: rayCount * GLOBAL_SDF_HIT_STRIDE },
    settings: { buffer: buffers.settings, size: 16 },
  };
  const shader = await compile(device, { code: GLOBAL_SDF_QUERY_WGSL, label: 'global-sdf.query' });
  if (!shader.ok) return fail(shader);
  const recorder = createGlobalSdfQueryRecorder(device, shader.value);
  if (!recorder.ok) return fail(recorder);
  return ok({
    buffers,
    rayCount,
    dispose,
    record(encoder) {
      if (disposed) return rayReferenceFailure('global SDF query is disposed');
      const pass = encoder.beginComputePass({ label: 'global-sdf.query' });
      const result = recorder.value.record(pass, input, rayCount);
      pass.end();
      return result;
    },
  });
}

/** Exact borrowed ranges; the caller owns allocation, initialization and retirement.
 * Grid is the unchanged 48-byte GlobalSdfComposition settings and voxels its complete
 * 16-byte record range (4..128 centers/axis). Settings is u32 maxSteps (1..1024),
 * f32 minStepFactor ((0,1], producing a normal f32 half-spacing advance), then zeroes.
 * Rays use the 48-byte ReferenceRay ABI. Their producer must ensure finite f32
 * origins/directions/endpoints, normal nonzero direction length, 0 <= tMin < tMax,
 * and mask 0 or 255. CPU placeholder validation cannot validate later GPU writes.
 * Record the producer before this query; no data readback or submission occurs here.
 * RHI validates actual allocation capacity, usage and device ownership. */
export type GlobalSdfQueryInputs = Readonly<
  Record<
    'voxels' | 'grid' | 'rays' | 'hits' | 'settings',
    { readonly buffer: Buffer; readonly offset?: number; readonly size: number }
  >
>;

/** One query kernel for CPU-authored and GPU-produced rays. Owns no buffers or queue work. */
export function createGlobalSdfQueryRecorder(device: RhiDevice, module: ShaderModule) {
  const failure = (expected: string, code: RhiError['code'] = 'rhi-descriptor-invalid') =>
    err(
      new RhiError({
        code,
        expected,
        hint: 'Supply supported limits, exact borrowed ranges and producer-validated Global SDF inputs.',
      }),
    );
  if (!device.caps.compute || !device.caps.storageBuffer)
    return failure('compute and storage-buffer support for Global SDF query', 'rhi-not-available');
  for (const [name, required] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 5],
    ['maxStorageBuffersPerShaderStage', 3],
    ['maxUniformBuffersPerShaderStage', 2],
    ['maxUniformBufferBindingSize', 48],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
  ] as const)
    if (!(device.limits[name] >= required))
      return failure(`Global SDF query requires ${name} >= ${required}`, 'limit-exceeded');
  const layout = device.createBindGroupLayout({
    entries: [16, 48, RAY_INPUT_STRIDE, GLOBAL_SDF_HIT_STRIDE, 16].map(
      (minBindingSize, binding) => ({
        binding,
        visibility: 4,
        buffer: {
          type:
            binding === 1 || binding === 4
              ? ('uniform' as const)
              : binding === 3
                ? ('storage' as const)
                : ('read-only-storage' as const),
          minBindingSize,
        },
      }),
    ),
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: 'global-sdf.query',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'main' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: GlobalSdfQueryInputs,
      rayCount: number,
    ): Result<void, RhiError> {
      if (
        !Number.isSafeInteger(rayCount) ||
        rayCount < 1 ||
        rayCount > RAY_REFERENCE_LIMIT ||
        !(Math.ceil(rayCount / 64) <= device.limits.maxComputeWorkgroupsPerDimension)
      )
        return failure('Global SDF ray count in 1..65536 within dispatch limits', 'limit-exceeded');
      if (
        input.rays.size !== rayCount * RAY_INPUT_STRIDE ||
        input.hits.size !== rayCount * GLOBAL_SDF_HIT_STRIDE ||
        input.grid.size !== 48 ||
        input.settings.size !== 16 ||
        !Number.isSafeInteger(input.voxels.size) ||
        input.voxels.size < 4 ** 3 * 16 ||
        input.voxels.size > 128 ** 3 * 16 ||
        input.voxels.size % 16 !== 0
      )
        return failure('exact ray/hit/grid/settings ranges and a complete Global SDF voxel range');
      for (const name of ['voxels', 'grid', 'rays', 'hits', 'settings'] as const) {
        const range = input[name],
          offset = range.offset ?? 0;
        const uniform = name === 'grid' || name === 'settings';
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset %
            (uniform
              ? device.limits.minUniformBufferOffsetAlignment
              : device.limits.minStorageBufferOffsetAlignment) !==
            0
        )
          return failure(`device-aligned nonnegative ${name} offset`);
        if (
          !Number.isSafeInteger(offset + range.size) ||
          !(offset + range.size <= device.limits.maxBufferSize) ||
          !(
            range.size <=
            (uniform
              ? device.limits.maxUniformBufferBindingSize
              : device.limits.maxStorageBufferBindingSize)
          )
        )
          return failure(`${name} range within device buffer limits`, 'limit-exceeded');
      }
      if (
        (['voxels', 'grid', 'rays', 'settings'] as const).some(
          (name) => input[name].buffer === input.hits.buffer,
        )
      )
        return failure('Global SDF query hits must not alias any borrowed input');
      const group = device.createBindGroup({
        layout: layout.value,
        entries: [input.voxels, input.grid, input.rays, input.hits, input.settings].map(
          (value, binding) => ({ binding, resource: { kind: 'buffer' as const, value } }),
        ),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(rayCount / 64));
      return ok(undefined);
    },
  });
}
