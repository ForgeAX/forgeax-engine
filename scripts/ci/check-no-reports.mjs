#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const uploadAction =
  /^(?:actions\/upload-artifact@|\.\/\.github\/actions\/(?:upload-artifact-with-retry|upload-optional-artifact)$)/u;

export function hasReportsComponent(path) {
  return typeof path === 'string' && path.replaceAll('\\', '/').split('/').includes('reports');
}

export function trackedReportViolations(paths) {
  return paths.filter(hasReportsComponent).map((path) => ({ code: 'tracked-reports', path }));
}

function includesReportLiteral(value) {
  if (hasReportsComponent(value)) return true;
  return [...value.matchAll(/(['"])(.*?)\1/gu)].some((match) => hasReportsComponent(match[2]));
}

function uploadPaths(value) {
  return String(value ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function uploadInputViolations({ name = '', path = '' }, { runtime = false } = {}) {
  const violations = [];
  if (/(?:^|[-_./])reports(?:$|[-_./])/u.test(name))
    violations.push({ code: 'reports-artifact-name', path: name });
  for (const pattern of uploadPaths(path)) {
    if (pattern.startsWith('!')) continue;
    if (includesReportLiteral(pattern))
      violations.push({ code: 'reports-upload-path', path: pattern });
    if (runtime && pattern.includes('${{'))
      violations.push({ code: 'unresolved-upload-path', path: pattern });
  }
  return violations;
}

function inputKey(input = {}) {
  return JSON.stringify([
    input.name ?? '',
    input.path ?? '',
    input['include-hidden-files'] ?? 'false',
  ]);
}

function checkedUploadInputs(step) {
  if (!step || step.if !== undefined) return undefined;
  if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false)
    return undefined;
  const command = String(step.run ?? '').trim();
  if (
    command !==
      'node "$GITHUB_ACTION_PATH/../../../scripts/ci/check-no-reports.mjs" --upload-inputs' &&
    command !== 'node scripts/ci/check-no-reports.mjs --upload-inputs'
  )
    return undefined;
  if (
    typeof step.env?.FORGEAX_ARTIFACT_PATH !== 'string' ||
    typeof step.env?.FORGEAX_ARTIFACT_NAME !== 'string'
  )
    return undefined;
  return inputKey({
    name: step.env.FORGEAX_ARTIFACT_NAME,
    path: step.env.FORGEAX_ARTIFACT_PATH,
    'include-hidden-files': step.env.FORGEAX_ARTIFACT_INCLUDE_HIDDEN ?? 'false',
  });
}

// Direct uploads must retain the default success condition. Wrappers can be
// invoked under always()/failure(); their own guard still controls transport.
function overridesGuardFailure(condition) {
  const text = String(condition ?? '')
    .replace(/^\s*\$\{\{|\}\}\s*$/gu, '')
    .trim();
  return text !== 'success()' && /\b(?:always|failure|cancelled|success)\s*\(/u.test(text);
}

/** Full YAML parsing preserves flow mappings, folded scalars and aliases. */
export async function workflowReportViolations(text, file = '<workflow>') {
  const { parseDocument } = await import('yaml');
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`);
  const violations = [];
  function visit(value, guarded = new Set()) {
    if (Array.isArray(value)) {
      const preceding = new Set(guarded);
      for (const item of value) {
        visit(item, preceding);
        const guard = checkedUploadInputs(item);
        if (guard !== undefined) preceding.add(guard);
      }
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (typeof value.uses === 'string' && uploadAction.test(value.uses)) {
      for (const entry of uploadInputViolations(value.with ?? {}))
        violations.push({ file, ...entry });
      // Every direct upload must be preceded by the actual resolved-input
      // checker for these same name/path expressions. No owner is exempted.
      if (
        value.uses.startsWith('actions/') &&
        (!guarded.has(inputKey(value.with)) || overridesGuardFailure(value.if))
      )
        violations.push({ file, code: 'unchecked-upload-selection', path: value.with.path });
    }
    for (const item of Object.values(value)) visit(item, guarded);
  }
  visit(document.toJS({ maxAliasCount: 100 }));
  return violations;
}

/** Use the upload owner's official selector, including hidden-file and exclusion semantics. */
export async function resolvedUploadViolations(input, cwd = process.cwd()) {
  const violations = uploadInputViolations(input, { runtime: true });
  if (violations.length) return violations;
  let create;
  try {
    ({ create } = await import('@actions/glob'));
  } catch (cause) {
    throw new Error(
      'Artifact selection is unverified: the declared @actions/glob dependency is unavailable; original evidence files remain unchanged.',
      { cause },
    );
  }
  const patterns = uploadPaths(input.path).map((pattern) =>
    pattern.startsWith('!') ? `!${resolve(cwd, pattern.slice(1))}` : resolve(cwd, pattern),
  );
  const globber = await create(patterns.join('\n'), {
    followSymbolicLinks: true,
    implicitDescendants: true,
    omitBrokenSymbolicLinks: true,
    excludeHiddenFiles: input.includeHiddenFiles !== 'true',
  });
  // The action executes in GITHUB_WORKSPACE. Tests use an explicit isolated root.
  const files = await globber.glob();
  for (const path of files)
    if (!statSync(resolve(cwd, path)).isDirectory() && hasReportsComponent(path))
      violations.push({ code: 'reports-upload-file', path });
  return violations;
}

async function main() {
  let violations;
  if (process.argv.includes('--upload-inputs')) {
    violations = await resolvedUploadViolations({
      name: process.env.FORGEAX_ARTIFACT_NAME,
      path: process.env.FORGEAX_ARTIFACT_PATH,
      includeHiddenFiles: process.env.FORGEAX_ARTIFACT_INCLUDE_HIDDEN,
    });
  } else {
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    violations = trackedReportViolations(paths);
    for (const file of paths.filter((path) =>
      /^\.github\/(?:workflows\/.*|actions\/.*\/action)\.ya?ml$/u.test(path),
    ))
      violations.push(
        ...(await workflowReportViolations(readFileSync(resolve(root, file), 'utf8'), file)),
      );
  }
  for (const entry of violations)
    process.stderr.write(`REPORTS_POLICY ${entry.file ?? ''}: ${entry.code}: ${entry.path}\n`);
  if (violations.length) process.exitCode = 1;
  else
    process.stdout.write(
      'Reports policy PASS (no tracked reports or report artifact selections)\n',
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`REPORTS_POLICY ${error.message}\n`);
    process.exitCode = 1;
  });
}
