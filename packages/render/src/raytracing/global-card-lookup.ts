import type {
  Buffer,
  ComputePipeline,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  CARD_LOOKUP_STRIDE,
  CARD_LOOKUP_WGSL,
  CardLookupStatus,
  packCardLookupProjections,
} from './card-lookup';
import type { GlobalSdfComposition } from './global-sdf';
import {
  GLOBAL_SDF_HIT_STRIDE,
  type GlobalSdfQuery,
  GlobalSdfQueryStatus,
} from './global-sdf-query';
import { RAY_REFERENCE_LIMIT, type RayReferenceError, rayReferenceFailure } from './scene';
import { SDF_INSTANCE_STRIDE, SDF_SAMPLE_WGSL } from './sdf-query';
import { CARD_TEXTURES, type SurfaceCapture, type SurfaceCardSource } from './surface-cards';

/** meta = retained count, refusal flags, query status, admitted count; then four instance IDs. */
export const GLOBAL_CARD_CANDIDATE_STRIDE = 32;
export const GlobalCardCandidateFlags = { missingField: 1, overflow: 2, invalidNormal: 4 } as const;
export interface GlobalSdfCardLookup {
  /** Four independent CARD_LOOKUP_STRIDE entries per ray, in candidate order. No blended material identity. */
  readonly buffer: Buffer;
  readonly candidateBuffer: Buffer;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError | RhiError>;
  dispose(): void;
}

/** Distance-ordered instance association for one global hit. The composing
 * kernel declares Grid/`grid`, `instances`, `fields`, and `bounds`. */
export const GLOBAL_CARD_CANDIDATES_WGSL = `
struct ObjectBounds { lo: vec4f, hi: vec4f, scale: vec4f }
struct Candidates { state: vec4u, ids: vec4u }
fn findCandidates(hit: SdfHit) -> Candidates {
 var out=Candidates(vec4u(0,0,hit.state.x,0),vec4u(0xffffffffu));
 if(hit.state.x!=${GlobalSdfQueryStatus.hit}u){return out;}
 if(dot(hit.normal.xyz,hit.normal.xyz)<0.5){out.state.y=${GlobalCardCandidateFlags.invalidNormal}u;return out;}
 let halfSpacing=grid.originSpacing.w*0.5;
 let world=hit.position.xyz+hit.normal.xyz*halfSpacing;
 // Association support only: this radius is not a bound on geometric error.
 let radius=3.0*halfSpacing;
 var distances=vec4f(3.402823466e+38);
 for(var i=0u;i<grid.dimensionsCount.w;i++){
  let m=instances[i];if(m.ids.w==0u){continue;}
  let b=bounds[i];let p=(m.inverse*vec4f(world,1)).xyz;
  let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
  let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
  if(boxDistance>=radius){continue;}
  if(m.field.x==0xffffffffu){out.state.y|=${GlobalCardCandidateFlags.missingField}u;continue;}
  let distance=max(sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz))*b.scale.w+max(boxDistance,0.0),boxDistance);
  if(abs(distance)>=radius){continue;}
  out.state.w++;
  // Signed-distance ordering with stable instance-ID ties, independent of roster order.
  var slot=4u;
  for(var k=0u;k<4u;k++){
   if(distance<distances[k]||(distance==distances[k]&&m.ids.x<out.ids[k])){slot=k;break;}
  }
  if(slot<4u){
   for(var k=3u;k>slot;k--){distances[k]=distances[k-1u];out.ids[k]=out.ids[k-1u];}
   distances[slot]=distance;out.ids[slot]=m.ids.x;
  }
 }
 out.state.x=min(out.state.w,4u);
 if(out.state.w>4u){out.state.y|=${GlobalCardCandidateFlags.overflow}u;}
 return out;
}
`;

