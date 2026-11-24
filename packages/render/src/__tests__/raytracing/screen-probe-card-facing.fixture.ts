import { createHash } from 'node:crypto';
import { assert } from 'vitest';
import { SCREEN_PROBE_ENDPOINT_WGSL } from '../../raytracing/screen-probe-endpoint';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { SCREEN_PROBE_RECORD_BYTES } from '../../raytracing/screen-probe-plan';
import { SCREEN_PROBE_CONTACT_WGSL } from '../../raytracing/screen-probe-receiver';
import { WORLD_CARD_RADIANCE_WGSL, worldTraversalWgsl } from '../../raytracing/world-traversal';

/** Controlled post-Hit input, never a qualified canonical receiver. */
export function packControlledCardFacingProbe() {
  const bytes = new Uint8Array(SCREEN_PROBE_RECORD_BYTES);
  new Float32Array(bytes.buffer).set([0, 0, 0, 1, 0, 0, 1, 0]);
  // Actual ScreenProbe96 enclosure/identity fields: no receiver source certificate.
  new Uint32Array(bytes.buffer).set(
    [0, 0, 0, 0xffff_ffff, 0, 0, 0, 0xffff_ffff, 0, 0, 0, 0, 0, 0, 0, 0],
    8,
  );
  return bytes;
}

/** Retain the actual facing/lookup/resolve suffix. The injected Hit deliberately
 * does not prove World geometry, canonical reconstruction, contact or endpoints. */
export function controlledCardFacingSource(
  exact: boolean,
  production = screenProbeWorldWgsl(exact ? 'ray-query' : 'global-sdf'),
) {
  const traversal = exact ? 'ray-query' : 'global-sdf';
  const prefix = worldTraversalWgsl(traversal, false, !exact, !exact);
  assert(production.slice(0, prefix.length) === prefix, 'Actual World prefix is byte-exact');
  let suffix = production.slice(prefix.length);
  if (!exact) {
    for (const declaration of [SCREEN_PROBE_CONTACT_WGSL, SCREEN_PROBE_ENDPOINT_WGSL]) {
      assert(suffix.split(declaration).length === 2, 'One source-owned receiver declaration');
      suffix = suffix.replace(declaration, '');
    }
  }
  assert(suffix.split(WORLD_CARD_RADIANCE_WGSL).length === 2, 'One complete radiance authority');
  const entryMarker = '@compute @workgroup_size(64) fn traceWorldProbes(';
  assert(suffix.split(entryMarker).length === 2, 'Unique actual dispatch entry');
  const entry = suffix.indexOf(entryMarker);
  const queryMarker =
    ' // Screen misses do not prove empty world space, especially at subpixel walls.';
  const statusMarker = ' let status=hit.state.x;';
  const query = suffix.indexOf(queryMarker, entry);
  const status = suffix.indexOf(statusMarker, query);
  assert(query > entry && status > query, 'Closed query-to-Hit splice');
  assert(suffix.slice(entry).split(statusMarker).length === 2, 'Unique post-Hit status tail');
  const origins = suffix.slice(query, status).match(/let origin=[^;]+;/g);
  assert(origins?.length === 1, 'Keep the actual selected origin statement');
  const tail = suffix.slice(status);
  const producer = `
const WORLD_HIT_NORMAL_EXACT:bool=${exact};
struct Ray { origin:vec3f,tMin:f32,direction:vec3f,tMax:f32,mask:vec4u }
struct Hit { state:vec4u,metrics:vec4f,position:vec4f,normal:vec4f }
struct Candidates { state:vec4u,ids:vec4u }
@group(0) @binding(0) var<storage,read> controlledHit:array<Hit>;
fn traceWorld(ray:Ray,maxSteps:u32,minStep:f32)->Hit{return controlledHit[0];}
fn worldHitCandidates(hit:Hit)->Candidates{return Candidates(vec4u(1,0,1,1),vec4u(7,0xffffffffu,0xffffffffu,0xffffffffu));}
fn worldCandidateOnRay(id:u32,ray:Ray)->bool{return true;}
fn worldSurfaceOrigin(position:vec3f,normal:vec3f,bias:f32)->vec3f{return position+normal*bias;}
`;
  const source = `${producer}${suffix.slice(0, query)} ${origins[0]}
 let hit=controlledHit[0];
${tail}`;
  assert(source.includes(WORLD_CARD_RADIANCE_WGSL) && source.endsWith(tail));
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  return {
    source,
    tail,
    prefix,
    identity: {
      productionSha256: sha(production),
      prefixSha256: sha(prefix),
      retainedRadianceSha256: sha(WORLD_CARD_RADIANCE_WGSL),
      retainedTailSha256: sha(tail),
      scope: 'controlled post-Hit facing/lookup/resolve only',
      receiverQualified: false,
    },
  };
}
