import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';
import { assertReleaseSource, releasePolicy } from './release-policy.mjs';
import { filesUnder, sha256 } from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const candidateSchemaPath = resolve(repositoryRoot, 'schemas/sdk-candidate.schema.json');
export const CANDIDATE_SCHEMA_VERSION = '2.0.0';
export const CANDIDATE_GATES = Object.freeze([
  'npm-consumer',
  'archive-browser',
  'reproducibility',
  'collision',
]);

function posixRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function parseArgs(argv) {
  const values = new Map();
  const repeated = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      values.set(name, true);
      continue;
    }
    index += 1;
    values.set(name, value);
    const entries = repeated.get(name) ?? [];
    entries.push(value);
    repeated.set(name, entries);
  }
  return {
    value(name) {
      return values.get(name);
    },
    values(name) {
      return repeated.get(name) ?? [];
    },
  };
}

async function digestFile(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

async function readJson(path, errorCode) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new Error(`${errorCode}: ${path}`, { cause });
  }
}

async function packageArchive(path) {
  const { stdout } = await execFileAsync('tar', ['-xOf', path, 'package/package.json'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const manifest = JSON.parse(stdout);
  const digest = await digestFile(path);
  return {
    name: manifest.name,
    version: manifest.version,
    path,
    integrity: digest.integrity,
  };
}

function gatePassed(report) {
  return (
    report?.ok === true ||
    report?.status === 'passed' ||
    report?.verdict === 'pass' ||
    report?.admission?.status === 'passed'
  );
}

async function copyGateReport(candidateRoot, name, sourcePath) {
  const report = await readJson(sourcePath, 'sdk-candidate-gate-report-invalid');
  if (!gatePassed(report)) throw new Error(`sdk-candidate-gate-failed: ${name}`);
  const destination = resolve(candidateRoot, 'gates', `${name}.json`);
  await mkdir(dirname(destination), { recursive: true });
  if (resolve(sourcePath) !== destination) await copyFile(sourcePath, destination);
  if (name === 'archive-browser') {
    const releaseEvidence = resolve(candidateRoot, 'sdk-verify-result.json');
    if (resolve(sourcePath) !== releaseEvidence) await copyFile(sourcePath, releaseEvidence);
  }
  return {
    name,
    result: 'passed',
    durationMs:
      Number.isInteger(report.durationMs) && report.durationMs >= 0 ? report.durationMs : 0,
    report: posixRelative(candidateRoot, destination),
    sha256: (await digestFile(destination)).sha256,
  };
}

async function listNpmArchives(candidateRoot) {
  const npmRoot = resolve(candidateRoot, 'npm');
  const files = (await filesUnder(npmRoot)).filter((path) => path.endsWith('.tgz')).sort();
  if (files.length === 0) throw new Error('sdk-candidate-npm-archives-missing');
  const packages = await Promise.all(files.map(packageArchive));
  const roster = ['@forgeax/engine', '@forgeax/view', '@forgeax/engine-sdk'];
  if (packages.some(({ name }) => !roster.includes(name)))
    throw new Error('sdk-candidate-npm-roster-foreign');
  const ordered = roster.map((name) => packages.find((item) => item.name === name));
  if (packages.length !== roster.length || ordered.some((item) => item === undefined))
    throw new Error('sdk-candidate-npm-roster-incomplete');
  return ordered.map((item, publishOrder) => ({
    name: item.name,
    version: item.version,
    path: posixRelative(candidateRoot, item.path),
    integrity: item.integrity,
    publishOrder,
  }));
}

export async function sealCandidate({
  candidateRoot,
  sdkVersion,
  sourceWorkflowRunId,
  gateSpecs = [],
  now = new Date(),
}) {
  const root = resolve(candidateRoot);
  const buildResult = await readJson(
    resolve(root, 'sdk-build-result.json'),
    'sdk-candidate-build-result-invalid',
  );
  const version = sdkVersion ?? buildResult.sdkVersion;
  if (buildResult.ok !== true || buildResult.sdkVersion !== version) {
    throw new Error('sdk-candidate-build-result-mismatch');
  }
  releasePolicy(version);
  if (!/^[0-9a-f]{40}$/.test(buildResult.engineCommit ?? '')) {
    throw new Error('sdk-candidate-engine-commit-invalid');
  }
  // Offline identity check: branch ancestry (including rc-contains-stable) was
  // proven by release-policy.mjs when the Candidate resolved its source.
  const engineCommit = buildResult.engineCommit;
  assertReleaseSource(
    version,
    engineCommit,
    { [releasePolicy(version).branch]: engineCommit, stable: engineCommit },
    () => true,
  );
  if (!/^[0-9a-f]{40}$/.test(buildResult.viewCommit ?? ''))
    throw new Error('sdk-candidate-view-commit-invalid');
  const runId = Number(sourceWorkflowRunId);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('sdk-candidate-source-run-id-invalid');

  const specs = gateSpecs.map((spec) => {
    const separator = spec.indexOf('=');
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`sdk-candidate-gate-spec-invalid: ${spec}`);
    }
    return { name: spec.slice(0, separator), path: resolve(spec.slice(separator + 1)) };
  });
  if (new Set(specs.map(({ name }) => name)).size !== specs.length) {
    throw new Error('sdk-candidate-gates-duplicate');
  }
  if (
    specs.length !== CANDIDATE_GATES.length ||
    CANDIDATE_GATES.some((name) => !specs.some((spec) => spec.name === name))
  ) {
    throw new Error(`sdk-candidate-gates-incomplete: ${specs.map(({ name }) => name).join(',')}`);
  }

  await rm(resolve(root, 'sdk-candidate.json'), { force: true });
  await rm(resolve(root, 'gates'), { recursive: true, force: true });
  const gates = await Promise.all(specs.map(({ name, path }) => copyGateReport(root, name, path)));
  const archivePaths = await filesUnder(root);
  const artifacts = (
    await Promise.all(
      archivePaths.map(async (path) => ({
        path,
        artifact: await digestFile(path),
      })),
    )
  )
    .map(({ path, artifact }) => ({
      path: posixRelative(root, path),
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const npmPackages = await listNpmArchives(root);
  const candidate = {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    candidateId: `${version}-${buildResult.engineCommit.slice(0, 12)}`,
    sdkVersion: version,
    engineCommit: buildResult.engineCommit,
    viewCommit: buildResult.viewCommit,
    sourceWorkflowRunId: runId,
    artifacts,
    npmPackages,
    gates: gates.sort((left, right) => left.name.localeCompare(right.name)),
    sealedAt: now.toISOString(),
  };
  await writeFile(resolve(root, 'sdk-candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`);
  await validateCandidate({ candidateRoot: root, expectedVersion: version });
  return candidate;
}

export async function validateCandidate({ candidateRoot, expectedVersion, expectedEngineCommit }) {
  const root = resolve(candidateRoot);
  const candidate = await readJson(
    resolve(root, 'sdk-candidate.json'),
    'sdk-candidate-manifest-invalid',
  );
  const schema = await readJson(candidateSchemaPath, 'sdk-candidate-schema-missing');
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(candidate)) {
    throw new Error(`sdk-candidate-schema: ${JSON.stringify(validate.errors)}`);
  }
  if (Number.isNaN(Date.parse(candidate.sealedAt)))
    throw new Error('sdk-candidate-sealed-at-invalid');
  assertReleaseSource(
    candidate.sdkVersion,
    candidate.engineCommit,
    {
      [releasePolicy(candidate.sdkVersion).branch]: candidate.engineCommit,
      stable: candidate.engineCommit,
    },
    () => true,
  );
  if (expectedVersion !== undefined && candidate.sdkVersion !== expectedVersion) {
    throw new Error('sdk-candidate-version-mismatch');
  }
  if (expectedEngineCommit !== undefined && candidate.engineCommit !== expectedEngineCommit) {
    throw new Error('sdk-candidate-engine-commit-mismatch');
  }
  const actualFiles = new Map(
    (await filesUnder(root)).map((path) => [posixRelative(root, path), path]),
  );
  const artifactPaths = new Set(candidate.artifacts.map(({ path }) => path));
  if (artifactPaths.size !== candidate.artifacts.length)
    throw new Error('sdk-candidate-artifacts-duplicate');
  if (actualFiles.has('sdk-candidate.json')) actualFiles.delete('sdk-candidate.json');
  if (actualFiles.size !== artifactPaths.size)
    throw new Error('sdk-candidate-unmanifested-artifact');
  for (const entry of candidate.artifacts) {
    const path = actualFiles.get(entry.path);
    if (path === undefined) throw new Error(`sdk-candidate-artifact-missing: ${entry.path}`);
    const digest = await digestFile(path);
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) {
      throw new Error(`sdk-candidate-artifact-mismatch: ${entry.path}`);
    }
  }
  const buildIdentity = await readJson(
    resolve(root, 'sdk-build-result.json'),
    'sdk-candidate-build-result-missing',
  );
  if (buildIdentity.viewCommit !== candidate.viewCommit)
    throw new Error('sdk-candidate-view-commit-mismatch');
  const gateNames = candidate.gates.map(({ name }) => name);
  if (
    gateNames.length !== CANDIDATE_GATES.length ||
    new Set(gateNames).size !== CANDIDATE_GATES.length ||
    CANDIDATE_GATES.some((name) => !gateNames.includes(name))
  ) {
    throw new Error(`sdk-candidate-gates-incomplete: ${gateNames.join(',')}`);
  }
  for (const gate of candidate.gates) {
    const reportPath = actualFiles.get(gate.report);
    if (reportPath === undefined)
      throw new Error(`sdk-candidate-gate-report-missing: ${gate.name}`);
    const digest = await digestFile(reportPath);
    if (digest.sha256 !== gate.sha256)
      throw new Error(`sdk-candidate-gate-report-mismatch: ${gate.name}`);
    const report = await readJson(reportPath, `sdk-candidate-gate-report-invalid: ${gate.name}`);
    if (!gatePassed(report)) throw new Error(`sdk-candidate-gate-failed: ${gate.name}`);
  }
  const artifactByPath = new Map(candidate.artifacts.map((entry) => [entry.path, entry]));
  const actualNpmPaths = new Set(
    [...actualFiles.keys()].filter((path) => path.startsWith('npm/') && path.endsWith('.tgz')),
  );
  const candidateNpmPaths = new Set(candidate.npmPackages.map(({ path }) => path));
  if (
    candidateNpmPaths.size !== candidate.npmPackages.length ||
    actualNpmPaths.size !== candidateNpmPaths.size ||
    [...actualNpmPaths].some((path) => !candidateNpmPaths.has(path))
  ) {
    throw new Error('sdk-candidate-npm-roster-mismatch');
  }
  const expectedRoster = ['@forgeax/engine', '@forgeax/view', '@forgeax/engine-sdk'];
  if (
    candidate.npmPackages.length !== expectedRoster.length ||
    candidate.npmPackages.some(
      (item, index) => item.name !== expectedRoster[index] || item.publishOrder !== index,
    )
  ) {
    throw new Error('sdk-candidate-npm-roster-invalid');
  }
  const npmOrders = new Set();
  const npmNames = new Set();
  for (const item of candidate.npmPackages) {
    if (item.version !== candidate.sdkVersion)
      throw new Error(`sdk-candidate-npm-version-mismatch: ${item.name}`);
    if (npmNames.has(item.name)) throw new Error('sdk-candidate-npm-name-duplicate');
    npmNames.add(item.name);
    if (npmOrders.has(item.publishOrder)) throw new Error('sdk-candidate-npm-order-duplicate');
    npmOrders.add(item.publishOrder);
    const artifact = artifactByPath.get(item.path);
    if (artifact === undefined) throw new Error(`sdk-candidate-npm-artifact-missing: ${item.name}`);
    const actual = await digestFile(resolve(root, item.path));
    if (actual.sha256 !== artifact.sha256 || actual.integrity !== item.integrity) {
      throw new Error(`sdk-candidate-npm-integrity-mismatch: ${item.name}`);
    }
    const archive = await packageArchive(resolve(root, item.path));
    if (archive.name !== item.name || archive.version !== item.version) {
      throw new Error(`sdk-candidate-npm-archive-identity-mismatch: ${item.name}`);
    }
  }
  if ([...npmOrders].sort((left, right) => left - right).some((order, index) => order !== index)) {
    throw new Error('sdk-candidate-npm-order-invalid');
  }
  return candidate;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);
  const candidateRoot = parsed.value('candidate') ?? parsed.value('output');
  if (typeof candidateRoot !== 'string')
    throw new Error('Usage: sdk-candidate.mjs <seal|verify> --output <path>');
  if (command === 'seal') {
    const candidate = await sealCandidate({
      candidateRoot,
      sdkVersion: parsed.value('version'),
      sourceWorkflowRunId: parsed.value('run-id') ?? process.env.GITHUB_RUN_ID,
      gateSpecs: parsed.values('gate'),
    });
    process.stdout.write(`${JSON.stringify(candidate)}\n`);
    return;
  }
  if (command === 'verify') {
    const candidate = await validateCandidate({
      candidateRoot,
      expectedVersion: parsed.value('version'),
      expectedEngineCommit: parsed.value('engine-commit'),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, candidateId: candidate.candidateId })}\n`);
    return;
  }
  throw new Error('sdk-candidate-command-invalid');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
