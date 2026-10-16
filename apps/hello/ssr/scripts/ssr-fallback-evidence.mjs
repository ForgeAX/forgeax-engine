import { composeSsrReflection } from '@forgeax/engine-render';

export const REFLECTION_FALLBACK_EXPECTATION_IDS = Object.freeze([
  'local-probe',
  'skylight',
  'neutral',
  'candidate-invisibility',
  'submit-failure',
  'device-recovery',
  'c=0',
  'c=1',
  'r32float',
]);

const rowSummary = (row) => {
  if (row === undefined || row === null || typeof row !== 'object') return row;
  return {
    renderableKey: row.renderableKey,
    sourceKey: row.sourceKey,
    source: row.source,
    state: row.state,
    frameId: row.frameId,
    deviceGeneration: row.deviceGeneration,
    sourceGeneration: row.sourceGeneration,
    projectionGeneration: row.projectionGeneration,
    coverage: row.coverage,
    extent: row.extent,
    candidateVisible: row.candidateVisible,
  };
};

const readbackSummary = (readback) => {
  if (readback === undefined || readback === null || typeof readback !== 'object') {
    return readback;
  }
  return {
    frameId: readback.frameId,
    deviceGeneration: readback.deviceGeneration,
    graphGeneration: readback.graphGeneration,
    textureIdentity: readback.textureIdentity,
    format: readback.format,
    size: readback.size,
    linearHdr: readback.linearHdr,
    readbackStatus: readback.readbackStatus,
    readbackHash: readback.readbackHash,
  };
};

const reportOwner = (report) =>
  report?.reflectionProbe?.initialOwner ?? report?.reflectionProbe?.owner;

const ownerFor = (report, expectedSource) => {
  const probe = report?.reflectionProbe;
  if (expectedSource === 'neutral') return probe?.neutralOwner ?? reportOwner(report);
  return probe?.initialOwner ?? reportOwner(report);
};

const dependenciesFor = (report, expectedSource) => {
  const probe = report?.reflectionProbe;
  if (expectedSource === 'neutral') {
    return probe?.neutralSsrDependencies ?? probe?.ssrDependencies ?? report?.ssrDependencies;
  }
  return probe?.initialSsrDependencies ?? probe?.ssrDependencies ?? report?.ssrDependencies;
};

const fallbackRows = (report, expectedSource) => {
  const rows = ownerFor(report, expectedSource)?.reflectionFallbacks;
  return Array.isArray(rows) ? rows : [];
};

const identityMatchesReadback = (row, readback) =>
  readback !== undefined &&
  row?.frameId === readback.frameId &&
  row?.deviceGeneration === readback.deviceGeneration;

const nonZeroReadback = (readback) =>
  readback?.readbackStatus === 'complete' &&
  Array.isArray(readback.linearHdr) &&
  readback.linearHdr.slice(0, 3).some(
    (value) => Number.isFinite(value) && value !== 0,
  );

const SSR_COMPOSITION_BASE = Object.freeze([0.2, 0.3, 0.4]);
const SSR_COMPOSITION_SCREEN_DELTA = Object.freeze([0.25, 0.2, 0.15]);

const colorClose = (actual, expected, epsilon = 1e-6) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]) <= epsilon);

