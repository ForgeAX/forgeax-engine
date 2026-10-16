import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const IDENTITY_FIELDS = Object.freeze([
  'sourceHead',
  'sourceTree',
  'lockSha256',
  'buildSha256',
]);

export const DEFAULT_REQUIRED_ANCESTORS = Object.freeze([
  Object.freeze({
    label: 'engineEvidenceRevision',
    revision: 'b30e8b68e2e75ce3a03a074d8c4e19a1207ac033',
  }),
  Object.freeze({
    label: 'reflectionProbeLandingRevision',
    revision: '3f621bf91f8fb304d89723a0ff958c383d825df2',
  }),
  Object.freeze({
    label: 'parentSsrM0Revision',
    revision: '1a07a092da53ed1bdb363862615f687704a3a2cb',
  }),
]);

export const FALLBACK_CHECK_NAMES = Object.freeze([
  'submittedSFallback',
  'sourceKind',
  'generation',
  'activeLkg',
  'candidateInvisibility',
  'recovery',
]);

export const FORMAT_STAGE_NAMES = Object.freeze([
  'texture-create',
  'mip-view',
  'sampled-storage-bind-group',
  'pipeline-bind',
  'finish',
  'submit',
  'completion',
  'readback',
]);

const SOURCE_KINDS = new Set(['probe', 'skylight', 'neutral']);

export class SsrDependencyInputError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'SsrDependencyInputError';
    this.code = code;
    this.detail = detail;
  }
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new SsrDependencyInputError(
      'git-command-failed',
      `${args.join(' ')}: ${(result.stderr || '').trim() || 'unknown git error'}`,
    );
  }
  return result.stdout.trim();
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

export function validateIdentity(identity) {
  const missing = IDENTITY_FIELDS.filter(
    (field) => typeof identity?.[field] !== 'string' || identity[field].length === 0,
  );
  return Object.freeze({ valid: missing.length === 0, missing });
}

export async function readCurrentIdentity(root, buildSummaryPath) {
  const repositoryRoot = resolve(root);
  const lockPath = join(repositoryRoot, 'pnpm-lock.yaml');
  const summaryPath = buildSummaryPath ? resolve(repositoryRoot, buildSummaryPath) : null;
  return Object.freeze({
    sourceHead: git(repositoryRoot, ['rev-parse', 'HEAD']),
    sourceTree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
    lockSha256: existsSync(lockPath) ? await sha256File(lockPath) : null,
    buildSha256: summaryPath && existsSync(summaryPath) ? await sha256File(summaryPath) : null,
  });
}

function ancestorCheck(root, requiredAncestors, head) {
  return requiredAncestors.map(({ label, revision }) => {
    const result = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', revision, head]);
    return Object.freeze({ label, revision, admitted: result.status === 0 });
  });
}

function identityFailures(actual, inputIdentity) {
  if (!inputIdentity) return [];
  return IDENTITY_FIELDS.filter((field) => inputIdentity[field] !== actual[field]).map((field) => ({
    stage: 'identity',
    field,
    expected: actual[field],
    actual: inputIdentity[field] ?? null,
    code: 'identity-mismatch',
  }));
}

function dependencyIdentityFailures(dependencies, identity) {
  const failures = [];
  if (!dependencies || typeof dependencies !== 'object') return failures;
  for (const [name, receipt] of [
    ['reflectionFallback', dependencies.reflectionFallback],
    ['capabilityFormat', dependencies.format],
    ['temporal', dependencies.temporal],
  ]) {
    if (!receipt || typeof receipt !== 'object') continue;
    if (receipt.identity && !sameIdentity(receipt.identity, identity)) {
      failures.push({ stage: name, code: 'receipt-identity-mismatch' });
    }
  }
  return failures;
}

function fallbackChecks(receipt, dependencies) {
  const source = receipt?.source;
  const state = receipt?.state;
  const validGeneration = [
    receipt?.sourceGeneration,
    receipt?.projectionGeneration,
    receipt?.deviceGeneration,
  ].every((value) => Number.isInteger(value) && value >= 0);
  return Object.freeze({
    submittedSFallback:
      receipt !== undefined &&
      (state === 'active' || state === 'lkg' || state === 'neutral') &&
      dependencies?.admission?.status === 'admitted',
    sourceKind: SOURCE_KINDS.has(source),
    generation: validGeneration,
    activeLkg: state === 'active' || state === 'lkg' || state === 'neutral',
    candidateInvisibility: receipt?.candidateVisible === false,
    recovery: dependencies?.failure === undefined,
  });
}

