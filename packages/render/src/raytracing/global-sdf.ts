import type { FieldVec3 } from '@forgeax/engine-geometry';
import type {
  Buffer,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayGeometryKey, rayReferenceFailure } from './scene';
import {
  packSdfScene,
  SDF_INSTANCE_STRIDE,
  SDF_SAMPLE_WGSL,
  type SdfMeshInstance,
  sdfInstanceKey,
} from './sdf-query';

export const GlobalSdfVoxelStatus = { unwritten: 0, complete: 1, missingField: 2 } as const;
export interface GlobalSdfGrid {
  readonly origin: FieldVec3;
  readonly dimensions: FieldVec3;
  readonly spacing: number;
  readonly maxDistance: number;
  readonly coverageDistance: number;
}
export interface GlobalSdfComposition {
  readonly grid: GlobalSdfGrid;
  readonly voxelCount: number;
  readonly sources: readonly {
    readonly instanceId: number;
    readonly key: string;
    /** Geometry/pose identity shared with Card capture, independent of field resolution. */
    readonly geometryKey: string;
  }[];
  readonly buffers: Readonly<{
    instances: Buffer;
    fields: Buffer;
    bounds: Buffer;
    settings: Buffer;
    voxels: Buffer;
  }>;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError | RhiError>;
  dispose(): void;
}
// The output is a diagnostic composition, not a triangle hit or Card identity.
// Each voxel is { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }.
export const GLOBAL_SDF_VOXEL_STRIDE = 16;
export const GLOBAL_SDF_COMPOSE_WGSL = `
${SDF_SAMPLE_WGSL}
struct ObjectBounds { lo: vec4f, hi: vec4f, scale: vec4f }
struct Settings { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
struct GlobalVoxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
@group(0) @binding(0) var<storage,read> instances: array<Instance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> bounds: array<ObjectBounds>;
@group(0) @binding(3) var<uniform> settings: Settings;
@group(0) @binding(4) var<storage,read_write> voxels: array<GlobalVoxel>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims=settings.dimensionsCount.xyz;
  let count=dims.x*dims.y*dims.z;
  // ranges.zw: optional edit box as exact f32 integers, x|y<<8|z<<16 (lo, extent).
  let boxExtent=u32(settings.ranges.w);var cell:vec3u;
  if(boxExtent==0u){
    if(gid.x>=count){return;}
    cell=vec3u(gid.x%dims.x,(gid.x/dims.x)%dims.y,gid.x/(dims.x*dims.y));
  }else{
    let boxLo=u32(settings.ranges.z);
    let e=vec3u(boxExtent&255u,(boxExtent>>8u)&255u,boxExtent>>16u);
    if(gid.x>=e.x*e.y*e.z){return;}
    cell=vec3u(boxLo&255u,(boxLo>>8u)&255u,boxLo>>16u)+vec3u(gid.x%e.x,(gid.x/e.x)%e.y,gid.x/(e.x*e.y));
    if(any(cell>=dims)){return;}
  }
  let index=cell.x+cell.y*dims.x+cell.z*dims.x*dims.y;
  let world=settings.originSpacing.xyz+vec3f(cell)*settings.originSpacing.w;
  var distance=settings.ranges.x;var nearest=0xffffffffu;var missing=false;
  var oneSided=false;var twoSided=false;
  for(var i=0u;i<settings.dimensionsCount.w;i++){
    let m=instances[i];if(m.ids.w==0u){continue;}
    let b=bounds[i];let p=(m.inverse*vec4f(world,1)).xyz;
    let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
    let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
    if(boxDistance>=settings.ranges.x){continue;}
    if(m.field.x==0xffffffffu){missing=true;continue;}
    let local=sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz));
    let candidate=max(local*b.scale.w+max(boxDistance,0.0),boxDistance);
    if(candidate<distance||(candidate==distance&&candidate<settings.ranges.x&&m.ids.x<nearest)){
      distance=candidate;nearest=m.ids.x;
    }
    if(abs(candidate)<settings.ranges.y){
      if(b.lo.w>0.5){twoSided=true;}else{oneSided=true;}
    }
  }
  let coverage=select(1.0,0.0,twoSided&&!oneSided);
  voxels[index]=GlobalVoxel(clamp(distance,-settings.ranges.x,settings.ranges.x),coverage,select(${GlobalSdfVoxelStatus.complete}u,${GlobalSdfVoxelStatus.missingField}u,missing),nearest);
}
`;