function compositionOutcome(report, id, c) {
  const owner = ownerFor(report, 'probe');
  const rows = fallbackRows(report, 'probe');
  const row = rows.find(
    (candidate) =>
      candidate?.source === 'probe' &&
      (candidate.state === 'active' || candidate.state === 'lkg') &&
      candidate.candidateVisible === false,
  );
  const readback = owner?.reflectionFallbackReadback;
  const fallbackSpecular =
    Array.isArray(readback?.linearHdr) && readback.linearHdr.length >= 3
      ? readback.linearHdr.slice(0, 3)
      : undefined;
  const screenSpecular =
    fallbackSpecular === undefined
      ? undefined
      : fallbackSpecular.map((value, index) => value + SSR_COMPOSITION_SCREEN_DELTA[index]);
  const composed =
    fallbackSpecular === undefined || screenSpecular === undefined
      ? undefined
      : composeSsrReflection({
          c,
          baseSpecular: SSR_COMPOSITION_BASE,
          screenSpecular,
          fallbackSpecular,
        });
  const expected =
    c === 0
      ? SSR_COMPOSITION_BASE
      : fallbackSpecular === undefined
        ? undefined
        : SSR_COMPOSITION_BASE.map(
            (value, index) => value + c * (screenSpecular[index] - fallbackSpecular[index]),
          );
  const observed = {
    c,
    source: row?.source,
    sourceKey: row?.sourceKey,
    state: row?.state,
    candidateVisible: row?.candidateVisible,
    brdfSignature: row?.brdfSignature,
    frameId: readback?.frameId,
    deviceGeneration: readback?.deviceGeneration,
    fallbackSpecular,
    screenSpecular,
    baseSpecular: SSR_COMPOSITION_BASE,
    output: composed?.ok === true ? composed.value : undefined,
  };
  const identityOk =
    row !== undefined &&
    row.sourceKey?.startsWith('probe:') === true &&
    row.brdfSignature === 'standard-pbr-ibl-v1' &&
    identityMatchesReadback(row, readback) &&
    nonZeroReadback(readback);
  if (composed?.ok === true && expected !== undefined && identityOk && colorClose(composed.value, expected)) {
    return outcome(id, 'pass', observed);
  }
  if (composed?.ok === false) {
    return outcome(id, 'fail', observed, {
      code: 'reflection-fallback-composition-invalid',
      expected: 'finite linear HDR colors and a confidence in the inclusive range 0..1',
      hint: 'Keep the M0 composition inputs in the same linear BRDF domain.',
      detail: JSON.stringify(composed.error),
    });
  }
  return outcome(id, 'blocked', { ...observed, status: 'not-exercised' }, {
    code: `reflection-fallback-${id}-not-exercised`,
    expected:
      c === 0
        ? 'c=0 to preserve the base same-source BRDF specular lobe'
        : 'c=1 to replace only the same-source BRDF-projected specular lobe',
    hint: 'Publish a committed probe row and matching readback before composing SSR.',
    detail: 'no active probe row matched the completed producer readback identity',
  });
}

const outcome = (id, verdict, observed, failure) => ({
  expectation: {
    id,
    observed,
    verdict,
    confidence: verdict === 'pass' ? 1 : 0,
  },
  ...(failure === undefined ? {} : { failure: { id, ...failure } }),
});

function sourceOutcome(report, id, expectedSelection, expectedSource) {
  const probeReport = report?.reflectionProbe;
  const dependencies = dependenciesFor(report, expectedSource);
  const owner = ownerFor(report, expectedSource);
  const rows = fallbackRows(report, expectedSource);
  const readback = owner?.reflectionFallbackReadback;
  const candidates = rows.filter((row) => row?.source === expectedSource);
  const committed = candidates.find(
    (row) =>
      row?.state === 'active' &&
      row?.candidateVisible === false &&
      identityMatchesReadback(row, readback),
  );
  const observed = {
    selection: probeReport?.[expectedSelection],
    source: expectedSource,
    admission: dependencies?.admission?.status,
    dependencyStatus: dependencies?.status,
    rows: candidates.map(rowSummary),
    readback: readbackSummary(readback),
  };
  if (probeReport === undefined || owner === undefined || dependencies === undefined) {
    return outcome(id, 'fail', observed, {
      code: 'reflection-fallback-report-missing',
      expected: 'the completed producer report with detached rows and readback identity',
      hint: 'Run the paired fixture to completion before publishing this manifest.',
      detail: 'reflectionProbe.owner or the live ssrDependencies seam was absent',
    });
  }
  if (probeReport[expectedSelection] !== expectedSource) {
    return outcome(id, 'fail', observed, {
      code: 'reflection-fallback-selection-mismatch',
      expected: `${expectedSelection}=${expectedSource}`,
      hint: 'The fixture selection must name the producer source that wrote the fallback MRT.',
      detail: JSON.stringify({ selection: probeReport[expectedSelection], expectedSource }),
    });
  }
  if (
    dependencies.status === 'admitted' &&
    dependencies.admission?.status === 'admitted' &&
    committed !== undefined &&
    nonZeroReadback(readback)
  ) {
    return outcome(id, 'pass', { ...observed, committed: rowSummary(committed) });
  }
  return outcome(id, 'fail', observed, {
    code: 'reflection-fallback-receipt-incomplete',
    expected: 'an active, candidate-invisible source row bound to a complete non-zero readback',
    hint: 'Keep the row fail-closed until the matching submit, completion, and mapped readback arrive.',
    detail: 'no source row matched the completed readback identity',
  });
}

