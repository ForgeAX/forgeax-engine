import { pushAll } from '../arrays';
/**
 * Minimum-cost perfect matching on a general graph (Edmonds' blossom method, primal-dual, O(n^3)).
 * Blossom-Quad pairs triangles across a dual graph that is not bipartite, so odd cycles must be
 * contracted into blossoms. Costs are quantized to integers so every dual value stays exact.
 */

export interface MatchEdge {
  readonly a: number;
  readonly b: number;
  readonly cost: number;
}

export type MatchingResult =
  | { readonly ok: true; readonly mate: readonly number[]; readonly total: number }
  | { readonly ok: false; readonly reason: 'no-perfect-matching' | 'bad-edge' };

/** Cost resolution: 2^-20 of the cost unit. */
const COST_SCALE = 1048576;
/** Bound on |quantized cost|, keeping every dual value far below 2^53. */
const COST_LIMIT = 1099511627776;

/**
 * Minimum-cost perfect matching. Parallel edges keep the cheapest one; self loops, out-of-range,
 * non-finite or oversized costs fail closed. `mate[v]` is the partner of v.
 */
export function minCostPerfectMatching(n: number, edges: readonly MatchEdge[]): MatchingResult {
  if (!Number.isInteger(n) || n < 0) return { ok: false, reason: 'bad-edge' };
  if (n % 2 !== 0) return { ok: false, reason: 'no-perfect-matching' };
  if (n === 0) return { ok: true, mate: [], total: 0 };
  const best = new Map<number, { a: number; b: number; cost: number; q: number }>();
  let maxQ = 0;
  for (const e of edges) {
    if (!Number.isInteger(e.a) || !Number.isInteger(e.b) || e.a === e.b) {
      return { ok: false, reason: 'bad-edge' };
    }
    if (e.a < 0 || e.b < 0 || e.a >= n || e.b >= n || !Number.isFinite(e.cost)) {
      return { ok: false, reason: 'bad-edge' };
    }
    const q = Math.round(e.cost * COST_SCALE);
    if (Math.abs(q) > COST_LIMIT) return { ok: false, reason: 'bad-edge' };
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    const key = lo * n + hi;
    const prev = best.get(key);
    if (prev === undefined || q < prev.q) best.set(key, { a: lo, b: hi, cost: e.cost, q });
    maxQ = Math.max(maxQ, Math.abs(q));
  }
  // Every perfect matching outweighs every imperfect one, so maximum weight means maximum cardinality.
  const big = (n / 2 + 1) * (2 * maxQ + 1);
  const solver = new MaxWeightMatching(n);
  for (const e of best.values()) solver.addEdge(e.a, e.b, big - e.q);
  const mate = solver.solve();
  let total = 0;
  for (let v = 0; v < n; v++) {
    const u = mate[v] as number;
    if (u < 0) return { ok: false, reason: 'no-perfect-matching' };
    if (u > v) total += (best.get(v * n + u) as { cost: number }).cost;
  }
  return { ok: true, mate, total };
}

/** Python-style index: negative positions wrap from the end. */
function at(arr: readonly number[], i: number): number {
  const len = arr.length;
  return arr[((i % len) + len) % len] as number;
}

/**
 * Maximum-weight matching, a direct port of the primal-dual formulation in Van Rantwijk's
 * mwmatching (public domain algorithm). Vertices are 0..n-1; blossoms are n..2n-1.
 * Endpoint p = 2k or 2k+1 belongs to edge k; endpoint[p] is the vertex at that end.
 */
class MaxWeightMatching {
  private readonly nv: number;
  private readonly ei: number[] = [];
  private readonly ej: number[] = [];
  private readonly ew: number[] = [];
  private readonly endpoint: number[] = [];
  private readonly neighbend: number[][];
  private readonly mate: number[];
  private readonly label: number[];
  private readonly labelend: number[];
  private readonly inblossom: number[];
  private readonly blossomparent: number[];
  private readonly blossomchilds: (number[] | null)[];
  private readonly blossombase: number[];
  private readonly blossomendps: (number[] | null)[];
  private readonly bestedge: number[];
  private readonly blossombestedges: (number[] | null)[];
  private readonly unusedblossoms: number[] = [];
  private readonly dualvar: number[];
  private allowedge: boolean[] = [];
  private queue: number[] = [];
  private maxweight = 0;

