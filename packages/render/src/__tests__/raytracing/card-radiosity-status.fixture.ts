import { CARD_RADIOSITY_RAY_TRANSPORT_WGSL } from '../../raytracing/card-radiosity-kernels';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import { WorldCardSampleStatus } from '../../raytracing/world-traversal';

export const cardRadiosityStatusCases = [
  { state: GlobalSdfQueryStatus.miss, back: 0, card: [0, 0, 0, 0], expected: [0.25, 0.5, 0.75, 1] },
  {
    state: GlobalSdfQueryStatus.negativeStart,
    back: 0,
    card: [0, 0, 0, 0],
    expected: [0, 0, 0, 1],
  },
  { state: GlobalSdfQueryStatus.hit, back: 1, card: [0, 0, 0, 0], expected: [0, 0, 0, 1] },
  {
    state: GlobalSdfQueryStatus.hit,
    back: 0,
    card: [0, 0, 0, WorldCardSampleStatus.backface],
    expected: [0, 0, 0, 1],
  },
  {
    state: GlobalSdfQueryStatus.hit,
    back: 0,
    card: [0, 0, 0, WorldCardSampleStatus.mapped],
    expected: [0, 0, 0, 1],
  },
  {
    state: GlobalSdfQueryStatus.hit,
    back: 0,
    card: [0.5, 0.25, 0.125, WorldCardSampleStatus.mapped],
    expected: [0.5, 0.25, 0.125, 1],
  },
  {
    state: GlobalSdfQueryStatus.hit,
    back: 0,
    card: [0, 0, 0, WorldCardSampleStatus.unmapped],
    expected: [0, 0, 0, 0],
  },
  {
    state: GlobalSdfQueryStatus.missingField,
    back: 0,
    card: [0, 0, 0, WorldCardSampleStatus.mapped],
    expected: [0, 0, 0, 0],
  },
] as const;

export const cardRadiosityStatusFixture = `${CARD_RADIOSITY_RAY_TRANSPORT_WGSL}
@group(0) @binding(0) var<storage,read> cases:array<vec4u>;
@group(0) @binding(1) var<storage,read> cards:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn auditCardRadiosityStatus(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=arrayLength(&cases)){return;}
 let c=cases[i];let card=cards[i];let environment=vec3f(0.25,0.5,0.75);
 results[i*2u]=cardRadiosityRayTransport(c.x,c.y!=0u,card,environment);
 // Preserved former classifier: its missing backface cases invalidate a whole
 // otherwise complete sixteen-ray probe. This is an executable negative control.
 var old=vec4f(0);
 if(c.x==${GlobalSdfQueryStatus.miss}u){old=vec4f(environment,1);}
 else if(c.x==${GlobalSdfQueryStatus.hit}u&&c.y==0u&&card.w==${WorldCardSampleStatus.mapped}.0){old=vec4f(max(card.xyz,vec3f(0)),1);}
 results[i*2u+1u]=old;
}`;
