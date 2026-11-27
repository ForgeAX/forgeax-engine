import { worldTraversalWgsl } from '../../raytracing/world-traversal';

const bits = new DataView(new ArrayBuffer(4));
export function floatBits(value: number): number {
  bits.setFloat32(0, value, true);
  return bits.getUint32(0, true);
}
export function bitsFloat(value: number): number {
  bits.setUint32(0, value, true);
  return bits.getFloat32(0, true);
}

export interface HardwareEndpointCase {
  readonly name: string;
  readonly planes: readonly [number, number];
  readonly direction: number;
  readonly first: number;
  readonly last: number;
  readonly expected: 0 | 1 | 4;
  readonly primitive?: number;
  readonly steps?: number;
}

export const HARDWARE_ENDPOINT_CASES: readonly HardwareEndpointCase[] = [
  {
    name: 'opaque-closed-upper',
    planes: [1, 2],
    direction: 1,
    first: 0,
    last: 1,
    expected: 1,
    primitive: 0,
  },
  {
    name: 'opaque-positive-closed-lower',
    planes: [1, 2],
    direction: 1,
    first: 1,
    last: 3,
    expected: 1,
    primitive: 0,
  },
  {
    name: 'outside-lower-gap-before-inside',
    planes: [bitsFloat(floatBits(1.875) - 1), 2.5],
    direction: 1.25,
    first: 1.5,
    last: 3,
    expected: 1,
    primitive: 1,
  },
  {
    name: 'outside-lower-gap-only',
    planes: [bitsFloat(floatBits(1.875) - 1), bitsFloat(floatBits(1.875) - 1)],
    direction: 1.25,
    first: 1.5,
    last: 3,
    expected: 0,
  },
  {
    name: 'outside-upper-gap-only',
    planes: [bitsFloat(floatBits(1.875) + 1), 3],
    direction: 1.25,
    first: 0,
    last: 1.5,
    expected: 0,
  },
  {
    name: 'outside-upper-gap-with-inside',
    planes: [bitsFloat(floatBits(1.875) + 1), 1.25],
    direction: 1.25,
    first: 0,
    last: 1.5,
    expected: 1,
    primitive: 1,
  },
  {
    name: 'adjacent-lower-ulp-before-inside',
    planes: [bitsFloat(floatBits(1) - 1), 2],
    direction: 1,
    first: 1,
    last: 3,
    expected: 1,
    primitive: 1,
  },
  {
    name: 'adjacent-upper-ulp-with-inside',
    planes: [bitsFloat(floatBits(1) + 1), 1],
    direction: 1,
    first: 0,
    last: 1,
    expected: 1,
    primitive: 1,
  },
  {
    name: 'recovery-shares-proceed-budget',
    planes: [bitsFloat(floatBits(1.875) - 1), 2.5],
    direction: 1.25,
    first: 1.5,
    last: 3,
    expected: 4,
    steps: 1,
  },
];

type Rational = readonly [bigint, bigint];
/** Independent exact dyadic input decoding, with rational plane/ray intersection. */
function rational(value: number): Rational {
  const word = floatBits(value),
    exponent = ((word >>> 23) & 255) - 150;
  if ((word & 0x80000000) !== 0 || ((word >>> 23) & 255) === 0 || !Number.isFinite(value)) {
    if (value === 0) return [0n, 1n];
    throw Error('This authored native endpoint roster requires nonnegative normal finite inputs');
  }
  const significand = BigInt((word & 0x7fffff) | 0x800000);
  return exponent >= 0
    ? [significand << BigInt(exponent), 1n]
    : [significand, 1n << BigInt(-exponent)];
}
const compare = (a: Rational, b: Rational) => a[0] * b[1] - b[0] * a[1];
const quotient = (n: number, d: number): Rational => {
  const a = rational(n),
    b = rational(d);
  return [a[0] * b[1], a[1] * b[0]];
};

export function exactHardwareEndpoint(entry: HardwareEndpointCase) {
  const candidates = entry.planes.map((z, primitive) => ({
    t: quotient(z, entry.direction),
    primitive,
  }));
  const inside = candidates.filter(
    (c) => compare(c.t, rational(entry.first)) >= 0n && compare(c.t, rational(entry.last)) <= 0n,
  );
  inside.sort((a, b) =>
    compare(a.t, b.t) < 0n ? -1 : compare(a.t, b.t) > 0n ? 1 : a.primitive - b.primitive,
  );
  return inside[0];
}

export function hardwareQuerySource(): string {
  return worldTraversalWgsl('ray-query');
}

