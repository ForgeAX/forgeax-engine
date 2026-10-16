import parityPackage from '../../package.json' with { type: 'json' };
import byteDiff from '../../cases/m0/byte-diff.json' with { type: 'json' };
import invalidBudget from '../../cases/m0/invalid-budget.json' with { type: 'json' };
import missingPrimary from '../../cases/m0/missing-primary.json' with { type: 'json' };
import positiveMinimal from '../../cases/m0/positive-minimal.json' with { type: 'json' };
import sameProvenance from '../../cases/m0/same-provenance.json' with { type: 'json' };
import selfCompare from '../../cases/m0/self-compare.json' with { type: 'json' };
import alphaCase from '../../cases/material-alpha/material-alpha-blend.json' with { type: 'json' };
import alphaEqualCase from '../../cases/material-alpha/material-alpha-mask-equal.json' with { type: 'json' };
import alphaExplicitCase from '../../cases/material-alpha/material-alpha-mask-explicit.json' with { type: 'json' };
import alphaDefaultCase from '../../cases/material-alpha/material-alpha-mask-default.json' with { type: 'json' };
import alphaOneCase from '../../cases/material-alpha/material-alpha-mask-one.json' with { type: 'json' };
import alphaZeroCase from '../../cases/material-alpha/material-alpha-mask-zero.json' with { type: 'json' };
import alphaRgbaCase from '../../cases/material-alpha/material-alpha-rgba-factor.json' with { type: 'json' };
import capabilityLoss from '../../cases/ibl/capability-loss.json' with { type: 'json' };
import constantEnvironment from '../../cases/ibl/constant-environment.json' with { type: 'json' };
import directionalUrp from '../../cases/direct-light/cases/directional-urp.json' with { type: 'json' };
import khrSpotUrp from '../../cases/direct-light/cases/khr-spot-urp.json' with { type: 'json' };
import pointUrp from '../../cases/direct-light/cases/point-urp.json' with { type: 'json' };
import spotUrp from '../../cases/direct-light/cases/spot-urp.json' with { type: 'json' };
import transparentHdrp from '../../cases/transparency-post/transparent-hdr-hdrp.json' with { type: 'json' };
import transparentUrp from '../../cases/transparency-post/transparent-ldr-urp.json' with { type: 'json' };
import falsificationManifest from '../../cases/default/falsification/manifest.json' with { type: 'json' };
import { M1_REQUIRED_CASES } from '../report/m1-required';
import { TONE_REQUIRED_CASES } from '../report/tone-required';

export type ParityCaseOwner = 'm0' | 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6';
export type ParityBackendId = 'browser-webgpu' | 'dawn' | 'chromium-webgl2';

export const VERTEX_COLOR_CASE_IDS = [
  'vertex-color-vec3',
  'vertex-color-vec4',
  'vertex-color-normalized',
  'vertex-color-skinning',
  'vertex-color-mixed-primitives',
  'vertex-color-mask-taa',
  'vertex-color-no-color-baseline',
] as const;

export type VertexColorCaseId = (typeof VERTEX_COLOR_CASE_IDS)[number];
export type VertexColorColorDomain = 'linearHdr' | 'displayEncoded';

export interface VertexColorSamplePoint {
  readonly id: string;
  readonly coordinate: readonly [number, number];
}

export interface VertexColorCaseDefinition {
  readonly caseId: VertexColorCaseId;
  readonly required: true;
  readonly owner: 'm5';
  readonly requiredBackends: readonly ['browser-webgpu', 'dawn'];
  readonly frameCount: 60;
  readonly colorDomain: VertexColorColorDomain;
  readonly epsilon: { readonly rgb: 0.05; readonly alpha: 0.05 };
  readonly samplePoints: readonly VertexColorSamplePoint[];
  readonly falsifier: 'white-color' | 'no-color-baseline';
  readonly sourceFixtureHash?: string;
}

