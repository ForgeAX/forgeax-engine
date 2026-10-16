import type { CaptureEnvelope } from '../capture/named-capture';
import type { ForgeaxAdapter, ForgeaxSurfaceEvidence } from '../adapters/forgeax-adapter';
import type { ThreeAdapter } from '../adapters/three-adapter';
import type { CaseReport, ParityProvenance, PrimaryMetric, SceneCase } from '../contracts/types';
import { type ColorLightingParityError, parityError } from '../errors';
import { evaluateCase } from '../evaluator/evaluate-case';

export { createForgeaxAdapter } from '../adapters/forgeax-adapter';
export { createThreeAdapter } from '../adapters/three-adapter';

export interface CaseRunResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly report: CaseReport;
  readonly errorCode?: string;
  readonly expectedErrorCode?: string;
  readonly surfaceEvidence?: ForgeaxSurfaceEvidence;
}

export interface ParityMatrixResult {
  readonly ok: boolean;
  readonly cases: readonly CaseRunResult[];
}

export interface ParityMatrixOptions {
  readonly expectedErrors?: Readonly<Record<string, ColorLightingParityError['code']>>;
  readonly mutateThree?: Readonly<Record<string, (capture: CaptureEnvelope) => CaptureEnvelope>>;
  readonly overrideProvenance?: Readonly<Record<string, { forgeax?: ParityProvenance; three?: ParityProvenance }>>;
  readonly allowThreeWebglFallback?: boolean;
}

function emptyReport(sceneCase: SceneCase, provenance: { forgeax: ParityProvenance; three: ParityProvenance }): CaseReport {
  return {
    schemaVersion: 1,
    caseId: sceneCase.caseId,
    required: sceneCase.required,
    ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline }),
    ...(sceneCase.light === undefined ? {} : { light: sceneCase.light }),
    ...(sceneCase.import === undefined ? {} : { import: sceneCase.import }),
    provenance,
    captures: {
      forgeax: { linear: [], final: [], hash: '' },
      three: { linear: [], final: [], hash: '' },
    },
    budget: sceneCase.budget,
    metrics: { analyticMax: 0, roiMax: 0, differingBytes: 0 },
    verdict: 'failed',
    status: 'failed',
    firstDivergence: null,
  };
}

function enrichReport(
  report: CaseReport,
  sceneCase: SceneCase,
  forgeax: CaptureEnvelope,
  three: CaptureEnvelope,
): CaseReport {
  const expectedPipelineId = sceneCase.pipeline?.engineId;
  const observations = forgeax.observations;
  const attachmentPipelineMatches = expectedPipelineId === undefined || (
    observations !== undefined
    && observations.linearHdr.pipelineId === expectedPipelineId
    && observations.finalDisplay.pipelineId === expectedPipelineId
  );
  return {
    ...report,
    ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline }),
    ...(sceneCase.light === undefined ? {} : { light: sceneCase.light }),
    ...(sceneCase.import === undefined ? {} : { import: sceneCase.import }),
    readback: {
      ...(forgeax.readback === undefined ? {} : { forgeax: forgeax.readback.source }),
      ...(three.readback === undefined ? {} : { three: three.readback.source }),
    },
    ...(observations === undefined || !attachmentPipelineMatches
      ? {}
      : {
          attachmentEvidence: {
            linearHdr: observations.linearHdr,
            finalDisplay: observations.finalDisplay,
            attachmentReadbackStatus: 'partial' as const,
            capabilityStatus: 'supported' as const,
            executionStatus: 'partial' as const,
            verdict: 'notRun' as const,
            missingPipelineIds: [],
          },
        }),
  };
}

function isRgbaNonBackground(
  forgeax: CaptureEnvelope,
  three: CaptureEnvelope,
  pixelOffset: number,
  background: readonly number[],
): boolean {
  return [0, 1, 2, 3].some((component) => {
    const expected = background[component] ?? 0;
    const left = forgeax.captures.final[pixelOffset + component] ?? 0;
    const right = three.captures.final[pixelOffset + component] ?? 0;
    return left !== expected || right !== expected;
  });
}

