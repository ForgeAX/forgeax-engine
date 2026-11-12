import { model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { closureRays, closureVerdict, roleOf, seams } from '../s6-closure';

/**
 * Criterion 14 gate: the closure ray cast and the seam measure on small falsifier models
 * (the whole-car run, red until the S6a closure fix, is the case `s6-closure.case.dawn`).
 */
function shelledPanel(m: ReturnType<typeof model>, part: string, x0: number, x1: number, lift = 0, rows = 1) {
  const p = model();
  p.plane({ width: x1 - x0, height: 0.6, heightSegments: rows, center: [(x0 + x1) / 2, 0.5, lift] });
  p.shell(sel.all(), { thickness: 0.003, label: 'wall' });
  p.tag(sel.all(), `part:${part}`);
  if (p.poisoned !== undefined) throw p.poisoned;
  m.append(p);
}

describe('C-100 criterion 14 closure gate', () => {
  it('classifies parts: body panels and wheels are skin, the tub is the cockpit, everything else internal', () => {
    expect(['hood-l', 'door-r-outer', 'front-wheel-l', 'diffuser-center', 'headlight-r'].map(roleOf)).toEqual(['skin', 'skin', 'skin', 'skin', 'skin']);
    expect(roleOf('monocoque')).toBe('cockpit');
    expect(['v12-engine', 'hw-knee-l-mechanism', 'core-thigh-r'].map(roleOf)).toEqual(['internal', 'internal', 'internal']);
  });

  it('a closed body hides its internals; a hole in it leaks and names the panel', () => {
    const closed = model();
    closed.box({ size: [1, 0.6, 2], center: [0, 0.5, 0] });
    closed.tag(sel.all(), 'part:roof-front');
    closed.box({ size: [0.3, 0.2, 0.3], center: [0, 0.5, 0] });
    closed.tag(sel.all().minus(sel.tag('part:roof-front')), 'part:v12-engine');
    const ok = closureRays(closed, 2000);
    expect(ok.hits).toBeGreaterThan(1000);
    expect(ok.failures).toEqual({});
    const holed = model();
    holed.append(closed.snapshot());
    holed.delete(sel.tag('part:roof-front').and(sel.facing('+y', 5)));
    const bad = closureRays(holed, 2000);
    expect(Object.keys(bad.failures).some((k) => k.startsWith('body /'))).toBe(true);
    expect(Object.keys(bad.leaks)).toContain('roof-front');
    expect(closureVerdict(ok, []).rays).toBe(0);
    expect(closureVerdict(bad, []).rays).toBeGreaterThan(0);
  });

  it('seams: two panels 3.5 mm apart pass, a 10 mm gap or a 2 mm step fails', () => {
    const measure = (gap: number, step: number) => {
      const m = model();
      shelledPanel(m, 'hood-l', -0.5, -gap / 2);
      // Different edge subdivision on each side: stations do not mirror each other.
      shelledPanel(m, 'hood-r', gap / 2, 0.5, step, 7);
      const line = seams(m).find((l) => l.pair.join() === 'hood-l,hood-r');
      if (line === undefined) throw new Error('no seam found');
      return line;
    };
    const good = measure(0.0035, 0);
    expect(good.gap.median).toBeCloseTo(0.0035, 4);
    expect(good.gap.p90 - good.gap.p10).toBeLessThan(0.0002);
    expect(good.failing).toBeLessThan(0.1);
    expect(measure(0.01, 0).failing).toBeGreaterThan(0.9);
    expect(closureVerdict({ failures: {} }, [good]).lines).toEqual([]);
    expect(closureVerdict({ failures: {} }, [measure(0.01, 0)]).lines).toHaveLength(1);
    expect(measure(0.0035, 0.002).flush.median).toBeGreaterThan(0.001);
  });
});