/** Validate the canonical f32 grid without allocating field or GPU storage. */
export function normalizeGlobalSdfGrid(grid: GlobalSdfGrid) {
  if (!grid || !Array.isArray(grid.origin) || !Array.isArray(grid.dimensions))
    return rayReferenceFailure('global SDF requires origin and dimension triples');
  const numeric = [...grid.origin, grid.spacing, grid.maxDistance, grid.coverageDistance];
  if (
    grid.origin.length !== 3 ||
    grid.dimensions.length !== 3 ||
    !numeric.every((v) => Number.isFinite(Math.fround(v))) ||
    Math.fround(grid.spacing) <= 0 ||
    Math.fround(grid.maxDistance) <= 0 ||
    grid.coverageDistance < 0 ||
    grid.coverageDistance > grid.maxDistance ||
    grid.dimensions.some((v) => !Number.isInteger(v) || v < 1 || v > 128)
  )
    return rayReferenceFailure(
      'global SDF requires finite origin, positive spacing/range, 0..maxDistance coverage and 1..128 samples per axis',
    );
  // Match the f32 inputs used by WGSL, including rounding of its multiply.
  // Checking every center is bounded to 384 scalar samples and catches loss
  // of spacing at the far end of a grid crossing an f32 exponent boundary.
  for (let a = 0; a < 3; a++) {
    let previous = -Infinity;
    for (let i = 0; i < (grid.dimensions[a] ?? 0); i++) {
      const center = Math.fround(
        Math.fround(grid.origin[a] ?? 0) + Math.fround(i * Math.fround(grid.spacing)),
      );
      if (!Number.isFinite(center) || center <= previous)
        return rayReferenceFailure(
          'global SDF sample centers must remain distinct finite f32 positions',
        );
      previous = center;
    }
  }
  const frozen: GlobalSdfGrid = {
    origin: [Math.fround(grid.origin[0]), Math.fround(grid.origin[1]), Math.fround(grid.origin[2])],
    dimensions: [grid.dimensions[0], grid.dimensions[1], grid.dimensions[2]],
    spacing: Math.fround(grid.spacing),
    maxDistance: Math.fround(grid.maxDistance),
    coverageDistance: Math.fround(grid.coverageDistance),
  };
  return ok(frozen);
}

/** Canonical frozen scene/grid projection shared by reference and Renderer owners. */
export function packGlobalSdfComposition(source: readonly SdfMeshInstance[], grid: GlobalSdfGrid) {
  const normalized = normalizeGlobalSdfGrid(grid);
  if (!normalized.ok) return normalized;
  const frozen = normalized.value;
  const packed = packSdfScene(source, 1024);
  if (!packed.ok) return packed;
  const sources = source.map((m) => ({
    instanceId: m.instanceId,
    key: sdfInstanceKey(m),
    geometryKey: rayGeometryKey(m, 'missing' in m.field ? 'missing' : m.field.meshDigest),
  }));
  const objectBytes = new Uint8Array(Math.max(1, source.length) * 48),
    view = new DataView(objectBytes.buffer);
  for (const [i, m] of source.entries()) {
    const t = Array.from(m.transform, Math.fround);
    const axes = [0, 4, 8].map((a) => [t[a] ?? 0, t[a + 1] ?? 0, t[a + 2] ?? 0]);
    const scales = axes.map((a) => Math.hypot(...a));
    if (
      !scales.every((v) => Math.fround(v) > 0 && Number.isFinite(Math.fround(v))) ||
      ![...m.field.bounds.min, ...m.field.bounds.max].every((v) => Number.isFinite(Math.fround(v)))
    )
      return rayReferenceFailure(
        'global SDF bounds and transform scales must be finite f32 values',
      );
    for (let a = 0; a < 3; a++)
      for (let b = a + 1; b < 3; b++) {
        const x = axes[a],
          y = axes[b];
        if (!x || !y) return rayReferenceFailure('missing transform axis');
        const dot = x.reduce((n, v, k) => n + v * (y[k] ?? 0), 0);
        if (Math.abs(dot) > 1e-5 * (scales[a] ?? 0) * (scales[b] ?? 0))
          return rayReferenceFailure(
            'global SDF composition requires orthogonal transform axes; shear is not qualified',
            true,
          );
      }
    const b =
      !('missing' in m.field) && m.field.policy.kind === 'sampled-visibility'
        ? m.field.policy.traceBounds
        : m.field.bounds;
    [
      ...b.min,
      'missing' in m.field
        ? 0
        : Number(
            m.field.policy.kind === 'sampled-visibility'
              ? m.field.policy.mostlyTwoSided
              : m.field.policy.kind === 'two-sided',
          ),
      ...b.max,
      0,
      ...scales,
      Math.min(...scales),
    ].forEach((v, k) => {
      view.setFloat32(i * 48 + k * 4, v, true);
    });
  }
  const count = grid.dimensions[0] * grid.dimensions[1] * grid.dimensions[2];
  const settings = new Uint8Array(48),
    sv = new DataView(settings.buffer);
  [...frozen.origin, frozen.spacing].forEach((v, i) => {
    sv.setFloat32(i * 4, v, true);
  });
  [...frozen.dimensions, source.length].forEach((v, i) => {
    sv.setUint32(16 + i * 4, v, true);
  });
  sv.setFloat32(32, frozen.maxDistance, true);
  sv.setFloat32(36, frozen.coverageDistance, true);
  const data = {
    instances: packed.value.instances,
    fields: packed.value.fields,
    bounds: objectBytes,
    settings,
    voxels: new Uint8Array(count * GLOBAL_SDF_VOXEL_STRIDE),
  };
  return ok({ grid: frozen, voxelCount: count, sources, data });
}