export function unsafeOpaqueBroadening(source: string): string {
  const marker =
    'if(forceOpaque && committed.kind==RAY_QUERY_INTERSECTION_TRIANGLE && (committed.t<ray.tMin || committed.t>ray.tMax)){';
  if (source.split(marker).length !== 2)
    throw Error('Actual recovery guard is missing or ambiguous');
  return source.replace(marker, 'if(false){');
}

/** Diagnostic overreach only: production continues to broaden by exactly one ULP. */
export function twoUlpOpaqueBroadening(source: string): string {
  const replacements = [
    ['bitcast<f32>(bitcast<u32>(first)-1u)', 'bitcast<f32>(bitcast<u32>(first)-2u)'],
    ['bitcast<f32>(bitcast<u32>(last)+1u)', 'bitcast<f32>(bitcast<u32>(last)+2u)'],
  ] as const;
  let value = source;
  for (const [from, to] of replacements) {
    if (value.split(from).length !== 2) throw Error('Actual broadphase boundary is ambiguous');
    value = value.replace(from, to);
  }
  return value;
}

export type HardwareEndpointVariant = 'production' | 'two-ulp-recovery' | 'two-ulp-without-guard';

/** Private counters and a separate caller output preserve the production Hit ABI.
 * Removing every inserted observation statement recovers the selected source exactly. */