export const GLOBAL_SDF_CARD_LOOKUP_WGSL = `
${SDF_SAMPLE_WGSL}
struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
@group(0) @binding(0) var<storage,read> hits: array<SdfHit>;
@group(0) @binding(1) var<storage,read> instances: array<Instance>;
@group(0) @binding(2) var<storage,read> fields: array<u32>;
@group(0) @binding(3) var<storage,read> bounds: array<ObjectBounds>;
@group(0) @binding(4) var<uniform> grid: Grid;
@group(0) @binding(5) var<storage,read_write> candidates: array<Candidates>;
@group(0) @binding(6) var<storage,read> cards: array<Card>;
@group(0) @binding(7) var<storage,read_write> output: array<Lookup>;
@group(0) @binding(8) var<uniform> settings: vec4u;
@group(0) @binding(9) var albedo: texture_2d<f32>;
@group(0) @binding(10) var normal: texture_2d<f32>;
@group(0) @binding(11) var emission: texture_2d<f32>;
@group(0) @binding(12) var f0: texture_2d<f32>;
@group(0) @binding(13) var cardDepth: texture_depth_2d;
${CARD_LOOKUP_WGSL}
${GLOBAL_CARD_CANDIDATES_WGSL}
@compute @workgroup_size(64) fn selectCandidates(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x<arrayLength(&hits)){candidates[gid.x]=findCandidates(hits[gid.x]);}
}
@compute @workgroup_size(64) fn sampleCards(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=arrayLength(&hits)){return;}
 let hit=hits[gid.x];let c=candidates[gid.x];
 for(var k=0u;k<4u;k++){
  var sample=Lookup(vec4u(${CardLookupStatus.notSurface}u,hit.state.x,0xffffffffu,c.ids[k]),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
  if(hit.state.x==${GlobalSdfQueryStatus.hit}u){sample.state.x=${CardLookupStatus.unmapped}u;}
  if(k<c.state.x&&c.state.y==0u){
   // UE offsets the object-grid query; its executed Card lookup uses the original hit position.
   sample=lookupCardPoint(hit.position.xyz,hit.normal.xyz,c.ids[k],grid.originSpacing.w*1.5,hit.state.x,settings.x,settings.y);
  }
  output[gid.x*4u+k]=sample;
 }
}
`;

/** Frozen association diagnostic. Borrowed composition/query/cache must outlive the submitted work. */
export async function createGlobalSdfCardLookup(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  composition: GlobalSdfComposition,
  query: GlobalSdfQuery,
  cache: SurfaceCapture,
  expected: readonly SurfaceCardSource[],
): Promise<Result<GlobalSdfCardLookup, RayReferenceError | RhiError>> {
  if (cache.kind !== 'cards')
    return rayReferenceFailure('global Card lookup requires an offline card layout');
  if (
    query.buffers.voxels !== composition.buffers.voxels ||
    query.buffers.grid !== composition.buffers.settings
  )
    return rayReferenceFailure(
      'global Card lookup requires the composition that produced the query',
    );
  const { bytes, count } = packCardLookupProjections(
    cache,
    composition.sources.map((s) => ({ instanceId: s.instanceId, key: s.geometryKey })),
    expected,
  );
  const owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
  };
  const fail = <E>(r: Result<never, E>) => {
    dispose();
    return r;
  };
  const make = (name: string, data: Uint8Array, uniform = false) => {
    const b = device.createBuffer({
      label: `global-sdf.cards.${name}`,
      size: data.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!b.ok) return b;
    owned.push(b.value);
    const w = device.queue.writeBuffer(b.value, 0, data);
    return w.ok ? b : w;
  };
  const projections = make('projections', bytes);
  if (!projections.ok) return fail(projections);
  const candidates = make(
    'candidates',
    new Uint8Array(query.rayCount * GLOBAL_CARD_CANDIDATE_STRIDE),
  );
  if (!candidates.ok) return fail(candidates);
  const output = make('samples', new Uint8Array(query.rayCount * 4 * CARD_LOOKUP_STRIDE));
  if (!output.ok) return fail(output);
  const settings = make(
    'settings',
    new Uint8Array(new Uint32Array([count, cache.resolution, 0, 0]).buffer),
    true,
  );
  if (!settings.ok) return fail(settings);
  const textures = {} as Record<(typeof CARD_TEXTURES)[number], TextureView>;
  for (const name of CARD_TEXTURES) {
    const view = device.createTextureView(cache.textures[name], {});
    if (!view.ok) return fail(view);
    textures[name] = view.value;
  }
  const rayCount = query.rayCount;
  const rows = Math.max(1, composition.sources.length);
  const input: GlobalSdfCardLookupInputs = {
    hits: { buffer: query.buffers.hits, size: rayCount * GLOBAL_SDF_HIT_STRIDE },
    instances: { buffer: composition.buffers.instances, size: rows * SDF_INSTANCE_STRIDE },
    fields: { buffer: composition.buffers.fields },
    bounds: { buffer: composition.buffers.bounds, size: rows * 48 },
    grid: { buffer: composition.buffers.settings, size: 48 },
    candidates: { buffer: candidates.value, size: rayCount * GLOBAL_CARD_CANDIDATE_STRIDE },
    cards: { buffer: projections.value, size: bytes.byteLength },
    output: { buffer: output.value, size: rayCount * 4 * CARD_LOOKUP_STRIDE },
    settings: { buffer: settings.value, size: 16 },
    textures,
  };
  const shader = await compile(device, {
    code: GLOBAL_SDF_CARD_LOOKUP_WGSL,
    label: 'global-sdf.cards',
  });
  if (!shader.ok) return fail(shader);
  const recorder = createGlobalSdfCardLookupRecorder(device, shader.value);
  if (!recorder.ok) return fail(recorder);
  return ok({
    buffer: output.value,
    candidateBuffer: candidates.value,
    dispose,
    record(encoder) {
      if (disposed) return rayReferenceFailure('global Card lookup is disposed');
      for (const stage of CARD_STAGES) {
        const pass = encoder.beginComputePass({ label: `global-sdf.cards.${stage}` });
        try {
          const result = recorder.value.record(pass, input, rayCount, stage);
          if (!result.ok) return result;
        } finally {
          pass.end();
        }
      }
      return ok(undefined);
    },
  });
}

