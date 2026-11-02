import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { curveFairness, nurbs } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ARCH_LINES, comb, FEATURE_TABLE, FIT, fitLine, type Span, toleranceOf } from '../feature-lines';

/**
 * Case C-100 (examples/mech-gt): the feature-curve network is fitted, never
 * interpolated: every span has at most FIT.maxPoints control points, stays within its line's
 * tolerance of the measured drawing and turns one way only. With FORGEAX_CASE_OUT it writes
 * the feature-line table and one curvature-comb plot per view.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
/** Global comb scale: meters of tooth per 1/m of curvature (a 3.3 m radius draws a 1.5 cm tooth). */
const GLOBAL_COMB = 0.05;
const lines = FEATURE_TABLE.map((line) => ({ line, spans: fitLine(line) }));

describe('C-100 feature-line network', () => {
  it.each(lines.map((l) => [l.line.id, l] as const))('%s: few control points, within tolerance, no inflection', (_id, { line, spans }) => {
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect([s.index, s.curve.points.length <= FIT.maxPoints]).toEqual([s.index, true]);
      expect([s.index, s.error.max <= toleranceOf(line) + 1e-9]).toEqual([s.index, true]);
      // Fairness by the kernel's check: no inflection, no curvature spike, a bounded curvature rate.
      if (s.points.length >= 2 * FIT.minSpan) {
        const fair = curveFairness({ name: `${line.id}#${s.index}`, curve: s.curve });
        if (!fair.ok) throw fair.error;
        expect([s.index, { inflections: fair.value.inflections.length, spikes: fair.value.spikes.length, rateRatio: fair.value.rateRatio <= 15 }]).toEqual([s.index, { inflections: 0, spikes: 0, rateRatio: true }]);
      }
    }
  });

  it('writes the table and the comb plots', () => {
    if (OUT === undefined) return;
    mkdirSync(OUT, { recursive: true });
    const table = lines.map(({ line, spans }) => ({
      id: line.id,
      view: line.view,
      note: line.note,
      continuity: line.continuity,
      lock: line.lock,
      ...(line.radius === undefined ? {} : { radius: line.radius }),
      tolerance: toleranceOf(line),
      spans: spans.map((s) => ({ controlPoints: s.curve.points.length, maxError: Math.round(s.error.max * 1e5) / 1e5, inflections: s.inflections, next: s.next })),
    }));
    writeFileSync(join(OUT, 'feature-lines.json'), `${JSON.stringify({ schema: 'forgeax.mech-gt.feature-lines/1', fit: FIT, lines: table, arches: ARCH_LINES }, null, 2)}\n`);
    for (const view of [...new Set(FEATURE_TABLE.map((l) => l.view))]) {
      const spans = lines.filter((l) => l.line.view === view).flatMap((l) => l.spans);
      const arches = view === 'right' ? ARCH_LINES : [];
      writeFileSync(join(OUT, `combs-${view}.png`), PNG.sync.write(plot(spans, arches, 'span')));
      writeFileSync(join(OUT, `combs-${view}-global.png`), PNG.sync.write(plot(spans, arches, 'global')));
    }
    writeFileSync(join(OUT, 'feature-lines.md'), markdown());
  });
});

/** The feature-line table for review: per line its spans, fit, continuity and lock. */
function markdown(): string {
  const rows = lines.map(({ line, spans }) => {
    const fit = spans.map((s) => `${s.curve.points.length}cp ${(s.error.max * 1000).toFixed(1)}mm${s.inflections > 0 ? ` i${s.inflections}` : ''}${s.next === 'end' ? '' : ` →${s.next}`}`).join(', ');
    const lock = line.radius === undefined ? line.lock : `${line.lock} ${(line.radius * 1000).toFixed(0)} mm`;
    return `| ${line.id} | ${line.view} | ${line.continuity} | ${lock} | ${(toleranceOf(line) * 1000).toFixed(0)} mm | ${spans.length} | ${fit} | ${line.note} |`;
  });
  const breaks = lines.flatMap(({ line }) => (line.breaks ?? []).map((b) => `| ${line.id} | ${b.at} | ${b.continuity} | ${b.note} |`));
  return [
    '# C-100 mech-gt feature-line network',
    '',
    `Fit: cubic NURBS (quadratic for 3 control points), ${FIT.minPoints}–${FIT.maxPoints} control points per span, never interpolated. Spans are listed as control points, largest distance to the drawing, inflections (if any) and the continuity to the next span.`,
    '',
    '| Line | View | Continuity across | Lock | Tolerance | Spans | Fit per span | Note |',
    '|:--|:--|:--|:--|--:|--:|:--|:--|',
    ...rows,
    '',
    '## Designed breaks',
    '',
    '| Line | At | Continuity | Station |',
    '|:--|--:|:--|:--|',
    ...breaks,
    '',
    '## Wheel arches',
    '',
    ...ARCH_LINES.map((a) => `- ${a.id}: exact arc, center z ${a.center[0].toFixed(3)} y ${a.center[1].toFixed(3)}, radius ${a.radius.toFixed(3)} m (surface boundary, the arch lip)`),
    '',
  ].join('\n');
}

