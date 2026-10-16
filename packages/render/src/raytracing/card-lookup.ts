import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import { type SdfQuery, SdfQueryStatus } from './sdf-query';
import {
  CARD_TEXTURES,
  packCardProjection,
  type SurfaceCapture,
  type SurfaceCaptureSource,
  type SurfaceCardSource,
  surfaceCardKey,
} from './surface-cards';
export const CardLookupStatus = { notSurface: 0, mapped: 1, unmapped: 2, stale: 3 } as const;
export const CARD_LOOKUP_STRIDE = 112;
/** Card lookup at a world point (`lookupCardPoint`); needs no SDF hit type. */
export const CARD_POINT_LOOKUP_WGSL = `
fn decodeCardNormal(p: vec2f) -> vec3f {
 var n = vec3f(p,1.0-abs(p.x)-abs(p.y));
 if(n.z<0.0){n=vec3f((vec2f(1)-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}
 return normalize(n);
}
struct Card { origin: vec4f, u: vec4f, v: vec4f, n: vec4f, ids: vec4u }
struct Lookup { state: vec4u, albedoRoughness: vec4f, normalDepth: vec4f, emissionMetallic: vec4f, f0: vec4f, texels: vec4u, weights: vec4f }
fn lookupCardPoint(position: vec3f, hitNormal: vec3f, instanceId: u32, projectionMargin: f32, queryStatus: u32, cardCount: u32, resolution: u32) -> Lookup {
 var out=Lookup(vec4u(${CardLookupStatus.unmapped}u,queryStatus,0xffffffffu,instanceId),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
 var best=-1.0;
 for(var i=0u;i<cardCount;i++){
  let card=cards[i];if(card.ids.x!=instanceId){continue;}
  if(card.ids.y!=1u){out.state.x=${CardLookupStatus.stale}u;continue;}
  let alignment=dot(hitNormal,card.n.xyz);if(alignment<0.5){continue;}
  let rel=position-card.origin.xyz;let uv=vec2f(dot(rel,card.u.xyz)/card.u.w,dot(rel,card.v.xyz)/card.v.w);
  // The caller owns the world-space projection margin and its approximation.
  // Preserve depth/orientation tests when admitting a point outside the silhouette.
  // Interior points have exact zero edge distance. Keep that decision separate
  // from GPU distance arithmetic, especially for zero-allowance visibility hits.
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){
   let edge=clamp(uv,vec2f(0),vec2f(1));
   if(length((uv-edge)*vec2f(card.u.w,card.v.w))>projectionMargin){continue;}
  }
  let depth=-dot(rel,card.n.xyz)/card.n.w;
  let pixelRadius=0.5*length(vec2f(card.u.w,card.v.w))/f32(resolution);
  let tolerance=projectionMargin+pixelRadius+card.n.w/1024.0;
  let xy=clamp(uv*f32(resolution)-vec2f(0.5),vec2f(0),vec2f(f32(resolution-1u)));
  let base=vec2u(floor(xy));let fraction=fract(xy);
  let tile=vec2u(i%(textureDimensions(f0).x/resolution),i/(textureDimensions(f0).x/resolution))*resolution;
  var texels=vec4u(0xffffffffu);var weights=vec4f(0);
  var a=vec4f(0);var e=vec4f(0);var specular=vec3f(0);var n=vec3f(0);var z=0.0;var error=0.0;var materialFlags=0u;var materialWeight=-1.0;
  for(var tap=0u;tap<4u;tap++){
   let offset=vec2u(tap&1u,tap>>1u);
   let axisWeight=select(vec2f(1)-fraction,fraction,offset>vec2u(0));let weight=axisWeight.x*axisWeight.y;
   if(weight<=0.0){continue;}
   let pixel=vec2i(tile+min(base+offset,vec2u(resolution-1u)));
   let material=textureLoad(f0,pixel,0);if((u32(material.w)&3u)!=1u){continue;}
   let frame=textureLoad(normal,pixel,0);if(dot(decodeCardNormal(frame.zw),hitNormal)<0.5){continue;}
   let sampleDepth=textureLoad(cardDepth,pixel,0);let delta=abs(depth-sampleDepth)*card.n.w;
   if(delta>tolerance){continue;}
   // Discrete material metadata follows the strongest accepted sample.
   if(weight>materialWeight){materialFlags=u32(material.w);materialWeight=weight;}
   texels[tap]=u32(pixel.y)*textureDimensions(f0).x+u32(pixel.x);weights[tap]=weight;
   a+=textureLoad(albedo,pixel,0)*weight;e+=textureLoad(emission,pixel,0)*weight;specular+=material.xyz*weight;
   n+=decodeCardNormal(frame.xy)*weight;z+=sampleDepth*weight;error+=delta*weight;
  }
  let support=dot(weights,vec4f(1));if(support<=0.0||length(n)<1e-10){continue;}
  let score=alignment-error/support/max(tolerance,1e-8)*0.1;
  if(score>best){best=score;out=Lookup(vec4u(${CardLookupStatus.mapped}u,queryStatus,i,instanceId),a/support,vec4f(normalize(n),z/support),e/support,vec4f(specular/support,f32(materialFlags)),texels,weights/support);}
 }
 return out;
}
`;
/** `lookupCardPoint` plus the `SdfHit` adapter `lookupSdfCard`. */
export const CARD_LOOKUP_WGSL = `${CARD_POINT_LOOKUP_WGSL}
fn lookupSdfCard(hit: SdfHit, cardCount: u32, resolution: u32) -> Lookup {
 if(hit.state.x!=${SdfQueryStatus.surfaceBand}u&&hit.state.x!=${SdfQueryStatus.visibilityHit}u){
  return Lookup(vec4u(${CardLookupStatus.notSurface}u,hit.state.x,0xffffffffu,hit.state.y),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
 }
 return lookupCardPoint(hit.position.xyz,hit.normal.xyz,hit.state.y,hit.metrics.y,hit.state.x,cardCount,resolution);
}

`;
const WGSL = `
struct SdfHit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
@group(0) @binding(0) var<storage,read> hits: array<SdfHit>;
@group(0) @binding(1) var<storage,read> cards: array<Card>;
@group(0) @binding(2) var<storage,read_write> output: array<Lookup>;
@group(0) @binding(3) var albedo: texture_2d<f32>;
@group(0) @binding(4) var normal: texture_2d<f32>;
@group(0) @binding(5) var emission: texture_2d<f32>;
@group(0) @binding(6) var f0: texture_2d<f32>;
@group(0) @binding(7) var cardDepth: texture_depth_2d;
@group(0) @binding(8) var<uniform> settings: vec4u;
${CARD_LOOKUP_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u){
 if(gid.x<arrayLength(&hits)){output[gid.x]=lookupSdfCard(hits[gid.x],settings.x,settings.y);}
}
`;
export interface SdfCardLookup {
  readonly buffer: Buffer;
  record(encoder: RhiCommandEncoder): Result<void, RayReferenceError>;
  dispose(): void;
}
export function packCardLookupProjections(
  cache: SurfaceCapture,
  sources: readonly { readonly instanceId: number; readonly key: string }[],
  expected: readonly (SurfaceCardSource | Pick<SurfaceCaptureSource, 'instance' | 'captureKey'>)[],
): { readonly bytes: Uint8Array; readonly count: number } {
  const projectionBytes = new Uint8Array(
      Math.max(
        1,
        cache.entries.reduce((n, e) => n + e.projections.length, 0),
      ) * 80,
    ),
    view = new DataView(projectionBytes.buffer);
  let count = 0;
  for (const entry of cache.entries) {
    const source = expected.find((s) => s.instance.instanceId === entry.instanceId);
    const current = sources.find((s) => s.instanceId === entry.instanceId);
    const valid =
      source !== undefined &&
      current?.key === entry.geometryKey &&
      ('captureKey' in source ? source.captureKey : surfaceCardKey(source)) === entry.captureKey;
    for (const p of entry.projections) {
      projectionBytes.set(packCardProjection(p), count * 80);
      view.setUint32(count * 80 + 64, entry.instanceId, true);
      view.setUint32(count * 80 + 68, valid ? 1 : 0, true);
      count++;
    }
  }
  return { bytes: projectionBytes, count };
}