function compareCaptures(
  forgeax: CaptureEnvelope,
  three: CaptureEnvelope,
  primaryMetric: PrimaryMetric,
) {
  const length = Math.max(forgeax.captures.final.length, three.captures.final.length);
  const pixelCount = Math.ceil(length / 4);
  const background = forgeax.config.background.map((channel) => Math.round((channel ?? 0) * 255));
  const backgroundAlpha = background[3] ?? 0;
  let differingBytes = 0;
  let maxDelta = 0;
  let roiMax = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const pixelOffset = pixel * 4;
    const leftAlpha = forgeax.captures.final[pixelOffset + 3] ?? 0;
    const rightAlpha = three.captures.final[pixelOffset + 3] ?? 0;
    const leftVisible = leftAlpha !== backgroundAlpha;
    const rightVisible = rightAlpha !== backgroundAlpha;
    const components = primaryMetric === 'rgba' ? [0, 1, 2, 3] : [3];
    const deltas = components.map((component) => {
      const left = forgeax.captures.final[pixelOffset + component] ?? 0;
      const right = three.captures.final[pixelOffset + component] ?? 0;
      if (primaryMetric === 'occupancy') return leftVisible === rightVisible ? 0 : 1;
      return Math.abs(left - right) / 255;
    });
    const delta = Math.max(...deltas);
    const nonBackground = primaryMetric === 'rgba'
      ? isRgbaNonBackground(forgeax, three, pixelOffset, background)
      : primaryMetric === 'alpha'
        ? leftAlpha !== backgroundAlpha || rightAlpha !== backgroundAlpha
        : leftVisible || rightVisible;
    if (delta > 0) differingBytes += primaryMetric === 'rgba' ? deltas.filter((value) => value > 0).length : 1;
    if (delta > maxDelta) maxDelta = delta;
    if (nonBackground && delta > roiMax) roiMax = delta;
  }
  return { analyticMax: maxDelta, roiMax, differingBytes };
}

function replaceProvenance(
  envelope: CaptureEnvelope,
  provenance: ParityProvenance | undefined,
): CaptureEnvelope {
  return provenance === undefined ? envelope : { ...envelope, provenance };
}

function expectedFailureReport(
  sceneCase: SceneCase,
  forgeax: CaptureEnvelope,
  three: CaptureEnvelope,
  error: ColorLightingParityError,
): CaseReport {
  return {
    ...emptyReport(sceneCase, { forgeax: forgeax.provenance, three: three.provenance }),
    captures: { forgeax: forgeax.captures, three: three.captures },
    verdict: 'failed',
    status: 'failed',
    firstDivergence: error.code === 'budget-exceeded'
      ? { owner: 'final-capture', metric: 'bytes' }
      : null,
  };
}

