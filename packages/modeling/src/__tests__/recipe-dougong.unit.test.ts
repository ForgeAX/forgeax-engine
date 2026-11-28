import { describe, expect, it } from 'vitest';
import type { Point2 } from '../primitives';
import { CAI_WIDTH_FEN, caiFen } from '../recipes/caifen';
import {
  armOutline,
  type BracketDou,
  type BracketMember,
  bracketDous,
  bracketMembers,
  crossingsOf,
  type DougongOptions,
  type DougongPuzuo,
  dougong,
  douProfile,
  fashiEnvelope,
  JUMP_FEN,
  mazhaTouProfile,
  memberBottomOf,
  mouthsOf,
  QI_INSET_FRACTIONS,
  supportReport,
} from '../recipes/dougong';
import { sel } from '../selectors';

function fen6(): number {
  const r = caiFen(6);
  if (!r.ok) throw new Error('caiFen(6) failed');
  return r.value.fen;
}

/** Arm span from the mouth face out to the far side of its jump (5 to 55 fen for tier 1). */
const ARM_SPAN_FEN = 50;

/**
 * Outer reach of the set along X: the shuatou tip, 25 fen past the outermost jump (round 6). The
 * huagong tips sit inside it, so the shuatou is the outermost point of each set.
 */
const TIP_FEN: Readonly<Record<DougongPuzuo, number>> = { 4: 55, 5: 85 };

/**
 * Tip bound for a huagong past the centre of its outermost jiaohu dou, in fen. The Yingzao Fashi
 * figure is 6 fen; the dou is 18 fen long along the arm, so the outer 3 fen of the dou project past
 * the tip (the requested 9-fen lower bound would need a 9-fen margin; see knowledge/timber-members.md, round 6 review).
 */
const HUA_TIP_PAST_DOU_BOUND_FEN = { min: 6, max: 10 } as const;

/** Round-5 stack height in fen: 58 for puzuo 4, 79 for puzuo 5. */
const STACK_FEN: Readonly<Record<DougongPuzuo, number>> = { 4: 58, 5: 79 };

/** Declared contacts per set: seats and fits (anchors of the dou table, halved crossings included). */
const CONTACTS: Readonly<Record<DougongPuzuo, number>> = { 4: 24, 5: 42 };

/** A dou's bottom face on a member top: true when the vertical gap is at most 0.05 mm. */
function bottomOnTop(douBottomY: number, memberTopY: number): boolean {
  return Math.abs(douBottomY - memberTopY) <= 0.05 * 1e-3;
}

function snapshotBytes(r: { model: { snapshot(): Uint8Array } }): Buffer {
  return Buffer.from(r.model.snapshot());
}

function dim(r: { dimensions: Readonly<Record<string, number>> }, key: string): number {
  return r.dimensions[key] as number;
}

/** Statuses of every designed-contact issue (`within`, `exceeded`, `mismatch`, `apart`, `unknown-part`). */
function fitStatuses(report: {
  issues: readonly { code: string; detail: Readonly<Record<string, unknown>> }[];
}): string[] {
  return report.issues
    .filter((i) => i.code === 'designed-contact')
    .flatMap((i) => (i.detail.fits as { status: string }[]).map((f) => f.status));
}

