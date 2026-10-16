import { R_MIN } from '@forgeax/engine-types';
import type { ProbeBlendInspection } from '../inspection-types';
import {
  PROBE_BLEND_RECORD_BYTE_SIZE,
  PROBE_BLEND_RECORD_CAPACITY,
  type ProbeBlendRecord,
  type ProbeBlendRecordSentinel,
} from './probe-blend-record';

export const PROBE_R_MIN = R_MIN;
export const PROBE_MAX_CONTRIBUTORS = PROBE_BLEND_RECORD_CAPACITY;

export interface ProbeBlendContributor {
  readonly identity: string;
  readonly admitted: boolean;
  readonly distance: number;
  readonly radius: number;
  readonly irradiance: ArrayLike<number>;
}

export interface ProbeBlendInput {
  readonly contributors: readonly ProbeBlendContributor[];
  readonly normal: readonly [number, number, number];
  readonly skyIrradiance: readonly [number, number, number];
  readonly radiusMinimum?: number;
}

export interface ProbeSceneObjectInput {
  readonly objectKey: number;
  readonly generation: number;
  readonly position: readonly [number, number, number];
}

export interface ProbeBlendBufferProjection {
  /** Stable producer identity; dirty evidence is never portable across producers. */
  readonly sourceIdentity: object;
  readonly revision: number;
  /** Exact accepted revision from which dirty/removed evidence was derived. */
  readonly baseRevision: number;
  /** Producer-computed lane capacity, including the slot-zero sentinel. */
  readonly capacity: number;
  readonly records: readonly {
    readonly cacheKey: number;
    readonly record: ProbeBlendRecord;
  }[];
  /** Records whose generation or payload changed at this revision. */
  readonly dirtyRecords: readonly {
    readonly cacheKey: number;
    readonly record: ProbeBlendRecord;
  }[];
  /** Cache keys retired at this revision. */
  readonly removedCacheKeys: readonly number[];
}

export interface ProbeSceneProbeInput {
  readonly identity: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly irradiance: ArrayLike<number>;
  readonly admitted: boolean;
}

export interface ProbeAdmissionReceipt {
  readonly activeIdentities: readonly string[];
  readonly admittedIdentities: readonly string[];
  readonly rejectedIdentities: readonly string[];
  readonly stableOrder: readonly string[];
  readonly capacity: number;
  readonly overflowReason?: 'active-count-exceeds-capacity';
  readonly scaleRadius: number;
  readonly finite: boolean;
}

export type ProbeAdmissionError = {
  readonly code: 'capacity-exceeded' | 'invalid-admitted-prefix';
  readonly activeCount: number;
  readonly capacity: number;
  readonly receipt: ProbeAdmissionReceipt;
};

export interface ProbeAdmissionResult {
  readonly admitted: readonly ProbeBlendContributor[];
  readonly active: readonly ProbeBlendContributor[];
  readonly rejected: readonly ProbeBlendContributor[];
  readonly receipt: ProbeAdmissionReceipt;
  readonly error?: ProbeAdmissionError;
}

export interface ProbeSceneProjectionInput {
  readonly objects: readonly ProbeSceneObjectInput[];
  readonly probes: readonly ProbeSceneProbeInput[];
  /** Keep explicit zero-local rows for consumers whose published ABI always reads this page. */
  readonly retainSkyResidualRecords?: boolean;
  /** Optional analytic oracle input; records never store or replace Sky. */
  readonly skyIrradiance?: readonly [number, number, number];
  readonly sky?: {
    readonly available: boolean;
    readonly identity?: string;
    readonly sourceKey?: string;
    readonly irradiance: readonly [number, number, number];
    readonly fallbackReason?: string;
  };
  readonly worldRevision?: number;
  readonly lastKnownGood?: boolean;
}

