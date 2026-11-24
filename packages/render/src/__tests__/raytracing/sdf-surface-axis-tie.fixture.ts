import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  type EndpointCompositionRow,
  endpointCompositionParts,
  endpointCurrentCompositionSource,
  endpointRowCompositionCode,
  endpointRowCompositionInput,
} from './sdf-surface-endpoint-aggregation.fixture';
import { exactSurface } from './sdf-surface-intersection.fixture';

type Vector = readonly [number, number, number];
type Triangle = readonly [Vector, Vector, Vector];
export interface AxisTieCase {
  readonly name: string;
  readonly mesh: readonly Triangle[];
  readonly records: readonly Uint32Array[];
  readonly ids: readonly number[];
  readonly opaque?: readonly boolean[];
  readonly expectedState: number;
  readonly expectedPrimitive?: number;
  readonly expectedInterval?: readonly [number, number];
  readonly baselineState?: number;
}

/** Immutable component observation, not current Renderer or scene qualification.
 * Actual geometry-owner 8x8x0.25 box, placement z=-3. Each row stores
 * state/tLo/tHi/facing/localValid/primitive/reserved/reserved. */
export const AXIS_TIE_LEAF_PROVENANCE = {
  sourceCommit: 'df1a4fba8ef4dde12b928168dba0073acc20bf91',
  gpuJob: 'bcd304b4-8374-41b4-bf9e-46b15d2e8f59',
  adapter: 'NVIDIA GeForce RTX 4080 / Dx12',
  nativeSha256: 'f76dd9aa7f73ec91c37adfa3cb7c0d462b2ee1ad4144836d63f4377070e0c54d',
  compiledShaderSha256: '5392015bbf408dde418935bfc997c676dc97df7e32f663134d0d25c1afadafd7',
  rawSha256: '65d239cd7821afee1dd609d0d2be32b659ede3aa9900be74eb6962b98b20ebfb',
} as const;

export function axisTieLeafWitness(): Uint32Array {
  return Uint32Array.of(
    1,
    0x40817492,
    0x408174a2,
    1,
    1,
    8,
    0,
    0,
    1,
    0x40817492,
    0x408174a2,
    1,
    1,
    9,
    0,
    0,
    1,
    0x40818005,
    0x40818015,
    1,
    1,
    8,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    9,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    8,
    0,
    0,
    1,
    0x40818005,
    0x40818015,
    1,
    1,
    9,
    0,
    0,
  );
}

function originalDirection(): Vector {
  const [x, y, z] = new Float32Array(Uint32Array.of(0x3efeb42c, 0x3efeb42c, 0xbf35ee68).buffer);
  if (x === undefined || y === undefined || z === undefined)
    throw new Error('Original direction required');
  return [x, y, z];
}

function localMesh(): Triangle[] {
  const mesh = createBoxGeometry(8, 8, 0.25).unwrap();
  const positions = mesh.attributes.position as Float32Array;
  if (!mesh.indices) throw new Error('Actual indexed box required');
  const indices = mesh.indices;
  const vertex = (index: number): Vector => {
    const id = indices[index];
    if (id === undefined) throw new Error('Actual index required');
    const x = positions[id * 3],
      y = positions[id * 3 + 1],
      z = positions[id * 3 + 2];
    if (x === undefined || y === undefined || z === undefined)
      throw new Error('Actual position required');
    return [x, y, z];
  };
  return Array.from(
    { length: indices.length / 3 },
    (_, index): Triangle => [vertex(index * 3), vertex(index * 3 + 1), vertex(index * 3 + 2)],
  );
}

function record(raw: Uint32Array, primitive: number): Uint32Array {
  const result = raw.slice(primitive === 8 ? 0 : 8, primitive === 8 ? 8 : 16);
  if (result.length !== 8 || result[0] !== 1 || result[4] !== 1 || result[5] !== primitive)
    throw new Error('Original actual GPU diagonal hit records required');
  return result;
}

function plane(mesh: readonly Triangle[], primitive: number, z: number): Triangle[] {
  return mesh.map((triangle, index) =>
    index === primitive
      ? (triangle.map((v): Vector => [v[0], v[1], z]) as unknown as Triangle)
      : triangle,
  );
}