async function runCase(
  sceneCase: SceneCase,
  forgeaxAdapter: ForgeaxAdapter,
  threeAdapter: ThreeAdapter,
  options: ParityMatrixOptions,
): Promise<CaseRunResult> {
  const expectedErrorCode = options.expectedErrors?.[sceneCase.caseId];
  const forgeaxResult = await forgeaxAdapter.capture(sceneCase);
  const threeResult = await threeAdapter.capture(sceneCase);
  if (!forgeaxResult.ok || !threeResult.ok) {
    const error = forgeaxResult.ok ? (threeResult.ok ? null : threeResult.error) : forgeaxResult.error;
    if (error === null) throw new Error('capture result narrowed inconsistently');
    const fallbackForgeax = forgeaxResult.ok
      ? forgeaxResult.value
      : ({ provenance: { implementation: 'forgeax', version: 'unknown' }, captures: { linear: [], final: [], hash: '' } } as unknown as CaptureEnvelope);
    const fallbackThree = threeResult.ok
      ? threeResult.value
      : ({ provenance: { implementation: 'three', version: 'unknown', renderer: 'webgpu' }, captures: { linear: [], final: [], hash: '' } } as unknown as CaptureEnvelope);
    const expected = expectedErrorCode === error.code;
    return {
      caseId: sceneCase.caseId,
      passed: expected,
      report: expectedFailureReport(sceneCase, fallbackForgeax, fallbackThree, error),
      errorCode: error.code,
      ...(fallbackForgeax.surfaceEvidence === undefined ? {} : { surfaceEvidence: fallbackForgeax.surfaceEvidence }),
      ...(expectedErrorCode === undefined ? {} : { expectedErrorCode }),
    };
  }

  let forgeax = replaceProvenance(forgeaxResult.value, options.overrideProvenance?.[sceneCase.caseId]?.forgeax);
  let three = replaceProvenance(threeResult.value, options.overrideProvenance?.[sceneCase.caseId]?.three);
  const mutate = options.mutateThree?.[sceneCase.caseId];
  if (mutate !== undefined) three = mutate(three);
  if (
    sceneCase.light !== undefined
    && !options.allowThreeWebglFallback
    && (forgeax.readback?.source === 'unavailable' || three.readback?.source === 'unavailable')
  ) {
    const error = parityError('status-incomplete', {
      code: 'status-incomplete',
      missing: [
        ...(forgeax.readback?.source === 'unavailable' ? ['forgeax-linear-readback'] : []),
        ...(three.readback?.source === 'unavailable' ? ['three-linear-readback'] : []),
      ],
    });
    const report = enrichReport(
      {
        ...expectedFailureReport(sceneCase, forgeax, three, error),
        verdict: 'notRun',
        status: 'partial',
        firstDivergence: null,
      },
      sceneCase,
      forgeax,
      three,
    );
    return {
      caseId: sceneCase.caseId,
      passed: expectedErrorCode === error.code,
      report,
      errorCode: error.code,
      ...(forgeax.surfaceEvidence === undefined ? {} : { surfaceEvidence: forgeax.surfaceEvidence }),
      ...(expectedErrorCode === undefined ? {} : { expectedErrorCode }),
    };
  }
  const metrics = compareCaptures(forgeax, three, sceneCase.comparison?.primaryMetric ?? 'rgba');
  const evaluated = evaluateCase({
    caseId: sceneCase.caseId,
    required: sceneCase.required,
    budget: sceneCase.budget,
    forgeax: forgeax.provenance,
    three: three.provenance,
    captures: { forgeax: forgeax.captures, three: three.captures },
    analytic: { max: metrics.analyticMax },
    roi: { max: metrics.roiMax },
    bytes: { differing: metrics.differingBytes },
    ...(options.allowThreeWebglFallback ? { allowThreeWebglFallback: true } : {}),
  });
  const report = evaluated.ok
    ? evaluated.value
    : evaluated.value ?? expectedFailureReport(sceneCase, forgeax, three, evaluated.error);
  const enrichedReport = enrichReport(report, sceneCase, forgeax, three);
  const passed = expectedErrorCode === undefined
    ? evaluated.ok
    : !evaluated.ok && evaluated.error.code === expectedErrorCode;
  return {
    caseId: sceneCase.caseId,
    passed,
    report: enrichedReport,
    ...(forgeax.surfaceEvidence === undefined ? {} : { surfaceEvidence: forgeax.surfaceEvidence }),
    ...(evaluated.ok ? {} : { errorCode: evaluated.error.code }),
    ...(expectedErrorCode === undefined ? {} : { expectedErrorCode }),
  };
}

export async function runParityMatrix(
  cases: readonly SceneCase[],
  forgeaxAdapter: ForgeaxAdapter,
  threeAdapter: ThreeAdapter,
  options: ParityMatrixOptions = {},
): Promise<ParityMatrixResult> {
  const results: CaseRunResult[] = [];
  for (const sceneCase of cases) {
    results.push(await runCase(sceneCase, forgeaxAdapter, threeAdapter, options));
  }
  return { ok: results.every((result) => result.passed), cases: results };
}

export function matrixError(result: ParityMatrixResult): ColorLightingParityError | null {
  const failed = result.cases.find((entry) => !entry.passed);
  return failed === undefined
    ? null
    : parityError('status-incomplete', {
        code: 'status-incomplete',
        missing: [failed.caseId],
      });
}