function formatChecks(receipt) {
  const stages = receipt?.stages;
  const stageChecks = Object.fromEntries(
    FORMAT_STAGE_NAMES.map((stage) => [
      stage,
      Array.isArray(stages) &&
        stages.some((entry) => entry?.stage === stage && entry?.verdict === 'admitted'),
    ]),
  );
  return Object.freeze({
    ...stageChecks,
    profile: receipt?.profile === 'r32float-mip-sampled-storage',
    verdict: receipt?.verdict === 'admitted',
    evidence: receipt?.evidence === 'real',
    readback:
      receipt?.readback !== undefined &&
      Number.isInteger(receipt.readback.byteLength) &&
      receipt.readback.byteLength > 0 &&
      Array.isArray(receipt.readback.values),
  });
}

function allTrue(values) {
  return Object.values(values).every(Boolean);
}

function statusFor(checks) {
  return allTrue(checks) ? 'admitted' : 'unavailable';
}

function reportDigest(report) {
  const unsigned = JSON.parse(JSON.stringify(report));
  delete unsigned.reportDigest;
  return createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
}

function normalizeAncestors(requiredAncestors) {
  return requiredAncestors.map((entry) => {
    if (typeof entry === 'string') return { label: entry, revision: entry };
    if (!entry?.revision || !entry?.label) {
      throw new SsrDependencyInputError('invalid-ancestor', 'ancestor needs label and revision');
    }
    return { label: entry.label, revision: entry.revision };
  });
}

export function buildDependencyReport({
  root,
  identity,
  inputIdentity,
  dependencies,
  receipts = {},
  requiredAncestors = DEFAULT_REQUIRED_ANCESTORS,
}) {
  const actualIdentity = Object.freeze({ ...identity });
  const identityResult = validateIdentity(actualIdentity);
  const ancestorRequirements = normalizeAncestors(requiredAncestors);
  const ancestry = ancestorCheck(root, ancestorRequirements, actualIdentity.sourceHead);
  const ancestryAdmitted = ancestry.every((entry) => entry.admitted);
  const identityMismatch = identityFailures(actualIdentity, inputIdentity);
  const receiptMismatches = dependencyIdentityFailures(dependencies, actualIdentity);
  const legacyInput = Object.keys(receipts).length > 0;
  const fallbackReceipt = dependencies?.reflectionFallback;
  const formatReceipt = dependencies?.format;
  const fallback = fallbackChecks(fallbackReceipt, dependencies);
  const format = formatChecks(formatReceipt);
  const temporal = {
    successfulSubmit: dependencies?.temporal?.successfulSubmit === true,
  };
  const admissionStatus = dependencies?.admission?.status ?? dependencies?.status;
  const seamPresent = dependencies !== undefined && typeof dependencies === 'object';
  const identityAdmitted =
    identityResult.valid &&
    identityMismatch.length === 0 &&
    receiptMismatches.length === 0 &&
    !legacyInput;
  const checks = {
    identity: identityAdmitted,
    ancestry: ancestryAdmitted,
    fallback: allTrue(fallback),
    format: allTrue(format),
    temporal: temporal.successfulSubmit,
    admission: admissionStatus === 'admitted',
  };
  const admitted = seamPresent && Object.values(checks).every(Boolean);
  const failures = [
    ...identityMismatch,
    ...receiptMismatches,
    ...(legacyInput ? [{ stage: 'ssrDependencies', code: 'live-seam-required' }] : []),
    ...(identityResult.valid
      ? []
      : [{ stage: 'identity', code: 'identity-incomplete', missing: identityResult.missing }]),
    ...(seamPresent ? [] : [{ stage: 'ssrDependencies', code: 'live-seam-missing' }]),
    ...(ancestryAdmitted ? [] : [{ stage: 'ancestry', code: 'required-ancestor-missing' }]),
    ...(identityMismatch.length > 0 || allTrue(fallback)
      ? []
      : [{ stage: 'reflectionFallback', code: 'receipt-missing-or-incomplete' }]),
    ...(identityMismatch.length > 0 || allTrue(format)
      ? []
      : [{ stage: 'capabilityFormat', code: 'receipt-missing-or-incomplete' }]),
    ...(identityMismatch.length > 0 || temporal.successfulSubmit
      ? []
      : [{ stage: 'temporal', code: 'receipt-missing-or-incomplete' }]),
    ...(admissionStatus === 'admitted' || !seamPresent
      ? []
      : [{ stage: 'admission', code: 'consumer-admission-blocked' }]),
  ];
  const zeroWork = admitted
    ? {
        attachmentCount: 1,
        passCount: 1,
        bindingCount: 1,
        historyCount: 0,
        temporalDemand: 0,
      }
    : {
        attachmentCount: 0,
        passCount: 0,
        bindingCount: 0,
        historyCount: 0,
        temporalDemand: 0,
      };
  const seamSnapshot = seamPresent
    ? Object.freeze({
        status: dependencies.status,
        requested: dependencies.requested,
        identity: dependencies.identity,
        admission: dependencies.admission,
        work: dependencies.work,
        budget: dependencies.budget,
        failure: dependencies.failure,
      })
    : null;
  const report = {
    schemaVersion: '1.0.0',
    producer: 'collect-ssr-dependency-report',
    status: admitted ? 'admitted' : 'fallback-only',
    identity: Object.freeze({
      ...actualIdentity,
      ancestry: Object.freeze({
        required: ancestry,
        checks: Object.freeze({ admitted: ancestryAdmitted }),
      }),
    }),
    checks: Object.freeze(checks),
    reflectionFallback: Object.freeze({
      status: statusFor(fallback),
      checks: fallback,
      ...(fallbackReceipt === undefined ? {} : { receipt: fallbackReceipt }),
    }),
    capabilityFormat: Object.freeze({
      status: statusFor(format),
      stages: format,
      ...(formatReceipt === undefined ? {} : { receipt: formatReceipt }),
    }),
    temporal: Object.freeze({
      status: temporal.successfulSubmit ? 'admitted' : 'unavailable',
      ...temporal,
    }),
    parentGuard: Object.freeze({
      status: admitted ? 'admitted' : 'blocked',
      milestone: 'M1',
      reason: admitted ? null : 'm0-guard-admitted-dependency',
    }),
    failures: Object.freeze(failures),
    zeroWork: Object.freeze(zeroWork),
    ssrDependencies: seamSnapshot,
    admission: Object.freeze({
      status: admitted ? 'admitted' : 'fallback-only',
      checks: Object.freeze(checks),
      zeroWork: Object.freeze({
        ...zeroWork,
        resourceCount: admitted ? 1 : 0,
      }),
      failure: failures[0] ?? null,
    }),
  };
  const signed = { ...report, reportDigest: reportDigest(report) };
  return Object.freeze(signed);
}

