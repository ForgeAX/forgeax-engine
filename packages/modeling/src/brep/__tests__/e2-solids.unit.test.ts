import { describe, expect, it } from 'vitest';
import { revolve } from '../build';
import { measure } from '../measure';
import { revolveShell } from '../shell';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import type { P2 } from '../vec';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function watertight(shape: Shape): number {
  return boundaryEdges(must(tessellate(shape)));
}

const PI = Math.PI;

describe('revolveShell: cup with floor', () => {
  const R = 1;
  const h = 2;
  const t = 0.1;
  const shape = must(
    revolveShell({
      profile: [
        [0, 0],
        [R, 0],
        [R, h],
      ],
      thickness: t,
    }),
  );
  const closed = PI * R * R * t + PI * (R * R - (R - t) * (R - t)) * (h - t);

  it('volume equals the closed form floor + wall', () => {
    expect(Math.abs(must(measure(shape)).volume - closed)).toBeLessThan(1e-9);
  });

  it('tessellates watertight', () => {
    expect(watertight(shape)).toBe(0);
  });

  it('rejects a thickness that pushes the rim past the axis', () => {
    const bad = revolveShell({
      profile: [
        [0, 0],
        [R, 0],
        [R, h],
      ],
      thickness: 1.2,
    });
    expect(bad.ok).toBe(false);
  });
});

describe('revolveShell: bottle with a shoulder and neck', () => {
  const outer: P2[] = [
    [0, 0],
    [1, 0],
    [1, 1.5],
    [0.5, 2],
    [0.5, 2.6],
  ];
  // Outer solid closed on the axis at the rim height; its top disk is excluded from the thin-wall
  // estimate V ~ t * (outer area without the top disk), which holds to first order in t.
  const solid = must(revolve({ profile: [...outer, [0, 2.6]] }));
  const t = 0.01;
  const shell = must(revolveShell({ profile: outer, thickness: t }));

  it('thin-wall volume matches t times the outer surface area to first order', () => {
    const m = must(measure(solid));
    const topDisk = PI * 0.5 * 0.5;
    const estimate = t * (m.area - topDisk);
    const volume = must(measure(shell)).volume;
    expect(volume).toBeGreaterThan(0);
    expect(Math.abs(volume - estimate) / estimate).toBeLessThan(0.03);
  });

  it('tessellates watertight', () => {
    expect(watertight(shell)).toBe(0);
  });
});

describe('chamfered cylinder solid', () => {
  const R = 1;
  const h = 2;
  const c = 0.2;
  const shape = must(
    revolve({
      profile: [
        [0, -h / 2],
        [R - c, -h / 2],
        [R, -h / 2 + c],
        [R, h / 2 - c],
        [R - c, h / 2],
        [0, h / 2],
      ],
    }),
  );
  const volume = PI * R * R * h - 2 * PI * c * c * (R - c / 3);
  const area =
    2 * PI * R * (h - 2 * c) + 2 * PI * (2 * R - c) * Math.sqrt(2) * c + 2 * PI * (R - c) * (R - c);

  it('volume and area match the closed form', () => {
    const m = must(measure(shape));
    expect(Math.abs(m.volume - volume)).toBeLessThan(1e-9);
    expect(Math.abs(m.area - area)).toBeLessThan(1e-9);
  });

  it('tessellates watertight', () => {
    expect(watertight(shape)).toBe(0);
  });
});
