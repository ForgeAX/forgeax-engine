import { CARD_POINT_LOOKUP_WGSL } from '../../raytracing/card-lookup';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { writeCardLookupProjection } from '../../raytracing/surface-cards';

/** Mechanically counts the production directory iterations and physical visits. */
export function cardOwnerIndexWorkKernel(): string {
  const directory = 'let mid=lo+(hi-lo)/2u;let head=cards[mid].ids.z;';
  const visit = 'let card=cards[i];';
  if (
    CARD_POINT_LOOKUP_WGSL.split(directory).length !== 2 ||
    CARD_POINT_LOOKUP_WGSL.split(visit).length !== 2
  )
    throw new Error('Card work witness requires one exact production directory/visit boundary');
  const observed = CARD_POINT_LOOKUP_WGSL.replace(
    directory,
    `directorySteps+=1u;${directory}`,
  ).replace(visit, `ownedVisits+=1u;${visit}`);
  if (
    observed.replace('directorySteps+=1u;', '').replace('ownedVisits+=1u;', '') !==
    CARD_POINT_LOOKUP_WGSL
  )
    throw new Error('Work observation changed the production lookup');
  return `
var<private> directorySteps: u32;
var<private> ownedVisits: u32;
struct Query { position: vec4f, normal: vec4f, state: vec4u }
struct Observed { sample: Lookup, work: vec4u }
@group(0) @binding(0) var<storage,read> queries: array<Query>;
@group(0) @binding(1) var<storage,read> cards: array<Card>;
@group(0) @binding(2) var<storage,read_write> output: array<Observed>;
@group(0) @binding(3) var albedo: texture_2d<f32>;
@group(0) @binding(4) var normal: texture_2d<f32>;
@group(0) @binding(5) var emission: texture_2d<f32>;
@group(0) @binding(6) var f0: texture_2d<f32>;
@group(0) @binding(7) var cardDepth: texture_depth_2d;
@group(0) @binding(8) var<uniform> settings: vec4u;
${observed}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&queries)){return;}
 directorySteps=0u;ownedVisits=0u;
 let q=queries[gid.x];
 let sample=lookupCardPoint(q.position.xyz,q.normal.xyz,q.state.x,q.normal.w,q.state.y,settings.x,settings.y);
 output[gid.x]=Observed(sample,vec4u(directorySteps,ownedVisits,0u,0u));
}
`;
}

/** Authored atlas tiles; metadata comes from the same production index producer. */
export function cardOwnerIndexRows(
  owners: readonly number[],
  states: readonly number[],
  outside: ReadonlySet<number> = new Set(),
): Uint8Array {
  const rows = new Uint8Array(Math.max(1, owners.length) * 80);
  for (let tile = 0; tile < owners.length; tile++) {
    const origin = outside.has(tile) ? ([10, 10, 0] as const) : ([-1, -1, 0] as const);
    writeCardLookupProjection(
      rows,
      tile,
      {
        origin,
        u: [1, 0, 0],
        v: [0, 1, 0],
        n: [0, 0, 1],
        width: 2,
        height: 2,
        depth: 1,
      },
      owners[tile] ?? 0xffffffff,
      states[tile] ?? 1,
    );
  }
  rebuildCardOwnerIndex(rows, owners.length);
  return rows;
}

/** Original physical-order selection for these constant, aligned atlas tiles. */
export function cardOwnerIndexExpected(
  owners: readonly number[],
  states: readonly number[],
  owner: number,
  outside: ReadonlySet<number> = new Set(),
) {
  let state = 2,
    tile = 0xffffffff;
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] !== owner || owner === 0xffffffff) continue;
    if ((states[i] ?? 1) !== 1) {
      state = 3;
      continue;
    }
    if (!outside.has(i) && tile === 0xffffffff) {
      state = 1;
      tile = i;
    }
  }
  return { state, tile };
}
