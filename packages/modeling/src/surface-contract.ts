import type { EditMesh } from './mesh';
import type { OpDiagnostic } from './ops';
import type { Issue } from './report';
import { uvOverlapPairs } from './uv-overlap';
import type { ValidationCode } from './validation-code';

/**
 * P2-S1 SurfaceContract: what the exported game mesh carries per corner. `color` lanes
 * R = ambient occlusion, G = curvature, B = wear, A = variation seed, all in [0, 1]. `uv0` is
 * `zone + local`: the integer cell is the face's material zone (the cell declared for its tag),
 * the fractional part is the position inside the zone, so a metric uv0 stays inside one cell.
 * A non-finite `uv0` corner is `uv0-range`. `uv1` is the decal / emissive set, every corner in [0, 1]. The check reports; it never
 * rewrites a channel. `uv1-overlap` (BK56) reports faces whose uv1 triangles overlap in the unit square, the
 * lightmap rule: uv1 is one unique layout. It runs only with `uniqueUv1: true` (a patch-domain uv1 overlaps by design).
 */
export const SURFACE_CHECKS = [
  'color-range',
  'channel-missing',
  'zone-straddle',
  'zone-unknown',
  'uv0-range',
  'uv1-range',
  'uv1-overlap',
] as const;
export type SurfaceCheck = (typeof SURFACE_CHECKS)[number];

export type SurfaceChannel = 'color' | 'uv0' | 'uv1';

export interface SurfaceContract {
  /** Face tag -> zone cell `[i, j]`: faces carrying the tag lie in `floor(uv0) = [i, j]`. */
  readonly zones?: Readonly<Record<string, readonly [number, number]>>;
  /** Tags exempt from both zone checks (parts that tile beyond one cell and carry their material by slot). */
  readonly tiling?: readonly string[];
  /** Channels that must exist (default `color`, `uv0`, `uv1`). */
  readonly need?: readonly SurfaceChannel[];
  /** Also require uv1 to be one unique layout (`uv1-overlap`), as `uv.lightmap` leaves it. */
  readonly uniqueUv1?: boolean;
}

const DEFAULT_NEED: readonly SurfaceChannel[] = ['color', 'uv0', 'uv1'];
/** Slack on cell and unit-square borders (uv units). */
const EDGE = 1e-6;
const MAX_FACES = 32;

interface Finding {
  readonly severity: 'warn' | 'info';
  readonly check: SurfaceCheck;
  readonly detail: Readonly<Record<string, unknown>>;
}

function tagged(mesh: EditMesh, faces: readonly number[], tags: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const name of tags) {
    const tag = mesh.tagIndex(name, false);
    if (tag < 0) continue;
    for (const f of faces) if (mesh.hasTag(f, tag)) out.add(f);
  }
  return out;
}

