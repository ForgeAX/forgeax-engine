#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const FEATURE_ID = 'feat-20260812-format-classification-tier1';
export const CANDIDATE_BRANCH = ['codex', ['feat-20260810', 'format-classification-tier1'].join('-')].join('/');
export const OLD_FEATURE_ID = ['feat-20260810', 'format-classification-tier1'].join('-');
const RELEVANT_PATHS = ['apps/hello/format-tier1', 'scripts/forgeax'];

function git(root, args, allowFailure = false) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFailure) return '';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function lines(value) {
  return value.split('\n').filter(Boolean);
}

function refFiles(root, ref) {
  return lines(git(root, ['ls-tree', '-r', '--name-only', ref, '--', ...RELEVANT_PATHS]));
}

export function findRefHits(root, ref, pattern) {
  const output = git(
    root,
    ['grep', '-n', '-I', '-E', pattern, ref, '--', ...RELEVANT_PATHS],
    true,
  );
  return lines(output).map((rawLine) => {
    const line = rawLine.startsWith(`${ref}:`) ? rawLine.slice(ref.length + 1) : rawLine;
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    return {
      path: first >= 0 ? line.slice(0, first) : line,
      line: first >= 0 && second >= 0 ? Number(line.slice(first + 1, second)) : null,
      text: second >= 0 ? line.slice(second + 1).trim() : '',
    };
  });
}

function warning(code, detail, paths = []) {
  return { code, detail, paths };
}

function isAncestor(root, ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {cwd: root});
    return true;
  } catch {
    return false;
  }
}

function candidateAudit(root, candidateBranch, currentFiles) {
  const candidateSha = git(root, ['rev-parse', '--verify', candidateBranch], true);
  if (candidateSha === '') {
    return {
      branch: candidateBranch,
      sha: null,
      status: 'unavailable',
      candidateOnlyPaths: [],
      oldPathHits: [],
      passMarkers: [],
      pngArtifacts: [],
      supportClaims: [],
    };
  }
  const candidateFiles = refFiles(root, candidateBranch);
  const candidateOnlyPaths = candidateFiles.filter((path) => !currentFiles.has(path));
  const oldPathHits = findRefHits(root, candidateBranch, OLD_FEATURE_ID);
  const passMarkers = findRefHits(root, candidateBranch, '(^|[^[:alnum:]_])PASS([^[:alnum:]_]|$)');
  const pngArtifacts = candidateFiles.filter((path) => /\.png$/i.test(path));
  return {
    branch: candidateBranch,
    sha: candidateSha,
    status: 'audit-only',
    candidateOnlyPaths,
    oldPathHits,
    passMarkers,
    pngArtifacts,
    supportClaims: [],
  };
}

export function auditMigration({
  root = process.cwd(),
  featureId = FEATURE_ID,
  candidateBranch = CANDIDATE_BRANCH,
  currentRef = 'HEAD',
  mainRef = 'main',
} = {}) {
  if (featureId !== FEATURE_ID) {
    throw new Error(`featureId must be ${FEATURE_ID}`);
  }
  const currentSha = git(root, ['rev-parse', currentRef]);
  const mainSha = git(root, ['rev-parse', mainRef]);
  const currentFiles = new Set(lines(git(root, ['ls-tree', '-r', '--name-only', currentRef])));
  const candidate = candidateAudit(root, candidateBranch, currentFiles);
  const currentOldPathHits = findRefHits(root, currentRef, OLD_FEATURE_ID);
  const warnings = [];
  if (candidate.status === 'unavailable') {
    warnings.push(
      warning(
        'candidate-ref-unavailable',
        `Candidate ref ${candidate.branch} is not available in this checkout; candidate evidence remains audit-only and was not treated as support.`,
      ),
    );
  }
  if (candidate.candidateOnlyPaths.length > 0) {
    warnings.push(
      warning(
        'candidate-only-paths',
        'Candidate files are migration inputs only and were not copied.',
        candidate.candidateOnlyPaths,
      ),
    );
  }
  if (candidate.oldPathHits.length > 0) {
    warnings.push(
      warning(
        'old-feature-paths',
        `${OLD_FEATURE_ID} references remain on the candidate branch; keep them audit-only.`,
        candidate.oldPathHits.map((hit) => `${hit.path}:${hit.line}`),
      ),
    );
  }
  if (candidate.passMarkers.length > 0) {
    warnings.push(
      warning(
        'candidate-pass-markers',
        'Candidate PASS markers are not current-feature support evidence.',
        candidate.passMarkers.map((hit) => `${hit.path}:${hit.line}`),
      ),
    );
  }
  if (candidate.pngArtifacts.length > 0) {
    warnings.push(
      warning(
        'candidate-png-artifacts',
        'Candidate PNG artifacts are audit-only and were not copied.',
        candidate.pngArtifacts,
      ),
    );
  }
  const errors = [];
  if (currentOldPathHits.length > 0) {
    errors.push({
      code: 'current-old-feature-path',
      detail: 'The current feature tree contains the old feature identifier.',
      hits: currentOldPathHits,
    });
  }
  return {
    schemaVersion: 'format-tier1-migration-audit/1',
    featureId,
    current: {
      ref: currentRef,
      sha: currentSha,
      mainRef,
      mainSha,
      baselineAligned: currentSha === mainSha || isAncestor(root, mainSha, currentSha),
    },
    candidate,
    warnings,
    errors,
    status: errors.length === 0 ? 'audit-only' : 'blocked',
  };
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export async function runMigrationAudit(options = {}) {
  return auditMigration(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outputPath = argumentValue(args, '--output', '');
  const result = await runMigrationAudit({
    featureId: argumentValue(args, '--feature-id', FEATURE_ID),
    candidateBranch: argumentValue(args, '--candidate', CANDIDATE_BRANCH),
  }).catch((error) => ({
    schemaVersion: 'format-tier1-migration-audit/1',
    featureId: argumentValue(args, '--feature-id', FEATURE_ID),
    status: 'blocked',
    errors: [{code: 'audit-runner-failed', detail: error instanceof Error ? error.message : String(error)}],
    warnings: [],
  }));
  if (outputPath) await writeFile(resolve(process.cwd(), outputPath), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'blocked' || args.includes('--strict') && result.warnings.length > 0) process.exitCode = 1;
}
