#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '.wgsl',
  '.json',
  '.json5',
  '.schema',
  '.md',
]);
const executableExtensions = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.wgsl']);
const scanRoots = ['packages', 'apps', 'templates', 'scripts'];
const skippedPaths = new Set([
  'scripts/forgeax/check-standard-identity-cut.mjs',
  'scripts/forgeax/__tests__/check-standard-identity-cut.test.mjs',
  'scripts/forgeax/standard-identity-history-allowlist.json',
]);
const standardContext =
  /StandardProfile|standardProfile|DEFAULT_STANDARD_PROFILE|RenderPipelineAsset|renderPath|render-pipeline|pipelineId|engineId|standard-cluster/i;
const identityPattern = /forgeax::(?:urp|hdrp)\b/g;
const standardLightingPattern =
  /(?:\b["']?lighting["']?\s*:\s*["'](?:direct|clustered)["']|(?:^|[,{(\s])["']fallback["']?\s*:)/i;
const directModePattern = /(?:\b(?:mode|lane|path|lighting)\b\s*[=:]\s*["']direct["'])/i;
const retiredStandardErrorTokens = [
  'HdrpLightBudgetExceededError',
  'HdrpIndexListOverflowError',
  'HdrpDeferredCapsInsufficientError',
  'HdrpInstallError',
  'hdrp-light-budget-exceeded',
  'hdrp-index-list-overflow',
  'hdrp-deferred-caps-insufficient',
  'hdrp-grid-invalid',
  'isHdrpActive',
];

function isExecutable(path) {
  return executableExtensions.has(path.slice(path.lastIndexOf('.')));
}

function stripInlineComment(line, extension) {
  if (extension === '.wgsl') return line.replace(/\/\/.*$/, '');
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

function isNegativeAssertion(line) {
  return /(?:\.not\.|not\.to|doesNot|notMatch|reject|rejected|forbid|forbidden|must\s+not|never|negative|legacy\s+token)/i.test(
    line,
  );
}

function contextFor(line) {
  return line.trim().replace(/\s+/g, ' ').slice(0, 240);
}

function loadAllowlist(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schemaVersion !== 2 || !Array.isArray(value.entries)) {
    throw new Error('standard identity history allowlist must use schemaVersion 2');
  }
  const entries = new Map();
  for (const entry of value.entries) {
    if (
      typeof entry.path !== 'string' ||
      entry.path.includes('*') ||
      typeof entry.token !== 'string' ||
      typeof entry.reason !== 'string' ||
      typeof entry.expiry !== 'string' ||
      typeof entry.featureId !== 'string'
    ) {
      throw new Error('allowlist entries require exact path, token, reason, expiry, featureId');
    }
    if (executableExtensions.has(entry.path.slice(entry.path.lastIndexOf('.')))) {
      throw new Error(`executable path cannot be historical allowlisted: ${entry.path}`);
    }
    entries.set(`${entry.path}:${entry.token}`, entry);
  }
  return entries;
}

function walk(directory, output) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) walk(path, output);
    else if (sourceExtensions.has(path.slice(path.lastIndexOf('.')))) output.push(path);
  }
}

function findSemanticHits(relativePath, text) {
  const extension = relativePath.slice(relativePath.lastIndexOf('.'));
  const executable = isExecutable(relativePath);
  const hits = [];
  const lines = text.split('\n');
  for (const [index, originalLine] of lines.entries()) {
    const line = stripInlineComment(originalLine, extension);
    if (line.trim().length === 0 || isNegativeAssertion(originalLine)) continue;
    const localContext = lines
      .slice(Math.max(0, index - 8), Math.min(lines.length, index + 9))
      .join('\n');
    const hasStandardContext = standardContext.test(localContext);
    const matches = [];
    for (const token of retiredStandardErrorTokens) {
      if (line.includes(token)) {
        matches.push({ token, reason: 'retired Standard error token' });
      }
    }
    for (const match of line.matchAll(identityPattern)) {
      matches.push({ token: match[0], reason: 'retired profile identity' });
    }
    if (hasStandardContext && standardLightingPattern.test(line)) {
      const field = /fallback\s*:/i.test(line) ? 'fallback:' : 'lighting';
      matches.push({ token: field, reason: `legacy Standard ${field} field` });
    }
    if (hasStandardContext && directModePattern.test(line) && !/lighting\s*:/i.test(line)) {
      matches.push({ token: 'direct', reason: 'contextual Standard direct mode' });
    }
    for (const match of matches) {
      hits.push({
        channel: executable ? 'ts-script-wgsl' : 'json-schema',
        path: relativePath,
        line: index + 1,
        token: match.token,
        context: contextFor(originalLine),
        reason: match.reason,
      });
    }
  }
  return hits;
}

function auditStandardIdentity(repositoryRoot = root) {
  const allowlist = loadAllowlist(
    resolve(repositoryRoot, 'scripts/forgeax/standard-identity-history-allowlist.json'),
  );
  const files = [];
  for (const scanRoot of scanRoots) walk(resolve(repositoryRoot, scanRoot), files);
  const hits = [];
  for (const path of files) {
    const relativePath = relative(repositoryRoot, path);
    if (skippedPaths.has(relativePath)) continue;
    for (const hit of findSemanticHits(relativePath, readFileSync(path, 'utf8'))) {
      const allowlisted = allowlist.get(`${hit.path}:${hit.token}`);
      if (allowlisted && hit.channel !== 'ts-script-wgsl') continue;
      hits.push(hit);
    }
  }
  hits.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.token.localeCompare(b.token) ||
      a.context.localeCompare(b.context),
  );
  return {
    schemaVersion: 2,
    status: hits.length === 0 ? 'pass' : 'fail',
    channels: ['ts-script-wgsl', 'json-schema', 'historical'],
    hits,
  };
}

export { auditStandardIdentity, findSemanticHits };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = auditStandardIdentity(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `[standard-identity-cut] ${report.status}: ${report.hits.length} unallowlisted semantic legacy tokens`,
    );
    for (const hit of report.hits) {
      console.log(`${hit.path}:${hit.line} token=${hit.token} context=${hit.context}`);
    }
  }
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0 && process.argv[outputIndex + 1] !== undefined) {
    writeFileSync(resolve(process.argv[outputIndex + 1]), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = report.hits.length === 0 ? 0 : 1;
}
