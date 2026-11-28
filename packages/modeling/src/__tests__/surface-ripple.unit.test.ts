import { describe, expect, it } from 'vitest';
import { type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality, curveFairness, isoparm } from '../surface-quality';

const S = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

/** Cylinder panel R = 0.5 m, 0.8 rad wide, 0.4 m high; radial ripple of `amp` and wavelength `lambda` along the arc. */
function panel(amp: number, net = 16, lambda = 0.1): NurbsSurface {
  const g = S(net).map((a) =>
    S(net).map((b): [number, number, number] => {
      const t = -0.4 + 0.8 * a;
      const r = 0.5 + amp * Math.sin((2 * Math.PI * (0.4 * a)) / lambda);
      return [r * Math.sin(t), 0.4 * b, r * Math.cos(t)];
    }),
  );
  const s = nurbs.grid(g);
  if (!s.ok) throw s.error;
  return s.value;
}

function check(surface: NurbsSurface, net: number) {
  const r = checkSurfaceQuality(
    { surfaces: [{ name: 'P', surface }] },
    { maxNet: [net + 1, net + 1] },
  );
  if (!r.ok) throw r.error;
  return r.value;
}

describe('surface quality: ripples of any wavelength (S-R5, B12-1)', () => {
  it('fails a 0.3 mm ripple of 0.1 m wavelength on the default gate, at every net density', () => {
    for (const net of [16, 24, 32]) {
      const r = check(panel(0.0003, net), net);
      expect(r.pass, `net ${net}`).toBe(false);
      expect(r.issues.map((i) => i.code)).toEqual(['surface-fairness']);
    }
  });

  it('passes the smooth plate and a ripple of one wave only', () => {
    expect(check(panel(0), 16).pass).toBe(true);
    // 0.2 m wavelength: two waves over the 0.4 m panel, a designed-scale undulation.
    expect(check(panel(0.0003, 16, 0.2), 16).pass).toBe(true);
  });

  it('reports the peaks as spikes of the isoparm, with the ripple count', () => {
    const line = curveFairness({ name: 'iso', curve: isoparm(panel(0.0003), 'u', 0.5) });
    if (!line.ok) throw line.error;
    expect(line.value.pass).toBe(false);
    expect(line.value.spikes.length).toBeGreaterThanOrEqual(3);
    for (const spike of line.value.spikes) expect(spike.prominence).toBeGreaterThan(1);
  });

  it('lists a peak once when it is both a narrow spike and one of the ripple', () => {
    const line = curveFairness({ name: 'iso', curve: isoparm(panel(0.001), 'u', 0.5) });
    if (!line.ok) throw line.error;
    const at = line.value.spikes.map((spike) => spike.t);
    expect(at.length).toBeGreaterThanOrEqual(3);
    expect(new Set(at).size).toBe(at.length);
  });

  it('does not count a ripple that swings less than half the median curvature', () => {
    const r = check(panel(0.0001, 24), 24);
    expect(r.pass).toBe(true);
  });

  it('keeps a fair arc and its two-hump designed profile free of ripple spikes', () => {
    const fair = curveFairness({ name: 'fair', curve: isoparm(panel(0), 'u', 0.5) });
    if (!fair.ok) throw fair.error;
    expect(fair.value.spikes).toHaveLength(0);
    const waves = curveFairness({ name: 'two', curve: isoparm(panel(0.0003, 16, 0.2), 'u', 0.5) });
    if (!waves.ok) throw waves.error;
    expect(waves.value.spikes).toHaveLength(0);
  });
});