  constructor(n: number) {
    this.nv = n;
    this.neighbend = Array.from({ length: n }, () => []);
    this.mate = new Array<number>(n).fill(-1);
    this.label = new Array<number>(2 * n).fill(0);
    this.labelend = new Array<number>(2 * n).fill(-1);
    this.inblossom = Array.from({ length: n }, (_, i) => i);
    this.blossomparent = new Array<number>(2 * n).fill(-1);
    this.blossomchilds = new Array<number[] | null>(2 * n).fill(null);
    this.blossombase = [
      ...Array.from({ length: n }, (_, i) => i),
      ...new Array<number>(n).fill(-1),
    ];
    this.blossomendps = new Array<number[] | null>(2 * n).fill(null);
    this.bestedge = new Array<number>(2 * n).fill(-1);
    this.blossombestedges = new Array<number[] | null>(2 * n).fill(null);
    this.dualvar = new Array<number>(2 * n).fill(0);
    for (let b = 2 * n - 1; b >= n; b--) this.unusedblossoms.push(b);
  }

  addEdge(i: number, j: number, w: number): void {
    const k = this.ei.length;
    this.ei.push(i);
    this.ej.push(j);
    this.ew.push(w);
    this.endpoint.push(i, j);
    (this.neighbend[i] as number[]).push(2 * k + 1);
    (this.neighbend[j] as number[]).push(2 * k);
    this.maxweight = Math.max(this.maxweight, w);
  }