export interface ProbeSceneProjectionResult {
  readonly records: readonly ProbeBlendRecord[];
  readonly contributors: readonly ProbeBlendTerm[];
  readonly activeContributorCount: number;
  readonly admittedProbeCount: number;
  readonly coverage: number;
  readonly skyResidualFraction: number;
  readonly dirtyReasons: readonly ProbeSceneDirtyReason[];
  readonly affectedObjectKeys: readonly number[];
  readonly visits: number;
  readonly allocations: number;
  readonly uploads: number;
  readonly receipt: ProbeAdmissionReceipt;
  readonly error?: ProbeAdmissionError;
}

export type ProbeSceneDirtyReason =
  | 'object-boundary'
  | 'probe-fact'
  | 'sky'
  | 'object-position'
  | 'world'
  | 'generation';

export interface ProbeBlendTerm {
  readonly identity: string;
  readonly distance: number;
  readonly radius: number;
  readonly coverage: number;
  readonly q: number;
  readonly scaledQ: number;
  readonly qHat: number;
  readonly alpha: number;
}

/** Normal-independent contributor blend; the evaluated result adds sky and diffuse. */
export interface ProbeBlendCoefficients {
  readonly terms: readonly ProbeBlendTerm[];
  readonly rStar: number;
  readonly Q: number;
  readonly C: number;
  readonly S: number;
  readonly SHPreblend: readonly number[];
  readonly receipt: ProbeAdmissionReceipt;
  readonly finite: boolean;
  readonly scaledQLogOffset: number;
}

export interface ProbeBlendResult extends ProbeBlendCoefficients {
  readonly skyIrradiance: readonly [number, number, number];
  readonly diffuse: readonly [number, number, number];
  readonly error?: ProbeAdmissionError;
}

const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2 = 1.0925484305920792;
const SH_C20 = 0.31539156525252005;
const SH_C22 = 0.5462742152960396;

function finiteVector(values: ArrayLike<number>, length: number): boolean {
  if (values.length !== length) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

function contributorIsActive(probe: ProbeBlendContributor, radiusMinimum: number): boolean {
  return (
    probe.admitted &&
    Number.isFinite(probe.distance) &&
    probe.distance >= 0 &&
    Number.isFinite(probe.radius) &&
    probe.radius >= radiusMinimum &&
    probe.distance < probe.radius &&
    finiteVector(probe.irradiance, 27)
  );
}

function emptyReceipt(radiusMinimum: number): ProbeAdmissionReceipt {
  return {
    activeIdentities: [],
    admittedIdentities: [],
    rejectedIdentities: [],
    stableOrder: [],
    capacity: PROBE_MAX_CONTRIBUTORS,
    scaleRadius: radiusMinimum,
    finite: true,
  };
}

/** Admission is the only owner allowed to order and bound probe candidates. */
export function admitProbeContributors(
  candidates: readonly ProbeBlendContributor[],
  radiusMinimum = PROBE_R_MIN,
): ProbeAdmissionResult {
  const active = candidates.filter((candidate) => contributorIsActive(candidate, radiusMinimum));
  const overflowed = active.length > PROBE_MAX_CONTRIBUTORS;
  // Admission is a deterministic stable prefix, not an all-or-nothing gate.
  // Sort the complete active set by identity before clipping so query order
  // cannot change the selected contributors.
  const stableActive = active
    .slice()
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const admitted = stableActive.slice(0, PROBE_MAX_CONTRIBUTORS);
  const rejected = stableActive.slice(PROBE_MAX_CONTRIBUTORS);
  const scaleRadius = active.reduce(
    (minimum, candidate) => Math.min(minimum, candidate.radius),
    active[0]?.radius ?? radiusMinimum,
  );
  const receipt: ProbeAdmissionReceipt = {
    activeIdentities: stableActive.map((candidate) => candidate.identity),
    admittedIdentities: admitted.map((candidate) => candidate.identity),
    rejectedIdentities: rejected.map((candidate) => candidate.identity),
    stableOrder: admitted.map((candidate) => candidate.identity),
    capacity: PROBE_MAX_CONTRIBUTORS,
    ...(overflowed ? { overflowReason: 'active-count-exceeds-capacity' as const } : {}),
    scaleRadius,
    finite: stableActive.every((candidate) => Number.isFinite(candidate.radius)),
  };
  return {
    active: stableActive,
    admitted,
    rejected,
    receipt,
    ...(overflowed
      ? {
          error: {
            code: 'capacity-exceeded' as const,
            activeCount: active.length,
            capacity: PROBE_MAX_CONTRIBUTORS,
            receipt,
          },
        }
      : {}),
  };
}

function invalidInputResult(
  radiusMinimum: number,
  code: ProbeAdmissionError['code'],
): ProbeBlendResult {
  const receipt = emptyReceipt(radiusMinimum);
  return {
    terms: [],
    rStar: radiusMinimum,
    Q: 0,
    C: 0,
    S: 1,
    SHPreblend: new Array<number>(27).fill(0),
    skyIrradiance: [0, 0, 0],
    diffuse: [0, 0, 0],
    finite: false,
    receipt,
    scaledQLogOffset: 0,
    error: { code, activeCount: 0, capacity: PROBE_MAX_CONTRIBUTORS, receipt },
  };
}

/** Neumaier compensated sum in JavaScript's IEEE-754 binary64 number type. */
export function neumaierSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    if (Math.abs(sum) >= Math.abs(value)) correction += sum - next + value;
    else correction += value - next + sum;
    sum = next;
  }
  return sum + correction;
}

