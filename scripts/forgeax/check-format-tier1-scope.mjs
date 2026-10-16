#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  auditMigration,
  CANDIDATE_BRANCH,
  FEATURE_ID,
  findRefHits,
  OLD_FEATURE_ID,
} from '../../apps/hello/format-tier1/scripts/migration-audit.mjs';

const EXPECTED_CSV_SHA = 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5';
const EXPECTED_CSV_BYTES = 14749;
const EXPECTED_ROWS = [8, 18, 26];
const MATRIX_PATH = 'artifacts/format-tier1/support-matrix.json';
const CSV_PATH = 'artifacts/format-tier1/forgeax-format-classification.csv';

const M0_COHESION_FILES = Object.freeze({
  devkitIndex: 'packages/devkit/src/index.ts',
  packIndex: 'packages/pack/src/index.ts',
  sceneInstances: 'packages/scene/src/instances/scene-instances.ts',
  typesIndex: 'packages/types/src/index.ts',
});

const M0_COHESION_BASELINE = Object.freeze({
  devkitRootExports: 38,
  packInventoryExportModules: 2,
  sceneInstanceLines: 1564,
  typesIndexLines: 4856,
});

function countLinesInText(source) {
  return source.split('\n').length - 1;
}

function countRootExportDeclarations(source) {
  return [...source.matchAll(/^\s*export\b/gm)].length;
}

