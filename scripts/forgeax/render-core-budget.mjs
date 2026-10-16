#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '../..');

export const BUDGET_RULES = {
  version: 'ac-15-v1',
  lineMetric: 'non-empty-non-comment-source-lines',
  productionRoots: ['packages/render/src'],
  includeExtensions: ['.ts', '.tsx'],
  excludedPathParts: ['__tests__', 'fixtures', 'dist', 'coverage'],
  excludedFilePatterns: ['.d.ts', '.test.', '.spec.', '.bench.'],
  exportMetric: 'named-declarations-and-reexport-lines',
  sccMetric: 'relative-production-import-graph-tarjan',
};

export const BUDGET_THRESHOLDS = {
  productionCodeLines: 36_700,
  productionFiles: 120,
  rootExports: 72,
  authoringExports: 16,
  broadInternalExports: 0,
  constructRendererExports: 12,
  rendererGroups: 12,
  runtimeMaxScc: 1,
  publicRegistrationAuthorities: 1,
  deviceLifecycleRoots: 1,
  explicitAny: 0,
  highRiskCasts: 0,
  hostBackendDependencies: 0,
};

const EXACT_ONE_COUNTS = new Set(['publicRegistrationAuthorities', 'deviceLifecycleRoots']);

const rendererMember = (member) => ['renderer', member].join('.');
const STATIC_FORBIDDEN_PATTERNS = [
  rendererMember('store'),
  rendererMember('device'),
  rendererMember('shader'),
  rendererMember('input'),
  rendererMember('membershipTiming'),
  rendererMember('registerPipeline'),
  rendererMember('installPipeline'),
  `${rendererMember('postProcess')}.register`,
  rendererMember('_internal_'),
  'world._getGraph',
  'world._getArrayView',
  'world._routeError',
  'assets._guidForAsset',
  'IblPipelineDevice',
  'createMorphFeature',
  'createBuiltinMorphFeature',
  'createMembershipTiming',
  'RenderFeatureGraphBufferRegistry',
  'RenderFeatureGpuWorkResolver',
  'format: string',
  '@forgeax/engine-audio-webaudio',
  '@forgeax/engine-input',
  '@forgeax/engine-plugin',
  '@forgeax/engine-debug-draw',
  '@forgeax/engine-rhi-webgpu',
  '@forgeax/engine-rhi-wgpu',
  '@forgeax/engine-rhi-null',
  'expect(true).toBe(true)',
  'describe.skipIf',
  'passWithNoTests',
];

const HOST_BACKEND_PACKAGES = new Set([
  '@forgeax/engine-audio-webaudio',
  '@forgeax/engine-debug-draw',
  '@forgeax/engine-input',
  '@forgeax/engine-plugin',
  '@forgeax/engine-rhi-null',
  '@forgeax/engine-rhi-webgpu',
  '@forgeax/engine-rhi-wgpu',
]);

const LEDGER_KINDS = ['deleted', 'derived', 'migrated', 'added'];
const OBSERVATION_STATES = new Set(['absent', 'target', 'present']);

