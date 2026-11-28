import { R_MIN } from '@forgeax/engine-types';
import type { ProbeBlendInspection } from '../inspection-types';
import { at, nodes, put, remove } from './frame-tree';
import { TreeFrame } from './frame-tree-list';
import {
  PROBE_BLEND_RECORD_BYTE_SIZE,
  PROBE_BLEND_RECORD_CAPACITY,
  type ProbeBlendRecord,
  type ProbeBlendRecordSentinel,
} from './probe-blend-record';
import { ProbeInfluences } from './probe-influences';
import { captureProbeObjects, type ProbeObjects, probeObjectChanges } from './probe-object-changes';

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
  /** Number of live rows, available without materializing a full upload. */
  readonly recordCount?: number;
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
  readonly objects: ProbeObjects;
  readonly probes: readonly ProbeSceneProbeInput[];
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
    capacity: PROBE_BLEND_RECORD_CAPACITY,
    scaleRadius: radiusMinimum,
    finite: true,
  };
}

/** Admission is the only owner allowed to order and bound probe candidates. */
export function admitProbeContributors(
  candidates: readonly ProbeBlendContributor[],
  radiusMinimum = R_MIN,
): ProbeAdmissionResult {
  const active = candidates.filter((candidate) => contributorIsActive(candidate, radiusMinimum));
  active.sort((left, right) => left.identity.localeCompare(right.identity));
  return describeActiveProbes(active, radiusMinimum);
}

function describeActiveProbes(
  stableActive: readonly ProbeBlendContributor[],
  radiusMinimum: number,
): ProbeAdmissionResult {
  const overflowed = stableActive.length > PROBE_BLEND_RECORD_CAPACITY;
  const admitted = overflowed ? stableActive.slice(0, PROBE_BLEND_RECORD_CAPACITY) : stableActive;
  const rejected = overflowed ? stableActive.slice(PROBE_BLEND_RECORD_CAPACITY) : [];
  const scaleRadius = stableActive.reduce(
    (minimum, candidate) => Math.min(minimum, candidate.radius),
    stableActive[0]?.radius ?? radiusMinimum,
  );
  const activeIdentities = Object.freeze(stableActive.map((candidate) => candidate.identity));
  const admittedIdentities = overflowed
    ? Object.freeze(activeIdentities.slice(0, PROBE_BLEND_RECORD_CAPACITY))
    : activeIdentities;
  const receipt: ProbeAdmissionReceipt = {
    activeIdentities,
    admittedIdentities,
    rejectedIdentities: overflowed ? activeIdentities.slice(PROBE_BLEND_RECORD_CAPACITY) : [],
    stableOrder: admittedIdentities,
    capacity: PROBE_BLEND_RECORD_CAPACITY,
    ...(overflowed ? { overflowReason: 'active-count-exceeds-capacity' as const } : {}),
    scaleRadius,
    finite: true,
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
            activeCount: stableActive.length,
            capacity: PROBE_BLEND_RECORD_CAPACITY,
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
    error: { code, activeCount: 0, capacity: PROBE_BLEND_RECORD_CAPACITY, receipt },
  };
}

/** Neumaier compensated sum in JavaScript's IEEE-754 binary64 number type. */
export function neumaierSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += additionError(sum, next, value);
    sum = next;
  }
  return sum + correction;
}

function additionError(sum: number, next: number, value: number): number {
  return Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
}

/** Round a finite analytic value at the single f32 boundary. */
export function roundProbeToF32(value: number): number | undefined {
  return Number.isFinite(value) ? Math.fround(value) : undefined;
}

