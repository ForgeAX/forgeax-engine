import type { RhiComputePassEncoder, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GLOBAL_SDF_SAMPLE_WGSL, type GlobalSdfQueryInputs } from './global-sdf-query';
import { ProbeRayStatus } from './probe-rays';
import { RAY_REFERENCE_LIMIT } from './scene';

/** Six vec4 records: origin/distance, coverage/spacing/threshold/clearance,
 * id/generation/emission/emitted, sample-status/in-region/reserved/reserved,
 * miss/hit/negativeStart/stepBudget, missingField/outsideRegion/masked/unknown.
 * Clearance is a sampled SWRT diagnostic, never solid-exterior truth. */
export const PROBE_ORIGIN_SUPPORT_STRIDE = 96;
export type ProbeOriginSupportInputs = Readonly<
  Record<
    'probes' | 'candidate' | 'emission' | 'hits' | 'voxels' | 'grid' | 'diagnostics',
    GlobalSdfQueryInputs['rays']
  >
>;

export const PROBE_ORIGIN_SUPPORT_WGSL = `
${GLOBAL_SDF_SAMPLE_WGSL}
struct Probe { baseCell: vec4f, key: vec4u }
struct Candidate { offset: vec4f, key: vec4u }
struct Support {
 originDistance: vec4f, support: vec4f, identity: vec4u,
 availability: vec4u, counts0: vec4u, counts1: vec4u
}
@group(0) @binding(0) var<storage,read> probes: array<Probe>;
@group(0) @binding(1) var<storage,read> candidate: array<Candidate>;
@group(0) @binding(2) var<storage,read> emission: array<vec4u>;
// Each unchanged Global query Hit occupies four vec4 words; state is first.
@group(0) @binding(3) var<storage,read> hits: array<vec4u>;
@group(0) @binding(4) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(5) var<uniform> grid: Grid;
@group(0) @binding(6) var<storage,read_write> diagnostics: array<Support>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
 let i=gid.x; if(i>=arrayLength(&probes)){return;}
 let p=probes[i]; let state=candidate[i]; let e=emission[i];
 let origin=p.baseCell.xyz+state.offset.xyz;
 var result=Support(vec4f(origin,0),vec4f(0,grid.originSpacing.w,grid.originSpacing.w*0.25,0),
   vec4u(p.key.xy,e.zw),vec4u(0),vec4u(0),vec4u(0));
 let valid=all(p.key.xy==state.key.xy)&&all(p.key.xy==e.xy)&&
   (e.z==${ProbeRayStatus.emitted}u||e.z==${ProbeRayStatus.untraced}u);
 let lo=grid.originSpacing.xyz+vec3f(grid.originSpacing.w);
 let hi=grid.originSpacing.xyz+vec3f(grid.dimensionsCount.xyz-vec3u(2u))*grid.originSpacing.w;
 if(valid&&all(origin>=lo)&&all(origin<=hi)){
   let sample=sampleGlobal(origin);
   result.availability=vec4u(sample.status,1,0,0);
   if(sample.status==1u){
     result.originDistance.w=sample.distance;result.support.x=sample.coverage;
     result.support.w=select(0.0,1.0,sample.distance>result.support.z);
   }
 }
 let perProbe=arrayLength(&hits)/(4u*arrayLength(&probes));
 if(e.z==${ProbeRayStatus.emitted}u&&e.w==perProbe&&valid){
   for(var r=0u;r<perProbe;r++){
     let status=hits[(i*perProbe+r)*4u].x;
     if(status<4u){result.counts0[status]++;}
     else if(status<6u){result.counts1[status-4u]++;}
     else{result.counts1.w++;}
   }
 }else{result.counts1.z=perProbe;}
 diagnostics[i]=result;
}
`;

