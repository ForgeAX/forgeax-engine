// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { meshVolume } from '../../geom';
import { box, cone, cylinder, extrude, revolve, sphere, torus } from '../build';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { validate } from '../validate';
import corpus from './fixtures/corpus.json';
import { boundaryEdges, meshEuler } from './support';

interface Case {
  name: string;
  kind: string;
  args: Record<string, unknown>;
  area: number;
  volume: number;
  euler: number;
}

const BUILD: Record<string, (a: never) => ReturnType<typeof box>> = {
  box: box as never,
  cylinder: cylinder as never,
  cone: cone as never,
  sphere: sphere as never,
  torus: torus as never,
  extrude: extrude as never,
  revolve: revolve as never,
};

describe('oracle corpus: analytic area, volume and Euler number, no external kernel', () => {
  for (const c of corpus as Case[]) {
    it(c.name, () => {
      const built = BUILD[c.kind]!(c.args as never);
      if (!built.ok) throw new Error(JSON.stringify(built.error));
      expect(validate(built.value).ok).toBe(true);
      const m = measure(built.value);
      if (!m.ok) throw new Error('measure');
      expect(m.value.area / c.area).toBeGreaterThan(1 - 1e-6);
      expect(m.value.area / c.area).toBeLessThan(1 + 1e-6);
      expect(m.value.volume / c.volume).toBeGreaterThan(1 - 1e-6);
      expect(m.value.volume / c.volume).toBeLessThan(1 + 1e-6);
      const t = tessellate(built.value, { angle: Math.PI / 24 });
      if (!t.ok) throw new Error(JSON.stringify(t.error));
      expect(boundaryEdges(t.value)).toBe(0);
      expect(meshEuler(t.value)).toBe(c.euler);
      const mv = meshVolume(t.value);
      expect(Math.abs(mv - c.volume) / c.volume).toBeLessThan(0.02);
      expect(mv).toBeLessThanOrEqual(c.volume * (1 + 1e-9));
    });
  }

  it('falsifier: a perturbed oracle value is rejected by the ratio bound', () => {
    const c = (corpus as Case[])[0]!;
    const built = box(c.args as never);
    if (!built.ok) throw new Error('box');
    const m = measure(built.value);
    if (!m.ok) throw new Error('measure');
    expect(Math.abs(m.value.volume / (c.volume * 1.0001) - 1)).toBeGreaterThan(1e-6);
  });
});
