import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { bevel } from './bevel';
import { booleanOp } from './boolean';
import { append } from './connect';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { add, cross, dot, faceNormal, length, normalize, scale, sub, type Tuple3 } from './geom';
import { EditMesh, NONE } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';
import type { SubdivideContext } from './subdivide';
import { segmentDistance } from './sweep';
import type { BallCylinder } from './weld-ball';
import { type BallStripResult, ballStrip } from './weld-strip';

/** Hard joint: tubes unioned by exact boolean, rolling-ball fillet along each intersection curve. */
export interface PipeWeldOptions {
  /** Fillet radius (meters), at most the smallest tube radius at any node. */
  readonly radius: number;
  /** Quad rows across the fillet (1 to 16; default 4). */
  readonly segments?: number;
  /**
   * `miter` (default) joins two struts that meet at a node with equal radii by one mitered
   * tube; `cope` puts a hub ball on every node that is not a straight through pass.
   */
  readonly end?: 'miter' | 'cope';
}

export interface WeldBranch {
  readonly edge: number;
  readonly other: number;
  readonly dir: Tuple3;
}

export function invalid(
  expected: string,
  detail: Record<string, unknown>,
): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

export type PipeRefusal =
  | 'radius-small'
  | 'node-hull'
  | 'edge-short'
  | 'strut-collision'
  | 'branch-angle'
  | 'weld-radius-small'
  | 'weld-radius'
  | 'weld-loop'
  | 'weld-size'
  | 'weld-union'
  | 'weld-none'
  | 'weld-clamp'
  | 'weld-ball'
  | 'bend-straight'
  | 'bend-radius'
  | 'bend-loop'
  | 'bend-segments';

export function refuse(
  expected: string,
  reason: PipeRefusal,
  detail: Record<string, unknown>,
  hint?: string,
): Result<never, ModelingError> {
  return err(modelingError('model-precondition', expected, { reason, ...detail }, hint));
}

const THROUGH_COS = -0.9962;
const HUB_SCALE = 1.25;
const MAX_FILLET_COS = 0.9998;
const MAX_SEGMENTS = 16;
const PHASE = 0.5;
const MAX_PIECES = 16;

export interface WeldInput {
  readonly options: { readonly weld: PipeWeldOptions };
  readonly nodes: readonly Tuple3[];
  readonly edges: readonly (readonly [number, number])[];
  readonly branches: readonly (readonly WeldBranch[])[];
  readonly ringSegments: number;
  readonly strutSegments: number;
  readonly endRadius: (edge: number, end: 0 | 1) => number;
  readonly widestCos: (list: readonly WeldBranch[]) => number;
}

interface Link {
  readonly edge: number;
  readonly sign: 1 | -1;
}

interface Segment {
  readonly edge: number;
  readonly from: number;
  readonly to: number;
  readonly u: Tuple3;
  readonly length: number;
  readonly rs: number;
  readonly re: number;
}

function frameOf(u: Tuple3): { e1: Tuple3; e2: Tuple3 } {
  const lead =
    Math.abs(u[0]) <= Math.abs(u[1]) && Math.abs(u[0]) <= Math.abs(u[2])
      ? 0
      : Math.abs(u[1]) <= Math.abs(u[2])
        ? 1
        : 2;
  const reference: Tuple3 = [0, 0, 0];
  reference[lead] = 1;
  const e1 = normalize(cross(u, reference));
  return { e1, e2: cross(u, e1) };
}

function reflect(v: Tuple3, n: Tuple3): Tuple3 {
  return sub(v, scale(n, 2 * dot(v, n)));
}

function label(mesh: EditMesh, name: string): number {
  return mesh.nameIndex(mesh.labelNames, name);
}