function neutralOutcome(report) {
  const rows = fallbackRows(report, 'neutral');
  const dependencies = dependenciesFor(report, 'neutral');
  const row = rows.find((candidate) => candidate?.source === 'neutral');
  const observed = {
    row: rowSummary(row),
    available: row !== undefined,
    admission: dependencies?.admission?.status,
    dependencyStatus: dependencies?.status,
  };
  if (
    row?.state === 'neutral' &&
    row.candidateVisible === false &&
    row.sourceKey === 'neutral' &&
    dependencies?.reflectionFallback?.source === 'neutral' &&
    dependencies.reflectionFallback.sourceKey === 'neutral' &&
    dependencies?.status === 'admitted' &&
    dependencies.admission?.status === 'admitted'
  ) {
    return outcome('neutral', 'pass', observed);
  }
  return outcome('neutral', 'blocked', {
    ...observed,
    status: 'not-exercised',
    reason: 'the paired fixture did not publish an admitted neutral transition for the selected owner row',
  }, {
    code: 'reflection-fallback-neutral-not-exercised',
    expected: 'a producer-owned neutral zero row after a real source transition',
    hint: 'Add a fixture transition that removes the Skylight and submit/reinspect the neutral generation.',
    detail: 'no neutral row was produced by this run',
  });
}

function candidateVisibilityOutcome(report) {
  const rows = [
    ...fallbackRows(report, 'probe'),
    ...fallbackRows(report, 'neutral'),
  ];
  const visible = rows.filter((row) => row?.candidateVisible !== false || row?.state === 'candidate');
  const observed = { rowCount: rows.length, visibleRows: visible.map(rowSummary) };
  if (rows.length > 0 && visible.length === 0) return outcome('candidate-invisibility', 'pass', observed);
  return outcome('candidate-invisibility', 'fail', observed, {
    code: 'reflection-fallback-candidate-visible',
    expected: 'candidateVisible=false for every published fallback row',
    hint: 'Do not publish a candidate before the matching completion boundary.',
    detail: `visibleRows=${visible.length}`,
  });
}

function notExercisedOutcome(id, reason, expected, hint) {
  return outcome(id, 'blocked', { status: 'not-exercised', reason }, {
    code: `reflection-fallback-${id}-not-exercised`,
    expected,
    hint,
    detail: reason,
  });
}

function submitFailureOutcome(report) {
  const scenario = report?.reflectionProbe?.submitFailure;
  const observed = scenario ?? { status: 'not-exercised' };
  if (
    scenario?.failureStage === 'submit' &&
    scenario.failureCode === 'reflection-fallback-submit-failed' &&
    scenario.preservedLkg === true &&
    scenario.generationStable === true &&
    scenario.candidateInvisible === true
  ) {
    return outcome('submit-failure', 'pass', observed);
  }
  if (scenario === undefined) {
    return notExercisedOutcome(
      'submit-failure',
      'the paired fixture did not inject a failed queue submit',
      'a failed submit preserves a compatible LKG and hides an incompatible candidate',
      'Run the submit-failure fixture before claiming this row.',
    );
  }
  return outcome('submit-failure', 'fail', observed, {
    code: 'reflection-fallback-submit-recovery-failed',
    expected: 'a failed submit to preserve a source-compatible LKG without advancing generation',
    hint: 'Inspect the owner submit transaction and keep the failed candidate invisible.',
    detail: JSON.stringify(scenario),
  });
}