export const RENDER_CORE_LEDGER = {
  deleted: [
    {
      id: 'legacy-lifecycle-transaction',
      source: 'packages/render/src/device/lifecycle-transaction.ts',
    },
    { id: 'legacy-feature-graph-state', source: 'packages/render/src/features/graph-state.ts' },
    { id: 'legacy-manual-shadow-recorders', source: 'packages/render/src/render-system.ts' },
  ],
  derived: [
    {
      id: 'render-scene-types',
      source: 'packages/render/src/scene/render-scene.ts',
      destination: 'packages/render/src/scene/render-scene-types.ts',
    },
  ],
  migrated: [
    {
      id: 'dynamic-texture-device-adapter',
      source: 'packages/render/src/assembly/factory.ts',
      destination: 'packages/assets-runtime/src/dynamic-texture-store.ts',
    },
    {
      id: 'glyph-pick-residency-owner',
      source: 'packages/render/src/record/render-resource-table.ts',
      destination: 'packages/render/src/device/gpu-residency.ts',
    },
  ],
  added: [{ id: 'render-core-budget-gate', destination: 'scripts/forgeax/render-core-budget.mjs' }],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyLedger() {
  return { deleted: [], derived: [], migrated: [], added: [] };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

export function buildIdentityFor(sourceSha) {
  return `render-build-${sourceSha.slice(0, 12)}`;
}

function bindLedgerIdentity(ledger, sourceSha, buildIdentity) {
  const bound = clone(ledger);
  for (const kind of LEDGER_KINDS) {
    bound[kind] = (bound[kind] ?? []).map((entry) => ({
      ...entry,
      sourceSha: entry.sourceSha ?? sourceSha,
      buildId: entry.buildId ?? buildIdentity,
    }));
  }
  return bound;
}

function normalizeInventory(inventory) {
  const counts = {};
  for (const key of Object.keys(BUDGET_THRESHOLDS)) counts[key] = inventory?.[key] ?? 0;
  counts.staticForbiddenMatches = clone(inventory?.staticForbiddenMatches ?? []);
  return {
    counts,
    observations: clone(inventory?.observations ?? []),
  };
}

export function buildBudgetReport({
  sourceSha,
  buildIdentity = buildIdentityFor(sourceSha),
  inventory,
  ledger = emptyLedger(),
}) {
  const normalized = normalizeInventory(inventory);
  return {
    schemaVersion: '1.0.0',
    reportKind: 'render-core-budget',
    sourceSha,
    identity: { sourceSha, buildId: buildIdentity },
    rules: clone(BUDGET_RULES),
    thresholds: clone(BUDGET_THRESHOLDS),
    counts: normalized.counts,
    observations: normalized.observations,
    ledger: bindLedgerIdentity(ledger, sourceSha, buildIdentity),
  };
}

function validateLedger(ledger, errors, { sourceSha, buildIdentity } = {}) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    errors.push('ledger must be an object');
    return;
  }
  let totalEntries = 0;
  for (const kind of LEDGER_KINDS) {
    const entries = ledger[kind];
    if (!Array.isArray(entries)) {
      errors.push(`ledger.${kind} must be an array`);
      continue;
    }
    totalEntries += entries.length;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') {
        errors.push(`ledger.${kind} entries require an id`);
        continue;
      }
      if (sourceSha !== undefined && entry.sourceSha !== sourceSha)
        errors.push(`ledger.${kind}.${entry.id} source identity mismatch`);
      if (buildIdentity !== undefined && entry.buildId !== buildIdentity)
        errors.push(`ledger.${kind}.${entry.id} build identity mismatch`);
      if (kind === 'deleted' && typeof entry.source !== 'string')
        errors.push(`ledger.${kind}.${entry.id} requires a source`);
      if (kind === 'deleted' && entry.destination !== undefined) {
        errors.push(`ledger entry ${entry.id} calls a move a deletion; use migrated or derived`);
      }
      if ((kind === 'migrated' || kind === 'derived') && entry.destination === undefined) {
        errors.push(`ledger.${kind} entry ${entry.id} requires a destination`);
      }
      if ((kind === 'migrated' || kind === 'derived') && typeof entry.source !== 'string')
        errors.push(`ledger.${kind} entry ${entry.id} requires a source`);
      if (kind === 'added' && typeof entry.destination !== 'string')
        errors.push(`ledger.${kind} entry ${entry.id} requires a destination`);
      if (
        entry.source !== undefined &&
        entry.destination !== undefined &&
        entry.source === entry.destination
      ) {
        errors.push(`ledger entry ${entry.id} has identical source and destination`);
      }
    }
  }
  if (totalEntries === 0) errors.push('ledger must classify at least one architectural change');
}