const CARD_STAGES = ['selectCandidates', 'sampleCards'] as const;
const CARD_BUFFER_BINDINGS = [
  ['hits', GLOBAL_SDF_HIT_STRIDE, 'read-only-storage'],
  ['instances', SDF_INSTANCE_STRIDE, 'read-only-storage'],
  ['fields', 4, 'read-only-storage'],
  ['bounds', 48, 'read-only-storage'],
  ['grid', 48, 'uniform'],
  ['candidates', GLOBAL_CARD_CANDIDATE_STRIDE, 'storage'],
  ['cards', 80, 'read-only-storage'],
  ['output', CARD_LOOKUP_STRIDE, 'storage'],
  ['settings', 16, 'uniform'],
] as const;

/** Borrowed ranges in the existing Global query/composition and Card ABI. Hits are
 * 64-byte rows; each ray writes one 32-byte candidate and four 112-byte samples.
 * Grid/settings are 48/16 bytes. Matching instances/bounds use 144/48-byte rows,
 * with one padding row for an empty scene; Card projections use 80-byte rows.
 * The producer validates grid counts, packed field indices, Card settings and
 * matching texture contents. It records query/capture before selection, then
 * sampleCards, and retains every input/output until submission completes.
 *
 * fields alone may omit size to retain the reference composition's native
 * whole-buffer binding. RHI then validates its actual remaining capacity and
 * binding limit, as well as every resource's usage and device ownership. */
export type GlobalSdfCardLookupInputs = Readonly<
  Record<
    Exclude<(typeof CARD_BUFFER_BINDINGS)[number][0], 'fields'>,
    { readonly buffer: Buffer; readonly offset?: number; readonly size: number }
  >
> & {
  readonly fields: { readonly buffer: Buffer; readonly offset?: number; readonly size?: number };
  readonly textures: Readonly<Record<(typeof CARD_TEXTURES)[number], TextureView>>;
};

/** The same two Card kernels for reference and caller-owned resources. Opens no
 * pass and owns no buffers, texture views, uploads, submission or retirement. */
