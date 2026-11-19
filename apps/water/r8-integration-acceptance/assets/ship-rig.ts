import { quat } from '@forgeax/engine/math';
import type { PhysicsMassProperties } from '@forgeax/engine/physics';
import { hullMesh } from './procedural';

type Vector = readonly [number, number, number];
type Tensor = readonly [number, number, number, number, number, number];
interface MassElement {
  readonly id: string;
  readonly massKg: number;
  readonly centerM: Vector;
  /** xx, yy, zz, xy, xz, yz about this element's center. */
  readonly inertiaKgM2: Tensor;
  readonly source: string;
}

const timberDensityKgM3 = 500;
const leadDensityKgM3 = 11340;
const sailDensityKgM2 = 0.6;
export const COAST_SHIP_ADDITIONAL_BALLAST_RATIO = 0.5;
export const COAST_SHIP_MASTS = [
  { xM: -1.7, heightM: 18.7, rakeM: -0.65, crowHeightM: 9.6 },
  { xM: 4.9, heightM: 19.5, rakeM: 0.1, crowHeightM: 10.4 },
] as const;
export const COAST_SHIP_PONTOONS = {
  anchorsM: [-6, -0.9, -1.6, -6, -0.9, 1.6, 6, -0.9, -1.6, 6, -0.9, 1.6],
  radiiM: [1.5, 1.5, 1.5, 1.5],
  designRootYM: 0.9,
} as const;

function box(id: string, centerM: Vector, sizeM: Vector, density: number): MassElement {
  const massKg = sizeM[0] * sizeM[1] * sizeM[2] * density;
  return {
    id,
    centerM,
    massKg,
    inertiaKgM2: [
      (massKg * (sizeM[1] ** 2 + sizeM[2] ** 2)) / 12,
      (massKg * (sizeM[0] ** 2 + sizeM[2] ** 2)) / 12,
      (massKg * (sizeM[0] ** 2 + sizeM[1] ** 2)) / 12,
      0,
      0,
      0,
    ],
    source: `Box ${sizeM.join(' x ')} m at ${density} kg/m3`,
  };
}

function spar(
  id: string,
  start: Vector,
  end: Vector,
  radiusM: number,
  innerRadiusM = 0,
  density = timberDensityKgM3,
): MassElement {
  const d = end.map((value, axis) => value - start[axis]!);
  const lengthM = Math.hypot(...d);
  const axis = d.map((value) => value / lengthM);
  const massKg = Math.PI * (radiusM ** 2 - innerRadiusM ** 2) * lengthM * density;
  const axial = (massKg * (radiusM ** 2 + innerRadiusM ** 2)) / 2;
  const transverse = (massKg * (3 * (radiusM ** 2 + innerRadiusM ** 2) + lengthM ** 2)) / 12;
  const difference = axial - transverse;
  return {
    id,
    massKg,
    centerM: start.map((value, index) => (value + end[index]!) / 2) as unknown as Vector,
    inertiaKgM2: [
      transverse + difference * axis[0]! ** 2,
      transverse + difference * axis[1]! ** 2,
      transverse + difference * axis[2]! ** 2,
      difference * axis[0]! * axis[1]!,
      difference * axis[0]! * axis[2]!,
      difference * axis[1]! * axis[2]!,
    ],
    source: `Cylinder length ${lengthM} m, outer/inner radius ${radiusM}/${innerRadiusM} m, ${density} kg/m3`,
  };
}

function combine(elements: readonly MassElement[]) {
  const massKg = elements.reduce((sum, element) => sum + element.massKg, 0);
  const centerM = [0, 1, 2].map(
    (axis) =>
      elements.reduce((sum, element) => sum + element.massKg * element.centerM[axis]!, 0) / massKg,
  ) as [number, number, number];
  const inertia = [0, 0, 0, 0, 0, 0];
  for (const element of elements) {
    const [x, y, z] = element.centerM.map((value, axis) => value - centerM[axis]!);
    const shift = [
      y! ** 2 + z! ** 2,
      x! ** 2 + z! ** 2,
      x! ** 2 + y! ** 2,
      -x! * y!,
      -x! * z!,
      -y! * z!,
    ];
    for (let axis = 0; axis < 6; axis++)
      inertia[axis] = inertia[axis]! + element.inertiaKgM2[axis]! + element.massKg * shift[axis]!;
  }
  return { massKg, centerM, inertiaKgM2: inertia as unknown as Tensor };
}

