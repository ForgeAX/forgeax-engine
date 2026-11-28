import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/brep/validate.ts';
import { GAPS } from '../gaps.ts';
import { buildAll, makeReport, renderStress } from '../render.ts';

const PI = Math.PI;
const parts = buildAll();
const [cover, pump] = parts;
const step = (part: typeof cover, id: string) => part?.steps.find((s) => s.id === id);

describe('stress parts: every step is recorded, valid or a structured fail-close', () => {
  it('a successful step is a valid solid with positive volume; a failed one names its reason and gap', () => {
    for (const p of parts) {
      expect(p.steps.length).toBeGreaterThan(8);
      for (const s of p.steps) {
        if (s.ok) {
          expect([s.id, s.valid]).toEqual([s.id, true]);
          expect(s.faces).toBeGreaterThan(2);
          expect(s.volume).toBeGreaterThan(0);
        } else {
          expect(s.failure?.expected.length).toBeGreaterThan(0);
          expect(s.failure?.detail.brep).toBe('brep-ssi-unsupported');
          expect(GAPS.map((g) => g.id)).toContain(s.gap);
        }
      }
    }
  });

  it('a failed direct step is followed by a fallback of the same step', () => {
    for (const p of parts)
      for (const s of p.steps.filter((x) => x.route === 'direct' && !x.ok)) {
        const next = p.steps.filter((x) => x.route === 'fallback' && x.id.startsWith(s.id));
        expect(next.length, `${s.id} has no fallback`).toBeGreaterThan(0);
        expect(next.every((x) => x.ok)).toBe(true);
      }
  });

  it('the bolt circles drill at seam phase 0, with the closed-form volume', () => {
    const plate = PI * 3600 * 8;
    expect(step(cover, 'A1')?.volume).toBeCloseTo(plate, 6);
    expect(step(cover, 'A2')?.volume).toBeCloseTo(plate - 8 * PI * 16 * 8, 6);
    expect(step(cover, 'A3')?.volume).toBeCloseTo(plate - 8 * PI * 16 * 8 + PI * 256 * 18, 6);
    expect(step(pump, 'B2')?.volume).toBeCloseTo(PI * (2500 - 6 * 12.25) * 10, 6);
    expect(step(pump, 'B3')?.volume).toBeCloseTo(PI * (2500 - 6 * 12.25 - 676) * 10, 6);
    expect(step(pump, 'B11')?.volume).toBeCloseTo(PI * (1296 - 8 * 9 - 256) * 8, 6);
  });

  it('the swept and lofted steps are valid solids', () => {
    for (const [p, id] of [
      [cover, 'A7b'],
      [pump, 'B5'],
      [pump, 'B7'],
    ] as const) {
      expect(step(p, id)?.ok).toBe(true);
      expect(step(p, id)?.valid).toBe(true);
    }
    for (const p of parts) for (const f of p.features) expect(validate(f.shape).ok).toBe(true);
  });
});

describe('gaps: each repro fail-closes with a structured reason or builds a valid solid', () => {
  it.each(GAPS.map((g) => [g.id, g] as const))('%s', (_id, gap) => {
    const r = gap.run();
    if (r.ok) expect(validate(r.value).ok).toBe(true);
    else if (gap.status === 'fixed') expect.fail(`${gap.id} regressed: ${r.error.code}`);
    else {
      expect(r.error.detail?.brep).toBe('brep-ssi-unsupported');
      expect(r.error.expected.length).toBeGreaterThan(0);
    }
    expect(['e1 boolean', 'trimface', 'offset', 'sweep']).toContain(gap.owner);
  });
});

describe('renders', () => {
  it('writes shaded and feature-line views for both parts; feature lines change the image', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stress-'));
    try {
      const files = renderStress(dir, parts, 240);
      expect(files).toHaveLength(14);
      for (const f of files) expect(statSync(f).size).toBeGreaterThan(2000);
      const shaded = readFileSync(join(dir, 'gearbox-cover-shaded-iso.png'));
      const lines = readFileSync(join(dir, 'gearbox-cover-features-iso.png'));
      expect(Buffer.compare(shaded, lines)).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.STRESS_EMIT !== undefined)(
    'emits report.json and the PNGs',
    () => {
      const report = join(__dirname, '..', 'report.json');
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, `${JSON.stringify(makeReport(parts), null, 2)}\n`);
      renderStress(process.env.STRESS_EMIT as string, parts);
    },
    600_000,
  );

  it('the committed report.json lists both parts and every gap', () => {
    const report = JSON.parse(readFileSync(join(__dirname, '..', 'report.json'), 'utf8'));
    expect(report.parts.map((p: { name: string }) => p.name)).toEqual([
      'gearbox-cover',
      'pump-manifold',
    ]);
    expect(report.gaps.map((g: { id: string }) => g.id)).toEqual(GAPS.map((g) => g.id));
  });
});