/** Frozen, single-region mesh-to-world composition. No residency, ray tracing, or GI publication. */
export async function createGlobalSdfComposition(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  source: readonly SdfMeshInstance[],
  grid: GlobalSdfGrid,
): Promise<Result<GlobalSdfComposition, RayReferenceError | RhiError>> {
  const prepared = packGlobalSdfComposition(source, grid);
  if (!prepared.ok) return prepared;
  const { grid: frozen, voxelCount: count, sources, data } = prepared.value;
  const buffers = {} as Record<keyof typeof data, Buffer>,
    owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
  };
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const bytes = data[key];
    const made = device.createBuffer({
      label: `global-sdf.${key}`,
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
  const shader = await compile(device, {
    code: GLOBAL_SDF_COMPOSE_WGSL,
    label: 'global-sdf.compose',
  });
  if (!shader.ok) {
    dispose();
    return shader;
  }
  const recorder = createGlobalSdfCompositionRecorder(device, shader.value);
  if (!recorder.ok) {
    dispose();
    return recorder;
  }
  const input = Object.fromEntries(
    (Object.keys(data) as (keyof typeof data)[]).map((name) => [
      name,
      { buffer: buffers[name], size: data[name].byteLength },
    ]),
  ) as GlobalSdfCompositionInputs;
  return ok({
    grid: frozen,
    voxelCount: count,
    sources,
    buffers,
    record(encoder) {
      if (disposed) return rayReferenceFailure('global SDF composition is disposed');
      const pass = encoder.beginComputePass({ label: 'global-sdf.compose' });
      try {
        return recorder.value.record(pass, input, count);
      } finally {
        pass.end();
      }
    },
    dispose,
  });
}

/** Exact borrowed ranges in the unchanged reference composition ABI. The caller
 * initializes inputs, orders their producers and retains buffers through submission
 * completion. Settings must describe the supplied voxelCount and instance count;
 * instances/bounds contain max(1, instanceCount) matching rows (one padding row for
 * an empty scene). The admitted scene/grid producer owns input-content validation.
 * RHI validates actual allocation capacity, usage and device ownership. */
export type GlobalSdfCompositionInputs = Readonly<
  Record<
    keyof GlobalSdfComposition['buffers'],
    { readonly buffer: Buffer; readonly offset?: number; readonly size: number }
  >
>;

/** Borrowed compute-pass composition. The producer supplies the already validated
 * packed scene and matching grid settings; this recorder checks resource ranges,
 * not their GPU contents. It owns no buffers, uploads, pass boundaries or submission. */
export function createGlobalSdfCompositionRecorder(device: RhiDevice, module: ShaderModule) {
  const failure = (expected: string, code: RhiError['code'] = 'rhi-descriptor-invalid') =>
    err(
      new RhiError({
        code,
        expected,
        hint: 'Supply supported limits and exact borrowed ranges from the admitted Global SDF scene/grid producer.',
      }),
    );
  if (!device.caps.compute || !device.caps.storageBuffer)
    return failure(
      'compute and storage-buffer support for Global SDF composition',
      'rhi-not-available',
    );
  for (const [name, required] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 5],
    ['maxStorageBuffersPerShaderStage', 4],
    ['maxUniformBuffersPerShaderStage', 1],
    ['maxUniformBufferBindingSize', 48],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
  ] as const)
    if (!(device.limits[name] >= required))
      return failure(`Global SDF composition requires ${name} >= ${required}`, 'limit-exceeded');
  const layout = device.createBindGroupLayout({
    entries: [SDF_INSTANCE_STRIDE, 4, 48, 48, GLOBAL_SDF_VOXEL_STRIDE].map(
      (minBindingSize, binding) => ({
        binding,
        visibility: 4,
        buffer: {
          type: binding === 3 ? 'uniform' : binding === 4 ? 'storage' : 'read-only-storage',
          minBindingSize,
        },
      }),
    ),
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: 'global-sdf.compose',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'main' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: GlobalSdfCompositionInputs,
      voxelCount: number,
      /** Invocations for an edit box encoded in settings; defaults to every voxel. */
      dispatchCount = voxelCount,
    ): Result<void, RhiError> {
      if (
        !Number.isSafeInteger(voxelCount) ||
        voxelCount < 1 ||
        voxelCount > 128 ** 3 ||
        !(Math.ceil(voxelCount / 64) <= device.limits.maxComputeWorkgroupsPerDimension)
      )
        return failure(
          'Global SDF voxel count in 1..128^3 within dispatch limits',
          'limit-exceeded',
        );
      const rows = input.instances.size / SDF_INSTANCE_STRIDE;
      if (
        !Number.isInteger(rows) ||
        rows < 1 ||
        rows > 1024 ||
        input.bounds.size !== rows * 48 ||
        input.settings.size !== 48 ||
        input.voxels.size !== voxelCount * GLOBAL_SDF_VOXEL_STRIDE ||
        !Number.isSafeInteger(input.fields.size) ||
        input.fields.size < 4 ||
        input.fields.size % 4 !== 0
      )
        return failure(
          'matching packed instance/bounds rows, u32 field words and exact grid/voxel ranges',
        );
      for (const name of ['instances', 'fields', 'bounds', 'settings', 'voxels'] as const) {
        const range = input[name],
          offset = range.offset ?? 0;
        const uniform = name === 'settings';
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
        (['instances', 'fields', 'bounds', 'settings'] as const).some(
          (name) => input[name].buffer === input.voxels.buffer,
        )
      )
        return failure('Global SDF composition voxels must not alias any borrowed input');
      const group = device.createBindGroup({
        layout: layout.value,
        entries: [input.instances, input.fields, input.bounds, input.settings, input.voxels].map(
          (value, binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value },
          }),
        ),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      if (!Number.isSafeInteger(dispatchCount) || dispatchCount < 1 || dispatchCount > voxelCount)
        return failure('Global SDF edit dispatch within 1..voxelCount', 'limit-exceeded');
      pass.dispatchWorkgroups(Math.ceil(dispatchCount / 64));
      return ok(undefined);
    },
  });
}

