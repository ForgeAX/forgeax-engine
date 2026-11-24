
@group(0) @binding(0) var<storage,read> probeList: array<u32>;
@group(0) @binding(1) var<storage,read> probeMeta: array<vec4u>;
@group(0) @binding(2) var<uniform> probeField: Field;
@group(0) @binding(3) var<uniform> frame: Frame;
@group(0) @binding(4) var<storage,read_write> probeOrigins: array<ProbeOrigin>;

struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct Frame { schedule: vec4u, cards: vec4u, atlas: vec4u, environment: vec4f, trace: vec4f, gather: vec4u, query: vec4u, expectedSource:vec4u }
struct Field { originSpacing: vec4f, dimensionsCount: vec4u, bias: vec4f, levels: vec4u, window: array<vec4i,4>, validMin: array<vec4i,4>, validMax: array<vec4i,4> }
struct CardSurface { position: vec3f, mask: u32, normal: vec3f, valid: u32, albedo: vec4f, emission: vec4f }
struct ProbeRay { radianceDistance: vec4f, directionStatus: vec4f }
struct ProbeOrigin { position: vec3f, probe: u32, updates: u32 }
fn linearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }
fn probeScale(probe: u32) -> f32 { return f32(1u<<(probe/probeField.levels.y)); }
// Toroidal decode: storage slot p of level l holds the window cell congruent to p.
fn probePosition(probe: u32) -> vec3f {
 let level=probe/probeField.levels.y;let local=probe%probeField.levels.y;
 let d=probeField.dimensionsCount.xyz;let di=vec3i(d);
 let p=vec3i(vec3u(local%d.x,(local/d.x)%d.y,local/(d.x*d.y)));
 let w=probeField.window[level].xyz;
 let c=w+(((p-w)%di)+di)%di;
 return probeField.originSpacing.xyz+vec3f(c)*(probeField.originSpacing.w*probeScale(probe));
}
const PROBE_FRESH=0x80000000u;const PROBE_FAST=0x40000000u;const PROBE_INDEX=0x3fffffffu;
// meta.zw: relocation offset in probe spacings from the lattice point, f16 xyz.
fn probeOffset(state: vec4u, spacing: f32) -> vec3f { return vec3f(unpack2x16float(state.z),unpack2x16float(state.w).x)*spacing; }

@compute @workgroup_size(64) fn placeProbes(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
 let i=linearId(gid,groups);
 if(i>=frame.schedule.y){return;}
 let entry=probeList[i];let probe=entry&PROBE_INDEX;
 let spacing=probeField.originSpacing.w*probeScale(probe);
 let origin=probePosition(probe)+select(probeOffset(probeMeta[probe],spacing),vec3f(0),(entry&PROBE_FRESH)!=0u);
 let updates=select(probeMeta[probe].x,0u,(entry&PROBE_FRESH)!=0u);
 probeOrigins[i]=ProbeOrigin(origin,probe,updates);
}