export function scaledProbeWeight(
  distance: number,
  radius: number,
  radiusMinimum = R_MIN,
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

/** The input has already passed the admission boundary. Accumulate each SH channel
 * directly from the ordered coefficients, retaining binary64 compensation until packing. */
function blendProbeCoefficients(
  contributors: readonly ProbeBlendContributor[],
  radiusMinimum: number,
) {
  let rStar = contributors[0]?.radius ?? radiusMinimum;
  for (const contributor of contributors) rStar = Math.min(rStar, contributor.radius);
  const terms: (ProbeBlendTerm & { alpha: number })[] = [];
  let sum = 0;
  let correction = 0;
  let product = 1;
  for (const contributor of contributors) {
    const { distance, radius } = contributor;
    const ratio = distance / radius;
    const coverage = 1 - ratio * ratio;
    const radiusRatio = rStar / radius;
    const scaledQ = coverage * radiusRatio * radiusRatio;
    if (!Number.isFinite(scaledQ)) return undefined;
    const next = sum + scaledQ;
    correction += additionError(sum, next, scaledQ);
    sum = next;
    product *= 1 - coverage;
    terms.push({
      identity: contributor.identity,
      distance,
      radius,
      coverage,
      q: coverage / (radius * radius),
      scaledQ,
      qHat: scaledQ,
      alpha: 0,
    });
  }
  const Q = sum + correction;
  const C = 1 - product;
  const S = 1 - C;
  for (const term of terms) term.alpha = Q > 0 ? term.scaledQ / Q : 0;
  const SHPreblend = new Array<number>(27);
  let finite = Number.isFinite(Q) && Number.isFinite(C) && Number.isFinite(S);
  for (let channel = 0; channel < SHPreblend.length; channel++) {
    let channelSum = 0;
    let channelCorrection = 0;
    for (let i = 0; i < terms.length; i++) {
      const value =
        ((contributors[i] as ProbeBlendContributor).irradiance[channel] as number) *
        (terms[i] as ProbeBlendTerm).alpha;
      const next = channelSum + value;
      channelCorrection += additionError(channelSum, next, value);
      channelSum = next;
    }
    const coefficient = (channelSum + channelCorrection) * C;
    SHPreblend[channel] = coefficient;
    finite &&= Number.isFinite(coefficient);
  }
  return { terms, rStar, Q, C, S, SHPreblend, finite, scaledQLogOffset: 0 };
}

/** With no overflow the active, admitted and stable orders are the same immutable sequence. */
function blendedReceipt(
  terms: readonly ProbeBlendTerm[],
  scaleRadius: number,
  finite: boolean,
): ProbeAdmissionReceipt {
  const identities = Object.freeze(terms.map((term) => term.identity));
  return {
    activeIdentities: identities,
    admittedIdentities: identities,
    rejectedIdentities: [],
    stableOrder: identities,
    capacity: PROBE_BLEND_RECORD_CAPACITY,
    scaleRadius,
    finite,
  };
}

/**
 * Evaluate the CPU analytic oracle. Sky is deliberately an explicit residual
 * input and never becomes a contributor or a q/Q term.
 */
export function blendLightProbes(input: ProbeBlendInput): ProbeBlendResult {
  const radiusMinimum = input.radiusMinimum ?? R_MIN;
  const normal = input.normal;
  const sky = input.skyIrradiance;
  if (
    !finiteVector(normal, 3) ||
    !finiteVector(sky, 3) ||
    input.contributors.length > PROBE_BLEND_RECORD_CAPACITY ||
    input.contributors.some((contributor) => !contributorIsActive(contributor, radiusMinimum))
  ) {
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
    receipt: blendedReceipt(coefficients.terms, coefficients.rStar, coefficients.finite),
    skyIrradiance: [sky[0], sky[1], sky[2]],
    diffuse,
    finite: coefficients.finite && diffuse.every(Number.isFinite),
  };
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

type ProbeUploadRow = ProbeBlendBufferProjection['records'][number];

interface ProbeReceiver {
  readonly upload: ProbeUploadRow;
  readonly contributors: readonly ProbeBlendTerm[];
  readonly qHatSum: number;
  readonly rStar: number;
  readonly coverage: number;
  readonly fallbackReason?: string | undefined;
  readonly error?: ProbeAdmissionError | undefined;
}

const noTerms: readonly ProbeBlendTerm[] = Object.freeze([]);
const zeroSh: readonly number[] = Object.freeze(new Array<number>(27).fill(0));

/** Slot order chooses the representative receiver; tree weight locates the first current error.
 * Each issued frame owns both its GPU rows and the facts that explain them. */
class ProbeRecordFrame extends TreeFrame<ProbeReceiver> {
  private uploaded?: readonly ProbeUploadRow[];
  private valuesBySlot?: readonly ProbeBlendRecord[];
  private observedReceipt?: ProbeAdmissionReceipt;

  get receipt(): ProbeAdmissionReceipt {
    if (this.observedReceipt !== undefined) return this.observedReceipt;
    const first = this.at(0);
    this.observedReceipt =
      first?.error?.receipt ??
      blendedReceipt(first?.contributors ?? noTerms, first?.rStar ?? R_MIN, true);
    return this.observedReceipt;
  }

  get error(): ProbeAdmissionError | undefined {
    return this.weight === 0 ? undefined : at(this.root, 0)?.node.value.error;
  }

  get uploadRows(): readonly ProbeUploadRow[] {
    this.uploaded ??= Object.freeze(Array.from(nodes(this.root), (node) => node.value.upload));
    return this.uploaded;
  }

  get records(): readonly ProbeBlendRecord[] {
    this.valuesBySlot ??= Object.freeze(
      Array.from(nodes(this.root), (node) => node.value.upload.record),
    );
    return this.valuesBySlot;
  }
}

export function projectedProbeCount(projection: ProbeBlendBufferProjection | undefined): number {
  return projection?.recordCount ?? projection?.records.length ?? 0;
}

/** Renderer-owned bounded projection; admission is explicit and fail-closed. */
export class ProbeBlendSceneProjection {
  private previous?: ProbeSceneProjectionInput;
  private readonly receiverTranslations = new Float32Array(6);
  private records = new ProbeRecordFrame();
  private influences?: ProbeInfluences | undefined;
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
  getRecord(objectKey: number): ProbeBlendRecord | undefined {
    return this.records.get(0, objectKey)?.upload.record;
  }

  captureRecordLookup(): (objectKey: number) => ProbeBlendRecord | undefined {
    const records = this.records;
    return (objectKey) => records.get(0, objectKey)?.upload.record;
  }

  hasRecords(): boolean {
    return this.records.length > 0;
  }

  hasLocalInputs(): boolean {
    return (this.previous?.probes.length ?? 0) > 0;
  }

  /** Stable upload projection; rebuilt only when probe/object facts change. */
  recordBufferProjection(): ProbeBlendBufferProjection {
    return this.bufferProjection;
  }

  inspect(): ProbeBlendInspection {
    const frame = this.records;
    const receipt = frame.receipt;
    const coverage = frame.at(0)?.coverage ?? 0;
    return {
      activeContributorCount: receipt.activeIdentities.length,
      admittedProbeCount: receipt.admittedIdentities.length,
      coverage,
      skyResidualFraction: 1 - coverage,
      finite: frame.records.every((record) => record.bytes.length === PROBE_BLEND_RECORD_BYTE_SIZE),
      errorCode: frame.error?.code,
      records: Array.from(nodes(frame.root), ({ value: facts }) => {
        const record = facts.upload.record;
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
          contributors: facts.contributors.map((term) => ({
            identity: term.identity,
            distance: term.distance,
            radius: term.radius,
            coverage: term.coverage,
            q: term.q,
            qHat: term.qHat,
            alpha: term.alpha,
          })),
          qHatSum: facts.qHatSum,
          rStar: facts.rStar,
          fallbackReason: facts.fallbackReason,
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
        activeIdentities: [...receipt.activeIdentities],
        admittedIdentities: [...receipt.admittedIdentities],
        rejectedIdentities: [...receipt.rejectedIdentities],
        stableOrder: [...receipt.stableOrder],
        capacity: receipt.capacity,
        scaleRadius: receipt.scaleRadius,
        finite: receipt.finite,
        overflowReason: receipt.overflowReason,
      },
    };
  }

  apply(input: ProbeSceneProjectionInput): ProbeSceneProjectionResult {
    const reasons = new Set<ProbeSceneDirtyReason>();
    const previous = this.previous;
    const probeFactsChanged =
      previous === undefined || !sameProbeFacts(input.probes, previous.probes);
    const skyChanged = previous === undefined || !sameSkyFacts(input, previous);
    if (previous !== undefined) {
      if (
        input.worldRevision !== previous.worldRevision ||
        input.lastKnownGood !== previous.lastKnownGood
      )
        reasons.add('world');
      if (probeFactsChanged) reasons.add('probe-fact');
      if (skyChanged) reasons.add('sky');
    }
    const objects = captureProbeObjects(input.objects, previous?.objects);
    const accepted: ProbeSceneProjectionInput = {
      ...input,
      objects,
      probes: probeFactsChanged
        ? input.probes.map((probe) => ({
            ...probe,
            position: [...probe.position] as const,
            irradiance: Array.from(probe.irradiance),
          }))
        : previous.probes,
      ...(input.sky === undefined
        ? {}
        : {
            sky: skyChanged
              ? { ...input.sky, irradiance: [...input.sky.irradiance] as const }
              : previous.sky,
          }),
      ...(input.skyIrradiance === undefined
        ? {}
        : {
            skyIrradiance: skyChanged
              ? ([...input.skyIrradiance] as const)
              : previous.skyIrradiance,
          }),
    };
    const { affected, removed } = probeObjectChanges(
      objects,
      previous?.objects,
      reasons.size !== 0,
      reasons,
      this.receiverTranslations,
    );
    const uniqueDirtyReasons = [...reasons];
    if (probeFactsChanged)
      this.influences =
        accepted.probes.length === 0 ? undefined : new ProbeInfluences(accepted.probes);
    const influences = this.influences;
    let root = this.records.root;
    const dirtyRecords: ProbeUploadRow[] = [];
    const removedCacheKeys: number[] = [];
    const retire = (key: number): void => {
      if (this.records.get(0, key) === undefined) return;
      root = remove(root, 0, key);
      removedCacheKeys.push(key);
    };
    for (const key of removed) retire(key);
    for (const object of affected.values()) {
      if (influences === undefined) {
        retire(object.objectKey);
        continue;
      }
      const active = influences.at(object.position);
      const overflow =
        active.length > PROBE_BLEND_RECORD_CAPACITY
          ? describeActiveProbes(active, R_MIN)
          : undefined;
      const admitted = overflow?.admitted ?? active;
      const blend = admitted.length === 0 ? undefined : blendProbeCoefficients(admitted, R_MIN);
      // Valid finite positive radii bound rStar / radius to [0, 1].
      // Only the public numerical oracle accepts unadmitted inputs.
      const lastKnownGood =
        input.lastKnownGood ?? this.getRecord(object.objectKey)?.lastKnownGood ?? false;
      const sentinel = blend !== undefined ? undefined : lastKnownGood ? 'no-active' : 'no-lkg';
      const record = encodeProbeRecord(
        object.objectKey,
        object.generation,
        blend?.C ?? 0,
        blend?.SHPreblend ?? zeroSh,
        true,
        blend !== undefined,
        blend !== undefined || lastKnownGood,
        sentinel,
      );
      const upload = { cacheKey: object.objectKey, record };
      const receiver: ProbeReceiver = {
        upload,
        contributors: blend?.terms ?? noTerms,
        qHatSum: blend?.Q ?? 0,
        rStar: blend?.rStar ?? R_MIN,
        coverage: blend?.C ?? 0,
        fallbackReason: overflow === undefined ? sentinel : 'capacity-exceeded-stable-prefix',
        error: overflow?.error,
      };
      root = put(root, receiver, 0, object.objectKey, receiver.error === undefined ? 0 : 1);
      dirtyRecords.push(upload);
    }
    const frame = root === this.records.root ? this.records : new ProbeRecordFrame(root);
    const representative = frame.at(0);
    const coverage = representative?.coverage ?? 0;
    const error = frame.error;
    const result: ProbeSceneProjectionResult = {
      get records() {
        return frame.records;
      },
      contributors: representative?.contributors ?? noTerms,
      activeContributorCount:
        representative?.error?.activeCount ?? representative?.contributors.length ?? 0,
      admittedProbeCount: representative?.contributors.length ?? 0,
      coverage,
      skyResidualFraction: 1 - coverage,
      dirtyReasons: uniqueDirtyReasons,
      affectedObjectKeys: [...affected.keys()].sort((left, right) => left - right),
      visits: affected.size,
      allocations: dirtyRecords.length,
      uploads: dirtyRecords.length,
      get receipt() {
        return frame.receipt;
      },
      ...(error === undefined ? {} : { error }),
    };
    this.previous = accepted;
    if (frame !== this.records) {
      this.records = frame;
      const baseRevision = this.bufferProjection.revision;
      const last = frame.at(-1);
      this.bufferProjection = Object.freeze({
        sourceIdentity: this.bufferProjectionSource,
        revision: baseRevision + 1,
        baseRevision,
        capacity: last === undefined ? 1 : last.upload.cacheKey + 2,
        recordCount: frame.length,
        get records() {
          return frame.uploadRows;
        },
        dirtyRecords: Object.freeze(dirtyRecords),
        removedCacheKeys: Object.freeze(removedCacheKeys),
      });
    }
    this.lastSky =
      accepted.sky ??
      (accepted.skyIrradiance === undefined
        ? { available: false, irradiance: [0, 0, 0] as const, fallbackReason: 'no-skylight' }
        : { available: true, irradiance: accepted.skyIrradiance });
    this.lastDirtyVisitCount = affected.size;
    this.lastDirtyReasons = uniqueDirtyReasons;
    return result;
  }
}
