import { buildVisibilityDistanceField } from '../../../../geometry/src/visibility-distance-field';
import { executable } from '../../../../shader/src/__tests__/sdf-surface-root.fixture';
import { CARD_OWNER_LOOKUP_WGSL, rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { writeCardLookupProjection } from '../../raytracing/surface-cards';
import { WORLD_BOUNDS_POOL_WGSL } from '../../raytracing/world-bounds-pool';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import { cardOwnerIndexRows } from './card-owner-index.fixture';
import { WORLD_BOUNDS_INDEX_QUERY_WGSL } from './world-bounds-index.fixture';

export type X01Point = readonly [number, number, number];
export const X01_RADIUS = 0.75;
const corners = [-1, 1].flatMap((z) =>
  [-1, 1].flatMap((y) => [-1, 1].map((x) => [x / 2, y / 2, z / 2])),
);
// Consistent binary corner order; each face has both triangles and outward winding.
const triangles = [
  0, 3, 1, 0, 2, 3, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 1, 3, 7, 1, 7, 5, 3, 2, 6, 3, 6, 7, 2, 0, 4,
  2, 4, 6,
];
let sharedField: ReturnType<typeof buildVisibilityDistanceField> | undefined;
function field() {
  sharedField ??= buildVisibilityDistanceField(
    Float32Array.from(corners.flat()),
    Uint32Array.from(triangles),
    {
      voxelSize: 0.25,
      triangleSidedness: new Uint8Array(12),
    },
  );
  return sharedField;
}

/** Morton prefixes remain genuinely three dimensional from the eight-row case.
 * All placement coordinates, local faces and query margins are binary32 exact.
 */
export function x01Center(row: number): X01Point {
  const axes = [0, 0, 0];
  for (let bit = 0; bit < 10; bit++)
    axes[bit % 3] = (axes[bit % 3] ?? 0) | (((row >>> bit) & 1) << Math.floor(bit / 3));
  return [(axes[0] ?? 0) * 4, (axes[1] ?? 0) * 4, (axes[2] ?? 0) * 4];
}
export async function x01Composition(
  count: number,
  variant: 'grid' | 'overlap' | 'missing' = 'grid',
) {
  const cube = (await field()).unwrap();
  const centers = Array.from(
    { length: count },
    (_, row): X01Point =>
      (variant === 'overlap' && row < 6) || (variant === 'missing' && row === count - 1)
        ? [0, 0, 0]
        : x01Center(row),
  );
  const ids = centers.map((_, row) => 1_000_003 + (count - row - 1) * 17);
  const sources = centers.map((point, row) => ({
    instanceId: ids[row] ?? 0,
    geometryId: 1,
    mask: 1,
    transform: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...point, 1),
    field:
      variant === 'missing' && row === count - 1
        ? { missing: true as const, bounds: cube.bounds }
        : cube,
  }));
  const composition = packGlobalSdfComposition(
    sources,
    {
      origin: [-2, -2, -2],
      dimensions: [2, 2, 2],
      spacing: 0.5,
      maxDistance: 1,
      coverageDistance: 1,
    },
    { sourceEpoch: 511, index: true },
  ).unwrap();
  return { composition, centers, ids, count, variant };
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const vector = (values: readonly number[]) => ({
  x: values[0] ?? 0,
  y: values[1] ?? 0,
  z: values[2] ?? 0,
  w: values[3] ?? 0,
});
const gridVectors = (bytes: Uint8Array) =>
  Array.from({ length: 6 }, (_, row) =>
    vector(
      Array.from({ length: 4 }, (_, column) => view(bytes).getUint32((row * 4 + column) * 4, true)),
    ),
  );

/** Independent wire consumer, not the builder's box/binning helper. Counts are
 * CPU CSR/roster rows to visit, NOT measured shader accesses or GPU timings.
 * The actual cursor additionally validates each local/oversized row reference.
 */
export function x01CursorRows(bytes: Uint8Array, point: X01Point, radius = X01_RADIUS) {
  const data = view(bytes),
    u = (word: number) => data.getUint32(word * 4, true),
    f = (word: number) => data.getFloat32(word * 4, true);
  const roster = () => ({
    mode: 'roster' as const,
    rows: Array.from({ length: u(2) }, (_, row) => row),
    regular: u(2),
    oversized: 0,
  });
  if (u(7) !== 1 || f(11) !== radius) return roster();
  const cell = point.map((value, axis) =>
    Math.floor(Math.fround(Math.fround(value - f(12 + axis)) / f(15))),
  );
  if (cell.some((value, axis) => !Number.isFinite(value) || value < 0 || value >= u(8 + axis)))
    return roster();
  const linear = ((cell[2] ?? 0) * u(9) + (cell[1] ?? 0)) * u(8) + (cell[0] ?? 0),
    start = u(u(16) + linear),
    end = u(u(16) + linear + 1);
  if (start > end || end > u(18)) return roster();
  const regular = Array.from({ length: end - start }, (_, i) => u(u(17) + start + i));
  const oversized = Array.from({ length: u(20) }, (_, i) => u(u(19) + i));
  if ([...regular, ...oversized].some((row) => row >= u(2))) return roster();
  return {
    mode: 'indexed' as const,
    rows: [...regular, ...oversized].sort((a, b) => a - b),
    regular: regular.length,
    oversized: oversized.length,
  };
}

/** Independent authored unit-cube necessary predicate, without the generated
 * index, SDF values or builder's expanded world envelopes. Candidate association
 * must keep these nearby boxes; this is not a signed-distance or radiance oracle.
 */
export function x01NearbyBoxes(centers: readonly X01Point[], point: X01Point) {
  return centers.flatMap((center, row) => {
    const d = point.map((value, axis) => Math.abs(value - (center[axis] ?? 0)) - 0.5);
    const distance =
      Math.hypot(...d.map((value) => Math.max(0, value))) + Math.min(0, Math.max(...d));
    return distance < X01_RADIUS ? [row] : [];
  });
}

/** Actual production binary-ID control with raw packed bytes and exact u32
 * arithmetic lowering. Distinguishes identity loads from index-word reads.
 */
export function x01ReverseId(bounds: Uint8Array, instances: Uint8Array, id: number) {
  let indexWords = 0,
    identityLoads = 0;
  const b = view(bounds),
    i = view(instances),
    count = instances.length / 144;
  const source = WORLD_BOUNDS_POOL_WGSL.replace('(hi-lo)/2u', 'half(hi-lo)');
  const actual = executable<number>(source, 'worldBoundsRowForId', 'id,count,radius', {
    bounds: gridVectors(bounds),
    half: (value: number) => Math.floor(value / 2),
    worldBoundsValid: () => true,
    worldBoundsIndexValid: () =>
      b.getUint32(28, true) === 1 && b.getFloat32(44, true) === X01_RADIUS,
    worldBoundsWord: (word: number) => {
      indexWords++;
      return b.getUint32(word * 4, true);
    },
    sdfInstanceWord: (row: number, word: number) => {
      identityLoads++;
      return i.getUint32(row * 144 + word * 4, true);
    },
  });
  const row = actual(id, count, X01_RADIUS);
  return { row, indexWords, identityLoads };
}

export function x01OwnerRows(ids: readonly number[], cardsPerOwner: number) {
  const owners: number[] = [],
    states: number[] = [];
  for (let face = 0; face < cardsPerOwner; face++)
    for (let index = 0; index < ids.length; index++) {
      if (owners.length % 7 === 0) {
        owners.push(0xffffffff);
        states.push(0);
      }
      owners.push(ids[(index * 73 + face * 31) % ids.length] ?? 0xffffffff);
      states.push(Number(face !== 0));
    }
  return { bytes: cardOwnerIndexRows(owners, states), owners, states };
}

/** Same 3D cube family grouped as one declared Card owner. This isolates a
 * large Mesh's local Card enumeration; it is NOT the many-instance DF scene.
 */
export function x01SpatialOwnerRows(cubeCount: number) {
  const faces = [
    { origin: [-0.5, -0.5, 0.5], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
    { origin: [0.5, -0.5, -0.5], u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
    { origin: [0.5, -0.5, 0.5], u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
    { origin: [-0.5, -0.5, -0.5], u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0] },
    { origin: [-0.5, 0.5, 0.5], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
    { origin: [-0.5, -0.5, -0.5], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  ];
  const bytes = new Uint8Array(cubeCount * 6 * 80);
  const triple = (parts: readonly number[]): X01Point => [
    parts[0] ?? 0,
    parts[1] ?? 0,
    parts[2] ?? 0,
  ];
  for (let row = 0; row < cubeCount; row++)
    for (const [face, projection] of faces.entries()) {
      const center = x01Center(row);
      writeCardLookupProjection(
        bytes,
        row * 6 + face,
        {
          origin: triple(projection.origin.map((value, axis) => value + (center[axis] ?? 0))),
          u: triple(projection.u),
          v: triple(projection.v),
          n: triple(projection.n),
          width: 1,
          height: 1,
          depth: 0.25,
        },
        7,
        1,
      );
    }
  rebuildCardOwnerIndex(bytes, cubeCount * 6);
  return bytes;
}

/** Necessary projection-prism support, independent of the owner chain and
 * texture samples. A sample may still reject; this does not certify mapped GI.
 */
export function x01LocalProjectionRows(bytes: Uint8Array, point: X01Point, margin = 0.75) {
  const data = view(bytes),
    result: number[] = [];
  for (let row = 0; row < bytes.length / 80; row++) {
    const f = (word: number) => data.getFloat32(row * 80 + word * 4, true);
    if (f(14) < 0.5) continue;
    const rel = point.map((value, axis) => value - f(axis));
    const dot = (first: number) =>
      rel.reduce((sum, value, axis) => sum + value * f(first + axis), 0);
    const u = dot(4),
      v = dot(8),
      depth = dot(12);
    if (
      u >= -margin &&
      u <= f(7) + margin &&
      v >= -margin &&
      v <= f(11) + margin &&
      depth >= -margin &&
      depth <= f(15) + margin
    )
      result.push(row);
  }
  return result;
}

/** Production directory control, followed by a test-only wire chain reader.
 * Physical-order scan is the independent oracle; stale rows stay owned.
 */
export function x01OwnerVisits(bytes: Uint8Array, owner: number) {
  const count = bytes.length / 80,
    data = view(bytes);
  let directorySteps = 0;
  const cards = Array.from({ length: count }, (_, row) => ({
    ids: vector(
      Array.from({ length: 4 }, (_, column) => data.getUint32(row * 80 + 64 + column * 4, true)),
    ),
  }));
  const anchor = 'let mid=lo+(hi-lo)/2u;let head=cards[mid].ids.z;';
  if (CARD_OWNER_LOOKUP_WGSL.split(anchor).length !== 2)
    throw Error('One production directory boundary required');
  const source = CARD_OWNER_LOOKUP_WGSL.replace(anchor, `step();${anchor}`).replace(
    '(hi-lo)/2u',
    'half(hi-lo)',
  );
  const first = executable<number>(source, 'firstOwnerCard', 'instanceId,count', {
    cards,
    step: () => {
      directorySteps++;
    },
    half: (value: number) => Math.floor(value / 2),
    select: (a: number, b: number, condition: boolean) => (condition ? b : a),
  });
  let cursor = first(owner, count),
    previous = 0;
  const visited: number[] = [];
  while (cursor !== 0) {
    if (
      cursor > count ||
      cursor <= previous ||
      data.getUint32((cursor - 1) * 80 + 64, true) !== owner
    )
      throw Error('Invalid physical owner chain');
    previous = cursor;
    visited.push(cursor - 1);
    cursor = data.getUint32((cursor - 1) * 80 + 76, true);
  }
  return { directorySteps, visited };
}

export { rebuildCardOwnerIndex };

/** Reversible observation on the actual production association body. Full-scan
 * reference is the maintained same-predicate fixture, not a new estimator.
 */
export function x01AssociationWorkKernel() {
  const source = worldTraversalWgsl('global-sdf');
  const edits = [
    ['let i=worldBoundsCursorRow(&cursor);', 'x01Visits++;let i=worldBoundsCursorRow(&cursor);'],
    [
      'let distance=max(sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz))',
      'x01Samples++;let distance=max(sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz))',
    ],
    ['fn worldBoundsWord(word:u32)->u32 {', 'fn worldBoundsWord(word:u32)->u32 {x01IndexWords++;'],
  ];
  let observed = source;
  for (const [anchor, replacement] of edits) {
    if (anchor === undefined || replacement === undefined || observed.split(anchor).length !== 2)
      throw Error('Exact association observation boundary required');
    observed = observed.replace(anchor, replacement);
  }
  let restored = observed;
  for (const [anchor, replacement] of [...edits].reverse())
    if (anchor !== undefined && replacement !== undefined)
      restored = restored.replace(replacement, anchor);
  if (restored !== source) throw Error('Observation changed production association');
  const referenceStart = WORLD_BOUNDS_INDEX_QUERY_WGSL.indexOf('fn referenceCandidates('),
    referenceEnd = WORLD_BOUNDS_INDEX_QUERY_WGSL.indexOf('@group(0) @binding(6)');
  const reference = WORLD_BOUNDS_INDEX_QUERY_WGSL.slice(referenceStart, referenceEnd);
  return `${observed}
var<private> x01Visits:u32;var<private> x01Samples:u32;var<private> x01IndexWords:u32;
struct X01Observed { routed:Candidates, generic:Candidates, reference:Candidates, routeWork:vec4u, genericWork:vec4u, reverseWork:vec4u }
@group(1) @binding(0) var<storage,read> x01Inputs:array<Hit>;
@group(1) @binding(1) var<uniform> x01Expected:vec4u;
@group(1) @binding(2) var<storage,read_write> x01Output:array<X01Observed>;
fn worldSceneExpected()->vec4u{return x01Expected;}
${reference}
fn x01Reset(){x01Visits=0u;x01Samples=0u;x01IndexWords=0u;}
@compute @workgroup_size(64) fn x01Candidates(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&x01Inputs)){return;}let hit=x01Inputs[id.x];x01Reset();
 let routed=worldHitCandidates(hit);let routeWork=vec4u(x01Visits,x01Samples,x01IndexWords,0u);x01Reset();
 let generic=findCandidates(SdfHit(hit.state,hit.metrics,hit.position,hit.normal));let genericWork=vec4u(x01Visits,x01Samples,x01IndexWords,0u);x01Reset();
 let reference=referenceCandidates(SdfHit(hit.state,hit.metrics,hit.position,hit.normal));x01Reset();
 let row=worldBoundsRowForId(hit.state.w,grid.dimensionsCount.w,grid.originSpacing.w*1.5);
 x01Output[id.x]=X01Observed(routed,generic,reference,routeWork,genericWork,vec4u(row,x01IndexWords,0u,0u));
}`;
}