/** Borrowed post-trace recorder; the graph owns all producers and lifetimes. */
export function createProbeOriginSupportRecorder(device: RhiDevice, module: ShaderModule) {
  const fail = (expected: string, code: RhiError['code'] = 'rhi-descriptor-invalid') =>
    err(
      new RhiError({
        code,
        expected,
        hint: 'Supply current candidate, emission and Global query ranges from the same attempted frame.',
      }),
    );
  if (!device.caps.compute || !device.caps.storageBuffer)
    return fail(
      'compute and storage-buffer support for probe origin diagnostics',
      'rhi-not-available',
    );
  for (const [name, count] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 7],
    ['maxStorageBuffersPerShaderStage', 6],
    ['maxUniformBuffersPerShaderStage', 1],
    ['maxUniformBufferBindingSize', 48],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
  ] as const)
    if (!(device.limits[name] >= count))
      return fail(`probe origin diagnostics require ${name} >= ${count}`, 'limit-exceeded');
  const layout = device.createBindGroupLayout({
    entries: [32, 32, 16, 64, 16, 48, PROBE_ORIGIN_SUPPORT_STRIDE].map(
      (minBindingSize, binding) => ({
        binding,
        visibility: 4,
        buffer: {
          type: binding === 5 ? 'uniform' : binding === 6 ? 'storage' : 'read-only-storage',
          minBindingSize,
        },
      }),
    ),
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: 'probe-global.origin-support',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'main' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: ProbeOriginSupportInputs,
      probeCount: number,
      rayCount: number,
    ): Result<void, RhiError> {
      if (
        !Number.isInteger(probeCount) ||
        probeCount < 1 ||
        probeCount > 4096 ||
        !Number.isInteger(rayCount) ||
        rayCount < probeCount ||
        rayCount > RAY_REFERENCE_LIMIT ||
        rayCount % probeCount !== 0 ||
        Math.ceil(probeCount / 64) > device.limits.maxComputeWorkgroupsPerDimension
      )
        return fail('bounded complete probe and query counts', 'limit-exceeded');
      const names = [
        'probes',
        'candidate',
        'emission',
        'hits',
        'voxels',
        'grid',
        'diagnostics',
      ] as const;
      const sizes = [
        probeCount * 32,
        probeCount * 32,
        probeCount * 16,
        rayCount * 64,
        input.voxels.size,
        48,
        probeCount * PROBE_ORIGIN_SUPPORT_STRIDE,
      ];
      for (let binding = 0; binding < names.length; binding++) {
        const name = names[binding];
        if (name === undefined) return fail('complete support bindings');
        const range = input[name];
        const alignment =
          binding === 5
            ? device.limits.minUniformBufferOffsetAlignment
            : device.limits.minStorageBufferOffsetAlignment;
        const limit =
          binding === 5
            ? device.limits.maxUniformBufferBindingSize
            : device.limits.maxStorageBufferBindingSize;
        if (
          !Number.isSafeInteger(range.offset ?? 0) ||
          (range.offset ?? 0) < 0 ||
          (range.offset ?? 0) % alignment !== 0 ||
          !Number.isSafeInteger(range.size) ||
          range.size <= 0 ||
          range.size !== sizes[binding] ||
          range.size > limit ||
          !Number.isSafeInteger((range.offset ?? 0) + range.size) ||
          (range.offset ?? 0) + range.size > device.limits.maxBufferSize ||
          (name === 'voxels' &&
            (range.size % 16 !== 0 || range.size < 4 ** 3 * 16 || range.size > 128 ** 3 * 16))
        )
          return fail(`exact aligned ${name} support range`);
      }
      if (names.slice(0, 6).some((name) => input[name].buffer === input.diagnostics.buffer))
        return fail('support output cannot alias a read input');
      const group = device.createBindGroup({
        layout: layout.value,
        entries: names.map((name, binding) => ({
          binding,
          resource: { kind: 'buffer', value: input[name] },
        })),
      });
      if (!group.ok) return group;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(probeCount / 64));
      return ok(undefined);
    },
  });
}