export function validateBudgetReport(report, { sourceSha, currentSourceSha, buildIdentity } = {}) {
  const errors = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['budget report must be an object'] };
  }
  if (report.schemaVersion !== '1.0.0') errors.push('unsupported budget report schemaVersion');
  if (report.reportKind !== 'render-core-budget')
    errors.push('reportKind must be render-core-budget');
  if (!isSha(report.sourceSha))
    errors.push('source SHA must be a 40-character lowercase hexadecimal identity');
  if (sourceSha !== undefined && report.sourceSha !== sourceSha)
    errors.push('source SHA does not match requested identity');
  if (currentSourceSha !== undefined && report.sourceSha !== currentSourceSha)
    errors.push('source SHA does not match current HEAD');
  if (!sameJson(report.rules, BUDGET_RULES))
    errors.push('budget measurement rules or metric changed');
  if (!sameJson(report.thresholds, BUDGET_THRESHOLDS)) errors.push('budget thresholds changed');
  const expectedBuildIdentity = buildIdentity ?? buildIdentityFor(report.sourceSha ?? '');
  if (
    report.identity === null ||
    typeof report.identity !== 'object' ||
    report.identity.sourceSha !== report.sourceSha ||
    report.identity.buildId !== expectedBuildIdentity
  ) {
    errors.push('budget source/build identity is missing or mismatched');
  }

  if (report.counts === null || typeof report.counts !== 'object') {
    errors.push('counts must be an object');
  } else {
    for (const key of Object.keys(BUDGET_THRESHOLDS)) {
      if (!isCount(report.counts[key])) {
        errors.push(`counts.${key} must be a non-negative integer`);
      } else if (EXACT_ONE_COUNTS.has(key) && report.counts[key] !== 1) {
        errors.push(`budget requires exactly one ${key}, got ${report.counts[key]}`);
      } else if (report.counts[key] > BUDGET_THRESHOLDS[key]) {
        errors.push(
          `budget exceeded for ${key}: ${report.counts[key]} > ${BUDGET_THRESHOLDS[key]}`,
        );
      }
    }
    if (!Array.isArray(report.counts.staticForbiddenMatches)) {
      errors.push('counts.staticForbiddenMatches must be an array');
    } else if (report.counts.staticForbiddenMatches.length > 0) {
      errors.push('static forbidden items are present');
    }
  }

  if (!Array.isArray(report.observations)) {
    errors.push('observations must be an array');
  } else {
    const ids = new Set();
    const observations = new Map();
    for (const observation of report.observations) {
      if (
        observation === null ||
        typeof observation !== 'object' ||
        typeof observation.id !== 'string'
      ) {
        errors.push('observation requires an id');
        continue;
      }
      if (ids.has(observation.id)) errors.push(`duplicate observation ${observation.id}`);
      ids.add(observation.id);
      observations.set(observation.id, observation);
      if (!OBSERVATION_STATES.has(observation.state))
        errors.push(`invalid observation state for ${observation.id}`);
      if (
        (observation.state === 'absent' || observation.state === 'target') &&
        observation.measuredCount !== undefined
      ) {
        errors.push(`absent/target observation ${observation.id} must not carry a measured count`);
      }
      if (observation.state === 'present' && !isCount(observation.measuredCount)) {
        errors.push(`present observation ${observation.id} requires a measured count`);
      }
    }
    for (const id of ['legacy-urp', 'legacy-hdrp']) {
      if (observations.get(id)?.state !== 'absent') {
        errors.push(`${id} must be explicitly absent`);
      }
    }
    for (const id of ['standard-pipeline', 'device-scope']) {
      if (observations.get(id)?.state !== 'target') {
        errors.push(`${id} must be explicitly marked as the target authority`);
      }
    }
  }

  validateLedger(report.ledger, errors, {
    sourceSha: report.sourceSha,
    buildIdentity: expectedBuildIdentity,
  });
  return { ok: errors.length === 0, errors };
}

async function filesUnder(directory) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(path)));
    else output.push(path);
  }
  return output;
}

function isProductionFile(path) {
  const normalized = path.replaceAll('\\', '/');
  if (!BUDGET_RULES.includeExtensions.includes(extname(normalized))) return false;
  if (BUDGET_RULES.excludedPathParts.some((part) => normalized.split('/').includes(part)))
    return false;
  return !BUDGET_RULES.excludedFilePatterns.some((pattern) => normalized.includes(pattern));
}

