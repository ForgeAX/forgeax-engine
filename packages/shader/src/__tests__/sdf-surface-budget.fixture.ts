import { SDF_SURFACE_TRACE_WGSL } from '../sdf-surface-trace-wgsl';
import {
  createSurfaceAcceptEvaluator,
  type SurfaceAcceptTuple,
} from './sdf-surface-accept.fixture';
import { executable, rootBits, rootVector } from './sdf-surface-root.fixture';

interface Trace {
  state: number;
  row: number;
  primitive: number;
  frontFace: number;
  lower: number;
  upper: number;
  uncertain: number;
  reserved: number;
  prefixSamples: number;
  hasUncertainty: number;
}
interface Plane {
  readonly t: number;
  readonly opaque: boolean;
  readonly intersects: boolean;
}
interface Node {
  readonly first: number;
  readonly last: number;
  escape: number;
  readonly slot?: number;
}
export interface BudgetCase {
  readonly farCount?: number;
  readonly allOpaque?: boolean;
  readonly near?: number;
  readonly unknownTime?: number;
  readonly firstTriangleMisses?: boolean;
  readonly nearTrianglesMiss?: boolean;
  readonly nestedReversals?: number;
  readonly invalidRank?: boolean;
  readonly budget?: number;
  readonly unqualifiedSlab?: boolean;
  readonly straddling?: boolean;
}
const empty = (last: number): Trace => ({
  state: 0,
  row: 0xffffffff,
  primitive: 0xffffffff,
  frontFace: 0,
  lower: last,
  upper: last,
  uncertain: last,
  reserved: 0,
  prefixSamples: 0,
  hasUncertainty: 0,
});
const fields = [
  'state',
  'row',
  'primitive',
  'frontFace',
  'lower',
  'upper',
  'uncertain',
  'reserved',
  'prefixSamples',
  'hasUncertainty',
] as const;
const tuple = (trace: Trace) => fields.map((key) => trace[key]) as unknown as SurfaceAcceptTuple;

/** Executes the actual generated traversal/charge/reducer control. Its slab and
 * triangle dependencies are independently authored exact dyadic plane witnesses,
 * not an emulation of GPU interval arithmetic or the captured Sponza packet.
 * The receiver ray is (0,0,0)+t*(0,0,1). Positive triangles project to
 * (-2,-2), (0,2), (2,-2); the ray is strictly inside. Far triangles project
 * to (-2,-2), (2,-2), (2,.25): their boxes intersect the ray but the triangles
 * do not. All coordinates are exact dyadics. Preorder child order is a valid BVH,
 * independent of which child is near along the incoming ray. */
