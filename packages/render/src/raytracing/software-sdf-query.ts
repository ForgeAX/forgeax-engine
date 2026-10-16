import type { RhiCommandEncoder, RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { GlobalSdfComposition } from './global-sdf';
import {
  createGlobalSdfQuery,
  type GlobalSdfQuery,
  type GlobalSdfQueryOptions,
} from './global-sdf-query';
import {
  packReferenceRays,
  type RayReferenceError,
  type ReferenceRay,
  rayReferenceFailure,
} from './scene';
import {
  createSdfQuery,
  SDF_HIT_STRIDE,
  type SdfMeshInstance,
  type SdfQuery,
  type SdfQueryOptions,
  SdfQueryStatus,
  sdfInstanceKey,
} from './sdf-query';

/** Both stages retain their original result vocabulary; disabled Global work is not a scene miss. */
export interface SoftwareSdfQuery {
  readonly detail: SdfQuery;
  readonly global: GlobalSdfQuery;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError | RhiError>;
  dispose(): void;
}

// Reuse the existing packed ray and hit buffers. Only an executed detail miss
// (including its sentinel identity) can advance the original ray's interval.
// A zero-initialized/unwritten detail result cannot impersonate that miss.
const CONTINUE_WGSL = `
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
@group(0) @binding(0) var<storage,read> detailRays: array<Ray>;
@group(0) @binding(1) var<storage,read> detailResults: array<vec4u>;
@group(0) @binding(2) var<storage,read_write> globalRays: array<Ray>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if(id.x>=arrayLength(&detailRays)){return;}
  let detail=detailRays[id.x];let state=detailResults[id.x*${SDF_HIT_STRIDE / 16}u];
  // tMax is the unchanged full interval on every recording, including repeats.
  let fullEnd=globalRays[id.x].tMax;
  let continued=detail.mask.x!=0u && state.x==${SdfQueryStatus.miss}u
    && all(state.yzw==vec3u(0xffffffffu)) && detail.tMax<fullEnd;
  var ray=detail;ray.tMax=fullEnd;
  ray.tMin=select(detail.tMin,detail.tMax,continued);
  ray.mask.x=select(0u,detail.mask.x,continued);
  globalRays[id.x]=ray;
}
`;

/** Frozen complete-roster detail traversal followed by GPU-gated Global continuation. */
export async function createSoftwareSdfQuery(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  composition: GlobalSdfComposition,
  source: readonly SdfMeshInstance[],
  rays: readonly ReferenceRay[],
  options: {
    /** World-space length after each original tMin; no implicit normal or direction bias. */
    readonly detailDistance: number;
    readonly detail?: SdfQueryOptions;
    readonly global?: GlobalSdfQueryOptions;
  },
): Promise<Result<SoftwareSdfQuery, RayReferenceError | RhiError>> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return rayReferenceFailure('software SDF query requires a detail distance');
  const distance = Math.fround(options.detailDistance);
  if (!Number.isFinite(distance) || distance < 2 ** -126)
    return rayReferenceFailure('detail distance must be positive normal finite f32');
  const expected = new Map(composition.sources.map((s) => [s.instanceId, s.key]));
  if (
    source.length !== expected.size ||
    source.some((s) => expected.get(s.instanceId) !== sdfInstanceKey(s))
  )
    return rayReferenceFailure(
      'detail traversal must use the complete frozen composition source roster',
    );
  const packed = packReferenceRays(rays);
  if (!packed.ok) return packed;
  const view = new DataView(packed.value.buffer, packed.value.byteOffset, packed.value.byteLength);
  const original: ReferenceRay[] = [],
    near: ReferenceRay[] = [];
  for (let offset = 0; offset < packed.value.byteLength; offset += 48) {
    const ray: ReferenceRay = {
      origin: [0, 1, 2].map((a) => view.getFloat32(offset + a * 4, true)) as [
        number,
        number,
        number,
      ],
      direction: [0, 1, 2].map((a) => view.getFloat32(offset + 16 + a * 4, true)) as [
        number,
        number,
        number,
      ],
      tMin: view.getFloat32(offset + 12, true),
      tMax: view.getFloat32(offset + 28, true),
      mask: view.getUint32(offset + 32, true),
    };
    const end = Math.min(ray.tMax, Math.fround(ray.tMin + distance / Math.hypot(...ray.direction)));
    if (!(end > ray.tMin))
      return rayReferenceFailure('detail distance cannot advance the rounded ray interval');
    original.push(ray);
    near.push({ ...ray, tMax: end });
  }
  // Both owners freeze their inputs before either asynchronous shader compile resolves.
  const [detailResult, globalResult] = await Promise.all([
    createSdfQuery(device, compile, source, near, options.detail),
    createGlobalSdfQuery(device, compile, composition, original, options.global),
  ]);
  if (!detailResult.ok) {
    if (globalResult.ok) globalResult.value.dispose();
    return detailResult;
  }
  const detail = detailResult.value;
  if (!globalResult.ok) {
    detail.dispose();
    return globalResult;
  }
  const global = globalResult.value;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    global.dispose();
    detail.dispose();
  };
  const fail = <T>(result: Result<never, T>) => {
    dispose();
    return result;
  };
  const shader = await compile(device, { code: CONTINUE_WGSL, label: 'sdf.continue-global' });
  if (!shader.ok) return fail(shader);
  const bgl = device.createBindGroupLayout({
    entries: [0, 1, 2].map((binding) => ({
      binding,
      visibility: 4,
      buffer: { type: binding === 2 ? ('storage' as const) : ('read-only-storage' as const) },
    })),
  });
  if (!bgl.ok) return fail(bgl);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl.value] });
  if (!layout.ok) return fail(layout);
  const group = device.createBindGroup({
    layout: bgl.value,
    entries: [detail.buffers.rays, detail.buffers.hits, global.buffers.rays].map(
      (buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer } },
      }),
    ),
  });
  if (!group.ok) return fail(group);
  const pipeline = device.createComputePipeline({
    layout: layout.value,
    compute: { module: shader.value, entryPoint: 'main' },
  });
  if (!pipeline.ok) return fail(pipeline);
  return ok({
    detail,
    global,
    dispose,
    record(encoder) {
      if (disposed) return rayReferenceFailure('software SDF query is disposed');
      const recorded = detail.record(encoder);
      if (!recorded.ok) return recorded;
      const pass = encoder.beginComputePass({ label: 'sdf.continue-global' });
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(detail.rayCount / 64));
      pass.end();
      return global.record(encoder);
    },
  });
}
