import type {
  CaseReport,
  NamedCaptures,
  ParityProvenance,
  SceneCaseBudget,
  VertexColorCaseReport,
  VertexColorCaseId,
  VertexColorProducerSample,
  VertexColorSemanticFixture,
} from '../contracts/types';
import type { VertexColorNamedCapture } from '../capture/named-capture';
import { VERTEX_COLOR_REQUIRED_CASES } from '../coverage/required-cases';
import { parityError, type ColorLightingParityError } from '../errors';
import {
  firstDivergence,
  hasUnreasonablyWideBudget,
  metricsAreFinite,
  type EvaluatorMetrics,
} from './metrics';

export interface EvaluateCaseInput {
  readonly caseId: string;
  readonly required: boolean;
  readonly budget: SceneCaseBudget;
  readonly forgeax: ParityProvenance;
  readonly three: ParityProvenance;
  readonly captures?: {
    readonly forgeax: NamedCaptures;
    readonly three: NamedCaptures;
  };
  readonly analytic?: { readonly max: number };
  readonly roi?: { readonly max: number };
  readonly bytes?: { readonly differing: number };
  readonly aggregateDiff?: number;
  readonly allowThreeWebglFallback?: boolean;
}

export type EvaluationResult =
  | { readonly ok: true; readonly value: CaseReport }
  | { readonly ok: false; readonly error: ColorLightingParityError; readonly value?: CaseReport };

export interface VertexColorExpectedSample {
  readonly id: string;
  readonly coordinate: readonly [number, number];
  readonly rgba: readonly [number, number, number, number];
}

export interface VertexColorWhiteFalsifier {
  readonly kind: 'white-color';
  readonly samples: readonly VertexColorProducerSample[];
}

export interface VertexColorNoColorFalsifier {
  readonly kind: 'no-color-baseline';
  readonly baselineFinal: readonly number[];
  readonly observedFinal: readonly number[];
  readonly colorStreamBytes: number;
}

export interface EvaluateVertexColorCaseInput {
  readonly caseId: VertexColorCaseId;
  readonly fixture: VertexColorSemanticFixture;
  readonly invocationId: string;
  readonly backend: 'browser-webgpu' | 'dawn';
  readonly sourceSha: string;
  readonly expectedSamples: readonly VertexColorExpectedSample[];
  readonly forgeax: VertexColorNamedCapture;
  readonly three: VertexColorNamedCapture;
  readonly falsifier: VertexColorWhiteFalsifier | VertexColorNoColorFalsifier;
  readonly artifacts: readonly string[];
}

export type VertexColorEvaluationResult =
  | { readonly ok: true; readonly value: VertexColorCaseReport }
  | { readonly ok: false; readonly error: ColorLightingParityError; readonly value?: VertexColorCaseReport };

function emptyCaptures(): NamedCaptures {
  return { linear: [], final: [], hash: '' };
}

function buildReport(input: EvaluateCaseInput, metrics: EvaluatorMetrics, verdict: CaseReport['verdict'], divergence: ReturnType<typeof firstDivergence>): CaseReport {
  return {
    schemaVersion: 1,
    caseId: input.caseId,
    required: input.required,
    provenance: { forgeax: input.forgeax, three: input.three },
    captures: input.captures ?? { forgeax: emptyCaptures(), three: emptyCaptures() },
    budget: input.budget,
    metrics,
    verdict,
    status: verdict === 'passed' ? 'complete' : 'failed',
    firstDivergence: divergence,
  };
}

function fail(error: ColorLightingParityError, value?: CaseReport): EvaluationResult {
  return value ? { ok: false, error, value } : { ok: false, error };
}