  /** Partner vertex of each vertex, or -1 when unmatched. */
  solve(): number[] {
    const n = this.nv;
    if (n === 0) return [];
    for (let v = 0; v < n; v++) this.dualvar[v] = this.maxweight;
    for (let stage = 0; stage < n; stage++) {
      this.label.fill(0);
      this.bestedge.fill(-1);
      for (let b = n; b < 2 * n; b++) this.blossombestedges[b] = null;
      this.allowedge = new Array<boolean>(this.ei.length).fill(false);
      this.queue = [];
      for (let v = 0; v < n; v++) {
        if (this.mate[v] === -1 && this.label[this.inblossom[v] as number] === 0)
          this.assignLabel(v, 1, -1);
      }
      let augmented = false;
      for (;;) {
        while (this.queue.length > 0 && !augmented) {
          const v = this.queue.pop() as number;
          for (const p of this.neighbend[v] as number[]) {
            const k = p >> 1;
            const w = this.endpoint[p] as number;
            if (this.inblossom[v] === this.inblossom[w]) continue;
            let kslack = 0;
            if (!this.allowedge[k]) {
              kslack = this.slack(k);
              if (kslack <= 0) this.allowedge[k] = true;
            }
            if (this.allowedge[k]) {
              const lw = this.label[this.inblossom[w] as number] as number;
              if (lw === 0) {
                this.assignLabel(w, 2, p ^ 1);
              } else if (lw === 1) {
                const base = this.scanBlossom(v, w);
                if (base >= 0) {
                  this.addBlossom(base, k);
                } else {
                  this.augmentMatching(k);
                  augmented = true;
                  break;
                }
              } else if (this.label[w] === 0) {
                this.label[w] = 2;
                this.labelend[w] = p ^ 1;
              }
            } else if (this.label[this.inblossom[w] as number] === 1) {
              const b = this.inblossom[v] as number;
              if (this.bestedge[b] === -1 || kslack < this.slack(this.bestedge[b] as number))
                this.bestedge[b] = k;
            } else if (this.label[w] === 0) {
              if (this.bestedge[w] === -1 || kslack < this.slack(this.bestedge[w] as number))
                this.bestedge[w] = k;
            }
          }
        }
        if (augmented) break;

        // Dual update: pick the smallest of the vertex, edge and blossom bounds.
        let deltatype = 1;
        let delta = Infinity;
        for (let v = 0; v < n; v++) delta = Math.min(delta, this.dualvar[v] as number);
        let deltaedge = -1;
        let deltablossom = -1;
        for (let v = 0; v < n; v++) {
          if (this.label[this.inblossom[v] as number] === 0 && this.bestedge[v] !== -1) {
            const d = this.slack(this.bestedge[v] as number);
            if (d < delta) {
              delta = d;
              deltatype = 2;
              deltaedge = this.bestedge[v] as number;
            }
          }
        }
        for (let b = 0; b < 2 * n; b++) {
          if (
            this.blossomparent[b] === -1 &&
            this.blossombase[b] !== -1 &&
            this.label[b] === 1 &&
            this.bestedge[b] !== -1
          ) {
            const d = this.slack(this.bestedge[b] as number) / 2;
            if (d < delta) {
              delta = d;
              deltatype = 3;
              deltaedge = this.bestedge[b] as number;
            }
          }
        }
        for (let b = n; b < 2 * n; b++) {
          if (this.blossombase[b] !== -1 && this.blossomparent[b] === -1 && this.label[b] === 2) {
            if ((this.dualvar[b] as number) < delta) {
              delta = this.dualvar[b] as number;
              deltatype = 4;
              deltablossom = b;
            }
          }
        }
        for (let v = 0; v < n; v++) {
          const lb = this.label[this.inblossom[v] as number];
          if (lb === 1) this.dualvar[v] = (this.dualvar[v] as number) - delta;
          else if (lb === 2) this.dualvar[v] = (this.dualvar[v] as number) + delta;
        }
        for (let b = n; b < 2 * n; b++) {
          if (this.blossombase[b] !== -1 && this.blossomparent[b] === -1) {
            if (this.label[b] === 1) this.dualvar[b] = (this.dualvar[b] as number) + delta;
            else if (this.label[b] === 2) this.dualvar[b] = (this.dualvar[b] as number) - delta;
          }
        }
        if (deltatype === 1) break;
        if (deltatype === 2) {
          this.allowedge[deltaedge] = true;
          let i = this.ei[deltaedge] as number;
          const j = this.ej[deltaedge] as number;
          if (this.label[this.inblossom[i] as number] === 0) i = j;
          this.queue.push(i);
        } else if (deltatype === 3) {
          this.allowedge[deltaedge] = true;
          this.queue.push(this.ei[deltaedge] as number);
        } else if (deltatype === 4) {
          this.expandBlossom(deltablossom, false);
        }
      }
      if (!augmented) break;
      for (let b = n; b < 2 * n; b++) {
        if (
          this.blossomparent[b] === -1 &&
          this.blossombase[b] !== -1 &&
          this.label[b] === 1 &&
          this.dualvar[b] === 0
        ) {
          this.expandBlossom(b, true);
        }
      }
    }
    return this.mate.map((p) => (p >= 0 ? (this.endpoint[p] as number) : -1));
  }

  private slack(k: number): number {
    return (
      (this.dualvar[this.ei[k] as number] as number) +
      (this.dualvar[this.ej[k] as number] as number) -
      2 * (this.ew[k] as number)
    );
  }

  private leaves(b: number): number[] {
    if (b < this.nv) return [b];
    const out: number[] = [];
    for (const c of this.blossomchilds[b] ?? []) pushAll(out, this.leaves(c));
    return out;
  }

  private assignLabel(w: number, t: number, p: number): void {
    const b = this.inblossom[w] as number;
    this.label[w] = t;
    this.label[b] = t;
    this.labelend[w] = p;
    this.labelend[b] = p;
    this.bestedge[w] = -1;
    this.bestedge[b] = -1;
    if (t === 1) {
      pushAll(this.queue, this.leaves(b));
    } else {
      const base = this.blossombase[b] as number;
      const mp = this.mate[base] as number;
      this.assignLabel(this.endpoint[mp] as number, 1, mp ^ 1);
    }
  }

