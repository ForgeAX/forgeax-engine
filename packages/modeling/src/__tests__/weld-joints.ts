import type { Tuple3 } from '../geom';

type Net = {
  nodes: Tuple3[];
  edges: [number, number][];
  edgeRadius?: (number | [number, number])[];
  end?: 'miter' | 'cope';
};

const R = 0.1;
const deg = (d: number) => (d * Math.PI) / 180;
const unit = (v: Tuple3): Tuple3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const star = (dirs: Tuple3[]): Net => ({
  nodes: [[0, 0, 0], ...dirs],
  edges: dirs.map((_, i) => [0, i + 1] as [number, number]),
});
const planar = (angles: number[]) =>
  star(angles.map((a) => [Math.cos(deg(a)), Math.sin(deg(a)), 0] as Tuple3));
const tee: Net = {
  nodes: [
    [-1, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  edges: [
    [0, 1],
    [1, 2],
    [1, 3],
  ],
};
const lateral = (a: number, edgeRadius: number[]): Net => ({
  nodes: [
    [-1, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [Math.cos(deg(a)), Math.sin(deg(a)), 0],
  ],
  edges: tee.edges,
  edgeRadius,
});

/** The joint roster of the weld gate (design note B26 rolling ball, P3 set). */
export const JOINTS: Record<string, Net> = {
  tee: { ...tee, edgeRadius: [R, R, 0.07] },
  'tee-equal': tee,
  'cross-equal': planar([0, 90, 180, 270]),
  'cross-unequal': { ...planar([0, 90, 180, 270]), edgeRadius: [R, 0.07, R, 0.05] },
  '5way-planar': planar([0, 72, 144, 216, 288]),
  '6way-planar': planar([0, 60, 120, 180, 240, 300]),
  '6way-3d': star([
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]),
  '5way-3d': star([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], unit([0, -1, -1])]),
  y120: planar([90, 210, 330]),
  near172: {
    nodes: [
      [-1, 0, 0],
      [0, 0, 0],
      [Math.cos(deg(8)), Math.sin(deg(8)), 0],
      [0, 1, 0],
    ],
    edges: tee.edges,
    edgeRadius: [R, R, 0.07],
  },
  lateral45: lateral(45, [R, R, 0.07]),
  branch16: lateral(16, [R, 0.07, R]),
  'branch25-thin': lateral(25, [R, 0.03, R]),
  'thin-on-fat': { ...planar([90, 210, 330]), edgeRadius: [0.02, R, R] },
  'thick-branch': { ...tee, edgeRadius: [R, R, R] },
  'tee-cope': { ...tee, edgeRadius: [R, R, 0.07], end: 'cope' },
  'cross-cope': { ...planar([0, 90, 180, 270]), end: 'cope' },
  'bend20-cope': {
    nodes: [
      [-1, 0, 0],
      [0, 0, 0],
      [-Math.cos(deg(20)), Math.sin(deg(20)), 0],
    ],
    edges: [
      [0, 1],
      [1, 2],
    ],
    end: 'cope',
  },
};