export function prepareAxisTie(actualLeaf: Uint32Array = axisTieLeafWitness()) {
  if (actualLeaf.length !== 48)
    throw new Error('Original complete six-row GPU leaf output required');
  const mesh = localMesh(),
    a = record(actualLeaf, 8),
    b = record(actualLeaf, 9);
  const narrow = b.slice();
  narrow[1] = (narrow[1] ?? 0) + 1;
  narrow[2] = (narrow[2] ?? 0) - 1;
  const narrowFloats = new Float32Array(narrow.buffer);
  const narrowLower = narrowFloats[1],
    narrowUpper = narrowFloats[2];
  if (narrowLower === undefined || narrowUpper === undefined || narrowLower >= narrowUpper)
    throw new Error('Finite strict interior interval required');
  const expectedInterval: readonly [number, number] = [narrowLower, narrowUpper];
  const earlier = a.slice();
  earlier[0] = 2;
  new Float32Array(earlier.buffer)[1] = 1;
  const backA = a.slice(),
    backB = b.slice();
  backA[3] = 0;
  backB[3] = 0;
  const earlierHit = b.slice(),
    laterHit = a.slice();
  new Float32Array(earlierHit.buffer).set([2, 3], 1);
  new Float32Array(laterHit.buffer).set([5, 6], 1);
  const pointA = a.slice(),
    pointB = b.slice();
  new Float32Array(pointA.buffer).set([4, 4], 1);
  new Float32Array(pointB.buffer).set([4, 4], 1);
  const partial = mesh.map((_triangle, index) => index !== 9);
  const cases: AxisTieCase[] = [
    {
      name: 'actual-shared-edge-8-9',
      mesh,
      records: [a, b],
      ids: [8, 9],
      expectedState: 1,
      expectedPrimitive: 8,
    },
    {
      name: 'lower-id-wider-first',
      mesh,
      records: [a, narrow],
      ids: [8, 9],
      expectedState: 1,
      expectedPrimitive: 8,
      expectedInterval,
    },
    {
      name: 'lower-id-wider-second',
      mesh,
      records: [narrow, a],
      ids: [9, 8],
      expectedState: 1,
      expectedPrimitive: 8,
      expectedInterval,
    },
    {
      name: 'actual-shared-edge-9-8',
      mesh,
      records: [b, a],
      ids: [9, 8],
      expectedState: 1,
      expectedPrimitive: 8,
    },
    {
      name: 'back-side-shared-plane',
      mesh: mesh.map((t) => t.map((v): Vector => [v[0], v[1], -v[2]]) as unknown as Triangle),
      records: [backA, backB],
      ids: [8, 9],
      expectedState: 1,
      expectedPrimitive: 8,
    },
    {
      name: 'different-plane-identical-interval',
      mesh: plane(mesh, 9, Math.fround(0.125 + 2 ** -26)),
      records: [a, b],
      ids: [8, 9],
      expectedState: 2,
    },
    {
      name: 'opposite-plane-identical-interval',
      mesh: plane(mesh, 9, -0.125),
      records: [a, b],
      ids: [8, 9],
      expectedState: 2,
    },
    {
      name: 'oblique-plane-not-certified',
      mesh: mesh.map(
        (t) => t.map((v): Vector => [v[0], v[1], v[2] + v[0] / 256]) as unknown as Triangle,
      ),
      records: [a, b],
      ids: [8, 9],
      expectedState: 2,
    },
    {
      name: 'nonfinite-plane-not-certified',
      mesh: plane(plane(mesh, 8, Infinity), 9, Infinity),
      records: [a, b],
      ids: [8, 9],
      expectedState: 2,
    },
    {
      name: 'prior-unknown-survives',
      mesh,
      records: [earlier, b, a],
      ids: [8, 9, 8],
      expectedState: 2,
    },
    {
      name: 'unknown-opacity-not-certified',
      mesh,
      records: [a, b],
      ids: [8, 9],
      opaque: partial,
      expectedState: 2,
    },
    {
      name: 'nonoverlap-keeps-original-nearest',
      mesh,
      records: [laterHit, earlierHit],
      ids: [8, 9],
      expectedState: 1,
      expectedPrimitive: 9,
      baselineState: 1,
    },
    {
      name: 'closed-point-original-tie',
      mesh: plane(plane(mesh, 8, -1), 9, -1),
      records: [pointB, pointA],
      ids: [9, 8],
      expectedState: 1,
      expectedPrimitive: 8,
      baselineState: 1,
    },
    {
      name: 'actual-x-interior',
      mesh,
      records: [actualLeaf.slice(16, 24), actualLeaf.slice(24, 32)],
      ids: [8, 9],
      expectedState: 1,
      expectedPrimitive: 8,
      baselineState: 1,
    },
    {
      name: 'actual-y-interior',
      mesh,
      records: [actualLeaf.slice(32, 40), actualLeaf.slice(40, 48)],
      ids: [8, 9],
      expectedState: 1,
      expectedPrimitive: 9,
      baselineState: 1,
    },
  ];
  let first = 0;
  const rows: EndpointCompositionRow[] = cases.map((row, caseIndex) => {
    const result: EndpointCompositionRow = {
      caseIndex,
      row: 0,
      first,
      count: row.records.length,
      end: row.name === 'closed-point-original-tie' ? 4 : 8,
      mesh: row.mesh,
      primitiveIds: row.ids,
      ...(row.opaque ? { opaque: row.opaque } : {}),
    };
    first += row.records.length;
    return result;
  });
  const records = new Uint32Array(first * 8);
  let next = 0;
  for (const row of cases)
    for (const raw of row.records) {
      records.set(raw, next);
      next += 8;
    }
  const parts = endpointCompositionParts(endpointCurrentCompositionSource);
  if (!parts.axisTie) throw new Error('Current owning axis tie certificate required');
  return {
    cases,
    input: endpointRowCompositionInput(rows, records),
    baseline: endpointRowCompositionCode({ ...parts, axisTie: null }),
    candidate: endpointRowCompositionCode(parts),
    recordBytes: parts.members.length * 4,
  };
}