function sourceLines(source) {
  return source.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== '' &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('/*') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('*/')
    );
  });
}

function countExports(source) {
  const declarations =
    source.match(
      /^\s*export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+[A-Za-z_$][\w$]*/gmu,
    ) ?? [];
  const namedLines = source.match(/^\s*export\s*\{[^}]*\}/gmu) ?? [];
  const starLines = source.match(/^\s*export\s+\*\s+from\s+/gmu) ?? [];
  return declarations.length + namedLines.length + starLines.length;
}

function resolveImport(fromPath, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromPath), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function buildImportGraph(files, sources) {
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, []]));
  const pattern =
    /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|import\s*\()(['"])(\.[^'"]+)\1/gmu;
  for (const file of files) {
    for (const match of sources.get(file).matchAll(pattern)) {
      const target = resolveImport(file, match[2], fileSet);
      if (target !== null) graph.get(file).push(target);
    }
  }
  return graph;
}

function largestScc(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  let largest = 0;
  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const child of graph.get(node) ?? []) {
      if (!indices.has(child)) {
        visit(child);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(child)));
      } else if (onStack.has(child)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(child)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    let size = 0;
    let child;
    do {
      child = stack.pop();
      onStack.delete(child);
      size += 1;
    } while (child !== node);
    largest = Math.max(largest, size);
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return largest;
}

function staticMatches(sources) {
  const matches = [];
  for (const [path, rawSource] of sources) {
    const source = stripComments(rawSource);
    const lines = source.split(/\r?\n/u);
    for (const pattern of STATIC_FORBIDDEN_PATTERNS) {
      const needle =
        pattern === 'format: string'
          ? /format\s*:\s*string/u
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u');
      for (let index = 0; index < lines.length; index += 1) {
        if (needle.test(lines[index]))
          matches.push({ pattern, path: relative(ROOT, path), line: index + 1 });
      }
    }
  }
  return matches;
}

async function packageHostBackendDependencies() {
  try {
    const packageJson = JSON.parse(
      await readFile(resolve(ROOT, 'packages/render/package.json'), 'utf8'),
    );
    return Object.keys({ ...packageJson.dependencies, ...packageJson.peerDependencies }).filter(
      (name) => HOST_BACKEND_PACKAGES.has(name),
    );
  } catch {
    return [];
  }
}