function memberByKey(members: readonly BracketMember[], key: string): BracketMember {
  const found = members.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no member ${key}`);
  return found;
}

describe('dougong', () => {
  it.each([4, 5] as const)('puzuo %i defaults build a closed, clean bracket set', (puzuo) => {
    const r = dougong({ puzuo });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.model.validate({ contacts: r.value.contacts ?? [] });
    expect(report.closed).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it.each([4, 5] as const)('puzuo %i: every declared contact reads within', (puzuo) => {
    const r = dougong({ puzuo });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.model.validate({ contacts: r.value.contacts ?? [] });
    const statuses = fitStatuses(report);
    expect(statuses).toHaveLength(CONTACTS[puzuo]);
    expect(statuses.every((s) => s === 'within')).toBe(true);
    expect(statuses.filter((s) => s === 'apart' || s === 'exceeded')).toEqual([]);
    expect(r.value.contacts?.length).toBe(CONTACTS[puzuo]);
  });

  it.each([4, 5] as const)('puzuo %i stack height matches the round-5 fen count', (puzuo) => {
    const r = dougong({ puzuo });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fen = fen6();
    const box = r.value.model.bounds(sel.all());
    expect(box.ok).toBe(true);
    if (!box.ok) return;
    expect(box.value.min[1]).toBeCloseTo(0, 9);
    expect(box.value.max[1] - box.value.min[1]).toBeCloseTo(STACK_FEN[puzuo] * fen, 9);
    expect(dim(r.value, 'stackHeight')).toBeCloseTo(STACK_FEN[puzuo] * fen, 9);
  });

  it.each([4, 5] as const)('puzuo %i is symmetric about the column axis', (puzuo) => {
    const r = dougong({ puzuo });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const box = r.value.model.bounds(sel.all());
    expect(box.ok).toBe(true);
    if (!box.ok) return;
    expect(box.value.min[0] + box.value.max[0]).toBeCloseTo(0, 9);
    expect(box.value.min[2] + box.value.max[2]).toBeCloseTo(0, 9);
  });

  it('outer reach: the shuatou tip, 55 fen for puzuo 4 and 85 fen for puzuo 5, equal to the projection', () => {
    const fen = fen6();
    for (const puzuo of [4, 5] as const) {
      const r = dougong({ puzuo });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const box = r.value.model.bounds(sel.all());
      expect(box.ok).toBe(true);
      if (!box.ok) return;
      expect(box.value.max[0]).toBeCloseTo(TIP_FEN[puzuo] * fen, 9);
      expect(dim(r.value, 'projection')).toBeCloseTo(TIP_FEN[puzuo] * fen, 9);
    }
    expect(TIP_FEN[5] - TIP_FEN[4]).toBe(JUMP_FEN);
  });

  it('huagong half length: 30 fen per tier plus 6 fen past the centre, so 72 fen total for tier 1', () => {
    const four = memberByKey(bracketMembers(4), 'huagong-1');
    expect(four.from).toBe(-36);
    expect(four.to).toBe(36);
    const five = bracketMembers(5);
    expect(memberByKey(five, 'huagong-1').to).toBe(36);
    expect(memberByKey(five, 'huagong-2').to).toBe(66);
    expect(memberByKey(five, 'huagong-2').from).toBe(-66);
  });

  it('huagong tips: 6 to 10 fen past the centre of the outermost jiaohu dou, on both sides', () => {
    for (const puzuo of [4, 5] as const) {
      const members = bracketMembers(puzuo);
      const dous = bracketDous(puzuo, members);
      const huagongs = members.filter((m) => m.role === 'huagong');
      expect(huagongs).toHaveLength(puzuo - 3);
      for (const huagong of huagongs) {
        const outer = dous.filter((d) => d.kind === 'jiaohu' && d.sitsOn === huagong.key);
        expect(outer, huagong.key).toHaveLength(2);
        for (const d of outer) {
          const past = d.at[0] > 0 ? huagong.to - d.at[0] : d.at[0] - huagong.from;
          expect(past, `${huagong.key} past ${d.key}`).toBeGreaterThanOrEqual(
            HUA_TIP_PAST_DOU_BOUND_FEN.min,
          );
          expect(past, `${huagong.key} past ${d.key}`).toBeLessThanOrEqual(
            HUA_TIP_PAST_DOU_BOUND_FEN.max,
          );
        }
      }
    }
  });

  it('shuatou is the longest member along X, so it is the outermost point of each set', () => {
    for (const puzuo of [4, 5] as const) {
      const members = bracketMembers(puzuo);
      const shuatou = memberByKey(members, 'shuatou');
      for (const m of members.filter((item) => item.axis === 'x' && item.key !== 'shuatou')) {
        expect(shuatou.to - shuatou.from, m.key).toBeGreaterThan(m.to - m.from);
      }
    }
  });

  it('dimensions carry the round-5 counts and sizes', () => {
    const fen = fen6();
    const four = dougong({ puzuo: 4 });
    const five = dougong({ puzuo: 5 });
    expect(four.ok && five.ok).toBe(true);
    if (!four.ok || !five.ok) return;
    expect(dim(four.value, 'fen')).toBeCloseTo(fen, 9);
    expect(dim(four.value, 'steps')).toBe(1);
    expect(dim(five.value, 'steps')).toBe(2);
    expect(dim(four.value, 'stackHeight')).toBeCloseTo(0.73312, 9);
    expect(dim(five.value, 'stackHeight')).toBeCloseTo(0.99856, 9);
    expect(dim(four.value, 'projection')).toBeCloseTo(TIP_FEN[4] * fen, 9);
    expect(dim(five.value, 'projection')).toBeCloseTo(TIP_FEN[5] * fen, 9);
    expect(dim(four.value, 'memberCount')).toBe(6);
    expect(dim(five.value, 'memberCount')).toBe(10);
    expect(dim(four.value, 'jiaohuDouCount')).toBe(2);
    expect(dim(five.value, 'jiaohuDouCount')).toBe(4);
    expect(dim(four.value, 'sanDouCount')).toBe(8);
    expect(dim(five.value, 'sanDouCount')).toBe(14);
    expect(dim(four.value, 'qixinDouCount')).toBe(2);
    expect(dim(five.value, 'qixinDouCount')).toBe(3);
    expect(dim(four.value, 'halvedCrossingCount')).toBe(4);
    expect(dim(five.value, 'halvedCrossingCount')).toBe(7);
    expect(dim(four.value, 'emptyMouthCount')).toBe(10);
    expect(dim(five.value, 'emptyMouthCount')).toBe(16);
  });

  it('places every member and dou anchor, and the top', () => {
    const four = dougong({ puzuo: 4 });
    const five = dougong({ puzuo: 5 });
    expect(four.ok && five.ok).toBe(true);
    if (!four.ok || !five.ok) return;
    expect(Object.keys(four.value.anchors)).toHaveLength(20);
    expect(Object.keys(five.value.anchors)).toHaveLength(33);
    for (const r of [four.value, five.value]) {
      expect(r.anchors.top).toBeDefined();
      expect(r.anchors.ludou).toBeDefined();
    }
    expect(four.value.anchors['nidaogong-1']).toBeDefined();
    expect(four.value.anchors['huagong-1']).toBeDefined();
    expect(four.value.anchors['manggong-2']).toBeDefined();
    expect(four.value.anchors['linggong-2-x+']).toBeDefined();
    expect(four.value.anchors['jiaohu-1-x+']).toBeDefined();
    expect(four.value.anchors['san-dou-nidaogong-1-hi']).toBeDefined();
    expect(four.value.anchors['qixin-dou-linggong-2-x+']).toBeDefined();
    expect(five.value.anchors['huagong-2']).toBeDefined();
    expect(five.value.anchors['guazi-2-x+']).toBeDefined();
    expect(five.value.anchors['san-dou-linggong-3-x--lo']).toBeDefined();
  });

  it('member table: six members for puzuo 4 and ten for puzuo 5, tiers and axes as built', () => {
    const four = bracketMembers(4);
    const five = bracketMembers(5);
    expect(four.map((m) => m.key).sort()).toEqual(
      [
        'huagong-1',
        'linggong-2-x+',
        'linggong-2-x-',
        'manggong-2',
        'nidaogong-1',
        'shuatou',
      ].sort(),
    );
    expect(five.map((m) => m.key).sort()).toEqual(
      [
        'guazi-2-x+',
        'guazi-2-x-',
        'huagong-1',
        'huagong-2',
        'linggong-3-c',
        'linggong-3-x+',
        'linggong-3-x-',
        'manggong-2',
        'nidaogong-1',
        'shuatou',
      ].sort(),
    );
    expect(memberByKey(five, 'huagong-2').axis).toBe('x');
    expect(memberByKey(five, 'huagong-2').tier).toBe(2);
    expect(memberByKey(five, 'linggong-3-x+').tier).toBe(3);
    expect(memberByKey(five, 'shuatou').tier).toBe(3);
    expect(memberByKey(four, 'shuatou').tier).toBe(2);
    expect(memberByKey(five, 'shuatou').ends).toBe('mazha-tou');
    expect(memberByKey(five, 'linggong-3-c').across).toBe(0);
    expect(memberByKey(five, 'guazi-2-x+').axis).toBe('z');
    expect(memberByKey(four, 'nidaogong-1').tier).toBe(1);
    expect(memberByKey(four, 'manggong-2').tier).toBe(2);
    expect(memberByKey(four, 'linggong-2-x+').across).toBe(30);
  });

  it('every gong carries a juansha at both ends, and the shuatou carries the mazha-tou leaf', () => {
    for (const puzuo of [4, 5] as const) {
      const envelope = fashiEnvelope();
      for (const m of bracketMembers(puzuo)) {
        const length = m.to - m.from;
        if (m.role === 'shuatou') {
          expect(m.ends).toBe('mazha-tou');
          // Tip at u = 0 rises to the nose (12 fen); the two 8-fen treads step down to the floor at 16 fen.
          const pts = armOutline(length, CAI_WIDTH_FEN, 'mazha-tou', { start: true, end: true });
          expect(pts).toContainEqual([0, 12]);
          expect(pts).toContainEqual([8, 8]);
          expect(pts).toContainEqual([16, 4]);
          continue;
        }
        expect(m.ends, `${m.key} must carry a juansha`).toBe('juansha');
        // Built as the recipe builds it: the juansha at both ends.
        const pts = armOutline(length, CAI_WIDTH_FEN, 'fashi', { start: true, end: true });
        // Five envelope points at each end: the inner end runs at x = u, the outer at x = length - u.
        for (const [u, v] of envelope) {
          const inner = pts.some(([x, y]) => Math.abs(x - u) < 1e-9 && Math.abs(y - v) < 1e-9);
          const outer = pts.some(
            ([x, y]) => Math.abs(x - (length - u)) < 1e-9 && Math.abs(y - v) < 1e-9,
          );
          expect(inner, `${m.key} inner envelope point (${u}, ${v})`).toBe(true);
          expect(outer, `${m.key} outer envelope point (${length - u}, ${v})`).toBe(true);
        }
      }
    }
  });

  it('dou table: 13 dous for puzuo 4 and 22 for puzuo 5, every sitsOn member one tier below', () => {
    for (const puzuo of [4, 5] as const) {
      const members = bracketMembers(puzuo);
      const dous = bracketDous(puzuo, members);
      expect(dous).toHaveLength(puzuo === 4 ? 13 : 22);
      for (const d of dous) {
        if (d.sitsOn === null) {
          expect(d.kind).toBe('ludou');
          continue;
        }
        expect(memberByKey(members, d.sitsOn).tier).toBe(d.tier);
      }
    }
  });

  it('crossing table: four halved crossings for puzuo 4 and seven for puzuo 5', () => {
    const four = crossingsOf(bracketMembers(4));
    const five = crossingsOf(bracketMembers(5));
    expect(four).toHaveLength(4);
    expect(four.map((c) => [c.x, c.z])).toContainEqual(['huagong-1', 'nidaogong-1']);
    expect(
      four
        .filter((c) => c.x === 'shuatou')
        .map((c) => c.z)
        .sort(),
    ).toEqual(['linggong-2-x+', 'linggong-2-x-', 'manggong-2'].sort());
    expect(five).toHaveLength(7);
    expect(
      five
        .filter((c) => c.x === 'shuatou')
        .map((c) => c.z)
        .sort(),
    ).toEqual(['linggong-3-c', 'linggong-3-x+', 'linggong-3-x-'].sort());
  });

  it('mouth table: the empty-mouth count equals the dimension for both sets', () => {
    for (const puzuo of [4, 5] as const) {
      const members = bracketMembers(puzuo);
      const dous = bracketDous(puzuo, members);
      const empty = dous.flatMap((d) => mouthsOf(d, members)).filter((mo) => mo.holds === null);
      const r = dougong({ puzuo });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(empty.length).toBe(dim(r.value, 'emptyMouthCount'));
    }
  });

  it('support report: puzuo 4 verdicts, with no declared exception', () => {
    const members = bracketMembers(4);
    const rows = supportReport(members, bracketDous(4, members));
    const verdict = (key: string) => rows.find((row) => row.key === key)?.verdict;
    expect(verdict('nidaogong-1')).toBe('ground');
    expect(verdict('huagong-1')).toBe('ground');
    expect(verdict('manggong-2')).toBe('two-mouths');
    expect(verdict('shuatou')).toBe('two-mouths');
    expect(verdict('linggong-2-x+')).toBe('mouth-and-crossing');
    expect(verdict('linggong-2-x-')).toBe('mouth-and-crossing');
    expect(rows.filter((row) => row.verdict === 'unsupported')).toEqual([]);
  });

  it('support report: puzuo 5 verdicts, the shuatou and the centre linggong rest in two mouths', () => {
    const members = bracketMembers(5);
    const rows = supportReport(members, bracketDous(5, members));
    const verdict = (key: string) => rows.find((row) => row.key === key)?.verdict;
    expect(verdict('nidaogong-1')).toBe('ground');
    expect(verdict('huagong-1')).toBe('ground');
    expect(verdict('huagong-2')).toBe('two-mouths');
    expect(verdict('manggong-2')).toBe('two-mouths');
    expect(verdict('guazi-2-x+')).toBe('mouth-and-crossing');
    expect(verdict('guazi-2-x-')).toBe('mouth-and-crossing');
    expect(verdict('linggong-3-c')).toBe('two-mouths');
    expect(verdict('linggong-3-x+')).toBe('mouth-and-crossing');
    expect(verdict('linggong-3-x-')).toBe('mouth-and-crossing');
    expect(verdict('shuatou')).toBe('two-mouths');
    expect(rows.filter((row) => row.verdict === 'unsupported')).toEqual([]);
  });

  it('no verdict is an exception: every member is ground, two-mouths or mouth-and-crossing', () => {
    for (const puzuo of [4, 5] as const) {
      const members = bracketMembers(puzuo);
      const rows = supportReport(members, bracketDous(puzuo, members));
      expect(rows).toHaveLength(members.length);
      for (const row of rows) {
        expect(['ground', 'two-mouths', 'mouth-and-crossing']).toContain(row.verdict);
      }
    }
  });

  it('shuatou reach: tips 25 fen past the outer top linggong, on the linggong centre line', () => {
    const four = memberByKey(bracketMembers(4), 'shuatou');
    const five = memberByKey(bracketMembers(5), 'shuatou');
    expect(four.to).toBe(30 + 25);
    expect(four.from).toBe(-(30 + 25));
    expect(five.to).toBe(60 + 25);
    expect(five.from).toBe(-(60 + 25));
    expect(four.across).toBe(0);
    expect(five.across).toBe(0);
  });

  /**
   * Falsifier: remove one dou from the table and the support report must downgrade the member it
   * held. Removing the upper dou of the 2-mouth manggong-2 (puzuo 4) leaves a lone mouth with no
   * crossing, so it is unsupported; removing the jiaohu under linggong-2-x+ leaves zero mouths.
   */
  it('falsifier: dropping a dou from the table downgrades the member it carried', () => {
    const members = bracketMembers(4);
    const dous = bracketDous(4, members);
    // The manggong keeps one mouth and its shuatou partner still rests in two: mouth-and-crossing.
    const noUpper = dous.filter((d) => d.key !== 'san-dou-nidaogong-1-hi');
    const rowsA = supportReport(members, noUpper);
    expect(rowsA.find((r) => r.key === 'manggong-2')?.verdict).toBe('mouth-and-crossing');
    // Removing the jiaohu x-mouth under linggong-2-x+ leaves that linggong with no mouth at all, and
    // the shuatou it crosses drops to one mouth.
    const noJiaohu = dous.filter((d) => d.key !== 'jiaohu-1-x+');
    const rowsB = supportReport(members, noJiaohu);
    expect(rowsB.find((r) => r.key === 'linggong-2-x+')?.verdict).toBe('unsupported');
    expect(rowsB.find((r) => r.key === 'shuatou')?.verdict).toBe('mouth-and-crossing');
  });

  it('is deterministic: the same options give the same mesh bytes', () => {
    const options: DougongOptions = { puzuo: 5, grade: 4, curlFacets: 3, curl: 'parabola' };
    const a = dougong(options);
    const b = dougong(options);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(snapshotBytes(a.value).equals(snapshotBytes(b.value))).toBe(true);
  });

  it('the parabola curl changes the arm geometry; the fashi default is a different envelope', () => {
    const fashi = dougong({ curl: 'fashi' });
    const shallow = dougong({ curl: 'parabola', curlDropFen: 1 });
    const deep = dougong({ curl: 'parabola', curlDropFen: 6 });
    expect(fashi.ok && shallow.ok && deep.ok).toBe(true);
    if (!fashi.ok || !shallow.ok || !deep.ok) return;
    expect(snapshotBytes(shallow.value).equals(snapshotBytes(deep.value))).toBe(false);
    expect(snapshotBytes(fashi.value).equals(snapshotBytes(shallow.value))).toBe(false);
  });

  it.each([
    ['puzuo too small', { puzuo: 3 }],
    ['puzuo too large', { puzuo: 6 }],
    ['non-integer puzuo', { puzuo: 4.5 }],
    ['grade out of table', { grade: 9 }],
    ['curl facets below two', { curl: 'parabola', curlFacets: 1 }],
    ['parabola run longer than the arm span', { curl: 'parabola', curlRunFen: 60 }],
    ['parabola drop taller than the cai', { curl: 'parabola', curlDropFen: 15 }],
    ['unknown curl name', { curl: 'spiral' }],
  ])('refuses %s with a structured argument error', (_, options) => {
    const r = dougong(options as unknown as DougongOptions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('the parabola curl sampled at equal runs is convex', () => {
    const pts = armOutline(
      ARM_SPAN_FEN,
      CAI_WIDTH_FEN,
      { facets: 4, run: 8, drop: 4 },
      {
        start: false,
        end: true,
      },
    );
    // Curled tip: bottom points with x in [span - run, span], excluding the top corner.
    const curve = pts
      .filter(
        ([x, y]) => x >= ARM_SPAN_FEN - 8 - 1e-9 && x <= ARM_SPAN_FEN + 1e-9 && y < CAI_WIDTH_FEN,
      )
      .sort((p, q) => p[0] - q[0]);
    expect(curve).toHaveLength(5);
    for (let i = 1; i < curve.length; i++) {
      expect((curve[i] as Point2)[0] - (curve[i - 1] as Point2)[0]).toBeCloseTo(2, 9);
    }
    for (let i = 1; i < curve.length - 1; i++) {
      const y0 = (curve[i - 1] as Point2)[1];
      const y1 = (curve[i] as Point2)[1];
      const y2 = (curve[i + 1] as Point2)[1];
      expect(y0 - 2 * y1 + y2).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('the fashi envelope is the four-part construction: runs and rises divided into equal parts', () => {
    const pts = fashiEnvelope();
    expect(pts).toHaveLength(5);
    // Join i pairs horizontal point i (run 16 fen, from the corner) with vertical point i (rise 9
    // fen, counted down from the tip). Point i sits on the join's tangency, (16 s^2, 9 (1 - s)^2).
    for (let i = 0; i <= 4; i++) {
      const s = i / 4;
      expect(pts[i]?.[0]).toBeCloseTo(16 * s * s, 9);
      expect(pts[i]?.[1]).toBeCloseTo(9 * (1 - s) * (1 - s), 9);
    }
    expect(pts[0]?.[0]).toBeCloseTo(0, 9);
    expect(pts[0]?.[1]).toBeCloseTo(9, 9);
    expect(pts[4]?.[0]).toBeCloseTo(16, 9);
    expect(pts[4]?.[1]).toBeCloseTo(0, 9);
  });

  it('the fashi envelope is not four equal chords: its joins are unequal by construction', () => {
    const pts = fashiEnvelope();
    const chords = pts.slice(1).map((p, i) => {
      const q = pts[i] as Point2;
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    });
    expect(Math.max(...chords) - Math.min(...chords)).toBeGreaterThan(0.5);
  });

  it('the fashi joins satisfy u / run + v / rise = 1, so the polyline lies on the envelope', () => {
    const pts = fashiEnvelope();
    for (let i = 0; i <= 4; i++) {
      const [u, v] = pts[i] as Point2;
      // Each vertex sits on sqrt(u / 16) + sqrt(v / 9) = 1.
      expect(Math.sqrt(u / 16) + Math.sqrt(v / 9)).toBeCloseTo(1, 9);
    }
  });

  /**
   * Falsifier for the round-3 one-tier-low placement: a dou one zucai (foot-cai, 21 fen) pitch below its
   * member's top fails the same bottom-on-top predicate that passes the real placement.
   */
  it.each([
    4, 5,
  ] as const)('puzuo %i: every dou sits on its member top, and a one-tier-low dou fails', (puzuo) => {
    const r = dougong({ puzuo });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const members = bracketMembers(puzuo);
    const fen = fen6();
    const dous: BracketDou[] = bracketDous(puzuo, members).filter((d) => d.sitsOn !== null);
    for (const d of dous) {
      const topY = (memberBottomOf(d.tier) + CAI_WIDTH_FEN) * fen;
      const placedY = (r.value.anchors[d.key] as number[])[1] as number;
      expect(bottomOnTop(placedY, topY), `${d.key} on its member`).toBe(true);
      const lowY = (memberBottomOf(d.tier - 1) + CAI_WIDTH_FEN) * fen;
      expect(bottomOnTop(placedY, lowY), `${d.key} not one tier low`).toBe(false);
    }
  });

  it('the dou profile follows the 4:2:4 ratio of ear, flat and qi', () => {
    const profile = douProfile(16, 14, 10);
    expect(profile.ear).toBeCloseTo(4, 9);
    expect(profile.flat).toBeCloseTo(2, 9);
    expect(profile.qi).toBeCloseTo(4, 9);
    expect(profile.ear + profile.flat + profile.qi).toBeCloseTo(10, 9);
    expect(profile.sections[profile.sections.length - 1]?.y).toBeCloseTo(10, 9);
  });

  it('the qi insets follow the three-band fractions and narrow toward the foot concavely', () => {
    const profile = douProfile(16, 14, 10);
    const qi = profile.sections.slice(0, 4);
    const insets = qi.map((s) => 8 - s.hx);
    QI_INSET_FRACTIONS.forEach((f, i) => {
      expect(insets[i] as number).toBeCloseTo(2 * f, 9);
    });
    // Concave in height: the inset step shrinks with each band, so the foot flares out sharply.
    const steps = insets.slice(1).map((v, i) => Math.abs(v - (insets[i] as number)));
    expect(steps[0] as number).toBeGreaterThan(steps[1] as number);
    expect(steps[1] as number).toBeGreaterThan(steps[2] as number);
  });

  it('mazha-tou leaf: nose 12 fen, two 4-fen risers, 8-fen treads, ends on the floor at 16 fen', () => {
    // Table-driven: each row is [tread, riser]. Points run from the nose inward and end on the floor.
    const expected: readonly (readonly [number, number])[] = [
      [0, 12],
      [0, 8],
      [8, 8],
      [8, 4],
      [16, 4],
      [16, 0],
    ];
    expect(mazhaTouProfile()).toEqual(expected);
  });

  it('falsifier: a 1:1:1 block fails the 4:2:4 ratio check', () => {
    const block = douProfile(16, 14, 10, [1, 1, 1]);
    expect(block.ear).not.toBeCloseTo(4, 3);
    expect(block.flat).not.toBeCloseTo(2, 3);
  });

  it('falsifier: an arm one fen wider than the mouth slot is a confirmed interference', () => {
    const baseline = dougong({ puzuo: 4 });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const wider = dougong({ puzuo: 4, armThicknessFen: 11 });
    expect(wider.ok).toBe(true);
    if (!wider.ok) return;
    const report = wider.value.model.validate({ contacts: wider.value.contacts ?? [] });
    const confirmed = report.issues.filter(
      (i) => i.code === 'self-intersection' && i.detail?.certainty === 'confirmed',
    );
    expect(confirmed.length).toBeGreaterThan(0);
  });
});