/** Independent dyadic triangle oracle; does not execute the new certificate. */
export function axisTieExactHits(secondPlane = 0.125) {
  const mesh = plane(localMesh(), 9, secondPlane),
    direction = originalDirection();
  return [8, 9].map((primitive) => {
    const triangle = mesh[primitive];
    if (!triangle) throw new Error('Actual triangle required');
    return exactSurface({
      name: `primitive-${primitive}`,
      triangle,
      origin: [0, 0, 3],
      direction,
      range: [0, 8],
      expected: 'oracle',
    });
  });
}

export function assessAxisTie(prepared: ReturnType<typeof prepareAxisTie>, raw: Uint32Array) {
  if (raw.byteLength !== prepared.cases.length * prepared.recordBytes)
    throw new Error('Complete Row records required');
  const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.length),
    failures: string[] = [];
  const rows = prepared.cases.map((row, index) => {
    const at = index * (prepared.recordBytes / 4),
      state = raw[at],
      primitive = raw[at + 2];
    if (state !== row.expectedState)
      failures.push(`${row.name}: state ${state} != ${row.expectedState}`);
    if (row.expectedPrimitive !== undefined && primitive !== row.expectedPrimitive)
      failures.push(`${row.name}: primitive ${primitive} != ${row.expectedPrimitive}`);
    if (row.name === 'prior-unknown-survives' && (floats[at + 6] !== 1 || raw[at + 9] !== 1))
      failures.push(`${row.name}: prior blocker payload changed`);
    if (row.name === 'back-side-shared-plane' && raw[at + 3] !== 0)
      failures.push(`${row.name}: facing changed`);
    if (
      row.expectedInterval &&
      (floats[at + 4] !== row.expectedInterval[0] || floats[at + 5] !== row.expectedInterval[1])
    )
      failures.push(`${row.name}: equal-t enclosure was not intersected`);
    return {
      name: row.name,
      state,
      primitive,
      lower: floats[at + 4],
      upper: floats[at + 5],
      uncertain: floats[at + 6],
      hasUncertainty: raw[at + 9],
      frontFace: raw[at + 3],
    };
  });
  return { failures, rows };
}