function countPackInventoryExportModules(root) {
  const source = readFileSync(resolve(root, M0_COHESION_FILES.packIndex), 'utf8');
  return new Set(
    [...source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter(
        (path) =>
          path === './scanner.js' ||
          path === './producer-contract.js' ||
          path === './inventory/index.js',
      ),
  ).size;
}

/** Return the small, JSON-safe M0 before/after cohesion snapshot. */
export function collectM0CohesionSnapshot(root = process.cwd()) {
  const devkitIndex = readFileSync(resolve(root, M0_COHESION_FILES.devkitIndex), 'utf8');
  const sceneInstances = readFileSync(resolve(root, M0_COHESION_FILES.sceneInstances), 'utf8');
  const typesIndex = readFileSync(resolve(root, M0_COHESION_FILES.typesIndex), 'utf8');
  return {
    schemaVersion: 1,
    files: M0_COHESION_FILES,
    metrics: {
      devkitRootExports: countRootExportDeclarations(devkitIndex),
      packInventoryExportModules: countPackInventoryExportModules(root),
      sceneInstanceLines: countLinesInText(sceneInstances),
      typesIndexLines: countLinesInText(typesIndex),
      assetReferenceDeclarations: [
        ...typesIndex.matchAll(/^export\s+interface\s+Asset(?:Ref|Envelope)\b/gm),
      ].map((match) => match[0]).length,
    },
  };
}

/** Compare a frozen pre-migration snapshot with the current checkout. */
export function compareM0CohesionSnapshots(before, after) {
  const beforeMetrics = before?.metrics ?? before;
  const afterMetrics = after?.metrics ?? after;
  const changes = Object.fromEntries(
    Object.keys(M0_COHESION_BASELINE).map((key) => [
      key,
      {
        before: beforeMetrics[key],
        after: afterMetrics[key],
        delta: afterMetrics[key] - beforeMetrics[key],
      },
    ]),
  );
  const reductions = [
    changes.devkitRootExports.delta < 0,
    changes.packInventoryExportModules.delta < 0,
    changes.sceneInstanceLines.delta < 0,
    changes.typesIndexLines.delta < 0,
  ];
  return {
    schemaVersion: 1,
    baseline: M0_COHESION_BASELINE,
    changes,
    status: reductions.every(Boolean) ? 'pass' : 'blocked',
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function csvRows(bytes) {
  const lines = bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split(/\r?\n/);
  const header = parseLine(lines[0] ?? '');
  return lines.slice(1).map((line) => {
    const fields = parseLine(line);
    return Object.fromEntries(header.map((key, index) => [key, fields[index] ?? '']));
  });
}

function matrixFailures(matrix, csvBytes, currentMainSha) {
  const failures = [];
  if (matrix.featureId !== FEATURE_ID) failures.push('matrix-feature-id');
  if (matrix.currentMainSha !== currentMainSha) failures.push('matrix-current-main-sha');
  if (matrix.source?.sha256 !== EXPECTED_CSV_SHA) failures.push('matrix-source-sha');
  if (matrix.source?.byteCount !== EXPECTED_CSV_BYTES) failures.push('matrix-source-byte-count');
  if (matrix.source?.dataRowCount !== 56) failures.push('matrix-source-row-count');
  if (JSON.stringify(matrix.source?.firstTierRows) !== JSON.stringify(EXPECTED_ROWS))
    failures.push('matrix-first-tier-rows');
  if (!matrix.source?.provenance?.requestedUrl) failures.push('matrix-requested-url');
  if (!matrix.source?.provenance?.resolvedUrl) failures.push('matrix-resolved-url');
  if (sha256(csvBytes) !== EXPECTED_CSV_SHA) failures.push('csv-sha');
  if (csvBytes.length !== EXPECTED_CSV_BYTES) failures.push('csv-byte-count');
  if (matrix.formats?.length !== EXPECTED_ROWS.length) failures.push('matrix-format-count');
  if (matrix.formats?.some((row) => row.sourceSha256 !== EXPECTED_CSV_SHA))
    failures.push('format-source-sha');
  if (matrix.formats?.some((row) => row.sourceCodeSha !== currentMainSha))
    failures.push('format-source-code-sha');
  if (matrix.formats?.some((row) => row.overallVerdict === 'supported'))
    failures.push('premature-supported-claim');
  return failures;
}

export async function checkFormatTier1Scope({
  root = process.cwd(),
  featureId = FEATURE_ID,
  candidateBranch = CANDIDATE_BRANCH,
} = {}) {
  const [csvBytes, matrixBytes] = await Promise.all([
    readFile(resolve(root, CSV_PATH)),
    readFile(resolve(root, MATRIX_PATH)),
  ]);
  const matrix = JSON.parse(matrixBytes);
  const audit = auditMigration({ root, featureId, candidateBranch });
  const rows = csvRows(csvBytes);
  const failures = matrixFailures(matrix, csvBytes, audit.current.mainSha);
  if (rows.length !== 56) failures.push('csv-row-count');
  const firstTierRows = rows
    .filter((row) => EXPECTED_ROWS.includes(Number(row['\u5e8f\u53f7'])))
    .map((row) => Number(row['\u5e8f\u53f7']));
  if (JSON.stringify(firstTierRows) !== JSON.stringify(EXPECTED_ROWS))
    failures.push('csv-first-tier-rows');
  const currentOldPathHits = findRefHits(root, 'HEAD', OLD_FEATURE_ID);
  if (currentOldPathHits.length > 0) failures.push('current-old-feature-path');
  const result = {
    schemaVersion: 'format-tier1-scope-check/1',
    criterionId: 'M1-format-tier1-scope-traceability',
    featureId,
    currentMainSha: audit.current.mainSha,
    currentHeadSha: audit.current.sha,
    candidateSha: audit.candidate.sha,
    csv: {
      path: CSV_PATH,
      sha256: sha256(csvBytes),
      byteCount: csvBytes.length,
      dataRowCount: rows.length,
      firstTierRows,
    },
    candidate: {
      status: 'audit-only',
      branch: candidateBranch,
      candidateOnlyPaths: audit.candidate.candidateOnlyPaths,
      oldPathHits: audit.candidate.oldPathHits,
      passMarkers: audit.candidate.passMarkers,
      pngArtifacts: audit.candidate.pngArtifacts,
      supportClaims: [],
    },
    warnings: audit.warnings,
    failures,
    status: failures.length === 0 ? 'audit-only' : 'blocked',
  };
  return result;
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outputPath = argumentValue(args, '--output', '');
  const result = await checkFormatTier1Scope({
    featureId: argumentValue(args, '--feature-id', FEATURE_ID),
    candidateBranch: argumentValue(args, '--candidate', CANDIDATE_BRANCH),
  }).catch((error) => ({
    schemaVersion: 'format-tier1-scope-check/1',
    criterionId: 'M1-format-tier1-scope-traceability',
    featureId: argumentValue(args, '--feature-id', FEATURE_ID),
    status: 'blocked',
    failures: ['scope-check-runner-failed'],
    error: error instanceof Error ? error.message : String(error),
  }));
  if (outputPath)
    await writeFile(resolve(process.cwd(), outputPath), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'blocked' || (args.includes('--strict') && result.warnings.length > 0))
    process.exitCode = 1;
}
