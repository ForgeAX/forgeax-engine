import { createHash } from 'node:crypto';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const CARD_IDS = ['exposure-adaptation-card', 'white-balance-card', 'lut-output-card'];

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/** Build the feature-specific evidence envelope without becoming a renderer owner. */
export function createFeatureEvidence({
  backend,
  runner,
  resolution = { width: 1, height: 1 },
  frames = 60,
  sourceSha = digest('unknown-source'),
  buildSha = digest('unknown-build'),
  stages,
  exposure = { mode: 'manual', ev: { first: 0, last: 0, generation: 0 } },
  lut = { generation: 0, strength: 0, sourceKey: 'none' },
  resourceGrowth = { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0 },
  visualEvidence,
  workloads,
  fixtureIdentity,
  provenance,
  timing,
} = {}) {
  const finalStages = stages ?? [];
  const cards = visualEvidence ?? CARD_IDS.map((id) => ({
    id,
    png: `${id}.png`,
    observed: 'not-collected by the raw observation producer',
    verdict: 'unavailable',
    confidence: 'low',
  }));
  const report = {
    schemaVersion: 'hello-taa-auto-exposure-evidence/1',
    featureId: FEATURE_ID,
    source: { path: 'apps/hello/taa/src/main.ts', sha256: sourceSha },
    build: { command: 'pnpm --filter @forgeax/hello-taa build', sha256: buildSha },
    backend,
    runner,
    resolution,
    frames,
    frameIdentity: { first: 0, last: Math.max(0, frames - 1), sequenceSha256: digest({ backend, frames, stages: finalStages }) },
    ...(stages === undefined ? {} : { stages }),
    exposure,
    lut,
    resourceGrowth,
    visualEvidence: cards,
    ...(workloads === undefined ? {} : { workloads }),
    ...(fixtureIdentity === undefined ? {} : { fixtureIdentity }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(timing === undefined ? {} : { timing }),
    // A producer can only publish raw observations. The independent validator
    // owns any derived feature verdict and must explicitly add it later.
    status: 'blocked',
  };
  return report;
}

export function emitRequiredUnavailable(report) {
  // A carrier is a gate, not optional telemetry: missing provider evidence
  // must fail the invoking command while retaining its structured report.
  const required = true;
  console.log(
    JSON.stringify({
      ...report,
      acceptance: 'blocked',
      exitPolicy: required ? 'fail-closed' : 'record-only',
    }),
  );
  if (required) process.exitCode = 1;
}