  private scanBlossom(v0: number, w0: number): number {
    let v = v0;
    let w = w0;
    const path: number[] = [];
    let base = -1;
    while (v !== -1 || w !== -1) {
      let b = this.inblossom[v] as number;
      if ((this.label[b] as number) & 4) {
        base = this.blossombase[b] as number;
        break;
      }
      path.push(b);
      this.label[b] = 5;
      if (this.labelend[b] === -1) {
        v = -1;
      } else {
        v = this.endpoint[this.labelend[b] as number] as number;
        b = this.inblossom[v] as number;
        v = this.endpoint[this.labelend[b] as number] as number;
      }
      if (w !== -1) {
        const t = v;
        v = w;
        w = t;
      }
    }
    for (const b of path) this.label[b] = 1;
    return base;
  }

  private addBlossom(base: number, k: number): void {
    let v = this.ei[k] as number;
    let w = this.ej[k] as number;
    const bb = this.inblossom[base] as number;
    let bv = this.inblossom[v] as number;
    let bw = this.inblossom[w] as number;
    const b = this.unusedblossoms.pop() as number;
    this.blossombase[b] = base;
    this.blossomparent[b] = -1;
    this.blossomparent[bb] = b;
    const path: number[] = [];
    const endps: number[] = [];
    this.blossomchilds[b] = path;
    this.blossomendps[b] = endps;
    while (bv !== bb) {
      this.blossomparent[bv] = b;
      path.push(bv);
      endps.push(this.labelend[bv] as number);
      v = this.endpoint[this.labelend[bv] as number] as number;
      bv = this.inblossom[v] as number;
    }
    path.push(bb);
    path.reverse();
    endps.reverse();
    endps.push(2 * k);
    while (bw !== bb) {
      this.blossomparent[bw] = b;
      path.push(bw);
      endps.push((this.labelend[bw] as number) ^ 1);
      w = this.endpoint[this.labelend[bw] as number] as number;
      bw = this.inblossom[w] as number;
    }
    this.label[b] = 1;
    this.labelend[b] = this.labelend[bb] as number;
    this.dualvar[b] = 0;
    for (const u of this.leaves(b)) {
      if (this.label[this.inblossom[u] as number] === 2) this.queue.push(u);
      this.inblossom[u] = b;
    }

    const bestedgeto = new Array<number>(2 * this.nv).fill(-1);
    for (const sub of path) {
      let nblists: number[][];
      const cached = this.blossombestedges[sub];
      if (cached === null || cached === undefined) {
        nblists = [];
        for (const u of this.leaves(sub))
          nblists.push((this.neighbend[u] as number[]).map((p) => p >> 1));
      } else {
        nblists = [cached];
      }
      for (const nb of nblists) {
        for (const kk of nb) {
          let j = this.ej[kk] as number;
          if (this.inblossom[j] === b) j = this.ei[kk] as number;
          const bj = this.inblossom[j] as number;
          if (
            bj !== b &&
            this.label[bj] === 1 &&
            (bestedgeto[bj] === -1 || this.slack(kk) < this.slack(bestedgeto[bj] as number))
          ) {
            bestedgeto[bj] = kk;
          }
        }
      }
      this.blossombestedges[sub] = null;
      this.bestedge[sub] = -1;
    }
    const list = bestedgeto.filter((kk) => kk !== -1);
    this.blossombestedges[b] = list;
    this.bestedge[b] = -1;
    for (const kk of list) {
      if (this.bestedge[b] === -1 || this.slack(kk) < this.slack(this.bestedge[b] as number))
        this.bestedge[b] = kk;
    }
  }