/** Round a finite analytic value at the single f32 boundary. */
export function roundProbeToF32(value: number): number | undefined {
  return Number.isFinite(value) ? new Float32Array([value])[0] : undefined;
}

export function scaledProbeWeight(
  distance: number,
  radius: number,
  radiusMinimum = PROBE_R_MIN,
): { readonly coverage: number; readonly q: number } {
  if (
    !Number.isFinite(distance) ||
    distance < 0 ||
    !Number.isFinite(radius) ||
    radius < radiusMinimum ||
    distance >= radius
  ) {
    return { coverage: 0, q: 0 };
  }
  const ratio = distance / radius;
  const coverage = 1 - ratio * ratio;
  // q is intentionally diagnostic only. The kernel consumes scaledQ below.
  return { coverage, q: coverage / (radius * radius) };
}

function sh9Irradiance(
  coefficients: readonly number[],
  normal: readonly [number, number, number],
): number[] {
  const x = normal[0];
  const y = normal[1];
  const z = normal[2];
  const basis = [
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
  const result = [0, 0, 0];
  for (let band = 0; band < basis.length; band += 1) {
    const factor = basis[band] ?? 0;
    const offset = band * 3;
    result[0] = (result[0] ?? 0) + (coefficients[offset] ?? 0) * factor;
    result[1] = (result[1] ?? 0) + (coefficients[offset + 1] ?? 0) * factor;
    result[2] = (result[2] ?? 0) + (coefficients[offset + 2] ?? 0) * factor;
  }
  return result;
}

function vectorNeumaierSum(values: readonly (readonly number[])[], width: number): number[] {
  return Array.from({ length: width }, (_, channel) =>
    neumaierSum(values.map((value) => value[channel] ?? 0)),
  );
}

function blendProbeCoefficients(
  contributors: readonly ProbeBlendContributor[],
  radiusMinimum: number,
): ProbeBlendCoefficients | undefined {
  if (
    contributors.length > PROBE_MAX_CONTRIBUTORS ||
    contributors.some((contributor) => !contributorIsActive(contributor, radiusMinimum))
  ) {
    return undefined;
  }
  const rStar = contributors.reduce(
    (minimum, contributor) => Math.min(minimum, contributor.radius),
    contributors[0]?.radius ?? radiusMinimum,
  );
  const rawTerms = contributors.map((contributor) => {
    const { coverage } = scaledProbeWeight(contributor.distance, contributor.radius, radiusMinimum);
    const scaledRatio = rStar / contributor.radius;
    return {
      contributor,
      coverage,
      // Diagnostic q is never used for Q, alpha, C, or SH accumulation.
      q: coverage / (contributor.radius * contributor.radius),
      scaledQ: coverage * scaledRatio * scaledRatio,
    };
  });
  // The frozen minimum radius bounds rStar/r_i by one. The kernel consumes
  // only scaledQ, never diagnostic q or a reciprocal-square value.
  const scaledQLogOffset = 0;
  const finiteTerms = rawTerms;
  if (finiteTerms.some((term) => !Number.isFinite(term.scaledQ))) return undefined;
  const Q = neumaierSum(finiteTerms.map((term) => term.scaledQ));
  const terms = finiteTerms.map((term) => ({
    identity: term.contributor.identity,
    distance: term.contributor.distance,
    radius: term.contributor.radius,
    coverage: term.coverage,
    q: term.q,
    scaledQ: term.scaledQ,
    qHat: term.scaledQ,
    alpha: Q > 0 ? term.scaledQ / Q : 0,
  }));
  let product = 1;
  for (const term of finiteTerms) product *= 1 - term.coverage;
  const C = 1 - product;
  const S = 1 - C;
  const weightedSh = finiteTerms.map((term) =>
    Array.from(term.contributor.irradiance, (value) => value * (Q > 0 ? term.scaledQ / Q : 0)),
  );
  const SHPreblend = vectorNeumaierSum(weightedSh, 27).map((value) => value * C);
  const finite =
    Number.isFinite(Q) &&
    Number.isFinite(C) &&
    Number.isFinite(S) &&
    SHPreblend.every(Number.isFinite) &&
    finiteTerms.every((term) => Number.isFinite(term.scaledQ));
  const receipt: ProbeAdmissionReceipt = {
    activeIdentities: contributors.map((contributor) => contributor.identity),
    admittedIdentities: contributors.map((contributor) => contributor.identity),
    rejectedIdentities: [],
    stableOrder: contributors.map((contributor) => contributor.identity),
    capacity: PROBE_MAX_CONTRIBUTORS,
    scaleRadius: rStar,
    finite,
  };
  return {
    terms,
    rStar,
    Q,
    C,
    S,
    SHPreblend,
    finite,
    receipt,
    scaledQLogOffset,
  };
}

/**
 * Evaluate the CPU analytic oracle. Sky is deliberately an explicit residual
 * input and never becomes a contributor or a q/Q term.
 */
export function blendLightProbes(input: ProbeBlendInput): ProbeBlendResult {
  const radiusMinimum = input.radiusMinimum ?? PROBE_R_MIN;
  const normal = input.normal;
  const sky = input.skyIrradiance;
  if (!finiteVector(normal, 3) || !finiteVector(sky, 3)) {
    return invalidInputResult(radiusMinimum, 'invalid-admitted-prefix');
  }
  const coefficients = blendProbeCoefficients(input.contributors, radiusMinimum);
  if (coefficients === undefined)
    return invalidInputResult(radiusMinimum, 'invalid-admitted-prefix');
  const shIrradiance = sh9Irradiance(coefficients.SHPreblend, normal);
  const diffuse = [0, 1, 2].map(
    (channel) => Math.max(shIrradiance[channel] ?? 0, 0) + coefficients.S * (sky[channel] ?? 0),
  ) as [number, number, number];
  return {
    ...coefficients,
    skyIrradiance: [sky[0], sky[1], sky[2]],
    diffuse,
    finite: coefficients.finite && diffuse.every(Number.isFinite),
  };
}

function vectorDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return Math.hypot(dx, dy, dz);
}