function deviceRecoveryOutcome(report) {
  const scenario = report?.reflectionProbe?.deviceRecovery;
  const observed = scenario ?? { status: 'not-exercised' };
  if (
    scenario?.triggered === true &&
    scenario.lostState === 'device-lost' &&
    scenario.recoverCode === 'recovered' &&
    scenario.generationChanged === true &&
    scenario.matchingReplacement === true
  ) {
    return outcome('device-recovery', 'pass', observed);
  }
  if (scenario === undefined) {
    return notExercisedOutcome(
      'device-recovery',
      'the healthy paired fixture did not replace a live device',
      'a device-generation change clears pending work and admits only a matching replacement receipt',
      'Run the device-loss/replacement fixture before claiming recovery.',
    );
  }
  return outcome('device-recovery', 'fail', observed, {
    code: 'reflection-fallback-device-recovery-failed',
    expected: 'device loss to invalidate old state and commit a matching replacement receipt',
    hint: 'Inspect renderer recovery and reject receipts from the old device generation.',
    detail: JSON.stringify(scenario),
  });
}

function formatOutcome(report, id, reason, expected, hint) {
  const dependencies = dependenciesFor(report, 'probe');
  const format = dependencies?.format;
  const stages = format?.stages;
  const complete =
    format?.profile === 'r32float-mip-sampled-storage' &&
    format?.verdict === 'admitted' &&
    format?.evidence === 'real' &&
    Array.isArray(stages) &&
    stages.length >= 8 &&
    stages.every((stage) => stage?.verdict === 'admitted') &&
    format.readback?.byteLength > 0;
  return complete
    ? outcome('r32float', 'pass', { profile: format.profile, verdict: format.verdict, stages })
    : notExercisedOutcome(id, reason, expected, hint);
}

export function deriveReflectionFallbackEvidence(report) {
  const outcomes = [
    sourceOutcome(report, 'local-probe', 'insideSelection', 'probe'),
    sourceOutcome(report, 'skylight', 'outsideSelection', 'skylight'),
    neutralOutcome(report),
    candidateVisibilityOutcome(report),
    submitFailureOutcome(report),
    deviceRecoveryOutcome(report),
    compositionOutcome(report, 'c=0', 0),
    compositionOutcome(report, 'c=1', 1),
    formatOutcome(
      report,
      'r32float',
      'the complete r32float storage/readback profile is not admitted by the live RHI seam',
      'Use the dedicated r32float Browser and Dawn profile before claiming this row.',
    ),
  ];
  const expectations = REFLECTION_FALLBACK_EXPECTATION_IDS.map((id) => {
    const matched = outcomes.find(({ expectation }) => expectation.id === id);
    if (matched === undefined) throw new Error(`missing reflection fallback expectation: ${id}`);
    return matched.expectation;
  });
  return {
    status: expectations.every((expectation) => expectation.verdict === 'pass') ? 'pass' : 'blocked',
    expectations,
    failures: outcomes
      .filter(({ expectation }) => expectation.verdict !== 'pass')
      .map(({ failure }) => failure)
      .filter((failure) => failure !== undefined),
  };
}

export function parseReflectionFallbackReport(output) {
  const lines = String(output ?? '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const marker = 'report=';
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) continue;
    try {
      const report = JSON.parse(line.slice(markerIndex + marker.length).trim());
      if (report !== null && typeof report === 'object') return report;
    } catch {
      // A diagnostic line may contain the marker as plain text; keep searching
      // for the complete JSON report emitted by the fixture.
    }
  }
  return undefined;
}

export function reflectionFallbackValidationLog(lane, report, evidence) {
  return `${JSON.stringify({
    lane,
    sourceSelection: {
      inside: report?.reflectionProbe?.insideSelection,
      outside: report?.reflectionProbe?.outsideSelection,
    },
    owner: {
      factCount: reportOwner(report)?.factCount,
      acceptedCount: reportOwner(report)?.acceptedCount,
      activeCount: reportOwner(report)?.activeCount,
      rows: fallbackRows(report).map(rowSummary),
      readback: readbackSummary(reportOwner(report)?.reflectionFallbackReadback),
    },
    expectations: evidence.expectations.map(({ id, verdict }) => ({ id, verdict })),
    status: evidence.status,
  })}\n`;
}
