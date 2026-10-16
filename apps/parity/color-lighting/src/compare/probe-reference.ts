export const PROBE_REFERENCE_R_MIN = 1e-4;

export interface ProbeReferenceInput {
  readonly identity: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly irradiance: readonly number[];
}

export interface ProbeReferenceObject {
  readonly objectKey: string;
  readonly position: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly skyIrradiance: readonly [number, number, number];
}

export interface ProbeReferenceTerm {
  readonly identity: string;
  readonly distance: number;
  readonly radius: number;
  readonly active: boolean;
  readonly c: number;
  readonly scaledQ: number;
  readonly alpha: number;
}

export interface ProbeReferenceResult {
  readonly objectKey: string;
  readonly position: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly terms: readonly ProbeReferenceTerm[];
  readonly Q: number;
  readonly C: number;
  readonly S: number;
  readonly SH_preblend: readonly number[];
  readonly E_sky: readonly [number, number, number];
  readonly trueE_skyResidual: readonly [number, number, number];
  readonly diffuse: readonly [number, number, number];
  readonly finite: boolean;
}

const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2 = 1.0925484305920792;
const SH_C20 = 0.31539156525252005;
const SH_C22 = 0.5462742152960396;

function finiteTuple(values: readonly number[], length: number): boolean {
  return values.length === length && values.every((value) => Number.isFinite(value));
}

function distanceBetween(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function neumaierSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + correction;
}

function shBasis(normal: readonly [number, number, number]): readonly number[] {
  const [x, y, z] = normal;
  return [
    SH_C0,
    SH_C1 * y,
    SH_C1 * z,
    SH_C1 * x,
    SH_C2 * x * y,
    SH_C2 * y * z,
    SH_C20 * (3 * z * z - 1),
    SH_C2 * x * z,
    SH_C22 * (x * x - y * y),
  ];
}

function evaluateSh9(coefficients: readonly number[], normal: readonly [number, number, number]): [number, number, number] {
  const basis = shBasis(normal);
  return [0, 1, 2].map((channel) =>
    neumaierSum(basis.map((value, band) => (coefficients[band * 3 + channel] ?? 0) * value)),
  ) as [number, number, number];
}

function multiplyVector(vector: readonly [number, number, number], scalar: number): [number, number, number] {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function clampNonNegative(vector: readonly [number, number, number]): [number, number, number] {
  return [Math.max(vector[0], 0), Math.max(vector[1], 0), Math.max(vector[2], 0)];
}

/**
 * Independent finite-volume reference for the local diffuse contract.
 * It intentionally does not import the renderer's probe implementation.
 */
export function evaluateProbeReference(
  object: ProbeReferenceObject,
  probes: readonly ProbeReferenceInput[],
): ProbeReferenceResult {
  const finiteObject = finiteTuple(object.position, 3) && finiteTuple(object.normal, 3) && finiteTuple(object.skyIrradiance, 3);
  const sortedProbes = probes.slice().sort((left, right) => left.identity.localeCompare(right.identity));
  const candidates = sortedProbes
    .map((probe) => ({ probe, distance: distanceBetween(object.position, probe.position) }))
    .filter(({ probe, distance }) =>
      finiteTuple(probe.position, 3) && finiteTuple(probe.irradiance, 27) && Number.isFinite(probe.radius) && probe.radius >= PROBE_REFERENCE_R_MIN && Number.isFinite(distance) && distance >= 0 && distance < probe.radius,
    );
  const rStar = candidates.length === 0
    ? PROBE_REFERENCE_R_MIN
    : candidates.reduce((minimum, entry) => Math.min(minimum, entry.probe.radius), candidates[0]?.probe.radius ?? PROBE_REFERENCE_R_MIN);
  const rawTerms = candidates.map(({ probe, distance }) => {
    const c = 1 - (distance / probe.radius) ** 2;
    return {
      probe,
      distance,
      c,
      scaledQ: c * (rStar / probe.radius) ** 2,
    };
  });
  const Q = neumaierSum(rawTerms.map((term) => term.scaledQ));
  const activeByIdentity = new Map(rawTerms.map((term) => [term.probe.identity, term]));
  const terms = sortedProbes.map((probe) => {
    const active = activeByIdentity.get(probe.identity);
    return {
      identity: probe.identity,
      distance: distanceBetween(object.position, probe.position),
      radius: probe.radius,
      active: active !== undefined,
      c: active?.c ?? 0,
      scaledQ: active?.scaledQ ?? 0,
      alpha: active !== undefined && Q > 0 ? active.scaledQ / Q : 0,
    };
  });
  const product = rawTerms.reduce((value, term) => value * (1 - term.c), 1);
  const C = Math.min(1, Math.max(0, 1 - product));
  const S = 1 - C;
  const SH_preblend = new Array<number>(27).fill(0).map((_, index) =>
    neumaierSum(rawTerms.map((term) => {
      const alpha = Q > 0 ? term.scaledQ / Q : 0;
      return alpha * (term.probe.irradiance[index] ?? 0);
    })) * C,
  );
  const E_sky = finiteObject ? object.skyIrradiance : [0, 0, 0] as const;
  const trueE_skyResidual = multiplyVector(E_sky, S);
  const local = finiteObject ? clampNonNegative(evaluateSh9(SH_preblend, object.normal)) : [0, 0, 0] as const;
  const diffuse = [
    local[0] + trueE_skyResidual[0],
    local[1] + trueE_skyResidual[1],
    local[2] + trueE_skyResidual[2],
  ] as [number, number, number];
  return {
    objectKey: object.objectKey,
    position: object.position,
    normal: object.normal,
    terms,
    Q,
    C,
    S,
    SH_preblend,
    E_sky,
    trueE_skyResidual,
    diffuse,
    finite: finiteObject && Number.isFinite(Q) && Number.isFinite(C) && SH_preblend.every((value) => Number.isFinite(value)),
  };
}

export function constantProbeSh(color: readonly [number, number, number]): number[] {
  const result = new Array<number>(27).fill(0);
  result[0] = color[0] / SH_C0;
  result[1] = color[1] / SH_C0;
  result[2] = color[2] / SH_C0;
  return result;
}