export function evaluateCase(input: EvaluateCaseInput): EvaluationResult {
  if (input.aggregateDiff !== undefined && input.analytic === undefined && input.roi === undefined) {
    return fail(parityError('aggregate-only-input', { code: 'aggregate-only-input', fields: ['aggregateDiff'] }));
  }
  if (input.forgeax.implementation === input.three.implementation && input.forgeax.version === input.three.version) {
    return fail(parityError('provenance-conflict', {
      code: 'provenance-conflict',
      forgeaxImplementation: input.forgeax.implementation,
      threeImplementation: input.three.implementation,
    }));
  }
  if (
    input.three.renderer !== undefined
    && input.three.renderer !== 'webgpu'
    && !(input.allowThreeWebglFallback && input.three.renderer === 'webgl')
  ) {
    return fail(parityError('primary-capture-missing', { code: 'primary-capture-missing', missing: ['threeWebGpu'] }));
  }
  if (hasUnreasonablyWideBudget(input.budget)) {
    return fail(parityError('budget-exceeded', {
      code: 'budget-exceeded',
      metric: 'analytic',
      actual: input.budget.analyticMax,
      budget: 1,
    }));
  }
  const metrics: EvaluatorMetrics = {
    analyticMax: input.analytic?.max ?? 0,
    roiMax: input.roi?.max ?? 0,
    differingBytes: input.bytes?.differing ?? 0,
  };
  if (!metricsAreFinite(metrics)) {
    return fail(parityError('metric-non-finite', {
      code: 'metric-non-finite',
      metric: 'analytic',
      actual: metrics.analyticMax,
      budget: input.budget.analyticMax,
    }));
  }
  // WebGL2 fallback captures are final-display evidence only. Their raw byte
  // diff remains in the report, while the declared analytic/ROI bounds are
  // the bounded numeric verdict because the fallback has no linear HDR seam
  // and backend quantization can touch every display byte.
  const divergence = firstDivergence(metrics, input.budget, {
    enforceByteBudget: !input.allowThreeWebglFallback,
  });
  if (divergence) {
    const report = buildReport(input, metrics, 'failed', divergence);
    return fail(parityError('budget-exceeded', { code: 'budget-exceeded', metric: divergence.metric, actual: divergence.actual, budget: divergence.budget }), report);
  }
  if (input.captures === undefined) {
    return fail(parityError('primary-capture-missing', { code: 'primary-capture-missing', missing: ['forgeax', 'threeWebGpu'] }));
  }
  return { ok: true, value: buildReport(input, metrics, 'passed', null) };
}

function vertexCaptureError(field: string): ColorLightingParityError {
  return parityError('capture-envelope-invalid', { code: 'capture-envelope-invalid', field, role: 'primary' });
}

function maxRgbDelta(left: readonly [number, number, number, number], right: readonly [number, number, number, number]): number {
  return Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]));
}