/** Voxel box touched by moving bounds, in cells; `undefined` means the whole grid. */
export interface GlobalSdfEditBox {
  readonly lo: readonly [number, number, number];
  readonly extent: readonly [number, number, number];
}

/**
 * Cells whose composed distance can change when the given world AABBs gain or lose
 * geometry: each box grows by the composition range plus one cell. Returns
 * `undefined` when the union covers the whole grid.
 */
export function globalSdfEditBox(
  grid: GlobalSdfGrid,
  bounds: readonly { readonly min: readonly number[]; readonly max: readonly number[] }[],
): GlobalSdfEditBox | undefined {
  if (bounds.length === 0) return undefined;
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  const pad = grid.maxDistance + grid.spacing;
  for (const box of bounds)
    for (let a = 0; a < 3; a++) {
      const d = grid.dimensions[a] ?? 1,
        o = grid.origin[a] ?? 0;
      const first = Math.floor(((box.min[a] ?? 0) - pad - o) / grid.spacing);
      const last = Math.ceil(((box.max[a] ?? 0) + pad - o) / grid.spacing);
      lo[a] = Math.min(lo[a] ?? 0, Math.max(0, first));
      hi[a] = Math.max(hi[a] ?? 0, Math.min(d - 1, last));
    }
  const extent = [0, 1, 2].map((a) => Math.max(0, (hi[a] ?? 0) - (lo[a] ?? 0) + 1));
  if (extent.some((e) => e === 0)) return { lo: [0, 0, 0], extent: [0, 0, 0] };
  if (extent.every((e, a) => e >= (grid.dimensions[a] ?? 0))) return undefined;
  return {
    lo: [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0],
    extent: [extent[0] ?? 0, extent[1] ?? 0, extent[2] ?? 0],
  };
}

/** The settings `ranges.zw` words for an edit box (zeros select the whole grid). */
export function packGlobalSdfEditBox(box: GlobalSdfEditBox | undefined): Float32Array {
  if (box === undefined) return new Float32Array(2);
  const pack = (v: readonly number[]) => (v[0] ?? 0) | ((v[1] ?? 0) << 8) | ((v[2] ?? 0) << 16);
  return new Float32Array([pack(box.lo), pack(box.extent)]);
}