/** The expected sources are a frozen frame/batch input; stale captures stay explicit data. */
export async function createSdfCardLookup(
  device: RhiDevice,
  compile: (
    device: RhiDevice,
    desc: { code: string; label?: string },
  ) => Promise<Result<ShaderModule, RhiError>>,
  query: SdfQuery,
  cache: SurfaceCapture,
  expected: readonly SurfaceCardSource[],
): Promise<Result<SdfCardLookup, RayReferenceError | RhiError>> {
  if (cache.kind !== 'cards')
    return rayReferenceFailure('card lookup requires an offline card layout');
  const { bytes: projectionBytes, count } = packCardLookupProjections(
    cache,
    query.sources,
    expected,
  );
  const owned: Buffer[] = [];
  const dispose = () => {
    for (const b of owned) device.destroyBuffer(b);
    owned.length = 0;
  };
  const fail = <E>(r: Result<never, E>) => {
    dispose();
    return r;
  };
  const make = (name: string, bytes: Uint8Array, uniform = false) => {
    const b = device.createBuffer({
      label: `cards.${name}`,
      size: bytes.byteLength,
      usage: (uniform ? 64 : 128) | 12,
    });
    if (!b.ok) return b;
    owned.push(b.value);
    const w = device.queue.writeBuffer(b.value, 0, bytes);
    return w.ok ? b : w;
  };
  const projections = make('lookup-projections', projectionBytes),
    output = make('lookup', new Uint8Array(query.rayCount * CARD_LOOKUP_STRIDE)),
    settings = make(
      'lookup-settings',
      new Uint8Array(new Uint32Array([count, cache.resolution, 0, 0]).buffer),
      true,
    );
  if (!projections.ok) return fail(projections);
  if (!output.ok) return fail(output);
  if (!settings.ok) return fail(settings);
  const views = [];
  for (const name of CARD_TEXTURES) {
    const v = device.createTextureView(cache.textures[name], {});
    if (!v.ok) return fail(v);
    views.push(v.value);
  }
  const layout = device.createBindGroupLayout({
    entries: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((binding) => ({
      binding,
      visibility: 4,
      ...(binding === 7
        ? { texture: { sampleType: 'depth' as const } }
        : binding >= 3 && binding <= 6
          ? { texture: { sampleType: 'unfilterable-float' as const } }
          : {
              buffer: {
                type:
                  binding === 8
                    ? ('uniform' as const)
                    : binding === 2
                      ? ('storage' as const)
                      : ('read-only-storage' as const),
              },
            }),
    })),
  });
  if (!layout.ok) return fail(layout);
  const group = device.createBindGroup({
    layout: layout.value,
    entries: [
      ...[query.buffers.hits, projections.value, output.value].map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer } },
      })),
      ...views.map((value, i) => ({
        binding: 3 + i,
        resource: { kind: 'textureView' as const, value },
      })),
      { binding: 8, resource: { kind: 'buffer', value: { buffer: settings.value } } },
    ],
  });
  if (!group.ok) return fail(group);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return fail(pipelineLayout);
  const shader = await compile(device, { code: WGSL, label: 'cards.lookup' });
  if (!shader.ok) return fail(shader);
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout.value,
    compute: { module: shader.value, entryPoint: 'main' },
  });
  if (!pipeline.ok) return fail(pipeline);
  let disposed = false;
  return ok({
    buffer: output.value,
    record(encoder) {
      if (disposed) return rayReferenceFailure('card lookup is disposed');
      const p = encoder.beginComputePass({ label: 'cards.lookup' });
      p.setPipeline(pipeline.value);
      p.setBindGroup(0, group.value);
      p.dispatchWorkgroups(Math.ceil(query.rayCount / 64));
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