function hullShell(): MassElement {
  const mesh = hullMesh(false),
    positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array) || mesh.indices === undefined)
    throw new Error('Hull shell requires indexed positions');
  const triangles: MassElement[] = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const corners = [0, 1, 2].map((corner) =>
      Array.from(
        positions.subarray(
          mesh.indices![index + corner]! * 3,
          mesh.indices![index + corner]! * 3 + 3,
        ),
      ),
    );
    const a = corners[0]!,
      b = corners[1]!,
      c = corners[2]!;
    const u = b.map((value, axis) => value - a[axis]!),
      v = c.map((value, axis) => value - a[axis]!);
    const areaM2 =
      Math.hypot(
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ) / 2;
    if (areaM2 === 0) continue;
    const centerM = [0, 1, 2].map((axis) => (a[axis]! + b[axis]! + c[axis]!) / 3) as [
      number,
      number,
      number,
    ];
    const covariance = (row: number, column: number) =>
      corners.reduce(
        (sum, point) => sum + (point[row]! - centerM[row]!) * (point[column]! - centerM[column]!),
        0,
      ) / 12;
    const massKg = areaM2 * 0.025 * timberDensityKgM3;
    triangles.push({
      id: 'hull-panel',
      massKg,
      centerM,
      inertiaKgM2: [
        massKg * (covariance(1, 1) + covariance(2, 2)),
        massKg * (covariance(0, 0) + covariance(2, 2)),
        massKg * (covariance(0, 0) + covariance(1, 1)),
        -massKg * covariance(0, 1),
        -massKg * covariance(0, 2),
        -massKg * covariance(1, 2),
      ],
      source: 'Uniform 25 mm timber shell',
    });
  }
  return {
    id: 'hull-shell',
    ...combine(triangles),
    source:
      'Indexed rendered hull sides and ends, excluding the deck closure; 25 mm timber shell at 500 kg/m3',
  };
}

const designElements: MassElement[] = [
  hullShell(),
  box('keel-ballast', [-1.25, -1.15, 0], [7, 0.14, 0.4], leadDensityKgM3),
  box('deck-planking', [-0.7, 1.55, 0], [14.5, 0.045, 3.65], timberDensityKgM3),
  box('cabin-roof', [-7.75, 3.16, 0], [2.5, 0.03, 3.65], timberDensityKgM3),
  ...[-1, 1].map((side) =>
    box(`cabin-side-${side}`, [-7.75, 2.6, side * 1.715], [2.2, 0.95, 0.02], timberDensityKgM3),
  ),
  ...[-1, 1].map((side) =>
    box(`cabin-end-${side}`, [-7.75 + side * 1.09, 2.6, 0], [0.02, 0.95, 3.45], timberDensityKgM3),
  ),
  ...COAST_SHIP_MASTS.flatMap(({ xM, heightM, rakeM, crowHeightM }, index) => [
    spar(`mast-${index}`, [xM, 1.5, 0], [xM + rakeM, heightM, 0], 0.13, 0.09),
    ...[8.1, 13.7].map((yM, yard) =>
      spar(
        `yard-${index}-${yard}`,
        [xM, yM, -(yard === 0 ? 2.8 : 2.2) / 2],
        [xM, yM, (yard === 0 ? 2.8 : 2.2) / 2],
        0.055,
      ),
    ),
    ...[-1, 1].flatMap((side) =>
      [-2, -1, 0, 1, 2].map((offset) =>
        spar(
          `rig-${index}-${side}-${offset}`,
          [xM + offset, 2.3, side * 2.1],
          [xM + rakeM * 0.5, crowHeightM + 0.7, 0],
          0.015,
          0,
          1300,
        ),
      ),
    ),
    spar(`stay-${index}`, [xM + rakeM, heightM, 0], [12.5, 4.2, 0], 0.017, 0, 1300),
    spar(`backstay-${index}`, [xM + rakeM, heightM, 0], [-8.7, 3.4, 0], 0.015, 0, 1300),
  ]),
  spar('bowsprit', [6.2, 2.1, 0], [13, 5, 0], 0.095),
  spar('aft-gaff', [-3.35, 3.2, 0], [-9.35, 10.5, 0], 0.055),
  box(
    'jib-aft-centerplane-envelope',
    [-1.4667, 5.1, 0],
    [2.4, 4.8, 0.001],
    (sailDensityKgM2 * 0.5) / 0.001,
  ),
  box(
    'jib-forward-centerplane-envelope',
    [5.4, 4.7667, 0],
    [1.7, 3.8, 0.001],
    (sailDensityKgM2 * 0.5) / 0.001,
  ),
  box(
    'aft-sail-centerplane-envelope',
    [-6.35, 6.85, 0],
    [0.65, 7.3, 0.001],
    sailDensityKgM2 / 0.001,
  ),
];
const design = combine(designElements);
const elements: MassElement[] = [
  ...designElements,
  box('additional-keel-ballast', [-1.25, -1, 0],
    [7, design.massKg * COAST_SHIP_ADDITIONAL_BALLAST_RATIO / (7 * 0.4 * leadDensityKgM3), 0.4],
    leadDensityKgM3),
];
const combined = combine(elements);
const [xx, yy, zz, xy, xz, yz] = combined.inertiaKgM2;
const tensor = [
  [xx, xy, xz],
  [xy, yy, yz],
  [xz, yz, zz],
];
const basis = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
// Jacobi rotations preserve the small off-axis terms of the actual hull panels.
for (let iteration = 0; iteration < 32; iteration++) {
  const [p, q] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ].sort((a, b) => Math.abs(tensor[b[0]!]![b[1]!]!) - Math.abs(tensor[a[0]!]![a[1]!]!))[0]!;
  const apq = tensor[p!]![q!]!;
  if (Math.abs(apq) < 1e-9) break;
  const tau = (tensor[q!]![q!]! - tensor[p!]![p!]!) / (2 * apq);
  const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
  const c = 1 / Math.sqrt(1 + t * t),
    s = t * c;
  tensor[p!]![p!] = tensor[p!]![p!]! - t * apq;
  tensor[q!]![q!] = tensor[q!]![q!]! + t * apq;
  tensor[p!]![q!] = tensor[q!]![p!] = 0;
  for (let row = 0; row < 3; row++) {
    if (row !== p && row !== q) {
      const a = tensor[row]![p!]!,
        b = tensor[row]![q!]!;
      tensor[row]![p!] = tensor[p!]![row] = c * a - s * b;
      tensor[row]![q!] = tensor[q!]![row] = s * a + c * b;
    }
    const a = basis[row]![p!]!,
      b = basis[row]![q!]!;
    basis[row]![p!] = c * a - s * b;
    basis[row]![q!] = s * a + c * b;
  }
}
const frame = quat.fromRotationMatrix(quat.create(), [
  basis[0]![0]!,
  basis[1]![0]!,
  basis[2]![0]!,
  basis[0]![1]!,
  basis[1]![1]!,
  basis[2]![1]!,
  basis[0]![2]!,
  basis[1]![2]!,
  basis[2]![2]!,
]);
const properties = {
  mode: 'explicit',
  mass: combined.massKg,
  centerOfMass: combined.centerM,
  principalInertia: [tensor[0]![0]!, tensor[1]![1]!, tensor[2]![2]!],
  principalInertiaLocalFrame: [frame[0]!, frame[1]!, frame[2]!, frame[3]!],
} as const satisfies PhysicsMassProperties;
const designImmersionM =
  COAST_SHIP_PONTOONS.radiiM[0] -
  COAST_SHIP_PONTOONS.anchorsM[1] -
  COAST_SHIP_PONTOONS.designRootYM;
