import {
  type FieldVec3,
  type MeshDistanceField,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  packReferenceRays,
  type RayReferenceError,
  type ReferenceRay,
  rayGeometryKey,
  rayReferenceFailure,
} from './scene';
import { packGeometricField, packSampledField, SDF_BRICK_EDGE } from './sdf-field-storage';

export const SdfQueryStatus = {
  miss: 0,
  surfaceBand: 1,
  insideStart: 2,
  stepBudget: 3,
  missingField: 4,
  /** Approximate scene visibility; metrics.y is zero, not a geometric uncertainty bound. */
  visibilityHit: 5,
} as const;
export interface SdfMeshInstance {
  readonly instanceId: number;
  readonly geometryId: number;
  readonly mask: number;
  readonly transform: ArrayLike<number>;
  readonly field:
    | MeshDistanceField
    | {
        readonly missing: true;
        readonly bounds: { readonly min: FieldVec3; readonly max: FieldVec3 };
      };
}
export function sdfInstanceKey(instance: SdfMeshInstance): string {
  return JSON.stringify([
    instance.instanceId,
    instance.geometryId,
    instance.mask,
    Array.from(instance.transform),
    'missing' in instance.field
      ? instance.field.bounds
      : [
          instance.field.meshDigest,
          instance.field.policy,
          instance.field.dimensions,
          instance.field.origin,
          instance.field.spacing,
        ],
  ]);
}
export interface SdfQuery {
  readonly sources: readonly { readonly instanceId: number; readonly key: string }[];
  readonly buffers: Readonly<{
    instances: Buffer;
    fields: Buffer;
    rays: Buffer;
    hits: Buffer;
    settings: Buffer;
  }>;
  readonly rayCount: number;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
export interface SdfQueryOptions {
  readonly maxSteps?: number;
  /** Ray distance favors diffuse coverage; clearance reduces reflection self-occlusion. */
  readonly visibilityExpansion?: 'clearance' | 'ray-distance';
}
export const SDF_HIT_STRIDE = 64;
export const SDF_INSTANCE_STRIDE = 144;
export const SDF_SAMPLE_WGSL = `
struct Instance { inverse: mat4x4f, ids: vec4u, field: vec4u, origin: vec4f, extent: vec4f, error: vec4f }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct SdfHit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn sdfTexel(m: Instance, c: vec3u) -> f32 {
  if(m.error.w>0.5){
    let edge=${SDF_BRICK_EDGE}u;
    let dims=(m.field.yzw+vec3u(edge-1u))/edge;
    let b=c/edge;
    let entry=fields[m.field.x+(b.z*dims.y+b.y)*dims.x+b.x];
    let p=c%edge;let local=(p.z*edge+p.y)*edge+p.x;
    return unpack2x16snorm(fields[m.field.x+entry+(local>>1u)])[local&1u]*m.extent.w;
  }
  return bitcast<f32>(fields[m.field.x+(c.z*m.field.z+c.y)*m.field.y+c.x]);
}
fn sdfValue(m: Instance, p: vec3f) -> f32 {
  let q=clamp((p-m.origin.xyz)/m.origin.w,vec3f(0),vec3f(m.field.yzw-vec3u(1u)));
  let cell=vec3u(min(floor(q),vec3f(m.field.yzw-vec3u(2u))));
  let f=q-vec3f(cell); var value=0.0;
  for(var z=0u;z<2u;z++){ for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
    let c=cell+vec3u(x,y,z); let w=select(vec3f(1)-f,f,vec3u(x,y,z)>vec3u(0));
    value+=sdfTexel(m,c)*w.x*w.y*w.z;
  }}}
  return value;
}
`;
export const SDF_TRACE_WGSL = `${SDF_SAMPLE_WGSL}fn sdfNormal(m: Instance,p: vec3f) -> vec3f {
  let h=select(m.origin.w,m.origin.w*0.5,m.error.w>0.5);let g=vec3f(sdfValue(m,p+vec3f(h,0,0))-sdfValue(m,p-vec3f(h,0,0)),
    sdfValue(m,p+vec3f(0,h,0))-sdfValue(m,p-vec3f(0,h,0)),sdfValue(m,p+vec3f(0,0,h))-sdfValue(m,p-vec3f(0,0,h)));
  let n=transpose(mat3x3f(m.inverse[0].xyz,m.inverse[1].xyz,m.inverse[2].xyz))*g;
  return n/max(length(n),1e-20);
}
fn traceSdf(ray: Ray, instanceCount: u32, maxSteps: u32, rayDistanceExpansion: bool) -> SdfHit {
var result=SdfHit(vec4u(${SdfQueryStatus.miss}u,0xffffffffu,0xffffffffu,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
  var totalSteps=0u;
  for(var i=0u;i<instanceCount;i++){
    let m=instances[i];if((m.ids.w&ray.mask.x)==0u){continue;}
    let o=(m.inverse*vec4f(ray.origin,1)).xyz;let d=(m.inverse*vec4f(ray.direction,0)).xyz;
    let visibility=m.error.w>0.5;let lo=select(m.origin.xyz,m.origin.xyz+vec3f(m.origin.w),visibility);
    var near=ray.tMin;var far=ray.tMax;var overlap=true;
    for(var axis=0u;axis<3u;axis++){
      if(d[axis]==0.0){if(o[axis]<lo[axis]||o[axis]>m.extent[axis]){overlap=false;}}
      else{let a=(lo[axis]-o[axis])/d[axis];let b=(m.extent[axis]-o[axis])/d[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
    }
    if(!overlap||near>far||near>result.metrics.x){continue;}
    var t=near;var status=${SdfQueryStatus.miss}u;var steps=0u;var insideHeuristic=0.0;
    if(m.field.x==0xffffffffu){status=${SdfQueryStatus.missingField}u;}
    else if(visibility){
      let speed=length(d);var maxDistance=0.0;
      for(var step=0u;step<maxSteps;step++){
        steps++;let value=sdfValue(m,o+d*t);
        if(step==0u && near==ray.tMin && value<0.0){insideHeuristic=1.0;}
        maxDistance=max(maxDistance,value);
        let expansionDistance=select(maxDistance,t*speed,rayDistanceExpansion);
        let expansion=m.error.x*clamp(expansionDistance/(2.0*m.error.x),0.0,1.0);
        if(value<expansion){
          t=clamp(t+(value-expansion)/speed,near,far);status=${SdfQueryStatus.visibilityHit}u;break;
        }
        let next=t+max(value,m.error.z)/speed;
        if(next<=t){status=${SdfQueryStatus.stepBudget}u;break;}
        t=next;
        if(t>far+expansion/speed || t>result.metrics.x){break;}
        if(step+1u==maxSteps){status=${SdfQueryStatus.stepBudget}u;}
      }
    }else {
      for(var step=0u;step<maxSteps;step++){
        if(t>far||t>result.metrics.x){break;}
        steps++;let p=o+d*t;let value=sdfValue(m,p);
        if(value < -m.error.x && step==0u && near==ray.tMin){status=${SdfQueryStatus.insideStart}u;break;}
        if(value<=m.error.x+m.origin.w*0.02){status=${SdfQueryStatus.surfaceBand}u;break;}
        let advance=(value-m.error.x)*0.9/length(d);
        if(t+advance<=t){status=${SdfQueryStatus.stepBudget}u;break;}
        t+=advance;
        if(step+1u==maxSteps && t<=far){status=${SdfQueryStatus.stepBudget}u;}
      }
    }
    totalSteps+=steps;
    if(status!=${SdfQueryStatus.miss}u && t<=result.metrics.x){
      var n=vec3f(0);if(status==${SdfQueryStatus.surfaceBand}u||status==${SdfQueryStatus.visibilityHit}u){n=sdfNormal(m,o+d*t);}
      result=SdfHit(vec4u(status,m.ids.xyz),vec4f(t,m.error.y,0,insideHeuristic),vec4f(ray.origin+ray.direction*t,1),vec4f(n,0));
    }
  }
  result.metrics.z=f32(totalSteps);return result;
}
`;
export const SDF_QUERY_WGSL = `
@group(0) @binding(0) var<storage,read> instances: array<Instance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> rays: array<Ray>;
@group(0) @binding(3) var<storage,read_write> hits: array<SdfHit>;
@group(0) @binding(4) var<uniform> settings: vec4u;
${SDF_TRACE_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u){
 if(gid.x<arrayLength(&rays)){hits[gid.x]=traceSdf(rays[gid.x],settings.x,settings.y,settings.z==1u);}
}
`;

/** One bounded snapshot. Missing field entries retain bounds so they cannot become sky. */
export async function createSdfQuery(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  source: readonly SdfMeshInstance[],
  rays: readonly ReferenceRay[],
  options: SdfQueryOptions = {},
): Promise<Result<SdfQuery, RayReferenceError | RhiError>> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return rayReferenceFailure('SDF query options must be an object');
  const { maxSteps = 128, visibilityExpansion = 'clearance' } = options;
  if (visibilityExpansion !== 'clearance' && visibilityExpansion !== 'ray-distance')
    return rayReferenceFailure('SDF visibility expansion must be clearance or ray-distance');
  const packed = packReferenceRays(rays);
  if (!packed.ok) return packed;
  if (source.length > 64 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1024)
    return rayReferenceFailure('SDF profile allows 64 instances and 1..1024 steps', true);
  const scene = packSdfScene(source);
  if (!scene.ok) return scene;
  const sources = source.map((instance) => ({
    instanceId: instance.instanceId,
    key: rayGeometryKey(
      instance,
      'missing' in instance.field ? 'missing' : instance.field.meshDigest,
    ),
  }));
  const rayCount = rays.length;
  const owned: Buffer[] = [];
  const dispose = () => {
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
  };
  const make = (label: string, bytes: Uint8Array, uniform = false) => {
    const result = device.createBuffer({
      label: `sdf.${label}`,
      size: bytes.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!result.ok) return result;
    owned.push(result.value);
    const wrote = device.queue.writeBuffer(result.value, 0, bytes);
    return wrote.ok ? result : wrote;
  };
  const data = {
    ...scene.value,
    rays: packed.value,
    hits: new Uint8Array(rays.length * SDF_HIT_STRIDE),
    settings: new Uint8Array(
      new Uint32Array([source.length, maxSteps, visibilityExpansion === 'ray-distance' ? 1 : 0, 0])
        .buffer,
    ),
  };
  const buffers = {} as Record<keyof typeof data, Buffer>;
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const b = make(key, data[key], key === 'settings');
    if (!b.ok) {
      dispose();
      return b;
    }
    buffers[key] = b.value;
  }
  const shader = await compile(device, { code: SDF_QUERY_WGSL, label: 'sdf.trace' });
  if (!shader.ok) {
    dispose();
    return shader;
  }
  const bgl = device.createBindGroupLayout({
    entries: [0, 1, 2, 3, 4].map((binding) => ({
      binding,
      visibility: 4,
      buffer: {
        type:
          binding === 4
            ? ('uniform' as const)
            : binding === 3
              ? ('storage' as const)
              : ('read-only-storage' as const),
      },
    })),
  });
  if (!bgl.ok) {
    dispose();
    return bgl;
  }
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!layout.ok) {
    dispose();
    return layout;
  }
  const group = device.createBindGroup({
    layout: bgl.value,
    entries: Object.values(buffers).map((buffer, binding) => ({
      binding,
      resource: { kind: 'buffer' as const, value: { buffer } },
    })),
  });
  if (!group.ok) {
    dispose();
    return group;
  }
  const pipeline = device.createComputePipeline({
    layout: layout.value,
    compute: { module: shader.value, entryPoint: 'main' },
  });
  if (!pipeline.ok) {
    dispose();
    return pipeline;
  }
  let disposed = false;
  return ok({
    buffers,
    sources,
    rayCount,
    record(encoder) {
      if (disposed) return rayReferenceFailure('SDF query is disposed');
      const p = encoder.beginComputePass({ label: 'sdf.trace' });
      p.setPipeline(pipeline.value);
      p.setBindGroup(0, group.value);
      p.dispatchWorkgroups(Math.ceil(rayCount / 64));
      p.end();
      return ok(undefined);
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        dispose();
      }
    },
  });
}