export interface RequiredCaseAuthorityEntry {
  readonly caseId: string;
  readonly required: boolean;
  readonly owner: ParityCaseOwner;
  readonly applicableBackends: readonly ParityBackendId[];
  readonly matrixRequiredBackends: readonly ParityBackendId[];
}

interface MatrixDeclaration {
  readonly requiredBackends: readonly string[];
  readonly requiredPipelines: readonly string[];
}

const matrix = (parityPackage as { parityMatrix: MatrixDeclaration }).parityMatrix;

function entry(
  caseId: string,
  required: boolean,
  owner: ParityCaseOwner,
  matrixRequiredBackends: readonly ParityBackendId[] = ['browser-webgpu'],
  applicableBackends: readonly ParityBackendId[] = matrixRequiredBackends,
): RequiredCaseAuthorityEntry {
  return { caseId, required, owner, applicableBackends, matrixRequiredBackends };
}

const chromiumFallbackSentinelCaseIds = new Set([
  'default-srgb-texture',
  'material-alpha-mask-default',
  'material-alpha-blend',
  'tone-aces-filmic-2',
  'direct-directional-urp',
  'transparent-ldr-urp',
]);

function browserBackends(caseId: string): readonly ParityBackendId[] {
  return chromiumFallbackSentinelCaseIds.has(caseId)
    ? ['browser-webgpu', 'chromium-webgl2']
    : ['browser-webgpu'];
}

const m0Cases = [
  positiveMinimal,
  selfCompare,
  sameProvenance,
  missingPrimary,
  invalidBudget,
  byteDiff,
].map((fixture) => entry(fixture.caseId, fixture.required, 'm0', []));

const m1Cases = [
  ...M1_REQUIRED_CASES.map((fixture) => {
    const backends = browserBackends(fixture.caseId);
    return entry(fixture.caseId, fixture.required, 'm1', backends, backends);
  }),
  ...falsificationManifest.cases.map((fixture) => entry(fixture.caseId, false, 'm1')),
];

const m2Cases = [
  alphaRgbaCase,
  alphaDefaultCase,
  alphaExplicitCase,
  alphaZeroCase,
  alphaOneCase,
  alphaEqualCase,
  alphaCase,
].map((fixture) => {
  const backends = browserBackends(fixture.caseId);
  return entry(fixture.caseId, true, 'm2', backends, backends);
});

const m4Cases = [
  directionalUrp,
  khrSpotUrp,
  pointUrp,
  spotUrp,
].map((fixture) => entry(fixture.caseId, true, 'm4', ['browser-webgpu', 'dawn']));

const m5Cases = [
  entry(constantEnvironment.caseId, true, 'm5', ['browser-webgpu', 'dawn']),
  entry(capabilityLoss.caseId, false, 'm5'),
];