function encodeProbeRecord(
  objectKey: number,
  generation: number,
  localBlendFraction: number,
  shPreblend: readonly number[],
  candidate: boolean,
  accepted: boolean,
  lastKnownGood: boolean,
  sentinel: ProbeBlendRecordSentinel | undefined,
): ProbeBlendRecord {
  const values = new Float32Array(PROBE_BLEND_RECORD_BYTE_SIZE / Float32Array.BYTES_PER_ELEMENT);
  values[0] = objectKey;
  values[1] = generation;
  values[2] = roundProbeToF32(localBlendFraction) ?? 0;
  values[3] = (candidate ? 1 : 0) | (accepted ? 2 : 0) | (lastKnownGood ? 4 : 0);
  for (let band = 0; band < 9; band += 1) {
    const lane = 4 + band * 4;
    values[lane] = roundProbeToF32(shPreblend[band * 3] ?? 0) ?? 0;
    values[lane + 1] = roundProbeToF32(shPreblend[band * 3 + 1] ?? 0) ?? 0;
    values[lane + 2] = roundProbeToF32(shPreblend[band * 3 + 2] ?? 0) ?? 0;
    values[lane + 3] = 0;
  }
  const packedSh = new Array<number>(27);
  for (let band = 0; band < 9; band += 1) {
    packedSh[band * 3] = values[4 + band * 4] ?? 0;
    packedSh[band * 3 + 1] = values[5 + band * 4] ?? 0;
    packedSh[band * 3 + 2] = values[6 + band * 4] ?? 0;
  }
  return {
    objectKey,
    generation,
    localBlendFraction: values[2] ?? 0,
    shPreblend: packedSh,
    bytes: new Uint8Array(values.buffer),
    byteLength: values.byteLength,
    candidate,
    accepted,
    lastKnownGood,
    ...(sentinel === undefined ? {} : { sentinel }),
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameVector3(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function sameProbeFacts(
  left: readonly ProbeSceneProbeInput[],
  right: readonly ProbeSceneProbeInput[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((probe, index) => {
    const other = right[index];
    if (
      other === undefined ||
      probe.identity !== other.identity ||
      probe.radius !== other.radius ||
      probe.admitted !== other.admitted ||
      !sameVector3(probe.position, other.position) ||
      probe.irradiance.length !== other.irradiance.length
    )
      return false;
    for (let value = 0; value < probe.irradiance.length; value += 1) {
      if (probe.irradiance[value] !== other.irradiance[value]) return false;
    }
    return true;
  });
}

function sameSkyFacts(left: ProbeSceneProjectionInput, right: ProbeSceneProjectionInput): boolean {
  const leftSky = left.sky;
  const rightSky = right.sky;
  if ((leftSky === undefined) !== (rightSky === undefined)) return false;
  if (
    leftSky !== undefined &&
    rightSky !== undefined &&
    (leftSky.available !== rightSky.available ||
      leftSky.identity !== rightSky.identity ||
      leftSky.sourceKey !== rightSky.sourceKey ||
      leftSky.fallbackReason !== rightSky.fallbackReason ||
      !sameVector3(leftSky.irradiance, rightSky.irradiance))
  )
    return false;
  if ((left.skyIrradiance === undefined) !== (right.skyIrradiance === undefined)) return false;
  return (
    left.skyIrradiance === undefined ||
    (right.skyIrradiance !== undefined && sameVector3(left.skyIrradiance, right.skyIrradiance))
  );
}

/** Renderer-owned bounded projection; admission is explicit and fail-closed. */
export class ProbeBlendSceneProjection {
  private previous?: ProbeSceneProjectionInput;
  private records = new Map<number, ProbeBlendRecord>();
  private lastError: ProbeAdmissionError | undefined;
  private lastReceipt = emptyReceipt(PROBE_R_MIN);
  private lastActiveContributorCount = 0;
  private lastAdmittedProbeCount = 0;
  private lastCoverage = 0;
  private lastFinite = true;
  private lastSky: ProbeSceneProjectionInput['sky'] = {
    available: false,
    irradiance: [0, 0, 0],
    fallbackReason: 'no-skylight',
  };
  private lastDirtyVisitCount = 0;
  private lastDirtyReasons: readonly ProbeSceneDirtyReason[] = [];
  private readonly bufferProjectionSource = Object.freeze({});
  private bufferProjection: ProbeBlendBufferProjection = Object.freeze({
    sourceIdentity: this.bufferProjectionSource,
    revision: 0,
    baseRevision: 0,
    capacity: 1,
    records: Object.freeze([]),
    dirtyRecords: Object.freeze([]),
    removedCacheKeys: Object.freeze([]),
  });
  private resultRecords: readonly ProbeBlendRecord[] = Object.freeze([]);
  private recordFacts = new Map<
    number,
    {
      readonly contributors: readonly ProbeBlendTerm[];
      readonly qHatSum: number;
      readonly rStar: number;
      readonly fallbackReason: string | undefined;
    }
  >();

  getRecord(objectKey: number): ProbeBlendRecord | undefined {
    return this.records.get(objectKey);
  }

  hasRecords(): boolean {
    return this.records.size > 0;
  }

  /** Stable upload projection; rebuilt only when probe/object facts change. */
  recordBufferProjection(): ProbeBlendBufferProjection {
    return this.bufferProjection;
  }

  inspect(): ProbeBlendInspection {
    return {
      activeContributorCount: this.lastActiveContributorCount,
      admittedProbeCount: this.lastAdmittedProbeCount,
      coverage: this.lastCoverage,
      skyResidualFraction: 1 - this.lastCoverage,
      finite: this.lastFinite,
      errorCode: this.lastError?.code,
      records: [...this.records.values()].map((record) => {
        const facts = this.recordFacts.get(record.objectKey);
        return {
          objectKey: record.objectKey,
          generation: record.generation,
          localBlendFraction: record.localBlendFraction,
          shPreblend: [...record.shPreblend],
          byteLength: record.byteLength,
          candidate: record.candidate,
          accepted: record.accepted,
          lastKnownGood: record.lastKnownGood,
          sentinel: record.sentinel,
          probeBlendIndex: record.objectKey,
          contributors: (facts?.contributors ?? []).map((term) => ({
            identity: term.identity,
            distance: term.distance,
            radius: term.radius,
            coverage: term.coverage,
            q: term.q,
            qHat: term.qHat,
            alpha: term.alpha,
          })),
          qHatSum: facts?.qHatSum ?? 0,
          rStar: facts?.rStar ?? PROBE_R_MIN,
          fallbackReason: facts?.fallbackReason,
        };
      }),
      sky: {
        available: this.lastSky?.available ?? false,
        identity: this.lastSky?.identity,
        sourceKey: this.lastSky?.sourceKey,
        irradiance: [...(this.lastSky?.irradiance ?? [0, 0, 0])] as [number, number, number],
        fallbackReason: this.lastSky?.fallbackReason,
      },
      dirtyVisitCount: this.lastDirtyVisitCount,
      dirtyReasons: [...this.lastDirtyReasons],
      receipt: {
        activeIdentities: [...this.lastReceipt.activeIdentities],
        admittedIdentities: [...this.lastReceipt.admittedIdentities],
        rejectedIdentities: [...this.lastReceipt.rejectedIdentities],
        stableOrder: [...this.lastReceipt.stableOrder],
        capacity: this.lastReceipt.capacity,
        scaleRadius: this.lastReceipt.scaleRadius,
        finite: this.lastReceipt.finite,
        overflowReason: this.lastReceipt.overflowReason,
      },
    };
  }

  apply(input: ProbeSceneProjectionInput): ProbeSceneProjectionResult {
    const dirtyReasons: ProbeSceneDirtyReason[] = [];
    const affectedObjectKeys = new Set<number>();
    const previous = this.previous;
    if (
      previous !== undefined &&
      previous.objects === input.objects &&
      input.worldRevision === previous.worldRevision &&
      input.retainSkyResidualRecords === previous.retainSkyResidualRecords &&
      sameProbeFacts(input.probes, previous.probes) &&
      sameSkyFacts(input, previous)
    ) {
      return {
        records: this.resultRecords,
        contributors: [],
        activeContributorCount: this.lastActiveContributorCount,
        admittedProbeCount: this.lastAdmittedProbeCount,
        coverage: this.lastCoverage,
        skyResidualFraction: 1 - this.lastCoverage,
        dirtyReasons: [],
        affectedObjectKeys: [],
        visits: 0,
        allocations: 0,
        uploads: 0,
        receipt: this.lastReceipt,
        ...(this.lastError === undefined ? {} : { error: this.lastError }),
      };
    }
    const objectKeys = input.objects.map((object) => String(object.objectKey)).sort();
    const previousObjectKeys =
      previous?.objects.map((object) => String(object.objectKey)).sort() ?? [];
    if (previous === undefined || !sameList(objectKeys, previousObjectKeys)) {
      dirtyReasons.push('object-boundary');
      for (const object of input.objects) affectedObjectKeys.add(object.objectKey);
    }
    if (previous !== undefined && input.worldRevision !== previous.worldRevision)
      dirtyReasons.push('world');
    if (
      previous !== undefined &&
      (!sameProbeFacts(input.probes, previous.probes) ||
        input.retainSkyResidualRecords !== previous.retainSkyResidualRecords)
    )
      dirtyReasons.push('probe-fact');
    if (previous !== undefined && !sameSkyFacts(input, previous)) dirtyReasons.push('sky');
    const previousObjects = new Map(previous?.objects.map((object) => [object.objectKey, object]));
    for (const object of input.objects) {
      const oldObject = previousObjects.get(object.objectKey);
      if (oldObject === undefined) {
        affectedObjectKeys.add(object.objectKey);
        continue;
      }
      if (!sameVector3(object.position, oldObject.position)) {
        dirtyReasons.push('object-position');
        affectedObjectKeys.add(object.objectKey);
      }
      if (object.generation !== oldObject.generation) {
        dirtyReasons.push('generation');
        affectedObjectKeys.add(object.objectKey);
      }
    }
    if (
      dirtyReasons.includes('world') ||
      dirtyReasons.includes('probe-fact') ||
      dirtyReasons.includes('sky')
    )
      for (const object of input.objects) affectedObjectKeys.add(object.objectKey);
    const uniqueDirtyReasons = [...new Set(dirtyReasons)];
    if (previous !== undefined && uniqueDirtyReasons.length === 0) {
      return {
        records: [...this.records.values()],
        contributors: [],
        activeContributorCount: this.lastActiveContributorCount,
        admittedProbeCount: this.lastAdmittedProbeCount,
        coverage: this.lastCoverage,
        skyResidualFraction: 1 - this.lastCoverage,
        dirtyReasons: [],
        affectedObjectKeys: [],
        visits: 0,
        allocations: 0,
        uploads: 0,
        receipt: this.lastReceipt,
        ...(this.lastError === undefined ? {} : { error: this.lastError }),
      };
    }
    const nextRecords = new Map(this.records);
    const currentObjectKeys = new Set(input.objects.map((object) => object.objectKey));
    for (const objectKey of nextRecords.keys()) {
      if (!currentObjectKeys.has(objectKey)) {
        nextRecords.delete(objectKey);
        this.recordFacts.delete(objectKey);
      }
    }
    let firstTerms: readonly ProbeBlendTerm[] = [];
    let firstReceipt = emptyReceipt(PROBE_R_MIN);
    let firstError: ProbeAdmissionError | undefined;
    let firstActiveCount = 0;
    let firstAdmittedCount = 0;
    let firstCoverage = 0;
    let firstObjectSeen = false;
    let visited = 0;
    for (const object of input.objects) {
      if (!affectedObjectKeys.has(object.objectKey)) continue;
      visited += 1;
      const candidates = input.probes.map((probe) => ({
        identity: probe.identity,
        admitted: probe.admitted,
        distance: vectorDistance(object.position, probe.position),
        radius: probe.radius,
        irradiance: probe.irradiance,
      }));
      const admission = admitProbeContributors(candidates);
      if (!firstObjectSeen) {
        firstObjectSeen = true;
        firstActiveCount = admission.active.length;
        firstAdmittedCount = admission.admitted.length;
        firstReceipt = admission.receipt;
      }
      const previousRecord = this.records.get(object.objectKey);
      const lastKnownGood = input.lastKnownGood ?? previousRecord?.lastKnownGood ?? false;
      let record: ProbeBlendRecord;
      if (admission.error !== undefined) firstError ??= admission.error;
      if (admission.admitted.length === 0) {
        if (input.probes.length === 0 && input.retainSkyResidualRecords !== true) {
          nextRecords.delete(object.objectKey);
          this.recordFacts.delete(object.objectKey);
          continue;
        }
        const sentinel: ProbeBlendRecordSentinel = lastKnownGood ? 'no-active' : 'no-lkg';
        record = encodeProbeRecord(
          object.objectKey,
          object.generation,
          0,
          new Array(27).fill(0),
          true,
          false,
          lastKnownGood,
          sentinel,
        );
        this.recordFacts.set(object.objectKey, {
          contributors: [],
          qHatSum: 0,
          rStar: PROBE_R_MIN,
          fallbackReason: admission.error?.code ?? sentinel,
        });
      } else {
        const blend = blendProbeCoefficients(admission.admitted, PROBE_R_MIN);
        if (blend === undefined) {
          firstError ??= {
            code: 'invalid-admitted-prefix',
            activeCount: admission.active.length,
            capacity: PROBE_MAX_CONTRIBUTORS,
            receipt: admission.receipt,
          };
          firstReceipt = admission.receipt;
          continue;
        }
        record = encodeProbeRecord(
          object.objectKey,
          object.generation,
          blend.C,
          blend.SHPreblend,
          true,
          true,
          true,
          undefined,
        );
        this.recordFacts.set(object.objectKey, {
          contributors: blend.terms,
          qHatSum: blend.Q,
          rStar: blend.rStar,
          fallbackReason:
            admission.error === undefined ? undefined : 'capacity-exceeded-stable-prefix',
        });
        if (firstTerms.length === 0) firstTerms = blend.terms;
        firstCoverage = blend.C;
      }
      nextRecords.set(object.objectKey, record);
      firstError ??= admission.error;
    }
    const allocations = previous === undefined ? nextRecords.size : 0;
    const resultRecords = Object.freeze([...nextRecords.values()]);
    const result = {
      records: resultRecords,
      contributors: firstTerms,
      activeContributorCount: firstActiveCount,
      admittedProbeCount: firstAdmittedCount,
      coverage: firstCoverage,
      skyResidualFraction: 1 - firstCoverage,
      dirtyReasons: uniqueDirtyReasons,
      affectedObjectKeys: [...affectedObjectKeys].sort((left, right) => left - right),
      visits: visited,
      allocations,
      uploads: nextRecords.size,
      receipt: firstReceipt,
      ...(firstError === undefined ? {} : { error: firstError }),
    };
    const projectedRecords = Object.freeze(
      [...nextRecords].map(([objectKey, record]) => Object.freeze({ cacheKey: objectKey, record })),
    );
    const dirtyRecords = Object.freeze(
      projectedRecords.filter(({ record }) => affectedObjectKeys.has(record.objectKey)),
    );
    const removedCacheKeys = Object.freeze(
      [...this.records.keys()].filter((objectKey) => !nextRecords.has(objectKey)),
    );
    const capacity = projectedRecords.reduce(
      (value, { record }) => Math.max(value, record.objectKey + 2),
      1,
    );
    this.previous = input;
    this.records = nextRecords;
    this.resultRecords = resultRecords;
    const baseRevision = this.bufferProjection.revision;
    this.bufferProjection = Object.freeze({
      sourceIdentity: this.bufferProjectionSource,
      revision: baseRevision + 1,
      baseRevision,
      capacity,
      records: projectedRecords,
      dirtyRecords,
      removedCacheKeys,
    });
    this.lastError = firstError;
    this.lastReceipt = firstReceipt;
    this.lastActiveContributorCount = firstActiveCount;
    this.lastAdmittedProbeCount = firstAdmittedCount;
    this.lastCoverage = firstCoverage;
    this.lastFinite = this.resultRecords.every(
      (record) => record.bytes.length === PROBE_BLEND_RECORD_BYTE_SIZE,
    );
    this.lastSky =
      input.sky ??
      (input.skyIrradiance === undefined
        ? { available: false, irradiance: [0, 0, 0] as const, fallbackReason: 'no-skylight' }
        : { available: true, irradiance: input.skyIrradiance });
    this.lastDirtyVisitCount = visited;
    this.lastDirtyReasons = uniqueDirtyReasons;
    return result;
  }
}
