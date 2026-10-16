import {
  buildRectAreaWorldFrame,
  rectAreaFacesPoint,
  DeviceScope,
  PROBE_MAX_CONTRIBUTORS,
  admitProbeContributors,
  blendLightProbes,
  createExtendedLightingState,
  createLightResourceUnavailable,
  deriveLtcResourcePlan,
  projectExtendedLightingInspection,
  promoteExtendedLightingCandidate,
  recordExtendedLightingFailure,
  scaledProbeWeight,
  type ExtendedLightingResourceCandidate,
} from '@forgeax/engine-render/internal';
import {
  LTC_TABLES,
} from '@forgeax/engine-shader';
import type { LightingReferenceKind } from './lighting-reference';
import {
  buildLightingReferenceEvidence,
  buildRecoveryLightingReferenceEvidence,
  buildSpotCombinedLightingReferenceEvidence,
} from './lighting-reference';
import {
  EXTENDED_LIGHTING_CASE_ROSTER,
  type ExtendedLightingCaseId,
  type ExtendedLightingComparisonBoundary,
  type ExtendedLightingSceneCaseId,
} from './case-roster';
import probeOracle from '../../cases/extended-lighting/probe-oracle.json' with { type: 'json' };
import {
  constantProbeSh,
  evaluateProbeReference,
  type ProbeReferenceInput,
  type ProbeReferenceObject,
} from './probe-reference';

type Vec3 = readonly [number, number, number];
type CoverageObservation = Readonly<Record<string, boolean | number | string>>;

export type ExtendedLightingComparisonKind =
  | 'three-pixel-carrier'
  | 'three-native-plus-independent-oracle'
  | 'three-reference-boundary-plus-negative-oracle';

export interface ExtendedLightingComparisonCoverageEntry {
  readonly caseId: ExtendedLightingCaseId;
  readonly required: true;
  readonly comparisonKind: ExtendedLightingComparisonKind;
  readonly referenceKinds: readonly LightingReferenceKind[];
  readonly boundary: ExtendedLightingComparisonBoundary;
  readonly evidence: readonly string[];
}

export interface ExtendedLightingSemanticCoverageResult {
  readonly caseId: Exclude<
    ExtendedLightingCaseId,
    'rect-area' | 'spot-modifiers' | 'probe' | 'recovery'
  >;
  readonly required: true;
  readonly verdict: 'passed' | 'failed';
  readonly comparisonKind: Exclude<ExtendedLightingComparisonKind, 'three-pixel-carrier'>;
  readonly referenceKinds: readonly LightingReferenceKind[];
  readonly observations: CoverageObservation;
}

const sky: Vec3 = [0.2, 0.4, 0.6];
const normal: Vec3 = [0, 0, 1];

const redProbe: ProbeReferenceInput = {
  identity: 'red',
  position: [0, 0, 0],
  radius: 2,
  irradiance: constantProbeSh([2, 0, 0]),
};

