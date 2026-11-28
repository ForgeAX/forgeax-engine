import { dist3, dot3, madd3, type P3, sub3 } from '../vec';

/**
 * Traced polylines indexed on a uniform spatial hash, to tell whether a new seed lies on a branch
 * already marched (within `radius`).
 */
export class Cover {
  private readonly cells = new Map<string, [P3, P3][]>();

  private readonly cell: number;
  private readonly radius: number;

  constructor(cell: number, radius: number) {
    this.cell = cell;
    this.radius = radius;
  }

  private key(i: number, j: number, k: number): string {
    return `${i},${j},${k}`;
  }

  add(points: readonly P3[], closed: boolean): void {
    const n = points.length;
    if (n === 1) this.segment(points[0] as P3, points[0] as P3);
    for (let i = 0; i + 1 < n; i++) this.segment(points[i] as P3, points[i + 1] as P3);
    if (closed && n > 2) this.segment(points[n - 1] as P3, points[0] as P3);
  }

  private segment(a: P3, b: P3): void {
    const r = this.radius;
    const lo = [0, 1, 2].map((k) =>
      Math.floor((Math.min(a[k] as number, b[k] as number) - r) / this.cell),
    );
    const hi = [0, 1, 2].map((k) =>
      Math.floor((Math.max(a[k] as number, b[k] as number) + r) / this.cell),
    );
    for (let i = lo[0] as number; i <= (hi[0] as number); i++) {
      for (let j = lo[1] as number; j <= (hi[1] as number); j++) {
        for (let k = lo[2] as number; k <= (hi[2] as number); k++) {
          const key = this.key(i, j, k);
          const list = this.cells.get(key);
          if (list === undefined) this.cells.set(key, [[a, b]]);
          else list.push([a, b]);
        }
      }
    }
  }

  covers(p: P3): boolean {
    const list = this.cells.get(
      this.key(
        Math.floor(p[0] / this.cell),
        Math.floor(p[1] / this.cell),
        Math.floor(p[2] / this.cell),
      ),
    );
    if (list === undefined) return false;
    for (const [a, b] of list) if (segmentDistance(p, a, b) <= this.radius) return true;
    return false;
  }
}

export function segmentDistance(p: P3, a: P3, b: P3): number {
  const d = sub3(b, a);
  const l2 = dot3(d, d);
  if (!(l2 > 0)) return dist3(p, a);
  const s = Math.max(0, Math.min(1, dot3(sub3(p, a), d) / l2));
  return dist3(p, madd3(a, d, s));
}