function sphere(mesh: EditMesh, centre: Tuple3, radius: number, m: number, name: string) {
  const bands = m / 2;
  const north = mesh.addVertex(centre[0], centre[1], centre[2] + radius);
  const rings: number[][] = [];
  for (let i = 1; i < bands; i++) {
    const polar = (Math.PI * i) / bands;
    const ring: number[] = [];
    for (let k = 0; k < m; k++) {
      const a = (2 * Math.PI * k) / m;
      ring.push(
        mesh.addVertex(
          centre[0] + radius * sin(polar) * cos(a),
          centre[1] + radius * sin(polar) * sin(a),
          centre[2] + radius * cos(polar),
        ),
      );
    }
    rings.push(ring);
  }
  const south = mesh.addVertex(centre[0], centre[1], centre[2] - radius);
  const faces: number[][] = [];
  const first = rings[0] as number[];
  const last = rings[rings.length - 1] as number[];
  for (let k = 0; k < m; k++) {
    const k1 = (k + 1) % m;
    faces.push([north, first[k] as number, first[k1] as number]);
    faces.push([south, last[k1] as number, last[k] as number]);
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    const up = rings[i] as number[];
    const low = rings[i + 1] as number[];
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      faces.push([up[k] as number, low[k] as number, low[k1] as number, up[k1] as number]);
    }
  }
  const tag = label(mesh, name);
  const role = mesh.nameIndex(mesh.roleNames, 'node');
  for (const loop of faces) {
    const f = mesh.addFace(loop);
    if (!f.ok) return f;
    mesh.fLabel[f.value] = tag;
    mesh.fRole[f.value] = role;
  }
  return ok(undefined);
}