export async function collectReport({
  root = process.cwd(),
  buildSummaryPath,
  input,
  requiredAncestors = DEFAULT_REQUIRED_ANCESTORS,
}) {
  const identity = await readCurrentIdentity(root, buildSummaryPath);
  const dependencies = input?.ssrDependencies ?? input?.reflectionProbe?.ssrDependencies;
  return buildDependencyReport({
    root: resolve(root),
    identity,
    inputIdentity: input?.identity ?? dependencies?.identity,
    dependencies,
    receipts: input?.receipts ?? {},
    requiredAncestors,
  });
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : (args[index + 1] ?? null);
}

export async function run(argv = process.argv.slice(2)) {
  const root = resolve(optionValue(argv, '--root') ?? process.cwd());
  const inputPath = optionValue(argv, '--input');
  const outputPath = resolve(
    root,
    optionValue(argv, '--output') ?? 'artifacts/ssr-fallback/ssr-dependency-report.json',
  );
  const buildSummaryPath = optionValue(argv, '--build-summary');
  const requiredAncestors = argv
    .flatMap((arg, index) => (arg === '--required-ancestor' ? [argv[index + 1]] : []))
    .filter(Boolean);
  if (existsSync(outputPath)) {
    let existing;
    try {
      existing = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch (error) {
      throw new SsrDependencyInputError(
        'report-integrity-invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      typeof existing.reportDigest !== 'string' ||
      existing.reportDigest !== reportDigest(existing)
    ) {
      throw new SsrDependencyInputError(
        'report-integrity-invalid',
        'existing report is unsigned or was manually modified',
      );
    }
  }
  const input = inputPath ? JSON.parse(await readFile(resolve(root, inputPath), 'utf8')) : {};
  const report = await collectReport({
    root,
    buildSummaryPath,
    input,
    requiredAncestors:
      requiredAncestors.length > 0 ? requiredAncestors : DEFAULT_REQUIRED_ANCESTORS,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const fatal = report.failures.some(
    (failure) =>
      failure.code === 'identity-mismatch' || failure.code === 'receipt-identity-mismatch',
  );
  return { report, exitCode: fatal ? 2 : 0, outputPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await run();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
