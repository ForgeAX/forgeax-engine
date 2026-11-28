// QuadriFlow integer consistency (Huang et al. 2018, Sections 3.1-3.2): edge offsets are adjusted
// by minimum-L1 flow until every triangle's oriented integer offset sum is zero. Each triangle uses
// its own 4-RoSy chart, so an edge variable can contribute to either coordinate in either face.

import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import { matchExtrinsic, matchPosition, type PositionField } from './field';
import { minCostFlow } from './min-cost-flow';
import { triTopology } from './trimesh';

export interface IntegerEdgeOffset {
  readonly vertices: readonly [number, number];
  readonly offset: readonly [number, number];
}

export interface IntegerFlowOptions {
  /** Skip the flow adjustment, for the falsifier test. */
  readonly flowDisabled?: boolean;
  /** Maximum absolute corrected edge offset. Default max(8, largest input offset). */
  readonly maxCapacity?: number;
  /** Maximum phases for the underlying min-cost flow. */
  readonly maxPhases?: number;
}

export interface IntegerFlowReport {
  readonly faces: number;
  readonly edges: number;
  readonly boundaryEdges: number;
  readonly initialSingularities: number;
  readonly finalSingularities: number;
  readonly initialChargeL1: number;
  readonly finalChargeL1: number;
  readonly changedEdges: number;
  readonly changeL1: number;
  readonly capacity: number;
  readonly flowDisabled: boolean;
}

export interface IntegerFlowResult {
  readonly offsets: readonly IntegerEdgeOffset[];
  readonly report: IntegerFlowReport;
}

interface Incidence {
  readonly face: number;
  /** Face-equation coordinate for each of this edge's two offset coordinates. */
  readonly equation: readonly [number, number];
  readonly coefficient: readonly [number, number];
}

interface Edge {
  readonly lo: number;
  readonly hi: number;
  readonly faces: [number, number];
  readonly incidence: [Incidence | null, Incidence | null];
  readonly initial: [number, number];
}

interface EdgeTable {
  readonly edges: Edge[];
  readonly faceEdges: Int32Array;
  readonly faceIncidence: (Incidence | null)[];
  readonly faceCount: number;
  readonly boundaryEdges: number;
}

interface Variable {
  readonly edge: number;
  readonly coordinate: 0 | 1;
  readonly first: { readonly node: number; readonly sign: number };
  readonly second: { readonly node: number; readonly sign: number } | null;
}

interface FlowArc {
  readonly edge: number;
  readonly coordinate: 0 | 1;
  readonly sign: number;
  readonly forward: number;
  readonly reverse: number;
}

const FLOW_LIMIT = 1 << 30;