export function observedHardwareEndpointProgram(
  production: string,
  variant: HardwareEndpointVariant,
): string {
  let selected = variant === 'production' ? production : twoUlpOpaqueBroadening(production);
  if (variant === 'two-ulp-without-guard') selected = unsafeOpaqueBroadening(selected);
  const changes: { from: string; to: string }[] = [];
  let observed = selected;
  const insert = (from: string, extra: string, count: number) => {
    if (observed.split(from).length !== count + 1)
      throw Error('Actual observation site is ambiguous');
    const to = `${from}${extra}`;
    changes.push({ from, to });
    observed = observed.replaceAll(from, to);
  };
  insert('steps++;', 'hardwareEndpointObservation[0]++;', 2);
  insert('forceOpaque=false;', 'hardwareEndpointObservation[2]++;', 1);
  const initializers = [...observed.matchAll(/^[ \t]*rayQueryInitialize\([^\n]+;/gm)];
  if (initializers.length !== 3) throw Error('Actual query initialization sites changed');
  for (const match of initializers) insert(match[0], 'hardwareEndpointObservation[1]++;', 1);
  insert(
    'let committed=rayQueryGetCommittedIntersection(&query);',
    'if(hardwareEndpointObservation[1]==1u && committed.kind==RAY_QUERY_INTERSECTION_TRIANGLE){hardwareEndpointObservation[5]=committed.primitive_index;hardwareEndpointObservation[6]=bitcast<u32>(committed.t);}',
    1,
  );
  insert(
    'let c=rayQueryGetCommittedIntersection(&query);',
    'if(c.kind==RAY_QUERY_INTERSECTION_TRIANGLE){hardwareEndpointObservation[4]=c.primitive_index;hardwareEndpointObservation[7]=bitcast<u32>(c.t);}',
    1,
  );
  let restored = observed;
  for (const change of changes.slice().reverse())
    restored = restored.replaceAll(change.to, change.from);
  if (restored !== selected) throw Error('Observation does not reversibly preserve query source');
  return `${observed}
var<private> hardwareEndpointObservation:array<u32,8>;
struct HardwareEndpointObservation {counts:vec4u,committed:vec4u,}
@group(0) @binding(7) var<storage,read> rays:array<Ray>;
@group(0) @binding(8) var<storage,read_write> hits:array<Hit>;
@group(0) @binding(9) var<storage,read_write> observations:array<HardwareEndpointObservation>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=arrayLength(&rays)){return;}
 hardwareEndpointObservation=array<u32,8>(0u,0u,0u,rays[gid.x].mask.y,0xffffffffu,0xffffffffu,0u,0u);
 hits[gid.x]=traceWorld(rays[gid.x],rays[gid.x].mask.y,1.0);
 observations[gid.x]=HardwareEndpointObservation(
  vec4u(hardwareEndpointObservation[0],hardwareEndpointObservation[1],hardwareEndpointObservation[2],hardwareEndpointObservation[3]),
  vec4u(hardwareEndpointObservation[4],hardwareEndpointObservation[5],hardwareEndpointObservation[6],hardwareEndpointObservation[7]));
}
`;
}

interface Intersection {
  kind: number;
  t: number;
  primitive_index: number;
  geometry_index: number;
  instance_custom_data: number;
  exact: Rational;
}
interface Query {
  desc: { flags: number; first: number; last: number };
  candidates: Intersection[];
  next: number;
  candidate: Intersection;
  committed: Intersection;
}
const empty = (): Intersection => ({
  kind: 0,
  t: 0,
  primitive_index: 0,
  geometry_index: 0,
  instance_custom_data: 0,
  exact: [0n, 1n],
});

/** Execute only the actual production query-control prefix against an independent
 * open-extent native API model. This is CPU control evidence, not a GPU substitute. */
export function executeHardwareQueryControl(
  source: string,
  entry: HardwareEndpointCase,
  clipping: 'exact-geometry' | 'reported-f32' = 'exact-geometry',
) {
  const marker =
    'fn traceWorldRayQuery(ray: Ray, maxSteps: u32, opaqueOccluderIsEnough: bool) -> Hit {';
  const begin = source.indexOf(marker);
  const end = source.indexOf(' let row=traversalInstances[c.instance_custom_data];', begin);
  if (begin < 0 || end < 0) throw Error('Actual query prefix boundary missing');
  let body = source
    .slice(begin + marker.length, end)
    .replace(/var (query|unresolved): ray_query;/g, 'var $1={};')
    .replaceAll('&query', 'query')
    .replaceAll('&unresolved', 'unresolved')
    .replaceAll('bitcast<f32>', 'asFloat')
    .replaceAll('bitcast<u32>', 'asBits')
    .replace(/\b(0x[0-9a-f]+|\d+)u\b/g, '$1');
  body = body.replace(/\bloop\s*\{/g, 'while(true){');
  let queries = 0,
    proceeds = 0;
  const flags: number[] = [];
  const initialise = (query: Query, _tlas: unknown, desc: Query['desc']) => {
    queries++;
    flags.push(desc.flags);
    query.desc = desc;
    query.next = 0;
    query.committed = empty();
    query.candidate = empty();
    query.candidates = entry.planes
      .map((z, primitive_index) => {
        const exact = quotient(z, entry.direction);
        return {
          kind: 1,
          t: Math.fround(Number(exact[0]) / Number(exact[1])),
          primitive_index,
          geometry_index: 0,
          instance_custom_data: 1,
          exact,
        };
      })
      .filter((c) => {
        const tested = clipping === 'reported-f32' ? rational(c.t) : c.exact;
        return (
          compare(tested, rational(desc.first)) > 0n && compare(tested, rational(desc.last)) < 0n
        );
      });
  };
  const proceed = (query: Query) => {
    proceeds++;
    if (query.desc.flags !== 0) {
      query.committed =
        [...query.candidates].sort((a, b) => (compare(a.exact, b.exact) < 0n ? -1 : 1))[0] ??
        empty();
      return false;
    }
    const next = query.candidates[query.next++];
    if (!next) return false;
    query.candidate = next;
    return true;
  };
  const vector = (...values: number[]) => ({
    x: values[0],
    y: values[1],
    z: values[2],
    w: values[3],
  });
  const scope = {
    ray: {
      origin: 0,
      direction: entry.direction,
      tMin: entry.first,
      tMax: entry.last,
      mask: { x: 1 },
    },
    maxSteps: entry.steps ?? 128,
    opaqueOccluderIsEnough: false,
    Hit: (state: unknown, metrics: unknown) => ({ state, metrics }),
    vec4u: vector,
    vec4f: vector,
    select: (a: unknown, b: unknown, c: boolean) => (c ? b : a),
    traversalInstances: [
      { x: 0, y: 0, z: 8, w: 0 },
      { x: 0, y: 0, z: 8, w: 0 },
    ],
    tlas: {},
    RAY_FLAG_FORCE_OPAQUE: 1,
    RAY_QUERY_INTERSECTION_TRIANGLE: 1,
    rayQueryInitialize: initialise,
    rayQueryProceed: proceed,
    rayQueryGetCommittedIntersection: (q: Query) => q.committed,
    rayQueryGetCandidateIntersection: (q: Query) => q.candidate,
    rayQueryConfirmIntersection: (q: Query) => {
      if (q.committed.kind === 0 || q.candidate.t < q.committed.t) q.committed = q.candidate;
    },
    RayDesc: (flags: number, _mask: number, first: number, last: number) => ({
      flags,
      first,
      last,
    }),
    worldRayQueryOpaque: () => true,
    asFloat: bitsFloat,
    asBits: floatBits,
    min: Math.min,
  };
  const run = new Function(
    ...Object.keys(scope),
    `${body}\nreturn {state:{x:1},primitive:c.primitive_index,time:c.t};`,
  );
  const result = run(...Object.values(scope)) as {
    state: { x: number };
    primitive?: number;
    time?: number;
  };
  return { ...result, queries, proceeds, flags };
}