/** A plot of spans as a PNG: drawing (grey), curve (black), control polygon and points (red), curvature comb (blue), arches (green). */
function plot(spans: readonly Span[], arches: typeof ARCH_LINES, scaleMode: 'span' | 'global'): PNG {
  const pts = spans.flatMap((s) => s.points);
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const scale = 1800 / Math.max(x1 - x0, y1 - y0, 1e-6);
  const pad = 80;
  const [w, h] = [Math.ceil(2 * pad + (x1 - x0) * scale), Math.ceil(2 * pad + (y1 - y0) * scale)];
  const png = new PNG({ width: w, height: h });
  png.data.fill(255);
  const X = (x: number) => pad + (x - x0) * scale;
  const Y = (y: number) => pad + (y1 - y) * scale;
  const dot = (x: number, y: number, c: readonly number[], r = 0) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const [px, py] = [Math.round(x) + dx, Math.round(y) + dy];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        png.data.set([...c, 255], (py * w + px) * 4);
      }
  };
  const line = (ax: number, ay: number, bx: number, by: number, c: readonly number[], r = 0) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let i = 0; i <= n; i++) dot(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, c, r);
  };
  const poly = (ps: readonly (readonly number[])[], c: readonly number[], r = 0) => {
    for (let i = 0; i + 1 < ps.length; i++) line(X(ps[i]?.[0] as number), Y(ps[i]?.[1] as number), X(ps[i + 1]?.[0] as number), Y(ps[i + 1]?.[1] as number), c, r);
  };

  for (const a of arches) poly(Array.from({ length: 121 }, (_, i) => [a.center[0] + a.radius * Math.cos((2 * Math.PI * i) / 120), a.center[1] + a.radius * Math.sin((2 * Math.PI * i) / 120)]), [40, 160, 40]);
  for (const s of spans) poly(s.points, [190, 190, 190], 2);
  for (const s of spans) {
    // 'span': each comb scaled to its own peak (shape within a span); 'global': one physical scale
    // for every view (GLOBAL_COMB meters of tooth per 1/m of curvature, so relative jumps between
    // spans show), teeth capped at 0.15 m so the tight radii read as saturated combs.
    const c = comb(s.curve);
    const tooth = scaleMode === 'span' ? 0.06 / Math.max(1e-6, ...c.map((q) => Math.abs(q.k))) : GLOBAL_COMB;
    const tips = c.map((q) => {
      const f = Math.min(tooth, 0.15 / Math.max(1e-9, Math.hypot(q.tooth[0], q.tooth[1])));
      return [q.p[0] - q.tooth[0] * f, q.p[1] - q.tooth[1] * f];
    });
    for (const [i, q] of c.entries()) line(X(q.p[0]), Y(q.p[1]), X(tips[i]?.[0] as number), Y(tips[i]?.[1] as number), [90, 140, 230]);
    poly(tips, [40, 90, 210]);
    const [t0, t1] = nurbs.domain(s.curve);
    poly(Array.from({ length: 161 }, (_, i) => nurbs.point(s.curve, t0 + ((t1 - t0) * i) / 160)), [0, 0, 0], 1);
    poly(s.curve.points, [220, 60, 60]);
    for (const p of s.curve.points) dot(X(p[0]), Y(p[1]), [220, 40, 40], 3);
  }
  return png;
}
