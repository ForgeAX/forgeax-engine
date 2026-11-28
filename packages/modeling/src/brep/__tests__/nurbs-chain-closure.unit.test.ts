import { describe, expect, it } from 'vitest';
import { loft } from '../loft';
import { joinBranches } from '../query/stitch';
import { intersectFaces } from '../ssi';
import { makeFrame } from '../surfaces';
import { sweep } from '../sweep';
import type { Shape } from '../types';

const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;
const pathFrame = {
  o: [0, 0, 0] as [number, number, number],
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z: [0, 0, 1] as [number, number, number],
};

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function stubShape(): Shape {
  return must(
    sweep({
      profile: sq(0.25),
      path: { kind: 'circle', frame: pathFrame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
}

function flangeShape(): Shape {
  return must(
    loft({
      sections: [
        { profile: sq(0.4), frame: makeFrame([0, 0, 0], [0, 0, 1]) },
        { profile: sq(0.4), frame: makeFrame([0, 0, 2], [0, 0, 1]) },
      ],
      mode: 'smooth',
    }),
  );
}

// Every NURBS face against one plane; returns the joined chains and the branches they were built from.
function chainsOf(shape: Shape, plane: ReturnType<typeof makeFrame>) {
  const out: { closed: boolean; ends: readonly { reason: string }[] }[] = [];
  let branches = 0;
  for (const f of shape.faces) {
    const surface = shape.surfaces[f.surface];
    if (surface?.kind !== 'nurbs') continue;
    const r = intersectFaces(
      { surface: { kind: 'nurbs', surface: surface.surface } },
      {
        surface: { kind: 'plane', frame: plane },
        bounds: [
          [-6, 6],
          [-6, 6],
        ],
      },
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    branches += r.value.branches.length;
    const jb = r.value.branches.map((b) => ({
      closed: b.closed,
      ends: [b.points[0], b.points[b.points.length - 1]] as [
        readonly [number, number, number],
        readonly [number, number, number],
      ],
      stops: b.ends as [string, string],
    }));
    out.push(...joinBranches(jb, 1e-6));
  }
  return { chains: out, branches };
}

describe('NURBS x plane chain closure on the sweep stub and loft flange', () => {
  const cases: [string, () => Shape, ReturnType<typeof makeFrame>][] = [
    ['sweep stub, plane z=0', stubShape, makeFrame([0, 0, 0], [0, 0, 1])],
    ['sweep stub, plane x=2', stubShape, makeFrame([2, 0, 0], [1, 0, 0])],
    ['loft flange, plane z=1', flangeShape, makeFrame([0, 0, 1], [0, 0, 1])],
    ['loft flange, plane x=0.2', flangeShape, makeFrame([0.2, 0, 0], [1, 0, 0])],
  ];
  for (const [label, build, plane] of cases) {
    it(`${label}: every chain end reaches the face boundary and no end is a gap or junction`, () => {
      const { chains, branches } = chainsOf(build(), plane);
      expect(branches).toBeGreaterThan(0);
      for (const c of chains) {
        for (const e of c.ends) expect(e.reason).toBe('boundary');
      }
    });
  }
});