  private expandBlossom(b: number, endstage: boolean): void {
    const childs = this.blossomchilds[b] as number[];
    const endps = this.blossomendps[b] as number[];
    for (const s of childs) {
      this.blossomparent[s] = -1;
      if (s < this.nv) {
        this.inblossom[s] = s;
      } else if (endstage && this.dualvar[s] === 0) {
        this.expandBlossom(s, endstage);
      } else {
        for (const u of this.leaves(s)) this.inblossom[u] = s;
      }
    }
    if (!endstage && this.label[b] === 2) {
      const entry = this.inblossom[
        this.endpoint[(this.labelend[b] as number) ^ 1] as number
      ] as number;
      const L = childs.length;
      let j = childs.indexOf(entry);
      let jstep: number;
      let endptrick: number;
      if (j & 1) {
        j -= L;
        jstep = 1;
        endptrick = 0;
      } else {
        jstep = -1;
        endptrick = 1;
      }
      let p = this.labelend[b] as number;
      while (j !== 0) {
        this.label[this.endpoint[p ^ 1] as number] = 0;
        this.label[this.endpoint[at(endps, j - endptrick) ^ endptrick ^ 1] as number] = 0;
        this.assignLabel(this.endpoint[p ^ 1] as number, 2, p);
        this.allowedge[at(endps, j - endptrick) >> 1] = true;
        j += jstep;
        p = at(endps, j - endptrick) ^ endptrick;
        this.allowedge[p >> 1] = true;
        j += jstep;
      }
      let bv = at(childs, j);
      const far = this.endpoint[p ^ 1] as number;
      this.label[far] = 2;
      this.label[bv] = 2;
      this.labelend[far] = p;
      this.labelend[bv] = p;
      this.bestedge[bv] = -1;
      j += jstep;
      while (at(childs, j) !== entry) {
        bv = at(childs, j);
        if (this.label[bv] === 1) {
          j += jstep;
          continue;
        }
        let v = -1;
        for (const u of this.leaves(bv)) {
          if (this.label[u] !== 0) {
            v = u;
            break;
          }
        }
        if (v !== -1) {
          this.label[v] = 0;
          this.label[this.endpoint[this.mate[this.blossombase[bv] as number] as number] as number] =
            0;
          this.assignLabel(v, 2, this.labelend[v] as number);
        }
        j += jstep;
      }
    }
    this.label[b] = -1;
    this.labelend[b] = -1;
    this.blossomchilds[b] = null;
    this.blossomendps[b] = null;
    this.blossombase[b] = -1;
    this.blossombestedges[b] = null;
    this.bestedge[b] = -1;
    this.unusedblossoms.push(b);
  }

  private augmentBlossom(b: number, v: number): void {
    const childs = this.blossomchilds[b] as number[];
    const endps = this.blossomendps[b] as number[];
    let t = v;
    while (this.blossomparent[t] !== b) t = this.blossomparent[t] as number;
    if (t >= this.nv) this.augmentBlossom(t, v);
    const i = childs.indexOf(t);
    let j = i;
    const L = childs.length;
    let jstep: number;
    let endptrick: number;
    if (i & 1) {
      j -= L;
      jstep = 1;
      endptrick = 0;
    } else {
      jstep = -1;
      endptrick = 1;
    }
    while (j !== 0) {
      j += jstep;
      t = at(childs, j);
      const p = at(endps, j - endptrick) ^ endptrick;
      if (t >= this.nv) this.augmentBlossom(t, this.endpoint[p] as number);
      j += jstep;
      t = at(childs, j);
      if (t >= this.nv) this.augmentBlossom(t, this.endpoint[p ^ 1] as number);
      this.mate[this.endpoint[p] as number] = p ^ 1;
      this.mate[this.endpoint[p ^ 1] as number] = p;
    }
    const rotated = childs.slice(i).concat(childs.slice(0, i));
    this.blossomchilds[b] = rotated;
    this.blossomendps[b] = endps.slice(i).concat(endps.slice(0, i));
    this.blossombase[b] = this.blossombase[rotated[0] as number] as number;
  }

  private augmentMatching(k: number): void {
    const v = this.ei[k] as number;
    const w = this.ej[k] as number;
    for (const [s0, p0] of [
      [v, 2 * k + 1],
      [w, 2 * k],
    ] as const) {
      let s = s0;
      let p = p0;
      for (;;) {
        const bs = this.inblossom[s] as number;
        if (bs >= this.nv) this.augmentBlossom(bs, s);
        this.mate[s] = p;
        if (this.labelend[bs] === -1) break;
        const t = this.endpoint[this.labelend[bs] as number] as number;
        const bt = this.inblossom[t] as number;
        s = this.endpoint[this.labelend[bt] as number] as number;
        const j = this.endpoint[(this.labelend[bt] as number) ^ 1] as number;
        if (bt >= this.nv) this.augmentBlossom(bt, j);
        this.mate[j] = this.labelend[bt] as number;
        p = (this.labelend[bt] as number) ^ 1;
      }
    }
  }
}