const sphereVolumeM3 = Math.PI * designImmersionM ** 2 * (1.5 - designImmersionM / 3);
// Loading changes displacement, not the existing hull's buoyancy calibration.
const buoyancyCoefficientNPerM3 = (design.massKg * 9.81) / sphereVolumeM3;
const loadedVolumeM3 = (properties.mass * 9.81) / buoyancyCoefficientNPerM3;
const radiusM = COAST_SHIP_PONTOONS.radiiM[0];
let lowerImmersionM = 0, upperImmersionM = radiusM * 2;
for (let iteration = 0; iteration < 32; iteration++) {
  const h = (lowerImmersionM + upperImmersionM) / 2;
  const volumeM3 = Math.PI * h ** 2 * (radiusM - h / 3);
  if (volumeM3 < loadedVolumeM3) lowerImmersionM = h;
  else upperImmersionM = h;
}
const loadedRootYM = radiusM - COAST_SHIP_PONTOONS.anchorsM[1] - (lowerImmersionM + upperImmersionM) / 2;
export const COAST_SHIP_MASS_RIG = {
  revision: 3,
  elements,
  properties,
  tensorKgM2: combined.inertiaKgM2,
  approximation:
    'Authored timber shell, hollow masts, planking, rope cylinders and internal lead ballast; bilateral sail envelopes retain authored membrane area. Decorative overlays carry no duplicate mass.',
  buoyancy: {
    designDisplacementMassKg: design.massKg,
    designImmersionM,
    designRootYM: COAST_SHIP_PONTOONS.designRootYM,
    loadedRootYM,
    buoyancyCoefficientNPerM3,
    maxBuoyantForceN: buoyancyCoefficientNPerM3 * (4 / 3) * Math.PI * 1.5 ** 3,
  },
};