export function weldNetwork(
  mesh: EditMesh,
  input: WeldInput,
  context: SubdivideContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const { nodes, edges, branches, ringSegments, strutSegments, endRadius } = input;
  const weld = input.options.weld;
  const rho = weld.radius;
  if (typeof rho !== 'number' || !Number.isFinite(rho) || !(rho > 0)) {
    return invalid('weld.radius is a positive finite number', { radius: rho });
  }
  if (rho < 10 * context.tolerance) {
    return refuse(
      'weld.radius is at least ten times the model tolerance',
      'weld-radius-small',
      { radius: rho, tolerance: context.tolerance },
      'raise weld.radius; a fillet this small is below what the model resolves',
    );
  }
  const segments = weld.segments ?? 4;
  if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SEGMENTS) {
    return invalid(`weld.segments is an integer from 1 to ${MAX_SEGMENTS}`, { segments });
  }
  const end = weld.end ?? 'miter';
  if (end !== 'miter' && end !== 'cope') {
    return invalid("weld.end is 'miter' or 'cope'", { end });
  }
  const point = (i: number) => nodes[i] as Tuple3;
  const nodeEnd = (e: number, n: number): 0 | 1 =>
    (edges[e] as readonly [number, number])[0] === n ? 0 : 1;
  const incident = (n: number) => branches[n] as readonly WeldBranch[];

  for (let n = 0; n < nodes.length; n++) {
    const list = incident(n);
    const smallest = minOf(list.map((b) => endRadius(b.edge, nodeEnd(b.edge, n))));
    if (rho > smallest) {
      return refuse(
        'the weld radius is at most the smallest tube radius at its node',
        'weld-radius',
        { node: n, radius: rho, tubeRadius: smallest },
        'lower weld.radius or thicken the tubes; a fillet larger than the pipe cannot roll between them',
      );
    }
  }

  const links: (Link | undefined)[][] = edges.map(() => [undefined, undefined]);
  const hub = new Set<number>();
  for (let n = 0; n < nodes.length; n++) {
    const list = incident(n);
    if (list.length < 2) continue;
    if (input.widestCos(list) > 0.9659258262890683) {
      let a = list[0] as WeldBranch;
      let b = list[1] as WeldBranch;
      let best = -2;
      for (let p = 0; p < list.length; p++)
        for (let q = p + 1; q < list.length; q++) {
          const c = dot((list[p] as WeldBranch).dir, (list[q] as WeldBranch).dir);
          if (c > best) {
            best = c;
            a = list[p] as WeldBranch;
            b = list[q] as WeldBranch;
          }
        }
      const degrees = (atan2(length(cross(a.dir, b.dir)), best) * 180) / Math.PI;
      return refuse(
        'branches at a node are at least 15 degrees apart',
        'branch-angle',
        { node: n, edges: [a.edge, b.edge], degrees },
        'split the node or spread the branches; closer branches would fuse their tubes',
      );
    }
    let pair: [WeldBranch, WeldBranch] | undefined;
    let bestCos = 2;
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const a = list[p] as WeldBranch;
        const b = list[q] as WeldBranch;
        const c = dot(a.dir, b.dir);
        const equal =
          endRadius(a.edge, nodeEnd(a.edge, n)) === endRadius(b.edge, nodeEnd(b.edge, n));
        const through = c < THROUGH_COS;
        const bend = list.length === 2 && end === 'miter';
        if ((through || bend) && equal && c < bestCos) {
          bestCos = c;
          pair = [a, b];
        }
      }
    }
    const host = pair === undefined ? 0 : endRadius(pair[0].edge, nodeEnd(pair[0].edge, n));
    const crowded = list.some(
      (b) =>
        pair !== undefined &&
        b !== pair[0] &&
        b !== pair[1] &&
        endRadius(b.edge, nodeEnd(b.edge, n)) >= host * 0.98,
    );
    if (pair === undefined || crowded || (end === 'cope' && bestCos > THROUGH_COS)) {
      hub.add(n);
      continue;
    }
    (links[pair[0].edge] as (Link | undefined)[])[nodeEnd(pair[0].edge, n)] = {
      edge: pair[1].edge,
      sign: 1,
    };
    (links[pair[1].edge] as (Link | undefined)[])[nodeEnd(pair[1].edge, n)] = {
      edge: pair[0].edge,
      sign: 1,
    };
  }

  const hubRadius = (n: number) =>
    HUB_SCALE * maxOf(incident(n).map((b) => endRadius(b.edge, nodeEnd(b.edge, n))));
  for (let e = 0; e < edges.length; e++) {
    const [i, j] = edges[e] as readonly [number, number];
    const len = length(sub(point(j), point(i)));
    const reach = (n: number) =>
      hub.has(n)
        ? hubRadius(n)
        : maxOf(incident(n).map((b) => endRadius(b.edge, nodeEnd(b.edge, n))));
    if (len < reach(i) + reach(j) + 2 * rho) {
      return refuse(
        'a strut is longer than the reach of its two joints plus two weld radii',
        'edge-short',
        { edge: e, length: len, needed: reach(i) + reach(j) + 2 * rho },
        'lengthen the strut or lower the radius',
      );
    }
    const gap = Math.max(endRadius(e, 0), endRadius(e, 1));
    for (let f = e + 1; f < edges.length; f++) {
      const [k, l] = edges[f] as readonly [number, number];
      if (k === i || k === j || l === i || l === j) continue;
      const other = Math.max(endRadius(f, 0), endRadius(f, 1));
      const d = Math.sqrt(segmentDistance(point(i), point(j), point(k), point(l)));
      if (d < 2 * (gap + other) + 2 * rho) {
        return refuse(
          'struts without a shared node stay clear of each other by their radii and the fillet',
          'strut-collision',
          { edges: [e, f], distance: d },
          'move the skeleton nodes apart or join the struts at a node',
        );
      }
    }
  }

  const chains: Segment[][] = [];
  const visited = new Set<number>();
  const segmentOf = (edge: number, from: number): Segment => {
    const [i, j] = edges[edge] as readonly [number, number];
    const to = from === i ? j : i;
    const span = sub(point(to), point(from));
    const len = length(span);
    return {
      edge,
      from,
      to,
      u: scale(span, 1 / len),
      length: len,
      rs: endRadius(edge, nodeEnd(edge, from)),
      re: endRadius(edge, nodeEnd(edge, to)),
    };
  };
  const walk = (first: number, from: number) => {
    const chain: Segment[] = [];
    let edge = first;
    let at = from;
    for (;;) {
      visited.add(edge);
      const seg = segmentOf(edge, at);
      chain.push(seg);
      const next = links[edge]?.[nodeEnd(edge, seg.to)];
      if (next === undefined) break;
      edge = next.edge;
      at = seg.to;
      if (visited.has(edge)) break;
    }
    chains.push(chain);
  };
  for (let e = 0; e < edges.length; e++) {
    if (visited.has(e)) continue;
    const [i, j] = edges[e] as readonly [number, number];
    if (links[e]?.[0] === undefined) walk(e, i);
    else if (links[e]?.[1] === undefined) walk(e, j);
  }
  for (let e = 0; e < edges.length; e++) {
    if (!visited.has(e)) {
      return refuse(
        'struts joined end to end form an open chain',
        'weld-loop',
        { edge: e },
        'break the closed loop with one node that is a hub (end: cope) or split the loop',
      );
    }
  }

  const scratch = new EditMesh();
  const pieces: EditMesh[] = [];
  const strutRole = 'strut';
  for (const chain of chains) {
    const piece = new EditMesh();
    const rings: number[][] = [];
    let { e1, e2 } = frameOf((chain[0] as Segment).u);
    const frames: { e1: Tuple3; e2: Tuple3 }[] = [];
    for (let s = 0; s < chain.length; s++) {
      frames.push({ e1, e2 });
      const seg = chain[s] as Segment;
      const next = chain[s + 1];
      if (next !== undefined) {
        const n = normalize(add(seg.u, next.u));
        e1 = reflect(e1, n);
        e2 = reflect(e2, n);
      }
    }
    const ringAt = (s: number, planeNode: number, n: Tuple3): number[] => {
      const seg = chain[s] as Segment;
      const frame = frames[s] as (typeof frames)[number];
      const origin = point(seg.from);
      const taper = (seg.re - seg.rs) / seg.length;
      const ids: number[] = [];
      for (let k = 0; k < ringSegments; k++) {
        const a = (2 * Math.PI * (k + PHASE)) / ringSegments;
        const d = add(scale(frame.e1, cos(a)), scale(frame.e2, sin(a)));
        const base = dot(sub(origin, point(planeNode)), n) + seg.rs * dot(d, n);
        const slope = dot(seg.u, n) + taper * dot(d, n);
        const tau = -base / slope;
        const p = add(add(origin, scale(seg.u, tau)), scale(d, seg.rs + taper * tau));
        ids.push(piece.addVertex(p[0], p[1], p[2]));
      }
      return ids;
    };
    rings.push(ringAt(0, (chain[0] as Segment).from, (chain[0] as Segment).u));
    for (let s = 0; s < chain.length; s++) {
      const seg = chain[s] as Segment;
      const next = chain[s + 1];
      const n = next === undefined ? seg.u : normalize(add(seg.u, next.u));
      rings.push(ringAt(s, seg.to, n));
    }
    for (let s = 0; s < chain.length; s++) {
      const seg = chain[s] as Segment;
      const lo = rings[s] as number[];
      const hi = rings[s + 1] as number[];
      const rows: number[][] = [lo];
      for (let r = 1; r < strutSegments; r++) {
        const t = r / strutSegments;
        rows.push(
          lo.map((v, k) => {
            const a = piece.position(v);
            const b = piece.position(hi[k] as number);
            return piece.addVertex(
              a[0] + (b[0] - a[0]) * t,
              a[1] + (b[1] - a[1]) * t,
              a[2] + (b[2] - a[2]) * t,
            );
          }),
        );
      }
      rows.push(hi);
      const tag = label(piece, `strut:${seg.edge}`);
      const role = piece.nameIndex(piece.roleNames, strutRole);
      for (let r = 0; r + 1 < rows.length; r++) {
        const a = rows[r] as number[];
        const b = rows[r + 1] as number[];
        for (let k = 0; k < ringSegments; k++) {
          const k1 = (k + 1) % ringSegments;
          const f = piece.addFace([
            a[k] as number,
            a[k1] as number,
            b[k1] as number,
            b[k] as number,
          ]);
          if (!f.ok) return f;
          piece.fLabel[f.value] = tag;
          piece.fRole[f.value] = role;
        }
      }
    }
    const caps: [number, number[], boolean][] = [
      [(chain[0] as Segment).from, rings[0] as number[], true],
      [(chain[chain.length - 1] as Segment).to, rings[rings.length - 1] as number[], false],
    ];
    for (const [n, ids, reversed] of caps) {
      const last = reversed ? (chain[0] as Segment) : (chain[chain.length - 1] as Segment);
      const linked = links[last.edge]?.[nodeEnd(last.edge, n)];
      if (linked !== undefined) continue;
      const f = piece.addFace(reversed ? [...ids].reverse() : ids);
      if (!f.ok) return f;
      piece.fLabel[f.value] = label(piece, `node:${n}`);
      piece.fRole[f.value] = piece.nameIndex(piece.roleNames, 'cap');
    }
    pieces.push(piece);
  }
  for (const n of [...hub].sort((a, b) => a - b)) {
    const piece = new EditMesh();
    const built = sphere(piece, point(n), hubRadius(n), ringSegments, `node:${n}`);
    if (!built.ok) return built;
    pieces.push(piece);
  }

  if (pieces.length > MAX_PIECES) {
    return refuse(
      'a weld joins at most a bounded number of tubes and hubs',
      'weld-size',
      { pieces: pieces.length, limit: MAX_PIECES },
      'the sequential exact union grows super-linearly; weld the joints in separate pipeNetwork calls or use the soft joint for large networks',
    );
  }
  const first = pieces[0] as EditMesh;
  scratch.assign(first);
  const attribution = { label: 0, material: 0, tag: -1 };
  const boolContext = {
    tolerance: context.tolerance,
    policy: context.policy,
    ...(context.native === undefined ? {} : { native: context.native }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.budget === undefined ? {} : { budget: context.budget }),
  };
  for (let p = 1; p < pieces.length; p++) {
    const joined = booleanOp(
      scratch,
      'union',
      { mesh: pieces[p] as EditMesh },
      {},
      attribution,
      boolContext,
      diagnostics,
    );
    if (!joined.ok) {
      return err(
        modelingError(
          joined.error.code,
          joined.error.expected,
          { ...joined.error.detail, reason: 'weld-union', piece: p },
          'the tube union failed; spread the nodes or change the radii so no two surfaces graze',
        ),
      );
    }
  }

  const apothem = cos(Math.PI / ringSegments);
  interface StripJoint {
    readonly node: number;
    readonly host: readonly [number, number];
    readonly hostCylinder: BallCylinder;
    readonly branches: readonly { readonly edge: number; readonly cylinder: BallCylinder }[];
  }
  const stripJoints = (): StripJoint[] | string => {
    if (hub.size > 0) return 'hub';
    const joints: StripJoint[] = [];
    for (let n = 0; n < nodes.length; n++) {
      const list = incident(n);
      if (list.length === 1) continue;
      if (list.length === 2) return 'bend';
      const radius = (b: WeldBranch) => endRadius(b.edge, nodeEnd(b.edge, n));
      if (!list.every((b) => endRadius(b.edge, 0) === endRadius(b.edge, 1))) return 'tapered';
      let pair: readonly [WeldBranch, WeldBranch] | undefined;
      for (let p = 0; p < list.length && pair === undefined; p++) {
        for (let q = p + 1; q < list.length; q++) {
          const a = list[p] as WeldBranch;
          const b = list[q] as WeldBranch;
          if (dot(a.dir, b.dir) < -0.99999 && radius(a) === radius(b)) {
            pair = [a, b];
            break;
          }
        }
      }
      if (pair === undefined) return 'no-through-pair';
      const origin = point(n);
      const ra = radius(pair[0]);
      const others = list.filter((b) => b !== pair?.[0] && b !== pair?.[1]);
      if (!others.every((b) => radius(b) < ra * 0.98)) return 'branch-thick';
      joints.push({
        node: n,
        host: [pair[0].edge, pair[1].edge],
        hostCylinder: {
          kind: 'cylinder',
          origin,
          axis: normalize(sub(pair[0].dir, pair[1].dir)),
          radius: ra * apothem,
        },
        branches: others.map((b) => ({
          edge: b.edge,
          cylinder: { kind: 'cylinder', origin, axis: b.dir, radius: radius(b) * apothem },
        })),
      });
    }
    return joints.length === 0 ? 'no-junction' : joints;
  };
  const nodeOf = (a: number, b: number): number | undefined => {
    const name = (f: number) => String(scratch.labelNames[scratch.fLabel[f] as number]);
    const la = name(a);
    const lb = name(b);
    const hubOf = (l: string) => (l.startsWith('node:') ? Number(l.slice(5)) : undefined);
    const strutOf = (l: string) => (l.startsWith('strut:') ? Number(l.slice(6)) : undefined);
    const na = hubOf(la) ?? hubOf(lb);
    if (na !== undefined) return na;
    const ea = strutOf(la);
    const eb = strutOf(lb);
    if (ea === undefined || eb === undefined || ea === eb) return undefined;
    const [i, j] = edges[ea] as readonly [number, number];
    const [k, l] = edges[eb] as readonly [number, number];
    return [i, j].find((n) => n === k || n === l);
  };
  const seam = (radius: number) => {
    const perEdge = new Map<number, { width: number; role: string }>();
    let widest = 0;
    for (const e of scratch.edges()) {
      const a = scratch.hFace[e * 2] as number;
      const b = scratch.hFace[e * 2 + 1] as number;
      if (a === NONE || b === NONE) continue;
      const p = scratch.position(scratch.hVert[e * 2 + 1] as number);
      const q = scratch.position(scratch.hVert[e * 2] as number);
      const inward = cross(faceNormal(scratch, b), normalize(sub(q, p)));
      const na = faceNormal(scratch, a);
      if (!(dot(na, inward) > 1e-9)) continue;
      const c = Math.max(-0.999999, Math.min(1, dot(na, faceNormal(scratch, b))));
      if (c > MAX_FILLET_COS) continue;
      const width = radius * Math.sqrt((1 - c) / (1 + c));
      widest = Math.max(widest, width);
      const owner = nodeOf(a, b);
      perEdge.set(e, { width, role: owner === undefined ? 'weld' : `weld:${owner}` });
    }
    return { perEdge, widest };
  };
  const round = (target: EditMesh, radius: number, tag: number, notes: OpDiagnostic[]) => {
    const { perEdge, widest } = seam(radius);
    const rounded = bevel(
      target,
      [...perEdge.keys()],
      { width: widest, segments },
      { label: tag, material: 0, tag: -1 },
      undefined,
      context.tolerance,
      notes,
      undefined,
      perEdge,
    );
    return { rounded, edges: perEdge.size };
  };
  const finish = (welds: number, edgeCount: number, path: Record<string, unknown>) => {
    diagnostics.push({
      severity: 'info',
      message: `weld fillet radius ${rho} on ${edgeCount} edges, ${welds} fillet faces`,
      detail: { radius: rho, edges: edgeCount, faces: welds, hubs: [...hub], ...path },
    });
    const done = append(mesh, scratch, {}, attribution);
    if (!done.ok) return done;
    return ok({ ...done.value, weld: welds });
  };
  let fallback = stripJoints();
  if (typeof fallback !== 'string') {
    const trial = scratch.clone();
    const named = (prefix: string, n: number) =>
      trial.nameIndex(trial.labelNames, `${prefix}:${n}`);
    let faces = 0;
    let deviation = 0;
    let shift = 0;
    let stripped: Result<BallStripResult, ModelingError> | undefined;
    for (const joint of fallback) {
      for (const branch of joint.branches) {
        stripped = ballStrip(trial, {
          host: joint.hostCylinder,
          branch: branch.cylinder,
          hostLabels: new Set(joint.host.map((e) => named('strut', e))),
          branchLabel: named('strut', branch.edge),
          weldLabel: named('weld', joint.node),
          weldRole: trial.nameIndex(trial.roleNames, 'weld'),
          rho,
          segments,
        });
        if (!stripped.ok) break;
        faces += stripped.value.faces;
        deviation = Math.max(deviation, stripped.value.deviation);
        shift = Math.max(shift, stripped.value.shift);
      }
      if (stripped !== undefined && !stripped.ok) break;
    }
    if (stripped?.ok) {
      scratch.assign(trial);
      return finish(faces, 0, { path: 'ball', deviation, shift });
    }
    fallback = String(stripped?.ok === false ? stripped.error.detail?.why : 'none');
    diagnostics.push({
      severity: 'warn',
      message: `weld rolling-ball strip did not fit (${fallback}); the bevel fillet is used`,
      detail: { path: 'bevel', fallback },
    });
  }
  const found = seam(rho);
  if (found.perEdge.size === 0) {
    return refuse('the tubes meet along an intersection curve to fillet', 'weld-none', {
      nodes: nodes.length,
    });
  }
  const temp = label(scratch, 'weld');
  const notes: OpDiagnostic[] = [];
  const trial = scratch.clone();
  const tried = round(trial, rho, temp, notes);
  if (!tried.rounded.ok) return tried.rounded;
  const clamped = notes.find((d) => d.severity === 'warn' && d.detail?.clamped !== undefined);
  if (clamped !== undefined) {
    let lo = 0;
    let hi = rho;
    for (let k = 0; k < 7; k++) {
      const mid = (lo + hi) / 2;
      const probe = scratch.clone();
      const probeNotes: OpDiagnostic[] = [];
      const t = round(probe, mid, temp, probeNotes);
      const bad =
        !t.rounded.ok ||
        probeNotes.some((d) => d.severity === 'warn' && d.detail?.clamped !== undefined);
      if (bad) hi = mid;
      else lo = mid;
    }
    return refuse(
      'the weld fillet keeps its radius (no clamp)',
      'weld-clamp',
      { ...clamped.detail, radius: rho, maxRadius: lo, path: 'bevel', fallback },
      lo > 0
        ? `lower weld.radius to about ${lo.toPrecision(2)} or below: the intersection leaves less room than the fillet needs (a finer ringSegments shortens the seam edges and lowers this limit; a coarser one raises it)`
        : 'this joint admits no fillet at any radius that fits; thicken the struts, widen the branch angle or use end: cope',
    );
  }
  scratch.assign(trial);
  const perEdge = found.perEdge;
  const centroids = (f: number): Tuple3 => {
    let sum: Tuple3 = [0, 0, 0];
    const loop = scratch.faceVertices(f);
    for (const v of loop) sum = add(sum, scratch.position(v));
    return scale(sum, 1 / loop.length);
  };
  let welds = 0;
  const weldRole = scratch.nameIndex(scratch.roleNames, 'weld');
  for (const f of scratch.faces()) {
    if (scratch.fLabel[f] !== temp) continue;
    const roleName = String(scratch.roleNames[scratch.fRole[f] as number]);
    let owner = roleName.startsWith('weld:') ? Number(roleName.slice(5)) : -1;
    if (owner < 0) {
      const c = centroids(f);
      let best = Infinity;
      for (let n = 0; n < nodes.length; n++) {
        const d = length(sub(c, point(n)));
        if (d < best) {
          best = d;
          owner = n;
        }
      }
    }
    scratch.fLabel[f] = label(scratch, `weld:${owner}`);
    if (roleName.startsWith('weld:')) scratch.fRole[f] = weldRole;
    welds++;
  }
  return finish(welds, perEdge.size, { path: 'bevel', fallback });
}