function surfaceFindings(mesh: EditMesh, contract: SurfaceContract): Finding[] {
  const out: Finding[] = [];
  const faces = mesh.faces();
  const need = contract.need ?? DEFAULT_NEED;
  const missing = need.filter((c) => !mesh.channels.has(c));
  if (missing.length > 0)
    out.push({ severity: 'warn', check: 'channel-missing', detail: { channels: missing } });

  if (mesh.channels.has('color')) {
    const bad: number[] = [];
    for (const f of faces) {
      const off = mesh.faceHalves(f).some((h) => {
        const c = mesh.corner('color', h);
        return c !== undefined && Array.from(c).some((v) => !Number.isFinite(v) || v < 0 || v > 1);
      });
      if (off) bad.push(f);
    }
    if (bad.length > 0)
      out.push({
        severity: 'warn',
        check: 'color-range',
        detail: { count: bad.length, faces: bad.slice(0, MAX_FACES) },
      });
  }

  if (mesh.channels.has('uv1')) {
    const bad: number[] = [];
    for (const f of faces) {
      const off = mesh.faceHalves(f).some((h) => {
        const c = mesh.corner('uv1', h);
        return c !== undefined && Array.from(c).some((v) => !(v >= -EDGE && v <= 1 + EDGE));
      });
      if (off) bad.push(f);
    }
    if (bad.length > 0)
      out.push({
        severity: 'warn',
        check: 'uv1-range',
        detail: { count: bad.length, faces: bad.slice(0, MAX_FACES) },
      });
    if (contract.uniqueUv1 === true) {
      const pairs = uvOverlapPairs(mesh, faces, 'uv1');
      if (pairs.length > 0)
        out.push({
          severity: 'warn',
          check: 'uv1-overlap',
          detail: { count: pairs.length, pairs: pairs.slice(0, MAX_FACES) },
        });
    }
  }

  if (!mesh.channels.has('uv0')) return out;
  const exempt = tagged(mesh, faces, contract.tiling ?? []);
  const straddle: number[] = [];
  const nonFinite: number[] = [];
  const cellOf = new Map<number, readonly [number, number]>();
  for (const f of faces) {
    if (exempt.has(f)) continue;
    const corners = mesh.faceHalves(f).flatMap((h) => {
      const c = mesh.corner('uv0', h);
      return c === undefined ? [] : [c];
    });
    if (corners.length === 0) continue;
    if (corners.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) {
      nonFinite.push(f);
      continue;
    }
    const u = corners.reduce((s, c) => s + (c[0] as number), 0) / corners.length;
    const v = corners.reduce((s, c) => s + (c[1] as number), 0) / corners.length;
    const cell: readonly [number, number] = [Math.floor(u), Math.floor(v)];
    cellOf.set(f, cell);
    const outside = corners.some(
      (c) =>
        (c[0] as number) < cell[0] - EDGE ||
        (c[0] as number) > cell[0] + 1 + EDGE ||
        (c[1] as number) < cell[1] - EDGE ||
        (c[1] as number) > cell[1] + 1 + EDGE,
    );
    if (outside) straddle.push(f);
  }
  if (nonFinite.length > 0)
    out.push({
      severity: 'warn',
      check: 'uv0-range',
      detail: { count: nonFinite.length, faces: nonFinite.slice(0, MAX_FACES) },
    });
  if (straddle.length > 0)
    out.push({
      severity: 'warn',
      check: 'zone-straddle',
      detail: { count: straddle.length, faces: straddle.slice(0, MAX_FACES) },
    });

  const zones = contract.zones;
  if (zones !== undefined) {
    const names = Object.keys(zones);
    const rows = new Map<string, number[]>();
    const add = (reason: string, f: number) => rows.set(reason, [...(rows.get(reason) ?? []), f]);
    for (const [f, cell] of cellOf) {
      const mine = names.filter((n) => {
        const tag = mesh.tagIndex(n, false);
        return tag >= 0 && mesh.hasTag(f, tag);
      });
      if (mine.length === 0) {
        add('no-zone', f);
        continue;
      }
      const wanted = mine.map((n) => zones[n] as readonly [number, number]);
      const first = wanted[0] as readonly [number, number];
      if (wanted.some((w) => w[0] !== first[0] || w[1] !== first[1])) add('ambiguous', f);
      else if (first[0] !== cell[0] || first[1] !== cell[1]) add('mismatch', f);
    }
    for (const [reason, list] of rows)
      out.push({
        severity: 'warn',
        check: 'zone-unknown',
        detail: { reason, count: list.length, faces: list.slice(0, MAX_FACES) },
      });
  }
  if (exempt.size > 0)
    out.push({
      severity: 'info',
      check: 'zone-unknown',
      detail: { reason: 'exempt', tags: contract.tiling, count: exempt.size },
    });
  return out;
}

/** `validate({ surface })`: every finding is a `surface` issue whose `detail.check` names it. */
export function checkSurface(
  mesh: EditMesh,
  contract: SurfaceContract,
  issues: Issue<ValidationCode>[],
): void {
  for (const f of surfaceFindings(mesh, contract))
    issues.push({ code: 'surface', severity: f.severity, detail: { check: f.check, ...f.detail } });
}

/** `toMesh({ surface })`: the same findings as export diagnostics; the export itself is unchanged. */
export function surfaceDiagnostics(mesh: EditMesh, contract: SurfaceContract): OpDiagnostic[] {
  return surfaceFindings(mesh, contract).map((f) => ({
    severity: f.severity,
    message: `surface ${f.check}`,
    detail: { check: f.check, ...f.detail },
  }));
}