const vertexColorCases: readonly VertexColorCaseDefinition[] = [
  {
    caseId: 'vertex-color-vec3', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'displayEncoded', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'triangle-centroid', coordinate: [0.5, 0.5] }, { id: 'vertex-a', coordinate: [0.25, 0.25] }],
    falsifier: 'white-color',
    sourceFixtureHash: '5e5ebc820d7db4904d11604c0ba00961ec4b1542bd4937d826eb781ed115c140',
  },
  {
    caseId: 'vertex-color-vec4', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'linearHdr', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'triangle-centroid', coordinate: [0.5, 0.5] }, { id: 'edge-midpoint', coordinate: [0.75, 0.5] }],
    falsifier: 'white-color',
    sourceFixtureHash: '15346d8eb1851a56dcacbb7f7bae1895fc99421626f759c26e1569426baca90e',
  },
  {
    caseId: 'vertex-color-normalized', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'linearHdr', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'normalized-endpoint', coordinate: [0.25, 0.25] }, { id: 'normalized-midpoint', coordinate: [0.5, 0.5] }],
    falsifier: 'white-color',
    sourceFixtureHash: '2433512dbe375b939ba3417223b3c49b27fdccf7eee26a1bb96f22064278eeaa',
  },
  {
    caseId: 'vertex-color-skinning', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'displayEncoded', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'pre-joint-centroid', coordinate: [0.5, 0.5] }, { id: 'post-joint-centroid', coordinate: [0.5, 0.5] }],
    falsifier: 'white-color',
    sourceFixtureHash: '85d79f2bf1408d9404c5077554a019c14e0ab6b68cb33093c34d096657957cb4',
  },
  {
    caseId: 'vertex-color-mixed-primitives', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'displayEncoded', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'colored-primitive', coordinate: [0.25, 0.5] }, { id: 'plain-primitive', coordinate: [0.75, 0.5] }],
    falsifier: 'white-color',
    sourceFixtureHash: '4647c26841a60c91b3dd82abb58e5f7725c113f74226c1dcc8d5ae74c950d466',
  },
  {
    caseId: 'vertex-color-mask-taa', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'displayEncoded', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'cutout-edge', coordinate: [0.48, 0.2] }, { id: 'history-interior', coordinate: [0.625, 0.2] }],
    falsifier: 'white-color',
    sourceFixtureHash: '417d5c25e22b88f2854f8ba7fc18850c8866c91b4b7079080fb7bba23c08bcbf',
  },
  {
    caseId: 'vertex-color-no-color-baseline', required: true, owner: 'm5', requiredBackends: ['browser-webgpu', 'dawn'],
    frameCount: 60, colorDomain: 'displayEncoded', epsilon: { rgb: 0.05, alpha: 0.05 },
    samplePoints: [{ id: 'baseline-centroid', coordinate: [0.5, 0.5] }, { id: 'background', coordinate: [0.05, 0.05] }],
    falsifier: 'no-color-baseline',
    sourceFixtureHash: 'dab68d4c265a7200910a87fb32700f658ebf1b39ef443d6c8e5ccdccae937774',
  },
];

const m6Cases = [
  entry(transparentHdrp.caseId, transparentHdrp.required, 'm6', ['browser-webgpu', 'dawn']),
  entry(transparentUrp.caseId, transparentUrp.required, 'm6', ['browser-webgpu', 'dawn', 'chromium-webgl2']),
];

const m3Cases = TONE_REQUIRED_CASES.map((fixture) => {
  const backends = browserBackends(fixture.caseId);
  return entry(fixture.caseId, fixture.required, 'm3', backends, backends);
});

const m4AuthorityCases = m4Cases.map((fixture) => {
  if (fixture.caseId !== 'direct-directional-urp') return fixture;
  return entry(fixture.caseId, fixture.required, fixture.owner, ['browser-webgpu', 'dawn', 'chromium-webgl2']);
});

export const PARITY_CASE_AUTHORITY = [
  ...m0Cases,
  ...m1Cases,
  ...m2Cases,
  ...m3Cases,
  ...m4AuthorityCases,
  ...m5Cases,
  ...vertexColorCases.map((fixture) => entry(fixture.caseId, true, 'm5', fixture.requiredBackends, fixture.requiredBackends)),
  ...m6Cases,
] as const satisfies readonly RequiredCaseAuthorityEntry[];

export const PARITY_REQUIRED_CASES = PARITY_CASE_AUTHORITY.filter((fixture) => fixture.required);
export const PARITY_REQUIRED_CASE_IDS = PARITY_REQUIRED_CASES.map((fixture) => fixture.caseId);
export const PARITY_REQUIRED_BACKEND_IDS = matrix.requiredBackends as readonly ParityBackendId[];
export const PARITY_REQUIRED_PIPELINE_IDS = matrix.requiredPipelines;
export const PARITY_REQUIRED_CHROMIUM_CASE_IDS = PARITY_CASE_AUTHORITY
  .filter((entry) => entry.required && entry.matrixRequiredBackends.includes('chromium-webgl2'))
  .map((entry) => entry.caseId);

export const VERTEX_COLOR_REQUIRED_CASES = vertexColorCases;