/** Shared frozen scene packing for query, composition and diffuse transport kernels. */
export function packSdfScene(
  source: readonly SdfMeshInstance[],
  maxInstances = 64,
): Result<{ instances: Uint8Array; fields: Uint8Array }, RayReferenceError> {
  if (
    !Number.isInteger(maxInstances) ||
    maxInstances < 1 ||
    maxInstances > 1024 ||
    source.length > maxInstances
  )
    return rayReferenceFailure(`SDF profile allows ${maxInstances} instances (maximum 1024)`, true);
  const fieldOffsets = new Map<MeshDistanceField, number>();
  const instances = new Uint8Array(Math.max(1, source.length) * SDF_INSTANCE_STRIDE),
    iv = new DataView(instances.buffer),
    segments: Uint32Array[] = [],
    ids = new Set<number>();
  let wordCount = 0;
  for (let i = 0; i < source.length; i++) {
    const m = source[i];
    if (m === undefined) return rayReferenceFailure('missing SDF instance');
    if (
      !Number.isInteger(m.instanceId) ||
      m.instanceId < 0 ||
      m.instanceId >= 0xffffffff ||
      ids.has(m.instanceId) ||
      ![m.geometryId, m.mask].every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff) ||
      m.mask > 255
    )
      return rayReferenceFailure('SDF identities must be unique u32 values and masks must be u8');
    ids.add(m.instanceId);
    const t = Array.from(m.transform);
    if (
      t.length !== 16 ||
      !t.every((v) => Number.isFinite(Math.fround(v))) ||
      t[3] !== 0 ||
      t[7] !== 0 ||
      t[11] !== 0 ||
      t[15] !== 1
    )
      return rayReferenceFailure('expected finite affine SDF transform');
    const matrix = mat4.clone(t),
      inverse = mat4.invert(mat4.create(), matrix),
      check = mat4.multiply(mat4.create(), matrix, inverse);
    if (
      !mat4.equals(check, mat4.identity(mat4.create()), 1e-4) ||
      !Array.from(inverse).every(Number.isFinite)
    )
      return rayReferenceFailure('singular or ill-conditioned SDF transform');
    const field = m.field,
      missing = 'missing' in field,
      bounds = field.bounds;
    if (
      ![...bounds.min, ...bounds.max].every(Number.isFinite) ||
      bounds.min.some((v, a) =>
        !missing && field.policy.kind === 'signed-solid'
          ? v >= (bounds.max[a] ?? -Infinity)
          : v > (bounds.max[a] ?? -Infinity),
      )
    )
      return rayReferenceFailure('invalid SDF bounds');
    const offset = i * SDF_INSTANCE_STRIDE;
    inverse.forEach((v, j) => {
      iv.setFloat32(offset + j * 4, v, true);
    });
    [m.instanceId, m.geometryId, 0xffffffff, m.mask].forEach((v, j) => {
      iv.setUint32(offset + 64 + j * 4, v, true);
    });
    let origin: FieldVec3 = bounds.min,
      extent: FieldVec3 = bounds.max,
      spacing = 0,
      error = 0,
      distanceBand = 0;
    if (!missing) {
      if (!validateMeshDistanceField(field).ok)
        return rayReferenceFailure('invalid or incomplete SDF payload');
      let fieldOffset = fieldOffsets.get(field);
      if (fieldOffset === undefined) {
        const remaining = 4_194_304 - wordCount;
        const packed =
          field.policy.kind === 'sampled-visibility'
            ? packSampledField(field.values, field.bricks, field.policy.distanceBand, remaining)
            : packGeometricField(field, remaining);
        if (!packed) return rayReferenceFailure('SDF sample memory exceeds 16 MiB', true);
        fieldOffset = wordCount;
        wordCount += packed.length;
        segments.push(packed);
        fieldOffsets.set(field, fieldOffset);
      }
      [fieldOffset, ...field.dimensions].forEach((v, j) => {
        iv.setUint32(offset + 80 + j * 4, v, true);
      });
      origin = field.origin;
      spacing = field.spacing;
      error = field.policy.kind === 'sampled-visibility' ? 0 : field.policy.errorBound;
      extent = [
        origin[0] + (field.dimensions[0] - 1) * spacing,
        origin[1] + (field.dimensions[1] - 1) * spacing,
        origin[2] + (field.dimensions[2] - 1) * spacing,
      ];
      if (field.policy.kind === 'sampled-visibility') {
        distanceBand = field.policy.distanceBand;
        const bounds = field.policy.traceBounds;
        extent = bounds.max;
        const halfExtent = Math.max(...extent.map((v, a) => (v - (bounds.min[a] ?? 0)) / 2));
        // A dense unsigned sample can remain half a voxel away from a sheet.
        // Use its half-diagonal coverage radius with the caller-distance falloff;
        // UE's sparse volume surface-bias coefficient alone misses this case.
        iv.setFloat32(offset + 128, (Math.sqrt(3) * spacing) / 2, true);
        iv.setFloat32(offset + 136, halfExtent / 1024, true);
        iv.setFloat32(offset + 140, 1, true);
      }
    } else iv.setUint32(offset + 80, 0xffffffff, true);
    [...origin, spacing].forEach((v, j) => {
      iv.setFloat32(offset + 96 + j * 4, v, true);
    });
    [...extent, distanceBand].forEach((v, j) => {
      iv.setFloat32(offset + 112 + j * 4, v, true);
    });
    if (missing || field.policy.kind !== 'sampled-visibility')
      iv.setFloat32(offset + 128, error, true);
    const scaleBound = Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((j) => t[j] ?? 0));
    iv.setFloat32(
      offset + 132,
      !missing && field.policy.kind === 'sampled-visibility'
        ? 0
        : (2 * error + spacing * 0.02) * scaleBound,
      true,
    );
  }
  const words = new Uint32Array(Math.max(1, wordCount));
  let offset = 0;
  for (const segment of segments) {
    words.set(segment, offset);
    offset += segment.length;
  }
  return ok({ instances, fields: new Uint8Array(words.buffer) });
}
