import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { WORLD_CARD_RADIANCE_WGSL, worldTraversalWgsl } from '../../raytracing/world-traversal';
import { cardOwnerIndexExpected, cardOwnerIndexRows } from './card-owner-index.fixture';

export interface CardResidencyOwnerCase {
  readonly name: string;
  readonly owners: readonly number[];
  readonly states: readonly number[];
  readonly outside: ReadonlySet<number>;
  readonly candidates: readonly number[];
  readonly admitted: number;
  readonly pending: boolean;
  readonly lit: boolean;
  readonly logicalCount?: number;
}

/** Controlled query association only; the entire production Card consumer runs. */
export function cardResidencyOwnerKernel(wrongUnlit: boolean | 'break-stale' = false): string {
  const insertions = [
    ['let mid=lo+(hi-lo)/2u;let head=cards[mid].ids.z;', 'witnessDirectory+=1u;'],
    ['let card=cards[i];', 'witnessLookup+=1u;'],
    ['let card=cards[c];', 'witnessPending+=1u;'],
  ] as const;
  let observed = WORLD_CARD_RADIANCE_WGSL;
  for (const [marker, counter] of insertions) {
    if (observed.split(marker).length !== 2)
      throw new Error(`Expected one owner marker: ${marker}`);
    observed = observed.replace(marker, counter + marker);
  }
  let reversed = observed;
  for (const [, counter] of insertions) reversed = reversed.replace(counter, '');
  if (reversed !== WORLD_CARD_RADIANCE_WGSL)
    throw new Error('Card observation changed production text');
  if (wrongUnlit === 'break-stale') {
    const marker = 'if(card.ids.y==1u){return vec4f(0);}';
    if (observed.split(marker).length !== 2)
      throw new Error('Expected one actual resident-chain state test');
    observed = observed.replace(marker, `${marker}else{break;}`);
  } else if (wrongUnlit) {
    const tail = '  return vec4f(0,0,0,-1);\n }\n return vec4f(0);\n}';
    if (observed.split(tail).length !== 2)
      throw new Error('Expected one actual pending-result tail');
    observed = observed.replace(tail, tail.replace('vec4f(0,0,0,-1)', 'vec4f(0)'));
  }
  const world = worldTraversalWgsl('global-sdf');
  const declarations = ['Ray', 'Hit', 'Candidates'].map((name) => {
    const matches = [...world.matchAll(new RegExp(`struct ${name}\\s*\\{[^}]+\\}`, 'g'))];
    if (matches.length !== 1) throw new Error(`Expected one actual ${name} declaration`);
    return matches[0]?.[0];
  });
  const exact = [...world.matchAll(/const WORLD_HIT_NORMAL_EXACT:\s*bool\s*=\s*(?:true|false);/g)];
  if (exact.length !== 1) throw new Error('Expected one actual normal qualification');
  return `
${declarations.join('\n')}
${exact[0]?.[0]}
var<private> witnessDirectory:u32;
var<private> witnessLookup:u32;
var<private> witnessPending:u32;
struct ControlledQuery { candidates:Candidates, options:vec4u }
struct Observed { radiance:vec4f, work:vec4u }
@group(0) @binding(0) var<storage,read> cardLit:array<vec4f>;
@group(0) @binding(1) var<storage,read> cards:array<Card>;
@group(0) @binding(2) var<uniform> settings:vec4u;
@group(0) @binding(3) var albedo:texture_2d<f32>;
@group(0) @binding(4) var normal:texture_2d<f32>;
@group(0) @binding(5) var emission:texture_2d<f32>;
@group(0) @binding(6) var f0:texture_2d<f32>;
@group(0) @binding(7) var cardDepth:texture_depth_2d;
@group(0) @binding(8) var<storage,read_write> output:array<Observed>;
@group(0) @binding(9) var<uniform> query:ControlledQuery;
fn worldHitCandidates(hit:Hit)->Candidates{return query.candidates;}
fn worldCandidateOnRay(id:u32,ray:Ray)->bool{
 for(var k=0u;k<query.candidates.state.x;k++){
  if(query.candidates.ids[k]==id){return (query.options.y&(1u<<k))!=0u;}
 }
 return false;
}
${observed}
@compute @workgroup_size(1) fn main(){
 witnessDirectory=0u;witnessLookup=0u;witnessPending=0u;
 let hit=Hit(vec4u(1,0,0,0),vec4f(1,0,0,0),vec4f(0,0,0,1),vec4f(0,0,1,0));
 let value=worldCardRadiance(hit,.25,true,Ray(vec3f(0,0,1),0,vec3f(0,0,-1),2,vec4u(255,0,0,0)));
 output[0]=Observed(value,vec4u(witnessDirectory,witnessLookup,witnessPending,0u));
}
`;
}

function authored(
  name: string,
  count: number,
  changes: Readonly<Record<number, readonly [number, number]>>,
  options: {
    readonly candidates?: readonly number[];
    readonly outside?: readonly number[];
    readonly admitted?: number;
    readonly pending?: boolean;
    readonly lit?: boolean;
    readonly logicalCount?: number;
  } = {},
): CardResidencyOwnerCase {
  const candidates = options.candidates ?? [17];
  const owners = Array.from({ length: count }, (_, tile) => changes[tile]?.[0] ?? tile + 1000);
  const states = owners.map((_, tile) => changes[tile]?.[1] ?? 1);
  return {
    name,
    owners,
    states,
    candidates,
    outside: new Set(options.outside),
    admitted: options.admitted ?? (1 << candidates.length) - 1,
    pending: options.pending ?? true,
    lit: options.lit ?? true,
    ...(options.logicalCount === undefined ? {} : { logicalCount: options.logicalCount }),
  };
}