export function budgetPlaneControl(input: BudgetCase = {}, source = SDF_SURFACE_TRACE_WGSL) {
  const planes: Plane[] = [
    {
      t: input.unknownTime ?? 1,
      opaque: input.allOpaque === true,
      intersects: input.firstTriangleMisses !== true,
    },
  ];
  const farCount = input.farCount ?? 512;
  for (let i = 0; i < farCount; i++)
    planes.push({ t: 2 + i / 64, opaque: true, intersects: false });
  const leftCount = planes.length;
  if (input.near !== undefined) {
    planes.push({ t: input.near, opaque: true, intersects: input.nearTrianglesMiss !== true });
    // An independent thin neighbour is retained; no bias/receiver ID exclusion.
    planes.push({
      t: input.near + 2 ** -16,
      opaque: true,
      intersects: input.nearTrianglesMiss !== true,
    });
    if (input.straddling) planes.push({ t: 2, opaque: true, intersects: false });
  }
  const nearSlots = planes.slice(leftCount).map((_, i) => leftCount + i);
  const detours: number[] = [];
  const nearTail: number[] = [];
  if (input.nestedReversals !== undefined) {
    for (let i = 0; i < input.nestedReversals; i++) {
      detours.push(planes.length);
      planes.push({ t: 0.75 + i / 64, opaque: true, intersects: false });
    }
    for (let i = 0; i < farCount; i++) {
      nearTail.push(planes.length);
      planes.push({ t: 12 + i / 64, opaque: true, intersects: false });
    }
  }
  const nodes: Node[] = [];
  function children(left: () => void, right: () => void): void {
    const at = nodes.length;
    nodes.push({ first: 0, last: 0, escape: 0 });
    left();
    const second = nodes.length;
    right();
    const a = nodes[at + 1];
    const b = nodes[second];
    if (!a || !b) throw Error('Two child roots required');
    nodes[at] = {
      first: Math.min(a.first, b.first),
      last: Math.max(a.last, b.last),
      escape: nodes.length,
    };
  }
  function branch(slots: readonly number[]): void {
    const at = nodes.length;
    const times = slots.map((slot) => planes[slot]?.t ?? NaN);
    const entry: Node = { first: Math.min(...times), last: Math.max(...times), escape: 0 };
    nodes.push(entry);
    if (slots.length === 1) {
      const slot = slots[0];
      if (slot === undefined) throw Error('Leaf primitive required');
      nodes[at] = { ...entry, slot, escape: at + 1 };
      return;
    }
    const split = Math.floor(slots.length / 2);
    branch(slots.slice(0, split));
    branch(slots.slice(split));
    entry.escape = nodes.length;
  }
  const left = Array.from({ length: leftCount }, (_, i) => i);
  function nearBranch(level: number): void {
    const detour = detours[level];
    if (detour !== undefined) {
      children(
        () => branch([detour]),
        () => nearBranch(level + 1),
      );
    } else if (nearTail.length > 0) {
      children(
        () => branch(nearSlots),
        () => branch(nearTail),
      );
    } else {
      branch(nearSlots);
    }
  }
  if (input.near === undefined) branch(left);
  else
    children(
      () => branch(left),
      () => nearBranch(0),
    );
  const words = nodes.flatMap((node) => [
    rootBits(-2),
    rootBits(-2),
    rootBits(node.first),
    node.escape,
    rootBits(2),
    rootBits(2),
    rootBits(node.last),
    node.slot === undefined ? 0 : (node.slot << 2) | 1,
  ]);
  const accept = createSurfaceAcceptEvaluator();
  let nodeTests = 0,
    triangleTests = 0;
  let rankTests = 0;
  let maximumDeferred = 0;
  type Deferred = { x: number; y: number; z: number; w: number };
  const deferred = new Proxy<Deferred[]>([], {
    set(target, key, value: Deferred) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= 6) throw Error('Stack overflow');
      maximumDeferred = Math.max(maximumDeferred, index + 1);
      target[index] = value;
      return true;
    },
  });
  const deps = {
    float: number,
    SdfSurfaceTrace: (...values: number[]) =>
      Object.fromEntries(fields.map((key, i) => [key, values[i]])),
    vec3u: rootVector,
    vec4u: (x: number, y: number, z: number, w: number) => ({ x, y, z, w }),
    min: Math.min,
    max: Math.max,
    select: (a: number, b: number, condition: boolean) => (condition ? b : a),
    sdfSurfaceRayUsable: () => true,
    sdfSurfaceTraceEmpty: empty,
    contact: { valid: 0 },
    seed: empty(60),
    sdfSurfaceDeferredSiblings: deferred,
    sdfSurfaceNearRight: (_ray: unknown, _packet: unknown, leftNode: number, rightNode: number) => {
      rankTests++;
      const a = nodes[leftNode];
      const b = nodes[rightNode];
      if (!a || !b) throw Error('Ranking next requires both authored child roots');
      // Nominal ranking port for this authored +Z ray. The closed slab and
      // triangle ports below still decide what may be pruned and what hit.
      return !input.invalidRank && b.first < a.first;
    },
    sdfSurfacePacket: () => ({
      valid: 1,
      nodes: { x: 0, y: nodes.length },
      order: { x: 0, y: planes.length },
      coefficients: { yz: [0, 0] },
    }),
    sdfSurfaceInverse: () => [],
    sdfSurfaceLocalRay: (ray: unknown) => ray,
    sdfSurfaceSegmentEnclosure: () => ({}),
    sdfFieldWord: (word: number) => words[word] ?? 0,
    sdfSurfaceCharge: (bank: { value: number }) => {
      if (bank.value === 0) return false;
      bank.value--;
      return true;
    },
    sdfSurfaceSegmentBoundsClear: () => false,
    sdfSurfaceSlab: (_ray: unknown, lo: { z: number }, hi: { z: number }) => {
      nodeTests++;
      return {
        certified: Number(!input.unqualifiedSlab),
        possible: 1,
        near: number(lo.z),
        far: number(hi.z),
      };
    },
    SdfSurfacePrefix: (end: number, valid: number, samples: number) => ({ end, valid, samples }),
    sdfSurfaceRootPrefix: () => ({ end: 0, valid: 0, samples: 0 }),
    sdfSurfaceLeafTrianglePrepared: (_packet: unknown, slot: number) => {
      triangleTests++;
      const plane = planes[slot];
      if (!plane) throw Error('Authored primitive required');
      if (!plane.intersects) return empty(60);
      return {
        ...empty(60),
        state: plane.opaque ? 1 : 2,
        row: 0,
        primitive: slot,
        frontFace: 1,
        lower: plane.t,
        upper: plane.t,
      };
    },
    sdfSurfaceAcceptAxisTie: () => false,
    sdfSurfaceAccept: (best: Trace, hit: Trace) => {
      const reduced = accept(tuple(best), tuple(hit));
      fields.forEach((key, i) => {
        best[key] = reduced[i] ?? NaN;
      });
    },
  };
  const lowered = source
    .replace('loop {', 'while(true) {')
    .replaceAll('&segment', 'segment')
    .replaceAll('&best', 'best')
    .replace('var hit:SdfSurfaceTrace;', 'var hit;');
  const invoke = executable<Trace>(lowered, 'sdfSurfaceTraceRow', 'row,world,remaining', deps);
  const remaining = { value: input.budget ?? 256 };
  const result = invoke(0, { tRange: rootVector(rootBits(0), rootBits(60)) }, remaining);
  return {
    result,
    remaining: remaining.value,
    nodeTests,
    triangleTests,
    rankTests,
    maximumDeferred,
    charged: (input.budget ?? 256) - remaining.value,
    planes,
    nodes,
  };
}
function number(bits: number) {
  return new Float32Array(Uint32Array.of(bits).buffer)[0] ?? NaN;
}
