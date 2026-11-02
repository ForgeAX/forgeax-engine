import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Model, model, sel, studioEnvironment, type Tuple3 } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, frame } from '../../case/render';
import { buildS3Mech } from '../s3-rough';
import { buildS5Internals } from '../s5-chassis';
import { buildS5JointsStowed } from '../s5-joints';
import { buildS6, S6_GROUPS, S6_NORMALS, type S6Group } from '../s6-exterior';
import { CLOSURE_GATE, closureRays, closureVerdict, seams } from '../s6-closure';
import { buildS6c, S6C_GROUPS, S6C_TO_GT, s6cMaterials } from '../s6c-assembly';

/**
 * Criterion 14 on the finished car form: the S6 exterior with every S6c group, the S5
 * internals and the stowed core in place (u = 0). In CI it checks the gate runs on the
 * exterior; with FORGEAX_CASE_OUT it writes the closure and seam report and lit close-ups of
 * the five worst spots (leaks first, then seams). With the gate on (`CLOSURE_GATE`) the whole
 * car must pass: no failing ray and no failing shut line.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
/** The hard gate (CLOSURE_GATE, or FORGEAX_CLOSURE_GATE=1 for one run) builds and checks the whole car, also in CI. */
const GATE = CLOSURE_GATE || process.env.FORGEAX_CLOSURE_GATE === '1';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

function joined(parts: readonly Model[]): Model {
  const all = model();
  for (const p of parts) all.append(p.snapshot());
  return all;
}

describe('C-100 criterion 14: car-form closure', () => {
  it('ray-casts the finished car form and measures its shut lines', { timeout: 3_600_000 }, async () => {
    const groups = (Object.keys(S6_GROUPS) as S6Group[]).filter((g) => OUT !== undefined || GATE || g === 'front');
    const exterior = joined(groups.map((g) => buildS6(g)));
    const lines = seams(exterior);
    expect(lines.length).toBeGreaterThan(0);
    if (OUT === undefined && !GATE) return;

    const inside = joined([buildS5Internals(), buildS3Mech(), buildS5JointsStowed()]);
    for (const channel of ['uv0', 'uv1'] as const) inside.uv.project({ mode: 'box', scale: 1, channel });
    const car = joined([exterior, ...S6C_GROUPS.map((g) => buildS6c(g).model), inside]);
    const closure = closureRays(car, 20000);
    if (GATE) expect(closureVerdict(closure, lines)).toEqual({ rays: 0, lines: [] });
    if (OUT === undefined) return;
    mkdirSync(OUT, { recursive: true });

    // The five worst spots: body leaks clustered by entry point (5 cm), then the worst seams.
    type Spot = { kind: string; at: Tuple3; look: Tuple3; note: string };
    const spots: Spot[] = [];
    const clusters: { at: Tuple3; dir: Tuple3; part: string; reached: string; n: number }[] = [];
    for (const s of closure.samples.filter((x) => x.via === 'body')) {
      const c = clusters.find((k) => Math.hypot(...k.at.map((v, i) => v - (s.entry.at[i] as number))) < 0.05);
      if (c !== undefined) c.n++;
      else clusters.push({ at: s.entry.at, dir: s.dir, part: s.entry.part, reached: s.reached, n: 1 });
    }
    clusters.sort((a, b) => b.n - a.n);
    for (const c of clusters.slice(0, 3)) spots.push({ kind: 'leak', at: c.at, look: c.dir.map((v) => -v) as Tuple3, note: `${c.n} rays past ${c.part} to ${c.reached}` });
    for (const l of lines.slice(0, 5 - spots.length)) spots.push({ kind: 'seam', at: l.worst.at, look: l.worst.normal, note: `${l.pair.join(' | ')} gap ${(l.worst.gap * 1000).toFixed(1)} mm, flush ${(l.worst.flush * 1000).toFixed(1)} mm` });

    const paint = joined([car]);
    for (const [from, to] of Object.entries({ ...S6C_TO_GT, louvre: 'gt-paint', 'number-l': 'gt-paint', 'number-r': 'gt-paint', badge: 'gt-metal-steel', underside: 'gt-frame', intake: 'gt-primer', tire: 'gt-primer', harness: 'gt-primer' })) {
      if (paint.count(sel.material(from)) > 0) paint.assign(sel.material(from), to);
    }
    for (const slot of paint.inspect().materials) if (paint.count(sel.material(slot)) > 0 && !slot.startsWith('gt-')) paint.assign(sel.material(slot), 'gt-frame');
    const recipes = s6cMaterials({ mips: false });
    const used = paint.inspect().materials.filter((s) => paint.count(sel.material(s)) > 0);
    const mesh = unwrap(paint.toMesh({ normals: S6_NORMALS })).mesh;
    const r = await createCaseRenderer({ width: 1200, height: 800, slots: { Default: [0.6, 0.6, 0.62] }, materials: Object.fromEntries(used.map((s) => [s, recipes[s] ?? (recipes['gt-frame'] as never)])), environment: unwrap(studioEnvironment()), view: frame({ min: [-1, 0, -2.5], max: [1, 1.2, 2.5] }, CASE_FOV) });
    try {
      for (const [k, s] of spots.entries()) {
        r.aim(frame({ min: s.at.map((v) => v - 0.12), max: s.at.map((v) => v + 0.12) }, CASE_FOV, s.look));
        writeFileSync(join(OUT, `closeup-${k + 1}-${s.kind}.png`), PNG.sync.write(await r.render(mesh)));
      }
    } finally {
      await r.dispose();
    }
    const report = {
      schema: 'forgeax.mech-gt.closure/1',
      criterion: 14,
      source: { commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', assembly: 'S6 exterior + S6c groups + S5 internals + stowed core (S3 mech) + S5 joints, car form u = 0' },
      closure: { rays: closure.rays, hits: closure.hits, skin: closure.skin, openings: closure.openings, failed: Object.values(closure.failures).reduce((a, b) => a + b, 0), failures: closure.failures, leaks: closure.leaks, samples: closure.samples },
      verdict: closureVerdict(closure, lines),
      seams: { lines: lines.length, failing: lines.filter((l) => l.failing > 0.1).length, worst: lines },
      closeups: spots.map((s, k) => ({ image: `closeup-${k + 1}-${s.kind}.png`, ...s })),
    };
    writeFileSync(join(OUT, 'closure-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  });
});
