#!/usr/bin/env node
// Transfer Browser reports once to the Runtime metric owner. The same-run
// identity and closed path inventory are checked before any file is imported.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const BROWSER_PATHS = Object.freeze([
  // Generic metrics consumes only these two pixel comparisons. Color-lighting
  // validates its full reports and captures inside the Browser producer.
  'report/pixel-parity.json',
  'report/pixel-parity-standard-lanes.json',
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stage') args.mode = 'stage';
    else if (arg === '--import') args.mode = 'import';
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--root') args.root = argv[++index];
    else if (arg === '--run-id') args.runId = argv[++index];
    else if (arg === '--run-attempt') args.runAttempt = argv[++index];
    else if (arg === '--head-sha') args.headSha = argv[++index];
    else if (arg === '--allow-earlier-attempt') args.allowEarlierAttempt = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function identity(args) {
  const runId = args.runId ?? process.env.GITHUB_RUN_ID ?? '';
  const runAttempt = args.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? '';
  const headSha = args.headSha ?? process.env.GITHUB_SHA ?? '';
  if (runId === '' || runAttempt === '' || headSha === '') {
    throw new Error('metrics evidence identity requires run ID, run attempt, and head SHA');
  }
  return {
    runId: String(runId),
    runAttempt: String(runAttempt),
    headSha: String(headSha),
  };
}

function pathExists(root, relativePath) {
  return existsSync(resolve(root, relativePath));
}

function copySelectedPaths(root, output, paths) {
  const presentPaths = [];
  for (const relativePath of paths) {
    const source = resolve(root, relativePath);
    if (!existsSync(source)) continue;
    const destination = resolve(output, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
    presentPaths.push(relativePath);
  }
  return presentPaths;
}

export function stageMetricsEvidence({ root, output, runId, runAttempt, headSha }) {
  const inputRoot = resolve(root ?? process.cwd());
  const outputRoot = resolve(output);
  const producerPaths = BROWSER_PATHS;
  const evidenceIdentity = identity({ runId, runAttempt, headSha });
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const presentPaths = copySelectedPaths(inputRoot, outputRoot, producerPaths);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    producer: 'browser',
    ...evidenceIdentity,
    requiredPaths: producerPaths,
    presentPaths,
  };
  writeFileSync(resolve(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readManifest(root, expectedIdentity, allowEarlierAttempt) {
  const expectedProducer = 'browser';
  const manifestPath = resolve(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${expectedProducer}: manifest.json is missing`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${expectedProducer}: manifest.json is invalid: ${error.message}`);
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`${expectedProducer}: unsupported manifest schema`);
  if (manifest.producer !== expectedProducer)
    throw new Error(`${expectedProducer}: producer identity mismatch`);
  for (const field of ['runId', 'headSha']) {
    if (manifest[field] !== expectedIdentity[field])
      throw new Error(
        `${expectedProducer}: ${field} mismatch (expected ${expectedIdentity[field]}, observed ${manifest[field] ?? 'missing'})`,
      );
  }
  const observedAttempt = Number(manifest.runAttempt);
  const expectedAttempt = Number(expectedIdentity.runAttempt);
  const attemptsMatch = manifest.runAttempt === expectedIdentity.runAttempt;
  const earlierAttempt =
    allowEarlierAttempt === true &&
    Number.isInteger(observedAttempt) &&
    observedAttempt >= 1 &&
    Number.isInteger(expectedAttempt) &&
    expectedAttempt >= 1 &&
    observedAttempt < expectedAttempt;
  if (!attemptsMatch && !earlierAttempt) {
    throw new Error(
      `${expectedProducer}: runAttempt mismatch (expected ${expectedIdentity.runAttempt}, observed ${manifest.runAttempt ?? 'missing'})`,
    );
  }
  const expectedPaths = BROWSER_PATHS;
  if (
    !Array.isArray(manifest.requiredPaths) ||
    manifest.requiredPaths.length !== expectedPaths.length ||
    manifest.requiredPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new Error(`${expectedProducer}: required evidence path manifest drifted`);
  }
  const missing = expectedPaths.filter((path) => !pathExists(root, path));
  if (missing.length > 0) {
    throw new Error(`${expectedProducer}: required evidence is missing: ${missing.join(', ')}`);
  }
  return manifest;
}

export function importMetricsEvidence({
  input,
  output,
  runId,
  runAttempt,
  headSha,
  allowEarlierAttempt = false,
  root = process.cwd(),
}) {
  const source = resolve(input);
  const destination = resolve(root, output ?? '.');
  const manifest = readManifest(
    source,
    identity({ runId, runAttempt, headSha }),
    allowEarlierAttempt,
  );
  // Derive the admitted files from the closed owner inventory, never from a
  // caller-controlled presentPaths field. Reject collisions before any copy.
  const files = BROWSER_PATHS;
  for (const file of files) {
    if (existsSync(resolve(destination, file)))
      throw new Error(`metrics evidence path collision: ${file}`);
  }
  for (const file of files) {
    const target = resolve(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(source, file), target, { force: false, errorOnExist: true });
  }
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error('an output directory is required');
  if (args.mode === 'stage') return stageMetricsEvidence(args);
  if (args.mode === 'import' && args.input) return importMetricsEvidence(args);
  throw new Error('choose --stage or --import --input <directory>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[metrics-evidence] FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
