import {
  type RhiComputePassEncoder,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { CARD_LOOKUP_STRIDE, CardLookupStatus } from './card-lookup';
import { GLOBAL_CARD_CANDIDATE_STRIDE } from './global-card-lookup';
import { type GlobalSdfQueryInputs, GlobalSdfQueryStatus } from './global-sdf-query';
import { RAY_REFERENCE_LIMIT } from './scene';

/** State/query-status/candidate-flags/mapped-mask, then hit-t/TMin/TMax/first-distance.
 * Surface support is independent of RGB; no lighting or environment is evaluated. */
export const PROBE_CARD_SUPPORT_STRIDE = 32;
export const ProbeCardSupportStatus = {
  masked: 0,
  blocked: 1,
  supported: 2,
  unsupported: 3,
  environment: 4,
  unresolved: 5,
} as const;
export const PROBE_CARD_SUPPORT_WGSL = `
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
struct Support { state: vec4u, interval: vec4f }
@group(0) @binding(0) var<storage,read> rays: array<Ray>;
@group(0) @binding(1) var<storage,read> hits: array<Hit>;
@group(0) @binding(2) var<storage,read> candidates: array<vec4u>;
@group(0) @binding(3) var<storage,read> samples: array<vec4u>;
@group(0) @binding(4) var<storage,read_write> output: array<Support>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 let i=gid.x;if(i>=arrayLength(&rays)){return;}
 let ray=rays[i];let hit=hits[i];let candidate=candidates[i*2u];
 var support=0u;
 for(var k=0u;k<4u;k++){
   if(samples[(i*4u+k)*7u].x==${CardLookupStatus.mapped}u){support|=1u<<k;}
 }
 var state=${ProbeCardSupportStatus.unresolved}u;
 if(ray.mask.x==0u){state=${ProbeCardSupportStatus.masked}u;}
 else if(hit.state.x==${GlobalSdfQueryStatus.negativeStart}u||
   (hit.state.x==${GlobalSdfQueryStatus.hit}u&&hit.metrics.x<=ray.tMin)){
   state=${ProbeCardSupportStatus.blocked}u;
 }else if(hit.state.x==${GlobalSdfQueryStatus.hit}u){
   state=select(${ProbeCardSupportStatus.unsupported}u,${ProbeCardSupportStatus.supported}u,support!=0u&&candidate.y==0u);
 }else if(hit.state.x==${GlobalSdfQueryStatus.miss}u){state=${ProbeCardSupportStatus.environment}u;}
 output[i]=Support(vec4u(state,hit.state.x,candidate.y,support),vec4f(hit.metrics.x,ray.tMin,ray.tMax,hit.metrics.z));
}
`;
const BINDINGS = [
  ['rays', 48],
  ['hits', 64],
  ['candidates', GLOBAL_CARD_CANDIDATE_STRIDE],
  ['samples', 4 * CARD_LOOKUP_STRIDE],
  ['output', PROBE_CARD_SUPPORT_STRIDE],
] as const;
export type ProbeCardSupportInputs = Readonly<
  Record<(typeof BINDINGS)[number][0], GlobalSdfQueryInputs['rays']>
>;

/** Borrowed caller-state diagnostic. Query and sample bytes remain untouched. */
export function createProbeCardSupportRecorder(device: RhiDevice, module: ShaderModule) {
  const failure = (expected: string) =>
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected,
        hint: 'Supply matching original Global rays/hits and all four Card sample records from this frame.',
      }),
    );
  if (
    !device.caps.compute ||
    !device.caps.storageBuffer ||
    device.limits.maxStorageBuffersPerShaderStage < 5 ||
    device.limits.maxBindingsPerBindGroup < 5 ||
    device.limits.maxComputeWorkgroupSizeX < 64 ||
    device.limits.maxComputeInvocationsPerWorkgroup < 64
  )
    return failure('five storage buffers and a 64-lane compute workgroup for Card support');
  const layout = device.createBindGroupLayout({
    entries: BINDINGS.map(([, minBindingSize], binding) => ({
      binding,
      visibility: 4,
      buffer: { type: binding === 4 ? 'storage' : 'read-only-storage', minBindingSize },
    })),
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: 'probe-global.card-support',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'main' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(pass: RhiComputePassEncoder, input: ProbeCardSupportInputs, rayCount: number) {
      if (
        !Number.isInteger(rayCount) ||
        rayCount < 1 ||
        rayCount > RAY_REFERENCE_LIMIT ||
        Math.ceil(rayCount / 64) > device.limits.maxComputeWorkgroupsPerDimension
      )
        return failure('bounded complete Card query count');
      for (const [name, stride] of BINDINGS) {
        const range = input[name],
          offset = range.offset ?? 0;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset % device.limits.minStorageBufferOffsetAlignment !== 0 ||
          range.size !== rayCount * stride ||
          range.size > device.limits.maxStorageBufferBindingSize ||
          offset + range.size > device.limits.maxBufferSize ||
          (name !== 'output' && range.buffer === input.output.buffer)
        )
          return failure(`exact non-aliasing ${name} Card support range`);
      }
      const group = device.createBindGroup({
        layout: layout.value,
        entries: BINDINGS.map(([name], binding) => ({
          binding,
          resource: { kind: 'buffer', value: input[name] },
        })),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(rayCount / 64));
      return ok(undefined);
    },
  });
}