const blueProbe: ProbeReferenceInput = {
  identity: 'blue',
  position: [1, 0, 0],
  radius: 4,
  irradiance: constantProbeSh([0, 0, 2]),
};

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function maxAbsDelta(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

function productProbeInput(
  object: ProbeReferenceObject,
  probes: readonly ProbeReferenceInput[],
) {
  return probes.map((probe) => ({
    identity: probe.identity,
    admitted: true,
    distance: distance(object.position, probe.position),
    radius: probe.radius,
    irradiance: probe.irradiance,
  }));
}

function probeComparison(
  object: ProbeReferenceObject,
  probes: readonly ProbeReferenceInput[],
): { readonly reference: ReturnType<typeof evaluateProbeReference>; readonly product: ReturnType<typeof blendLightProbes>; readonly maxDelta: number } {
  const reference = evaluateProbeReference(object, probes);
  const admission = admitProbeContributors(productProbeInput(object, probes));
  const product = blendLightProbes({
    normal: object.normal,
    skyIrradiance: object.skyIrradiance,
    contributors: admission.admitted,
  });
  const maxDelta = Math.max(
    Math.abs(reference.Q - product.Q),
    Math.abs(reference.C - product.C),
    Math.abs(reference.S - product.S),
    maxAbsDelta(reference.SH_preblend, product.SHPreblend),
    maxAbsDelta(reference.diffuse, product.diffuse),
  );
  return { reference, product, maxDelta };
}

function evaluateProbeOracleCoverage(): ExtendedLightingSemanticCoverageResult {
  const boundaryObject: ProbeReferenceObject = {
    objectKey: 'boundary',
    position: [2, 0, 0],
    normal,
    skyIrradiance: sky,
  };
  const boundary = probeComparison(boundaryObject, [redProbe]);
  const center = scaledProbeWeight(0, 1);
  const interior = scaledProbeWeight(0.5, 1);
  const peak = scaledProbeWeight(1, Math.sqrt(2));

  const blendObject: ProbeReferenceObject = {
    objectKey: 'blend',
    position: [0.5, 0, 0],
    normal,
    skyIrradiance: sky,
  };
  const blend = probeComparison(blendObject, [blueProbe, redProbe]);
  const scaled = probeComparison(
    {
      ...blendObject,
      objectKey: 'blend-scaled',
      position: [50, 0, 0],
    },
    [
      { ...blueProbe, position: [100, 0, 0], radius: 400 },
      { ...redProbe, radius: 200 },
    ],
  );
  const skyOnly = blendLightProbes({ normal, skyIrradiance: sky, contributors: [] });
  const overflow = admitProbeContributors(
    Array.from({ length: PROBE_MAX_CONTRIBUTORS + 1 }, (_, index) => ({
      identity: `overflow-${index}`,
      admitted: true,
      distance: 0,
      radius: 1,
      irradiance: constantProbeSh([1, 1, 1]),
    })),
  );

  const propertyVerdicts: Record<string, boolean> = {
    'strict-boundary':
      boundary.reference.terms[0]?.active === false &&
      boundary.product.terms.length === 0 &&
      boundary.product.Q === 0 &&
      boundary.product.C === 0 &&
      boundary.product.S === 1,
    'c0-non-c1': center.coverage === 1 && interior.coverage === 0.75 && scaledProbeWeight(1, 1).coverage === 0,
    'fixed-distance-radius-sqrt2-peak':
      Math.abs(peak.coverage - 0.5) <= 1e-12 && Math.abs(peak.q - 0.25) <= 1e-12,
    'common-scale-invariance':
      scaled.maxDelta <= probeOracle.epsilon &&
      Math.abs(scaled.reference.C - blend.reference.C) <= probeOracle.epsilon &&
      Math.abs(scaled.product.C - blend.product.C) <= probeOracle.epsilon,
    'sky-not-contributor':
      skyOnly.terms.length === 0 &&
      skyOnly.Q === 0 &&
      skyOnly.C === 0 &&
      skyOnly.S === 1 &&
      skyOnly.diffuse.every((value, index) => value === (sky[index] ?? 0)),
    'no-nearest-no-top-k-no-smoothstep':
      blend.product.terms.length === 2 &&
      blend.product.terms.every((term) => term.alpha > 0) &&
      overflow.error?.code === 'capacity-exceeded' &&
      overflow.admitted.length === 0 &&
      Math.abs(interior.coverage - 0.75) <= 1e-12,
  };
  const propertiesPassed = probeOracle.properties.filter((property) => propertyVerdicts[property]).length;
  const unknownProperties = probeOracle.properties.filter((property) => propertyVerdicts[property] === undefined);

  return {
    caseId: 'probe-oracle',
    required: true,
    verdict:
      propertiesPassed === probeOracle.properties.length &&
      unknownProperties.length === 0 &&
      blend.maxDelta <= probeOracle.epsilon
        ? 'passed'
        : 'failed',
    comparisonKind: 'three-native-plus-independent-oracle',
    referenceKinds: [buildLightingReferenceEvidence('probe', true).referenceKind],
    observations: {
      properties: probeOracle.properties.length,
      propertiesPassed,
      unknownProperties: unknownProperties.length,
      propertyFailures: probeOracle.properties.filter((property) => !propertyVerdicts[property]).join(','),
      blendMaxDelta: blend.maxDelta,
      boundarySkyResidual: boundary.product.S,
      skyOnlyQ: skyOnly.Q,
      overflowActiveCount: overflow.active.length,
    },
  };
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function evaluateRectReversedFrontCoverage(): ExtendedLightingSemanticCoverageResult {
  const axisX: Vec3 = [1, 0, 0];
  const axisY: Vec3 = [0, 1, 0];
  const reversedAxisY: Vec3 = [0, -1, 0];
  const frontPoint: Vec3 = [0, 0, 1];
  const canonicalNormal = cross(axisX, axisY);
  const reversedNormal = cross(axisX, reversedAxisY);
  const canonical = buildRectAreaWorldFrame({ center: [0, 0, 0], axisX, axisY, width: 4, height: 2 });
  const reversed = buildRectAreaWorldFrame({
    center: [0, 0, 0],
    axisX,
    axisY: reversedAxisY,
    width: 4,
    height: 2,
  });
  const independentCanonical = dot(canonicalNormal, frontPoint) > 0;
  const independentReversed = dot(reversedNormal, frontPoint) > 0;
  const productCanonical = rectAreaFacesPoint(canonical, frontPoint);
  const productReversed = rectAreaFacesPoint(reversed, frontPoint);
  return {
    caseId: 'rect-area-reversed-front',
    required: true,
    verdict:
      independentCanonical &&
      !independentReversed &&
      productCanonical === independentCanonical &&
      productReversed === independentReversed
        ? 'passed'
        : 'failed',
    comparisonKind: 'three-reference-boundary-plus-negative-oracle',
    referenceKinds: [buildLightingReferenceEvidence('rect', true).referenceKind],
    observations: {
      independentCanonicalFront: independentCanonical,
      independentReversedFront: independentReversed,
      productCanonicalFront: productCanonical,
      productReversedFront: productReversed,
    },
  };
}

function evaluateRectZeroLtcCoverage(): ExtendedLightingSemanticCoverageResult {
  const scope = DeviceScope.create(1, 'rect-area-zero-ltc');
  const admitted = deriveLtcResourcePlan({ scope, ltcAvailable: true });
  const zeroTables = deriveLtcResourcePlan({ scope, ltcAvailable: false });
  const tablesAreNonZero =
    Array.from(LTC_TABLES.lambert).some((value) => value !== 0) &&
    Array.from(LTC_TABLES.ggx).some((value) => value !== 0);
  return {
    caseId: 'rect-area-zero-ltc',
    required: true,
    verdict:
      tablesAreNonZero &&
      admitted.rectAdmission === 'admitted' &&
      admitted.tableCount === 2 &&
      admitted.uploadCount === 2 &&
      zeroTables.rectAdmission === 'omitted' &&
      zeroTables.tableCount === 0 &&
      zeroTables.uploadCount === 0
        ? 'passed'
        : 'failed',
    comparisonKind: 'three-reference-boundary-plus-negative-oracle',
    referenceKinds: [buildLightingReferenceEvidence('rect', true).referenceKind],
    observations: {
      tablesAreNonZero,
      admittedTableCount: admitted.tableCount,
      zeroTableCount: zeroTables.tableCount,
      zeroRectAdmission: zeroTables.rectAdmission,
      zeroUploadCount: zeroTables.uploadCount,
    },
  };
}

function evaluateProbeSkyContributorCoverage(): ExtendedLightingSemanticCoverageResult {
  const object: ProbeReferenceObject = {
    objectKey: 'sky-contributor',
    position: [0.5, 0, 0],
    normal,
    skyIrradiance: sky,
  };
  const correct = probeComparison(object, [redProbe, blueProbe]);
  const skyAsProbe: ProbeReferenceInput = {
    identity: 'sky',
    position: object.position,
    radius: 100,
    irradiance: constantProbeSh(sky),
  };
  const incorrect = blendLightProbes({
    normal,
    skyIrradiance: sky,
    contributors: productProbeInput(object, [redProbe, blueProbe, skyAsProbe]),
  });
  const receipt = admitProbeContributors(productProbeInput(object, [redProbe, blueProbe]));
  const correctHasSky = correct.product.terms.some((term) => term.identity === 'sky');
  const incorrectChangesQ = Math.abs(incorrect.Q - correct.product.Q) > 1e-9;
  return {
    caseId: 'probe-sky-contributor',
    required: true,
    verdict:
      !correctHasSky &&
      !receipt.receipt.admittedIdentities.includes('sky') &&
      incorrectChangesQ &&
      correct.maxDelta <= probeOracle.epsilon
        ? 'passed'
        : 'failed',
    comparisonKind: 'three-reference-boundary-plus-negative-oracle',
    referenceKinds: [buildLightingReferenceEvidence('probe', true).referenceKind],
    observations: {
      correctHasSky,
      admittedSky: receipt.receipt.admittedIdentities.includes('sky'),
      correctQ: correct.product.Q,
      incorrectQ: incorrect.Q,
      incorrectChangesQ,
      correctMaxDelta: correct.maxDelta,
    },
  };
}

function recoveryCandidate(scope: DeviceScope, generation: number): ExtendedLightingResourceCandidate {
  return {
    topology: 'extendedLighting',
    generation,
    scope,
    iesSliceCount: 1,
    cookieSliceCount: 1,
    cookieMatrices: 1,
    sampler: undefined as never,
    iesTexture: undefined,
    cookieTexture: undefined,
    cookieMatrixBuffer: undefined,
    descriptorBytes: 128,
    uploadCount: 1,
  };
}

function evaluateRecoveryStaleGenerationCoverage(): ExtendedLightingSemanticCoverageResult {
  const oldScope = DeviceScope.create(1, 'recovery-stale-generation');
  const recoveredScope = DeviceScope.create(2, 'recovery-stale-generation');
  const staleRef = oldScope.ref('texture', { identity: 'old-generation' });
  const state = promoteExtendedLightingCandidate(
    createExtendedLightingState(oldScope.generation),
    recoveryCandidate(oldScope, oldScope.generation),
  );
  const failure = createLightResourceUnavailable({
    entity: 3,
    feature: 'cookie',
    generation: recoveredScope.generation,
    sourceKey: 'parity/extended-lighting/recovery',
    reason: 'format',
    expected: 'rgba8unorm',
    actual: 'rgba16float',
    hint: 'retry the same source after renderer recovery',
  });
  const degraded = recordExtendedLightingFailure(state, failure);
  const inspection = projectExtendedLightingInspection(degraded);
  const staleRejected = staleRef.isStale(recoveredScope) && !recoveredScope.accepts(staleRef);
  const lkgRetained =
    inspection.accepted === 'extendedLighting:generation-1' &&
    inspection.lastKnownGood === 'extendedLighting:generation-1';
  return {
    caseId: 'recovery-stale-generation',
    required: true,
    verdict: staleRejected && lkgRetained && inspection.failure === 'light-resource-unavailable' ? 'passed' : 'failed',
    comparisonKind: 'three-reference-boundary-plus-negative-oracle',
    referenceKinds: [buildRecoveryLightingReferenceEvidence(true).referenceKind],
    observations: {
      staleRejected,
      staleGeneration: staleRef.generation,
      currentGeneration: recoveredScope.generation,
      accepted: inspection.accepted ?? 'none',
      lastKnownGood: inspection.lastKnownGood ?? 'none',
      lkgRetained,
      failure: inspection.failure ?? 'none',
    },
  };
}

export function evaluateExtendedLightingSemanticCoverage(): readonly ExtendedLightingSemanticCoverageResult[] {
  return [
    evaluateProbeOracleCoverage(),
    evaluateRectReversedFrontCoverage(),
    evaluateRectZeroLtcCoverage(),
    evaluateProbeSkyContributorCoverage(),
    evaluateRecoveryStaleGenerationCoverage(),
  ];
}

function sceneReferenceKind(caseId: ExtendedLightingSceneCaseId): LightingReferenceKind {
  switch (caseId) {
    case 'rect-area':
      return buildLightingReferenceEvidence('rect', true).referenceKind;
    case 'spot-modifiers':
      return buildSpotCombinedLightingReferenceEvidence(true).referenceKind;
    case 'probe':
      return buildLightingReferenceEvidence('probe', true).referenceKind;
    case 'recovery':
      return buildRecoveryLightingReferenceEvidence(true).referenceKind;
  }
}

function rosterEntry(caseId: ExtendedLightingCaseId) {
  const entry = EXTENDED_LIGHTING_CASE_ROSTER.find((candidate) => candidate.caseId === caseId);
  if (entry === undefined) throw new Error(`missing extended-lighting roster entry ${caseId}`);
  return entry;
}

export function buildExtendedLightingComparisonCoverage(): readonly ExtendedLightingComparisonCoverageEntry[] {
  return EXTENDED_LIGHTING_CASE_ROSTER.map((entry) => {
    if (entry.kind === 'scene') {
      return {
        caseId: entry.caseId,
        required: true,
        comparisonKind: 'three-pixel-carrier',
        referenceKinds: [sceneReferenceKind(entry.caseId)],
        boundary: entry.comparison,
        evidence: [entry.carrierSources.browser, entry.carrierSources.dawn],
      };
    }
    if (entry.kind === 'probe-oracle') {
      return {
        caseId: entry.caseId,
        required: true,
        comparisonKind: 'three-native-plus-independent-oracle',
        referenceKinds: [buildLightingReferenceEvidence('probe', true).referenceKind],
        boundary: entry.comparison,
        evidence: [
          'apps/parity/color-lighting/src/compare/__tests__/probe-reference.test.ts',
          'packages/render/src/__tests__/probe-blend-oracle.unit.test.ts',
        ],
      };
    }
    const source = rosterEntry(entry.sourceCaseId);
    return {
      caseId: entry.caseId,
      required: true,
      comparisonKind: 'three-reference-boundary-plus-negative-oracle',
      referenceKinds: [sceneReferenceKind(entry.sourceCaseId)],
      boundary: source.comparison,
      evidence: ['apps/parity/color-lighting/src/compare/__tests__/extended-case-coverage.test.ts'],
    };
  });
}