function failure(
  code: string,
  expected: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ModelingError {
  return modelingError(code as 'model-invalid-argument', expected, {
    reason: `integer-flow-${reason}`,
    ...extra,
  });
}

interface IncidenceMap {
  readonly equation: readonly [number, number];
  readonly coefficient: readonly [number, number];
}

function incidenceMap(turn: number, direction: number): IncidenceMap {
  switch (((turn % 4) + 4) % 4) {
    case 0:
      return { equation: [0, 1], coefficient: [direction, direction] };
    case 1:
      return { equation: [1, 0], coefficient: [direction, -direction] };
    case 2:
      return { equation: [0, 1], coefficient: [-direction, -direction] };
    default:
      return { equation: [1, 0], coefficient: [-direction, direction] };
  }
}

function buildEdgeTable(field: PositionField): Result<EdgeTable, ModelingError> {
  const mesh = field.orientation.mesh;
  const topology = triTopology(mesh);
  if (!topology.ok) return topology;
  const vertexCount = topology.value.vertexCount;
  const faceCount = topology.value.faceCount;
  if (
    field.orientation.site !== 'vertex' ||
    field.origin.length !== 3 * vertexCount ||
    field.orientation.normal.length !== 3 * vertexCount ||
    field.orientation.direction.length !== 3 * vertexCount ||
    field.vertexSource.length !== vertexCount
  )
    return err(
      failure(
        'model-invalid-argument',
        'a vertex-site position field matching its mesh',
        'field-array-shape',
      ),
    );
  if (!(field.scale > 0) || !Number.isFinite(field.scale))
    return err(
      failure('model-invalid-argument', 'a positive finite position-field scale', 'field-scale'),
    );
  for (const values of [field.origin, field.orientation.normal, field.orientation.direction])
    for (let i = 0; i < values.length; i++)
      if (!Number.isFinite(values[i] as number))
        return err(
          failure(
            'model-invalid-argument',
            'finite position-field vectors',
            'non-finite-field-value',
            { component: i },
          ),
        );

  const edges: Edge[] = [];
  const byKey = new Map<string, number>();
  const faceEdges = new Int32Array(3 * faceCount);
  const faceIncidence: (Incidence | null)[] = new Array(3 * faceCount).fill(null);
  const tri = mesh.triangles;
  for (let f = 0; f < faceCount; f++) {
    const anchor = tri[3 * f] as number;
    const faceTurn = new Int8Array(3);
    for (let k = 0; k < 3; k++) {
      const v = tri[3 * f + k] as number;
      const matched = matchExtrinsic(field.orientation, anchor, v);
      faceTurn[k] = (matched.a - matched.b + 4) % 4;
    }
    for (let k = 0; k < 3; k++) {
      const a = tri[3 * f + k] as number;
      const b = tri[3 * f + ((k + 1) % 3)] as number;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}:${hi}`;
      let id = byKey.get(key);
      if (id === undefined) {
        if (edges.length >= FLOW_LIMIT)
          return err(
            failure(
              'model-work-budget',
              'an edge table within the integer-flow range',
              'edge-count-limit',
            ),
          );
        const offset = matchPosition(field, lo, hi).offset;
        if (!Number.isInteger(offset[0]) || !Number.isInteger(offset[1]))
          return err(
            failure(
              'model-partial',
              'integral position-field edge offsets',
              'non-integral-offset',
              { edge: key },
            ),
          );
        id = edges.length;
        edges.push({
          lo,
          hi,
          faces: [f, -1],
          incidence: [null, null],
          initial: [offset[0], offset[1]],
        });
        byKey.set(key, id);
      }
      const edge = edges[id] as Edge;
      const side = edge.faces[0] === f ? 0 : 1;
      if (side === 1) {
        if (edge.faces[1] !== -1)
          return err(
            failure(
              'model-precondition',
              'at most two incident triangles per edge',
              'non-manifold-edge',
              { edge: key },
            ),
          );
        edge.faces[1] = f;
      }
      const loCorner = a === lo ? k : (k + 1) % 3;
      const map = incidenceMap(faceTurn[loCorner] as number, a === lo ? 1 : -1);
      const incidence: Incidence = { face: f, ...map };
      edge.incidence[side] = incidence;
      faceEdges[3 * f + k] = id;
      faceIncidence[3 * f + k] = incidence;
    }
  }
  for (const edge of edges)
    if (edge.faces[1] !== -1 && (!edge.incidence[0] || !edge.incidence[1]))
      return err(
        failure(
          'model-internal',
          'both equation incidences on every interior edge',
          'missing-incidence',
          { edge: `${edge.lo}:${edge.hi}` },
        ),
      );
  return ok({
    edges,
    faceEdges,
    faceIncidence,
    faceCount,
    boundaryEdges: edges.filter((edge) => edge.faces[1] === -1).length,
  });
}

function equationCharges(table: EdgeTable, offsets: Int32Array): Int32Array {
  const charge = new Int32Array(2 * table.faceCount);
  for (let i = 0; i < table.faceIncidence.length; i++) {
    const incidence = table.faceIncidence[i];
    if (!incidence) continue;
    const edge = table.faceEdges[i] as number;
    for (let c = 0; c < 2; c++) {
      const row = 2 * incidence.face + (incidence.equation[c] as number);
      charge[row] =
        (charge[row] as number) +
        (incidence.coefficient[c] as number) * (offsets[2 * edge + c] as number);
    }
  }
  return charge;
}

function find(parent: Int32Array, value: number): number {
  let root = value;
  while (parent[root] !== root) root = parent[root] as number;
  while (parent[value] !== value) {
    const next = parent[value] as number;
    parent[value] = root;
    value = next;
  }
  return root;
}

function join(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

function variablesOf(table: EdgeTable): Variable[] {
  const variables: Variable[] = [];
  for (let e = 0; e < table.edges.length; e++) {
    const edge = table.edges[e] as Edge;
    const first = edge.incidence[0];
    const second = edge.incidence[1];
    if (!first) continue;
    for (let c = 0; c < 2; c++) {
      variables.push({
        edge: e,
        coordinate: c as 0 | 1,
        first: {
          node: 2 * first.face + (first.equation[c] as number),
          sign: first.coefficient[c] as number,
        },
        second: second
          ? {
              node: 2 * second.face + (second.equation[c] as number),
              sign: second.coefficient[c] as number,
            }
          : null,
      });
    }
  }
  return variables;
}

function solveAtCapacity(
  table: EdgeTable,
  bound: number,
  options: IntegerFlowOptions,
): Result<Int32Array, ModelingError> {
  const reservoir = 2 * table.faceCount;
  const nodeCount = reservoir + 1;
  const original = new Int32Array(2 * table.edges.length);
  for (let e = 0; e < table.edges.length; e++) {
    original[2 * e] = (table.edges[e] as Edge).initial[0];
    original[2 * e + 1] = (table.edges[e] as Edge).initial[1];
  }
  const adjusted = new Int32Array(original);
  const variables = variablesOf(table);
  const parent = Int32Array.from({ length: nodeCount }, (_, i) => i);
  for (const variable of variables) {
    if (variable.second) join(parent, variable.first.node, variable.second.node);
    else join(parent, variable.first.node, reservoir);
  }

  const charge = equationCharges(table, adjusted);
  const compCharge = new Map<number, number>();
  for (let n = 0; n < reservoir; n++) {
    const root = find(parent, n);
    compCharge.set(root, (compCharge.get(root) ?? 0) + (charge[n] as number));
  }
  const reservoirRoot = find(parent, reservoir);
  const fixed = variables.filter((v) => v.second && v.first.sign === v.second.sign);
  const byRoot = new Map<number, Variable[]>();
  for (const v of fixed) {
    const root = find(parent, v.first.node);
    const list = byRoot.get(root) ?? [];
    list.push(v);
    byRoot.set(root, list);
  }
  for (const [root, start] of compCharge) {
    if (root === reservoirRoot || start === 0) continue;
    let remaining = start;
    if (Math.abs(remaining) % 2 !== 0)
      return err(
        failure(
          'model-partial',
          'even flow-component charge for same-sign variables',
          'odd-component-charge',
          { component: root, charge: remaining },
        ),
      );
    for (const v of byRoot.get(root) ?? []) {
      if (remaining === 0) break;
      const index = 2 * v.edge + v.coordinate;
      const current = adjusted[index] as number;
      const coefficientSum = v.first.sign + (v.second as NonNullable<typeof v.second>).sign;
      const delta = -Math.sign(remaining) * Math.sign(coefficientSum);
      const room = delta > 0 ? bound - current : bound + current;
      const steps = Math.min(Math.abs(remaining) / Math.abs(coefficientSum), room);
      if (steps < 1) continue;
      adjusted[index] = current + delta * steps;
      for (const incidence of (table.edges[v.edge] as Edge).incidence) {
        if (!incidence) continue;
        const row = 2 * incidence.face + (incidence.equation[v.coordinate] as number);
        charge[row] =
          (charge[row] as number) + (incidence.coefficient[v.coordinate] as number) * delta * steps;
      }
      remaining += coefficientSum * delta * steps;
    }
    if (remaining !== 0)
      return err(
        failure(
          'model-partial',
          'same-sign variables balance each flow component within capacity',
          'unbalanced-component',
          { component: root, charge: remaining, bound },
        ),
      );
  }

  const supply = new Int32Array(nodeCount);
  supply.set(charge);
  let total = 0;
  for (let n = 0; n < reservoir; n++) total += charge[n] as number;
  supply[reservoir] = -total;
  const from: number[] = [];
  const to: number[] = [];
  const capacity: number[] = [];
  const cost: number[] = [];
  const arcs: FlowArc[] = [];
  for (const v of variables) {
    if (v.second && v.first.sign !== -v.second.sign) continue;
    const value = adjusted[2 * v.edge + v.coordinate] as number;
    if (Math.abs(value) > bound)
      return err(
        failure(
          'model-partial',
          'adjusted edge offsets within maxCapacity',
          'offset-outside-capacity',
          { edge: v.edge, value, bound },
        ),
      );
    let a: number;
    let b: number;
    let sign: number;
    if (!v.second) {
      sign = v.first.sign;
      a = sign > 0 ? v.first.node : reservoir;
      b = sign > 0 ? reservoir : v.first.node;
    } else {
      const positive = v.first.sign > 0 ? v.first : v.second;
      const negative = v.first.sign > 0 ? v.second : v.first;
      sign = 1;
      a = positive.node;
      b = negative.node;
    }
    const forward = from.length;
    from.push(a, b);
    to.push(b, a);
    capacity.push(bound + sign * value, bound - sign * value);
    cost.push(1, 1);
    arcs.push({ edge: v.edge, coordinate: v.coordinate, sign, forward, reverse: forward + 1 });
  }

  const result = minCostFlow(
    { nodeCount, from, to, capacity, cost, supply },
    options.maxPhases === undefined ? {} : { maxPhases: options.maxPhases },
  );
  if (!result.ok) return result;
  if (!result.value.feasible)
    return err(
      failure('model-partial', 'a feasible integer flow within maxCapacity', 'flow-infeasible', {
        shipped: result.value.shipped,
        required: result.value.required,
        bound,
      }),
    );
  for (const arc of arcs) {
    const flow =
      (result.value.flow[arc.forward] as number) - (result.value.flow[arc.reverse] as number);
    const index = 2 * arc.edge + arc.coordinate;
    adjusted[index] = (adjusted[index] as number) - arc.sign * flow;
    if (Math.abs(adjusted[index] as number) > bound)
      return err(
        failure(
          'model-internal',
          'flow output within maxCapacity',
          'corrected-offset-outside-capacity',
          { edge: arc.edge },
        ),
      );
  }
  const finalCharge = equationCharges(table, adjusted);
  for (let n = 0; n < reservoir; n++)
    if (finalCharge[n] !== 0)
      return err(
        failure(
          'model-internal',
          'zero charge in every face equation after flow',
          'flow-left-charge',
          { equation: n, charge: finalCharge[n] },
        ),
      );
  return ok(adjusted);
}

function stats(
  table: EdgeTable,
  offsets: Int32Array,
): { readonly l1: number; readonly singularities: number } {
  const charge = equationCharges(table, offsets);
  let l1 = 0;
  let singularities = 0;
  for (let f = 0; f < table.faceCount; f++) {
    const x = charge[2 * f] as number;
    const y = charge[2 * f + 1] as number;
    l1 += Math.abs(x) + Math.abs(y);
    if (x !== 0 || y !== 0) singularities++;
  }
  return { l1, singularities };
}

/** Minimum-L1 offset correction; invalid or bounded-infeasible fields return a structured error. */
export function solveIntegerOffsets(
  field: PositionField,
  options: IntegerFlowOptions = {},
): Result<IntegerFlowResult, ModelingError> {
  const built = buildEdgeTable(field);
  if (!built.ok) return built;
  const table = built.value;
  const initial = new Int32Array(2 * table.edges.length);
  let maxInitial = 0;
  for (let e = 0; e < table.edges.length; e++) {
    const offset = (table.edges[e] as Edge).initial;
    initial[2 * e] = offset[0];
    initial[2 * e + 1] = offset[1];
    maxInitial = Math.max(maxInitial, Math.abs(offset[0]), Math.abs(offset[1]));
  }
  const initialStats = stats(table, initial);
  const maxCapacity = options.maxCapacity ?? Math.max(8, maxInitial);
  if (
    !Number.isInteger(maxCapacity) ||
    maxCapacity < Math.max(2, maxInitial) ||
    maxCapacity > FLOW_LIMIT
  )
    return err(
      failure(
        'model-invalid-argument',
        'maxCapacity >= 2 and >= every initial offset',
        'capacity-range',
        { maxCapacity, maxInitial },
      ),
    );
  let output: Int32Array = new Int32Array(initial);
  let capacity = Math.max(2, maxInitial);
  if (options.flowDisabled !== true) {
    let solved = false;
    for (; capacity <= maxCapacity; capacity++) {
      const result = solveAtCapacity(table, capacity, options);
      if (!result.ok) {
        const why = (result.error.detail as { reason?: string } | undefined)?.reason;
        if (
          why === 'integer-flow-flow-infeasible' ||
          why === 'integer-flow-unbalanced-component' ||
          why === 'integer-flow-odd-component-charge'
        )
          continue;
        return result;
      }
      output = result.value;
      solved = true;
      break;
    }
    if (!solved)
      return err(
        failure('model-partial', 'integer consistency within maxCapacity', 'capacity-limit', {
          maxCapacity,
        }),
      );
  }
  const finalStats = stats(table, output);
  if (options.flowDisabled !== true && finalStats.l1 !== 0)
    return err(
      failure('model-internal', 'all triangle charges vanish after flow', 'flow-left-charge', {
        finalChargeL1: finalStats.l1,
      }),
    );
  const offsets: IntegerEdgeOffset[] = [];
  let changedEdges = 0;
  let changeL1 = 0;
  for (let e = 0; e < table.edges.length; e++) {
    const edge = table.edges[e] as Edge;
    const x = output[2 * e] as number;
    const y = output[2 * e + 1] as number;
    if (x !== edge.initial[0] || y !== edge.initial[1]) changedEdges++;
    changeL1 += Math.abs(x - edge.initial[0]) + Math.abs(y - edge.initial[1]);
    offsets.push({ vertices: [edge.lo, edge.hi], offset: [x, y] });
  }
  return ok({
    offsets,
    report: {
      faces: table.faceCount,
      edges: table.edges.length,
      boundaryEdges: table.boundaryEdges,
      initialSingularities: initialStats.singularities,
      finalSingularities: finalStats.singularities,
      initialChargeL1: initialStats.l1,
      finalChargeL1: finalStats.l1,
      changedEdges,
      changeL1,
      capacity,
      flowDisabled: options.flowDisabled === true,
    },
  });
}
