import type { SceneCase } from '../contracts/types';
import falsificationManifest from '../../cases/extended-lighting/falsification/manifest.json' with { type: 'json' };
import probeOracle from '../../cases/extended-lighting/probe-oracle.json' with { type: 'json' };
import probe from '../../cases/extended-lighting/probe.json' with { type: 'json' };
import recovery from '../../cases/extended-lighting/recovery.json' with { type: 'json' };
import rectArea from '../../cases/extended-lighting/rect-area.json' with { type: 'json' };
import spotModifiers from '../../cases/extended-lighting/spot-modifiers.json' with { type: 'json' };

const CASE_ROOT = 'apps/parity/color-lighting/cases/extended-lighting';
const CARRIER_TEST_ROOT = `${CASE_ROOT}/__tests__`;

export type ExtendedLightingSceneCaseId = 'rect-area' | 'spot-modifiers' | 'probe' | 'recovery';
export type ExtendedLightingFalsifierId =
  | 'rect-area-reversed-front'
  | 'rect-area-zero-ltc'
  | 'probe-sky-contributor'
  | 'recovery-stale-generation';
export type ExtendedLightingCaseId = ExtendedLightingSceneCaseId | 'probe-oracle' | ExtendedLightingFalsifierId;

export interface ExtendedLightingComparisonBoundary {
  readonly threeNativeSubset: string;
  readonly independentOracleBoundary: string;
}

export interface ExtendedLightingCarrierSources {
  readonly browser: string;
  readonly dawn: string;
}

export interface ExtendedLightingSceneRosterEntry {
  readonly kind: 'scene';
  readonly caseId: ExtendedLightingSceneCaseId;
  readonly required: true;
  readonly fixturePath: string;
  readonly fixture: SceneCase;
  readonly carrierSources: ExtendedLightingCarrierSources;
  readonly comparison: ExtendedLightingComparisonBoundary;
}

export interface ExtendedLightingProbeOracleRosterEntry {
  readonly kind: 'probe-oracle';
  readonly caseId: 'probe-oracle';
  readonly required: true;
  readonly fixturePath: string;
  readonly fixture: typeof probeOracle;
  readonly comparison: ExtendedLightingComparisonBoundary;
}

interface ExtendedLightingFalsificationFixture {
  readonly caseId: ExtendedLightingFalsifierId;
  readonly sourceCaseId: ExtendedLightingSceneCaseId;
  readonly mutation: string;
  readonly expected: string;
}

export interface ExtendedLightingFalsifierRosterEntry {
  readonly kind: 'falsifier';
  readonly caseId: ExtendedLightingFalsifierId;
  readonly required: true;
  readonly fixturePath: string;
  readonly fixture: ExtendedLightingFalsificationFixture;
  readonly sourceCaseId: ExtendedLightingSceneCaseId;
  readonly mutation: string;
  readonly expected: string;
  readonly comparison: ExtendedLightingComparisonBoundary;
}

export type ExtendedLightingCaseRosterEntry =
  | ExtendedLightingSceneRosterEntry
  | ExtendedLightingProbeOracleRosterEntry
  | ExtendedLightingFalsifierRosterEntry;

const sceneEntry = (
  fixture: unknown,
  caseId: ExtendedLightingSceneCaseId,
  comparison: ExtendedLightingComparisonBoundary,
): ExtendedLightingSceneRosterEntry => ({
  kind: 'scene',
  caseId,
  required: true,
  fixturePath: `${CASE_ROOT}/${caseId}.json`,
  fixture: fixture as SceneCase,
  carrierSources: {
    browser: `${CARRIER_TEST_ROOT}/${caseId}.browser.test.ts`,
    dawn: `${CARRIER_TEST_ROOT}/${caseId}.dawn.test.ts`,
  },
  comparison,
});

const sceneEntries: readonly ExtendedLightingSceneRosterEntry[] = [
  sceneEntry(rectArea, 'rect-area', {
    threeNativeSubset: 'Three RectAreaLight native WebGL2 path',
    independentOracleBoundary: 'front-facing LTC BRDF with range and shadow isolation',
  }),
  sceneEntry(spotModifiers, 'spot-modifiers', {
    threeNativeSubset: 'Three SpotLight native IES rotational subset and SpotLight.map path',
    independentOracleBoundary: 'Type-C IES azimuth plus RGBA Cookie projection, cone, roll, and backface rules',
  }),
  sceneEntry(probe, 'probe', {
    threeNativeSubset: 'Three LightProbe native SH9 only',
    independentOracleBoundary: 'finite-volume c/q/Q/alpha/C/S interpolation with Sky diffuse residual',
  }),
  sceneEntry(recovery, 'recovery', {
    threeNativeSubset: 'Three lighting baseline only; generation and LKG recovery are ForgeaX-owned',
    independentOracleBoundary: 'candidate generation, atomic acceptance, stale rejection, and LKG observability',
  }),
];

const sceneComparisonById = new Map(sceneEntries.map((entry) => [entry.caseId, entry.comparison]));

function comparisonForScene(caseId: ExtendedLightingSceneCaseId): ExtendedLightingComparisonBoundary {
  const comparison = sceneComparisonById.get(caseId);
  if (comparison === undefined) throw new Error(`missing extended-lighting comparison boundary for ${caseId}`);
  return comparison;
}

const probeOracleEntry: ExtendedLightingProbeOracleRosterEntry = {
  kind: 'probe-oracle',
  caseId: 'probe-oracle',
  required: true,
  fixturePath: `${CASE_ROOT}/probe-oracle.json`,
  fixture: probeOracle,
  comparison: {
    threeNativeSubset: 'Three LightProbe SH9 reference only; no native local volume',
    independentOracleBoundary: 'f64 finite-support formula for active set, scaled Q, alpha, C, S, and Sky residual',
  },
};

const falsifierEntries: readonly ExtendedLightingFalsifierRosterEntry[] = falsificationManifest.cases.map((fixture) => {
  const typedFixture = fixture as ExtendedLightingFalsificationFixture;
  return {
    kind: 'falsifier',
    caseId: typedFixture.caseId,
    required: true,
    fixturePath: `${CASE_ROOT}/falsification/manifest.json`,
    fixture: typedFixture,
    sourceCaseId: typedFixture.sourceCaseId,
    mutation: typedFixture.mutation,
    expected: typedFixture.expected,
    comparison: comparisonForScene(typedFixture.sourceCaseId),
  };
});

export const EXTENDED_LIGHTING_CASE_ROSTER: readonly ExtendedLightingCaseRosterEntry[] = [
  ...sceneEntries,
  probeOracleEntry,
  ...falsifierEntries,
];

export const EXTENDED_LIGHTING_REQUIRED_CASE_IDS = EXTENDED_LIGHTING_CASE_ROSTER.map((entry) => entry.caseId);

const PLACEHOLDER_VERDICT = /\b(?:status|verdict)\s*:\s*[^,\n]*(?:['"](?:unavailable|not-run|notRun)['"])/;
const PLACEHOLDER_ASSERTION = /\btoMatch\(\s*\/\^\(not-run\|unavailable\)\$\/\s*\)/;

export function findCarrierPlaceholderVerdicts(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => PLACEHOLDER_VERDICT.test(line) || PLACEHOLDER_ASSERTION.test(line));
}