export async function collectBudgetInventory(rootDir = ROOT) {
  const productionFiles = [];
  for (const root of BUDGET_RULES.productionRoots) {
    const directory = resolve(rootDir, root);
    for (const path of await filesUnder(directory))
      if (isProductionFile(path)) productionFiles.push(path);
  }
  productionFiles.sort();
  const sources = new Map();
  for (const path of productionFiles) sources.set(path, await readFile(path, 'utf8'));
  const rootIndex = resolve(rootDir, 'packages/render/src/index.ts');
  const authoring = resolve(rootDir, 'packages/render/src/authoring.ts');
  const internal = resolve(rootDir, 'packages/render/src/internal.ts');
  const construct = resolve(rootDir, 'packages/render/src/construct-renderer.ts');
  const rendererFiles = productionFiles.filter((path) =>
    /(?:\/construct-renderer\.ts|\/assembly\/host-contract\.ts)$/u.test(path),
  );
  const rendererGroups = rendererFiles.length;
  const graph = buildImportGraph(productionFiles, sources);
  const allSource = [...sources.values()].join('\n');
  const executableSource = stripComments(allSource);
  const authorityPatterns = [/\bcreateRenderFeatureHost\b/u];
  const publicRegistrationAuthorities = new Set(
    authorityPatterns.flatMap((pattern) =>
      pattern.test(executableSource) ? [pattern.source] : [],
    ),
  ).size;
  const deviceLifecycleNames = [
    ...executableSource.matchAll(
      /\b(?:DeviceScope|RenderResourceTable|ShaderRegistry|IBLCache|SsaoCache)\b/gu,
    ),
  ].map((match) => match[0]);
  const observations = [
    {
      id: 'legacy-urp',
      state: /\bURP_PIPELINE_ID\b|urp-pipeline/iu.test(executableSource) ? 'present' : 'absent',
      ...(/\bURP_PIPELINE_ID\b|urp-pipeline/iu.test(executableSource) ? { measuredCount: 1 } : {}),
    },
    {
      id: 'legacy-hdrp',
      state: /\bhdrp-pipeline/iu.test(executableSource) ? 'present' : 'absent',
      ...(/\bhdrp-pipeline/iu.test(executableSource) ? { measuredCount: 1 } : {}),
    },
    { id: 'standard-pipeline', state: 'target' },
    { id: 'device-scope', state: 'target' },
  ];
  return {
    productionFiles: productionFiles.length,
    productionCodeLines: [...sources.values()].reduce(
      (total, source) => total + sourceLines(source).length,
      0,
    ),
    rootExports: sources.has(rootIndex) ? countExports(sources.get(rootIndex)) : 0,
    authoringExports: sources.has(authoring) ? countExports(sources.get(authoring)) : 0,
    broadInternalExports: sources.has(internal) ? countExports(sources.get(internal)) : 0,
    constructRendererExports: sources.has(construct) ? countExports(sources.get(construct)) : 0,
    rendererGroups,
    runtimeMaxScc: largestScc(graph),
    publicRegistrationAuthorities,
    deviceLifecycleRoots: new Set(deviceLifecycleNames.filter((name) => name === 'DeviceScope'))
      .size,
    explicitAny: (executableSource.match(/\bas\s+any\b|:\s*any\b|<any>/gu) ?? []).length,
    highRiskCasts: (executableSource.match(/\bas\s+unknown\s+as\b/gu) ?? []).length,
    hostBackendDependencies: await packageHostBackendDependencies().then((names) => names.length),
    staticForbiddenMatches: staticMatches(sources),
    observations,
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--verify') options.verify = true;
    else if (argument === '--json') options.json = true;
    else if (argument.startsWith('--source-sha='))
      options.sourceSha = argument.slice('--source-sha='.length);
    else if (argument === '--source-sha') options.sourceSha = args[++index];
    else if (argument.startsWith('--build-id='))
      options.buildIdentity = argument.slice('--build-id='.length);
    else if (argument === '--build-id') options.buildIdentity = args[++index];
    else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length);
    else if (argument === '--root') options.root = args[++index];
    else if (argument.startsWith('--output=')) options.output = argument.slice('--output='.length);
    else if (argument === '--output') options.output = args[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function currentHead(rootDir) {
  return execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/forgeax/render-core-budget.mjs --source-sha=<HEAD> [--verify] [--output=<path>] [--build-id=<id>]\n',
    );
    return;
  }
  if (!isSha(options.sourceSha))
    throw new Error('--source-sha must be a 40-character lowercase hexadecimal SHA');
  const rootDir = resolve(options.root ?? ROOT);
  const report = buildBudgetReport({
    sourceSha: options.sourceSha,
    buildIdentity: options.buildIdentity ?? buildIdentityFor(options.sourceSha),
    inventory: await collectBudgetInventory(rootDir),
    ledger: RENDER_CORE_LEDGER,
  });
  const result = validateBudgetReport(report, {
    sourceSha: options.sourceSha,
    currentSourceSha: currentHead(rootDir),
    buildIdentity: report.identity.buildId,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output !== undefined) await writeFile(resolve(options.output), output);
  if (options.json || options.output === undefined) process.stdout.write(output);
  if (!result.ok) {
    process.stderr.write(`FAIL render-core-budget: ${result.errors.join('; ')}\n`);
    if (options.verify) process.exitCode = 1;
  } else if (options.verify) {
    process.stdout.write('PASS render-core-budget\n');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`render-core-budget: ${error.message}\n`);
    process.exitCode = 2;
  });
}