export function cardResidencyOwnerCases(): readonly CardResidencyOwnerCase[] {
  const count = 8,
    last = count - 1;
  return [
    authored('empty', 0, {}),
    authored('valid-before-stale', count, { 6: [17, 1], 7: [17, 0] }),
    authored('stale-before-valid', count, { 6: [17, 0], 7: [17, 1] }),
    authored('valid-outside-projection', count, { 7: [17, 1] }, { outside: [last] }),
    authored('stale-only', count, { 7: [17, 0] }),
    authored('missing-owner', count, {}),
    authored('pending-with-unrelated-resident', count, { 7: [17, 2] }),
    authored(
      'rejected-candidate-is-resident',
      count,
      { 7: [23, 1] },
      { candidates: [23, 17], outside: [last], admitted: 2 },
    ),
    authored(
      'rejected-candidate-permutation',
      count,
      { 7: [23, 1] },
      { candidates: [17, 23], outside: [last], admitted: 1 },
    ),
    authored(
      'two-admitted-owners',
      count,
      { 6: [17, 0], 7: [23, 1] },
      { candidates: [17, 23], outside: [last] },
    ),
    authored(
      'two-admitted-permutation',
      count,
      { 6: [17, 0], 7: [23, 1] },
      { candidates: [23, 17], outside: [last] },
    ),
    authored('no-admitted-candidate', count, { 7: [23, 1] }, { candidates: [23], admitted: 0 }),
    authored('pending-disabled', count, {}, { pending: false }),
    authored('mapped-unavailable-light', count, { 7: [17, 1] }, { lit: false }),
    ...[32, 512, 8192].map((size) =>
      authored(`unrelated-growth-${size}`, size, { [size - 2]: [17, 1], [size - 1]: [17, 0] }),
    ),
  ];
}

/** Legal producer domains only. Corrupt chains are not full-scan equivalence inputs. */
export function cardResidencyOwnerAdditionalCases(): readonly CardResidencyOwnerCase[] {
  return [
    authored('stale-before-outside-valid', 8, { 6: [17, 0], 7: [17, 1] }, { outside: [7] }),
    authored('pending-before-outside-valid', 8, { 6: [17, 2], 7: [17, 1] }, { outside: [7] }),
    authored(
      'logical-tail-valid-ignored',
      8,
      { 4: [17, 0], 5: [17, 2], 7: [17, 1] },
      { logicalCount: 6 },
    ),
    authored(
      'owner-zero-with-free-holes',
      8,
      { 0: [0xffffffff, 1], 4: [0, 0], 5: [0, 1], 6: [0xffffffff, 1] },
      { candidates: [0], outside: [5] },
    ),
    authored(
      'owner-zero-logical-tail-ignored',
      8,
      { 0: [0xffffffff, 1], 4: [0, 0], 5: [0, 2], 7: [0, 1] },
      { candidates: [0], logicalCount: 6 },
    ),
    authored(
      'maximum-legal-owner',
      8,
      { 0: [0xffffffff, 1], 6: [0xfffffffe, 0], 7: [0xfffffffe, 1] },
      { candidates: [0xfffffffe], outside: [7] },
    ),
    authored(
      'reserved-empty-is-not-owner',
      8,
      { 0: [0xffffffff, 1], 7: [0xffffffff, 1] },
      { candidates: [0xffffffff] },
    ),
  ];
}

/** Independent full physical roster, never the index words or production loop. */
export function cardResidencyOwnerOracle(test: CardResidencyOwnerCase) {
  const count = test.logicalCount ?? test.owners.length;
  const physical = test.owners.slice(0, count);
  const states = test.states.slice(0, count);
  const owners = test.candidates.filter((_, k) => (test.admitted & (1 << k)) !== 0);
  const pendingBound = physical.filter(
    (owner) => owner !== 0xffffffff && owners.includes(owner),
  ).length;
  for (const owner of owners) {
    const lookup = cardOwnerIndexExpected(physical, states, owner, test.outside);
    if (lookup.state === 1) return { rgba: test.lit ? [2, 3, 5, 1] : [0, 0, 0, -1], pendingBound };
  }
  const resident = physical.some(
    (owner, tile) => owner !== 0xffffffff && owners.includes(owner) && states[tile] === 1,
  );
  const unlit = test.pending && owners.length !== 0 && !resident;
  return { rgba: [0, 0, 0, unlit ? -1 : 0], pendingBound };
}

export function cardResidencyOwnerInputs(test: CardResidencyOwnerCase) {
  const count = test.logicalCount ?? test.owners.length;
  const cards = cardOwnerIndexRows(test.owners, test.states, test.outside);
  rebuildCardOwnerIndex(cards, count);
  const query = new Uint32Array(12);
  query.set([test.candidates.length, 0, 1, 0]);
  query.fill(0xffffffff, 4, 8);
  query.set(test.candidates, 4);
  query.set([1, test.admitted, 0, 0], 8);
  return {
    cards,
    query: new Uint8Array(query.buffer),
    settings: new Uint8Array(Uint32Array.of(count, 1, Number(test.pending), 0).buffer),
  };
}