export function createGlobalSdfCardLookupRecorder(device: RhiDevice, module: ShaderModule) {
  const failure = (expected: string, code: RhiError['code'] = 'rhi-descriptor-invalid') =>
    err(
      new RhiError({
        code,
        expected,
        hint: 'Supply supported limits and producer-validated Global query, composition and Card bindings.',
      }),
    );
  if (!device.caps.compute || !device.caps.storageBuffer)
    return failure(
      'compute and storage-buffer support for Global Card lookup',
      'rhi-not-available',
    );
  for (const [name, required] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 14],
    ['maxStorageBuffersPerShaderStage', 7],
    ['maxUniformBuffersPerShaderStage', 2],
    ['maxSampledTexturesPerShaderStage', 5],
    ['maxUniformBufferBindingSize', 48],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
  ] as const)
    if (!(device.limits[name] >= required))
      return failure(`Global Card lookup requires ${name} >= ${required}`, 'limit-exceeded');
  const layout = device.createBindGroupLayout({
    entries: [
      ...CARD_BUFFER_BINDINGS.map(([, minBindingSize, type], binding) => ({
        binding,
        visibility: 4,
        buffer: { type, minBindingSize },
      })),
      ...CARD_TEXTURES.map((name, i) => ({
        binding: CARD_BUFFER_BINDINGS.length + i,
        visibility: 4,
        texture: {
          sampleType: name === 'depth' ? ('depth' as const) : ('unfilterable-float' as const),
        },
      })),
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipelines = {} as Record<(typeof CARD_STAGES)[number], ComputePipeline>;
  for (const entryPoint of CARD_STAGES) {
    const pipeline = device.createComputePipeline({
      layout: pipelineLayout.value,
      compute: { module, entryPoint },
    });
    if (!pipeline.ok) return pipeline;
    pipelines[entryPoint] = pipeline.value;
  }
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: GlobalSdfCardLookupInputs,
      rayCount: number,
      stage: (typeof CARD_STAGES)[number],
    ): Result<void, RhiError> {
      if (
        !Number.isSafeInteger(rayCount) ||
        rayCount < 1 ||
        rayCount > RAY_REFERENCE_LIMIT ||
        !(Math.ceil(rayCount / 64) <= device.limits.maxComputeWorkgroupsPerDimension)
      )
        return failure(
          'Global Card ray count in 1..65536 within dispatch limits',
          'limit-exceeded',
        );
      const rows = input.instances.size / SDF_INSTANCE_STRIDE;
      if (
        !Number.isInteger(rows) ||
        rows < 1 ||
        rows > 1024 ||
        input.bounds.size !== rows * 48 ||
        input.grid.size !== 48 ||
        input.settings.size !== 16 ||
        input.hits.size !== rayCount * GLOBAL_SDF_HIT_STRIDE ||
        input.candidates.size !== rayCount * GLOBAL_CARD_CANDIDATE_STRIDE ||
        input.output.size !== rayCount * 4 * CARD_LOOKUP_STRIDE ||
        !Number.isSafeInteger(input.cards.size) ||
        input.cards.size < 80 ||
        input.cards.size % 80 !== 0 ||
        (input.fields.size !== undefined &&
          (!Number.isSafeInteger(input.fields.size) ||
            input.fields.size < 4 ||
            input.fields.size % 4 !== 0))
      )
        return failure(
          'matching instance/bounds rows, u32 field words, Card projections and exact hit/candidate/sample/settings ranges',
        );
      for (const [name, , type] of CARD_BUFFER_BINDINGS) {
        const range = input[name],
          offset = range.offset ?? 0;
        const uniform = type === 'uniform';
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
          !(offset < device.limits.maxBufferSize) ||
          (range.size !== undefined &&
            (!Number.isSafeInteger(offset + range.size) ||
              !(offset + range.size <= device.limits.maxBufferSize) ||
              !(
                range.size <=
                (uniform
                  ? device.limits.maxUniformBufferBindingSize
                  : device.limits.maxStorageBufferBindingSize)
              )))
        )
          return failure(`${name} range within device buffer limits`, 'limit-exceeded');
      }
      // Conservatively reject any shared output allocation, including an unknown
      // whole-buffer fields tail; offset arithmetic cannot prove it disjoint.
      for (const output of ['candidates', 'output'] as const)
        if (
          CARD_BUFFER_BINDINGS.some(
            ([name]) => name !== output && input[name].buffer === input[output].buffer,
          )
        )
          return failure('Global Card candidate/sample outputs must not alias another binding');
      const group = device.createBindGroup({
        layout: layout.value,
        entries: [
          ...CARD_BUFFER_BINDINGS.map(([name], binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value: input[name] },
          })),
          ...CARD_TEXTURES.map((name, i) => ({
            binding: CARD_BUFFER_BINDINGS.length + i,
            resource: { kind: 'textureView' as const, value: input.textures[name] },
          })),
        ],
      });
      if (!group.ok) return group;
      pass.setPipeline(pipelines[stage]);
      pass.setBindGroup(0, group.value);
      pass.dispatchWorkgroups(Math.ceil(rayCount / 64));
      return ok(undefined);
    },
  });
}
