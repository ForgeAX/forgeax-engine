import {
  type FieldVec3,
  type MeshDistanceField,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
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
import { packGeometricField, SDF_BRICK_EDGE, SdfFieldUpload } from './sdf-field-storage';
import { SDF_INSTANCE_WGSL } from './sdf-instance-wgsl';
import { appendSdfSceneCandidates } from './sdf-scene-candidates';
import { sdfPlacementTransform } from './sdf-scene-placement';
import { packSceneSurface, sdfSurfaceRowAddress } from './sdf-scene-surface';
import type { SdfSurfaceCoverage } from './sdf-surface-coverage';
import { type SdfSurfacePlacement, sdfSurfacePlacement } from './sdf-surface-storage';
import type { SdfPlacementBounds } from './sdf-transform-certificate';

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
  /** Accepted placement opacity in the canonical primitive namespace. Unknown alpha
   * retains complete geometry and is unavailable only where an intersection may matter;
   * unqualified/custom geometry remains wholly unavailable. */
  readonly surfaceCoverage?: SdfSurfaceCoverage;
  /** Only an exact accepted asset-version owner supplies this fixed storage. */
  readonly fieldUpload?: SdfFieldUpload;
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
    instance.surfaceCoverage ?? 'opaque',
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
/** Private owner payload for one exact ordered field-upload layout. */
export interface SdfSceneFieldPayload {
  readonly uploads: readonly SdfFieldUpload[];
  readonly offsets: ReadonlyMap<SdfFieldUpload, number>;
  readonly wordLength: number;
  readonly initialization: Readonly<{
    version: string;
    byteLength: number;
    copyInto(target: Uint8Array): boolean;
  }>;
}
export const SDF_HIT_STRIDE = 64;
export const SDF_INSTANCE_STRIDE = 144;
export const SDF_SAMPLE_WGSL = `
${SDF_INSTANCE_WGSL}
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct SdfHit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn sdfTexel(m: Instance, c: vec3u) -> f32 {
  if(m.error.w==1.0 || m.error.w==2.0){
    let first=select(m.field.x,fields[m.field.x+4u],m.error.w==2.0);
    let edge=${SDF_BRICK_EDGE}u;
    let dims=(m.field.yzw+vec3u(edge-1u))/edge;
    let b=c/edge;
    let entry=fields[first+(b.z*dims.y+b.y)*dims.x+b.x];
    let p=c%edge;let local=(p.z*edge+p.y)*edge+p.x;
    return unpack2x16snorm(fields[first+entry+(local>>1u)])[local&1u]*m.extent.w;
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
export const SDF_TRACE_WGSL = `${SDF_SAMPLE_WGSL}
fn sdfNormal(m: Instance,p: vec3f) -> vec3f {
  let h=select(m.origin.w,m.origin.w*0.5,m.error.w>0.5);let g=vec3f(sdfValue(m,p+vec3f(h,0,0))-sdfValue(m,p-vec3f(h,0,0)),
    sdfValue(m,p+vec3f(0,h,0))-sdfValue(m,p-vec3f(0,h,0)),sdfValue(m,p+vec3f(0,0,h))-sdfValue(m,p-vec3f(0,0,h)));
  let n=transpose(mat3x3f(m.inverse[0].xyz,m.inverse[1].xyz,m.inverse[2].xyz))*g;
  return n/max(length(n),1e-20);
}
fn traceSdf(ray: Ray, instanceCount: u32, maxSteps: u32, rayDistanceExpansion: bool) -> SdfHit {
var result=SdfHit(vec4u(${SdfQueryStatus.miss}u,0xffffffffu,0xffffffffu,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
  var totalSteps=0u;
  for(var i=0u;i<instanceCount;i++){
    if((sdfInstanceMask(i)&ray.mask.x)==0u){continue;}
    if(!sdfInstanceValid(i)){result.state.x=${SdfQueryStatus.missingField}u;return result;}
    let m=sdfInstanceAt(i);
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
        // A zero sample at the first closed-interval contact is a surface even
        // when clearance history has not accumulated any expansion yet.
        if(value<=expansion){
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
@group(0) @binding(0) var<storage,read> instances: array<RawInstance>;
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
    instances: scene.value.instances,
    fields: scene.value.fields,
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
function sdfSceneCapacity(count: number, maximum: number, capacity: number) {
  return (
    Number.isInteger(maximum) &&
    maximum >= 1 &&
    maximum <= 1024 &&
    count <= maximum &&
    Number.isInteger(capacity) &&
    capacity >= Math.max(1, count) &&
    capacity <= maximum
  );
}

/** Repack a complete placement row, retaining only the admitted immutable Mesh payload address. */
export function repackSdfPlacementRow(instance: SdfMeshInstance, canonical: Uint8Array) {
  if (canonical.byteLength !== SDF_INSTANCE_STRIDE)
    return rayReferenceFailure('a complete canonical SDF instance row is required');
  const original = new DataView(canonical.buffer, canonical.byteOffset, canonical.byteLength);
  if (
    original.getUint32(64, true) !== instance.instanceId ||
    original.getUint32(68, true) !== instance.geometryId ||
    original.getUint32(76, true) !== instance.mask
  )
    return rayReferenceFailure('SDF placement identity must match its admitted row');
  const pose = sdfPlacementTransform(instance.transform);
  if (!pose.ok) return pose;
  const bytes = canonical.slice();
  const view = new DataView(bytes.buffer);
  pose.value.inverse.forEach((value, axis) => {
    view.setFloat32(axis * 4, value, true);
  });
  const field = instance.field;
  const sampled = !('missing' in field) && field.policy.kind === 'sampled-visibility';
  const error =
    'missing' in field || field.policy.kind === 'sampled-visibility' ? 0 : field.policy.errorBound;
  const spacing = 'missing' in field ? 0 : field.spacing;
  view.setFloat32(132, sampled ? 0 : (2 * error + spacing * 0.02) * pose.value.scaleBound, true);
  return ok({ bytes, forward: pose.value.matrix, inverse: pose.value.inverse });
}
type PreparedSdfSurface = Extract<ReturnType<typeof packSceneSurface>, { ok: true }>['value'];
type SdfFieldLayout =
  | {
      readonly kind: 'surface';
      readonly surface: PreparedSdfSurface;
      readonly segments: (Uint32Array | SdfFieldUpload)[];
      readonly offsets: Map<object, number>;
      wordCount: number;
    }
  | {
      readonly kind: 'static';
      readonly payload: SdfSceneFieldPayload;
      readonly used: SdfFieldUpload[];
      readonly offsets: Map<object, number>;
    };

export function packSdfScene(
  source: readonly SdfMeshInstance[],
  maxInstances = 64,
  capacity = Math.max(1, source.length),
  sourceEpoch?: number,
): Result<
  {
    instances: Uint8Array;
    fields: Uint8Array;
    surface: SdfSurfacePlacement;
    /** Immutable cold-pack facts, not valid for a later in-place edit. */
    placementBounds: readonly (SdfPlacementBounds | undefined)[];
  },
  RayReferenceError
> {
  if (!sdfSceneCapacity(source.length, maxInstances, capacity))
    return rayReferenceFailure(`SDF profile allows ${maxInstances} instances (maximum 1024)`, true);
  const surface = packSceneSurface(source, capacity);
  if (!surface.ok) return surface;
  const layout: Extract<SdfFieldLayout, { kind: 'surface' }> = {
    kind: 'surface',
    surface: surface.value,
    segments: [surface.value.pool.words],
    offsets: new Map(),
    wordCount: surface.value.pool.words.length,
  };
  const instances = packSdfInstanceRows(source, capacity, layout);
  return instances.ok
    ? finishSdfScene(surface.value, layout.segments, layout.wordCount, instances.value, sourceEpoch)
    : instances;
}

/** Sample-only consumers retain their exact owner-upload layout while poses change.
 * They use the existing sampled-field mode; they do not acquire surface certificates. */
export function packSdfSceneWithStaticFields(
  source: readonly SdfMeshInstance[],
  maxInstances: number,
  payload: SdfSceneFieldPayload,
): Result<
  { instances: Uint8Array; initialization: SdfSceneFieldPayload['initialization'] },
  RayReferenceError
> {
  const capacity = Math.max(1, source.length);
  if (!sdfSceneCapacity(source.length, maxInstances, capacity))
    return rayReferenceFailure(`SDF profile allows ${maxInstances} instances (maximum 1024)`, true);
  if (
    !Number.isSafeInteger(payload.wordLength) ||
    payload.wordLength <= 0 ||
    payload.wordLength > 4_194_304 ||
    payload.initialization.byteLength !== payload.wordLength * 4 ||
    payload.uploads.length !== payload.offsets.size
  )
    return rayReferenceFailure('invalid or incomplete SDF payload');
  const layout: Extract<SdfFieldLayout, { kind: 'static' }> = {
    kind: 'static',
    payload,
    used: [],
    offsets: new Map(),
  };
  const instances = packSdfInstanceRows(source, capacity, layout);
  if (!instances.ok) return instances;
  if (
    layout.used.length !== payload.uploads.length ||
    layout.used.some((upload, index) => upload !== payload.uploads[index])
  )
    return rayReferenceFailure('invalid or incomplete SDF payload');
  return ok({ instances: instances.value, initialization: payload.initialization });
}

function validateSdfInstanceIdentity(instance: SdfMeshInstance, ids: Set<number>) {
  if (
    !Number.isInteger(instance.instanceId) ||
    instance.instanceId < 0 ||
    instance.instanceId >= 0xffffffff ||
    ids.has(instance.instanceId) ||
    ![instance.geometryId, instance.mask].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff,
    ) ||
    instance.mask > 255
  )
    return rayReferenceFailure('SDF identities must be unique u32 values and masks must be u8');
  ids.add(instance.instanceId);
  return ok(undefined);
}

function sdfFieldAddress(
  instance: SdfMeshInstance,
  row: number,
  layout: SdfFieldLayout,
): Result<number, RayReferenceError> {
  const field = instance.field;
  if ('missing' in field) return ok(0xffffffff);
  const upload =
    instance.fieldUpload instanceof SdfFieldUpload && instance.fieldUpload.field === field
      ? instance.fieldUpload
      : undefined;
  if (layout.kind === 'static' && upload === undefined)
    return rayReferenceFailure('invalid or incomplete SDF payload');
  if (upload === undefined && !validateMeshDistanceField(field).ok)
    return rayReferenceFailure('invalid or incomplete SDF payload');
  if (layout.kind === 'surface' && field.policy.kind === 'sampled-visibility')
    return ok(sdfSurfaceRowAddress(row));
  const key = layout.kind === 'static' ? upload : field;
  if (key === undefined) return rayReferenceFailure('invalid or incomplete SDF payload');
  const prior = layout.offsets.get(key);
  if (prior !== undefined) return ok(prior);
  let address: number;
  if (layout.kind === 'static') {
    if (!upload) return rayReferenceFailure('invalid or incomplete SDF payload');
    const first = layout.payload.offsets.get(upload);
    if (first === undefined) return rayReferenceFailure('invalid or incomplete SDF payload');
    address = first;
    layout.used.push(upload);
  } else {
    const remaining = 4_194_304 - layout.wordCount;
    const packed = upload ?? packGeometricField(field, remaining);
    if (!packed || packed.length > remaining)
      return rayReferenceFailure('SDF sample memory exceeds 16 MiB', true);
    address = layout.wordCount;
    layout.wordCount += packed.length;
    layout.segments.push(packed);
  }
  layout.offsets.set(key, address);
  return ok(address);
}

function writeSdfFieldProperties(
  view: DataView,
  offset: number,
  field: SdfMeshInstance['field'],
  address: number,
  scaleBound: number,
  sampledMode: 1 | 2,
): Result<void, RayReferenceError> {
  const missing = 'missing' in field,
    bounds = field.bounds;
  if (
    ![...bounds.min, ...bounds.max].every(Number.isFinite) ||
    bounds.min.some((value, axis) =>
      !missing && field.policy.kind === 'signed-solid'
        ? value >= (bounds.max[axis] ?? -Infinity)
        : value > (bounds.max[axis] ?? -Infinity),
    )
  )
    return rayReferenceFailure('invalid SDF bounds');
  let origin: FieldVec3 = bounds.min,
    extent: FieldVec3 = bounds.max,
    spacing = 0,
    error = 0,
    distanceBand = 0;
  view.setUint32(offset + 80, address, true);
  if (!missing) {
    field.dimensions.forEach((value, axis) => {
      view.setUint32(offset + 84 + axis * 4, value, true);
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
      const trace = field.policy.traceBounds;
      extent = trace.max;
      const halfExtent = Math.max(
        ...extent.map((value, axis) => (value - (trace.min[axis] ?? 0)) / 2),
      );
      view.setFloat32(offset + 128, (Math.sqrt(3) * spacing) / 2, true);
      view.setFloat32(offset + 136, halfExtent / 1024, true);
      view.setFloat32(offset + 140, sampledMode, true);
    }
  }
  [...origin, spacing].forEach((value, axis) => {
    view.setFloat32(offset + 96 + axis * 4, value, true);
  });
  [...extent, distanceBand].forEach((value, axis) => {
    view.setFloat32(offset + 112 + axis * 4, value, true);
  });
  if (missing || field.policy.kind !== 'sampled-visibility')
    view.setFloat32(offset + 128, error, true);
  view.setFloat32(
    offset + 132,
    !missing && field.policy.kind === 'sampled-visibility'
      ? 0
      : (2 * error + spacing * 0.02) * scaleBound,
    true,
  );
  const properties = new Float32Array(view.buffer, view.byteOffset + offset + 96, 12);
  if (!properties.every(Number.isFinite) || (!missing && (properties[3] ?? 0) <= 0))
    return rayReferenceFailure(
      'SDF field properties require finite f32 values and positive spacing',
    );
  return ok(undefined);
}

function packSdfInstanceRows(
  source: readonly SdfMeshInstance[],
  capacity: number,
  layout: SdfFieldLayout,
): Result<Uint8Array, RayReferenceError> {
  const instances = new Uint8Array(capacity * SDF_INSTANCE_STRIDE),
    view = new DataView(instances.buffer),
    ids = new Set<number>();
  for (const [row, instance] of source.entries()) {
    if (!instance) return rayReferenceFailure('missing SDF instance');
    const identity = validateSdfInstanceIdentity(instance, ids);
    if (!identity.ok) return identity;
    const pose =
      layout.kind === 'surface'
        ? ok(layout.surface.placements[row])
        : sdfPlacementTransform(instance.transform);
    if (!pose.ok) return pose;
    if (!pose.value) return rayReferenceFailure('missing prepared SDF placement');
    const address = sdfFieldAddress(instance, row, layout);
    if (!address.ok) return address;
    const offset = row * SDF_INSTANCE_STRIDE;
    pose.value.inverse.forEach((value, axis) => {
      view.setFloat32(offset + axis * 4, value, true);
    });
    [instance.instanceId, instance.geometryId, 0xffffffff, instance.mask].forEach((value, axis) => {
      view.setUint32(offset + 64 + axis * 4, value, true);
    });
    const properties = writeSdfFieldProperties(
      view,
      offset,
      instance.field,
      address.value,
      pose.value.scaleBound,
      layout.kind === 'surface' ? 2 : 1,
    );
    if (!properties.ok) return properties;
  }
  return ok(instances);
}

function finishSdfScene(
  surface: PreparedSdfSurface,
  segments: readonly (Uint32Array | SdfFieldUpload)[],
  wordCount: number,
  instances: Uint8Array,
  sourceEpoch: number | undefined,
) {
  const words = new Uint32Array(Math.max(1, wordCount));
  let offset = 0;
  for (const segment of segments) {
    if (segment instanceof SdfFieldUpload) segment.copyInto(words, offset);
    else words.set(segment, offset);
    offset += segment.length;
  }
  const placementBounds = Object.freeze(surface.placements.map((row) => row.bounds)),
    candidates = appendSdfSceneCandidates(words, instances, placementBounds, sourceEpoch);
  if (!candidates.ok) return candidates;
  return ok({
    instances,
    fields: new Uint8Array(candidates.value.words.buffer),
    surface: sdfSurfacePlacement(
      surface.pool,
      candidates.value.words,
      placementBounds,
      candidates.value.directory,
      sourceEpoch,
    ),
    placementBounds,
  });
}