function sampleById(samples: readonly VertexColorProducerSample[], id: string): VertexColorProducerSample | undefined {
  return samples.find((sample) => sample.id === id);
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildVertexReport(
  input: EvaluateVertexColorCaseInput,
  samples: VertexColorCaseReport['samples'],
  falsifier: VertexColorCaseReport['falsifier'],
  verdict: VertexColorCaseReport['verdict'],
): VertexColorCaseReport {
  return {
    schemaVersion: 3,
    kind: 'vertex-color',
    caseId: input.caseId,
    required: true,
    invocationId: input.invocationId,
    backend: input.backend,
    sourceSha: input.sourceSha,
    sourceFixtureHash: input.forgeax.sourceFixtureHash,
    colorDomain: input.fixture.colorDomain,
    frameCount: 60,
    epsilon: { rgb: 0.05, alpha: 0.05 },
    producers: { forgeax: input.forgeax.producer, three: input.three.producer },
    samples,
    falsifier,
    artifacts: input.artifacts,
    verdict,
    status: verdict === 'passed' ? 'complete' : 'failed',
  };
}

export function evaluateVertexColorCase(input: EvaluateVertexColorCaseInput): VertexColorEvaluationResult {
  const authority = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === input.caseId);
  if (authority === undefined) return { ok: false, error: vertexCaptureError('caseId') };
  if (input.fixture.caseId !== input.caseId) return { ok: false, error: vertexCaptureError('fixture.caseId') };
  if (input.backend !== 'browser-webgpu' && input.backend !== 'dawn') return { ok: false, error: vertexCaptureError('backend') };
  if (input.sourceSha.length === 0 || input.forgeax.sourceSha !== input.sourceSha || input.three.sourceSha !== input.sourceSha) {
    return { ok: false, error: vertexCaptureError('sourceSha') };
  }
  if (input.forgeax.sourceFixtureHash !== authority.sourceFixtureHash || input.three.sourceFixtureHash !== authority.sourceFixtureHash) {
    return { ok: false, error: vertexCaptureError('sourceFixtureHash') };
  }
  if (input.forgeax.producer.implementation !== 'forgeax' || input.three.producer.implementation !== 'three' || input.three.producer.version !== 'r184') {
    return { ok: false, error: vertexCaptureError('producers') };
  }
  if (input.forgeax.producer.adapterId === input.three.producer.adapterId || input.forgeax.producer.buildIdentity === input.three.producer.buildIdentity) {
    return { ok: false, error: vertexCaptureError('producers') };
  }
  if (input.forgeax.backend !== input.backend || input.three.backend !== input.backend) return { ok: false, error: vertexCaptureError('backend') };
  if (input.forgeax.frameCount !== 60 || input.three.frameCount !== 60) return { ok: false, error: vertexCaptureError('frameCount') };
  if (input.forgeax.colorDomain !== input.fixture.colorDomain || input.three.colorDomain !== input.fixture.colorDomain) {
    return { ok: false, error: vertexCaptureError('colorDomain') };
  }
  if (input.artifacts.length < 2 || input.artifacts.some((artifact) => artifact.length === 0)) return { ok: false, error: vertexCaptureError('artifacts') };
  const expectedById = new Map(input.expectedSamples.map((sample) => [sample.id, sample]));
  const fixtureIds = new Set(input.fixture.samplePoints.map((sample) => sample.id));
  if (expectedById.size !== fixtureIds.size || [...fixtureIds].some((id) => !expectedById.has(id))) return { ok: false, error: vertexCaptureError('expectedSamples') };
  const allObserved = [...input.forgeax.samples, ...input.three.samples];
  if (allObserved.some((sample) => sample.rgba.some((channel) => !Number.isFinite(channel)))) return { ok: false, error: vertexCaptureError('samples') };
  if (allObserved.length === 0 || allObserved.every((sample) => sample.rgba.every((channel) => channel === 0))) return { ok: false, error: vertexCaptureError('samples') };
  const samples: Array<VertexColorCaseReport['samples'][number]> = [];
  let failed = false;
  for (const expected of input.expectedSamples) {
    const forgeax = sampleById(input.forgeax.samples, expected.id);
    const three = sampleById(input.three.samples, expected.id);
    if (forgeax === undefined || three === undefined || forgeax.coordinate[0] !== expected.coordinate[0] || forgeax.coordinate[1] !== expected.coordinate[1] || three.coordinate[0] !== expected.coordinate[0] || three.coordinate[1] !== expected.coordinate[1]) {
      return { ok: false, error: vertexCaptureError(`samples.${expected.id}`) };
    }
    const rgbDelta = maxRgbDelta(forgeax.rgba, three.rgba);
    const alphaDelta = Math.abs(forgeax.rgba[3] - three.rgba[3]);
    const sampleVerdict = rgbDelta <= 0.05 && alphaDelta <= 0.05 ? 'passed' : 'failed';
    if (sampleVerdict === 'failed') failed = true;
    samples.push({ id: expected.id, coordinate: expected.coordinate, expected: expected.rgba, observed: { forgeax: forgeax.rgba, three: three.rgba }, rgbMaxDelta: rgbDelta, alphaDelta, verdict: sampleVerdict, confidence: 'high' });
  }
  let falsifier: VertexColorCaseReport['falsifier'];
  if (input.falsifier.kind === 'white-color') {
    const changed = input.falsifier.samples.some((sample) => {
      const original = sampleById(input.forgeax.samples, sample.id);
      return original !== undefined && maxRgbDelta(original.rgba, sample.rgba) > 0.05;
    });
    falsifier = { kind: 'white-color', verdict: changed ? 'passed' : 'failed', observed: changed ? 'at least one colored sample crossed epsilon after white substitution' : 'white substitution did not change a colored sample' };
  } else {
    const unchanged = input.falsifier.colorStreamBytes === 0 && sameBytes(input.falsifier.baselineFinal, input.falsifier.observedFinal);
    falsifier = { kind: 'no-color-baseline', verdict: unchanged ? 'passed' : 'failed', observed: unchanged ? 'COLOR_0 remained absent and the baseline was byte-identical' : 'the no-color stream or baseline changed' };
  }
  if (falsifier.verdict === 'failed') failed = true;
  const report = buildVertexReport(input, samples, falsifier, failed ? 'failed' : 'passed');
  return failed
    ? { ok: false, error: parityError('budget-exceeded', { code: 'budget-exceeded', metric: 'analytic', actual: Math.max(...samples.map((sample) => sample.rgbMaxDelta)), budget: 0.05 }), value: report }
    : { ok: true, value: report };
}
