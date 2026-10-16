import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = resolve(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const auditScript = resolve(scriptDirectory, 'm0-branch-identity-audit.mjs');
const defaultFeatureDirectory = resolve(
  repositoryRoot,
  'artifacts/pack-baseline',
);

function runAudit(featureDirectory) {
  const output = execFileSync(process.execPath, [auditScript, '--feature-dir', featureDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function countLines(path) {
  return readFileSync(path, 'utf8').split('\n').length - 1;
}

function countRootExports(path) {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface)\b/gm)].length;
}

function countRuntimeExports(path) {
  if (!existsSync(path)) return 0;
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\b/gm)].length;
}

function countNamedExportClause(path, typeOnly) {
  const source = readFileSync(path, 'utf8');
  const keyword = typeOnly ? 'type\\s+' : '';
  const match = source.match(new RegExp(`export\\s+${keyword}\\{([^}]*)\\}`));
  if (match === null) return 0;
  return match[1]
    .split(',')
    .map((name) => name.trim().replace(/\s+as\s+.*$/, ''))
    .filter((name) => name.length > 0).length;
}

function findMaxFunctionLines(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  let maximum = 0;
  let start = null;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (start === null && /\bfunction\s+[A-Za-z0-9_$]+\s*\(/.test(lines[index])) {
      start = index;
      depth = 0;
    }
    if (start === null) continue;
    depth += (lines[index].match(/\{/g) ?? []).length;
    depth -= (lines[index].match(/\}/g) ?? []).length;
    if (depth <= 0 && index > start) {
      maximum = Math.max(maximum, index - start + 1);
      start = null;
    }
  }
  return maximum;
}

function hashStable(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function notMeasured(reason) {
  return { status: 'not-measured', value: null, reason };
}

function buildBehaviorEvidence(audit) {
  const reason = 'M0 records the baseline surface before owner instrumentation exists';
  return {
    status: 'not-measured',
    scannerExecutions: notMeasured(reason),
    producerExecutions: notMeasured(reason),
    decodeExecutions: notMeasured(reason),
    cookExecutions: notMeasured(reason),
    unchangedWatch: notMeasured(reason),
    closeDrain: notMeasured(reason),
    coldWarmDdcP95: {
      status: 'not-measured',
      coldMs: null,
      warmMs: null,
      regressionPercent: null,
      reason,
    },
    failureClassification: {
      staleOutput: {
        status: audit.distIdentity.classification === 'not-present' ? 'not-present' : 'classified',
        classification: audit.distIdentity.classification,
        observed: audit.distIdentity.status === 'present',
      },
      sourceFailure: {
        status: 'fixture-only',
        classification: 'real-source-failure',
        observed: false,
        reason: 'M0 has no injected source failure; later fixture task supplies this evidence',
      },
    },
  };
}

function isProductionSourcePath(path) {
  // Smoke, CI, maintenance, and evidence scripts are verification tooling,
  // not shipped producer/runtime source.
  return (
    /^(?:packages|apps|templates)\//.test(path) &&
    /\.(?:mjs|js|mts|ts|tsx)$/.test(path) &&
    !path.includes('/scripts/') &&
    !path.includes('/__tests__/') &&
    !path.includes('/bench/')
  );
}

function frozenM0Commit(featureDirectory) {
  const path = resolve(featureDirectory, 'evidence/m0-baseline.json');
  if (!existsSync(path)) {
    throw new Error(`frozen M0 evidence is required for final deletion accounting: ${path}`);
  }
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  const commit = baseline?.identity?.commitSha;
  if (typeof commit !== 'string' || commit.length === 0) {
    throw new Error(`frozen M0 evidence has no identity.commitSha: ${path}`);
  }
  return commit;
}

function gitCommitExists(commit) {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function countProductionDiff(audit, baseCommit) {
  const sourceCommit = audit.sourceIdentity.commitSha;
  if (!gitCommitExists(baseCommit)) {
    throw new Error(`frozen M0 baseline commit is unavailable in the checkout: ${baseCommit}`);
  }
  // PR merge refs can leave HEAD resolvable while omitting the synthetic commit
  // object from the local object store. Diffing the checked-out worktree keeps
  // final accounting equivalent without depending on that ephemeral object.
  const revisionMode = gitCommitExists(sourceCommit) ? 'commit-range' : 'checked-out-worktree';
  const revision = revisionMode === 'commit-range' ? `${baseCommit}..${sourceCommit}` : baseCommit;
  const output = execFileSync(
    'git',
    ['diff', '--numstat', revision, '--'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  let addedProductionLines = 0;
  let removedProductionLines = 0;
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const columns = line.split('\t');
    const added = Number(columns[0]);
    const removed = Number(columns[1]);
    const path = columns.slice(2).join('\t');
    if (!Number.isFinite(added) || !Number.isFinite(removed) || !isProductionSourcePath(path)) {
      continue;
    }
    addedProductionLines += added;
    removedProductionLines += removed;
  }
  return { addedProductionLines, removedProductionLines, revisionMode };
}

function buildDeletionLedger(audit, featureDirectory, finalMode) {
  if (finalMode) {
    const baseCommit = frozenM0Commit(featureDirectory);
    const { addedProductionLines, removedProductionLines, revisionMode } = countProductionDiff(
      audit,
      baseCommit,
    );
    return {
      status: 'measured',
      addedProductionLines,
      removedProductionLines,
      movedProductionLines: 0,
      netProductionLineChange: addedProductionLines - removedProductionLines,
      reason: 'Final mode compares the feature head with the frozen M0 implementation baseline.',
      sourceCommit: audit.sourceIdentity.commitSha,
      baseCommit,
      revisionMode,
    };
  }
  return {
    status: 'not-adjudicated',
    addedProductionLines: 0,
    removedProductionLines: 0,
    movedProductionLines: 0,
    netProductionLineChange: 0,
    reason: 'M0 has no before/after feature implementation revision to compare',
    sourceCommit: audit.sourceIdentity.commitSha,
  };
}

function buildStructuralEvidence(audit, finalMode) {
  const indexPath = resolve(repositoryRoot, 'packages/vite-plugin-pack/src/index.ts');
  const catalogClientPath = resolve(repositoryRoot, 'packages/vite-plugin-pack/src/catalog-client.ts');
  const files = audit.sourceIdentity.files.map((path) => resolve(repositoryRoot, path));
  const fileLines = files.map((path) => ({ path, lines: countLines(path) }));
  const largestFile = fileLines.reduce(
    (current, item) => (item.lines > current.lines ? item : current),
    { path: null, lines: 0 },
  );
  const largestFunction = files.reduce(
    (current, path) => {
      const lines = findMaxFunctionLines(path);
      return lines > current.lines ? { path, lines } : current;
    },
    { path: null, lines: 0 },
  );
  const thresholds = {
    productionFiles: 30,
    productionLines: 9500,
    largestFileLines: 700,
    largestFunctionLines: 250,
    rootRuntimeValues: 2,
    rootPublicTypes: 3,
    catalogClientRuntimeValues: 1,
    netProductionLinesRemoved: 1200,
  };
  const structural = {
    productionFiles: audit.sourceIdentity.fileCount,
    productionLines: audit.sourceIdentity.lines,
    largestFile,
    largestFunctionLines: largestFunction.lines,
    largestFunctionPath: largestFunction.path,
    rootExportDeclarations: countRootExports(indexPath),
    rootRuntimeValues: countNamedExportClause(indexPath, false),
    rootPublicTypes: countNamedExportClause(indexPath, true),
    catalogClientRuntimeValues: countRuntimeExports(catalogClientPath),
    packageExportKeys: audit.packageSurface.packageExportKeys,
    thresholds,
  };
  const staticBudgetPass =
    structural.productionFiles <= thresholds.productionFiles &&
    structural.productionLines <= thresholds.productionLines &&
    structural.largestFile.lines <= thresholds.largestFileLines &&
    structural.largestFunctionLines <= thresholds.largestFunctionLines &&
    structural.rootRuntimeValues <= thresholds.rootRuntimeValues &&
    structural.rootPublicTypes <= thresholds.rootPublicTypes &&
    structural.catalogClientRuntimeValues <= thresholds.catalogClientRuntimeValues;
  return {
    ...structural,
    budgetStatus: finalMode ? (staticBudgetPass ? 'pass' : 'fail') : 'not-adjudicated',
  };
}

function validateBaseline(baseline) {
  const required = [
    'schemaVersion',
    'featureId',
    'generatedAt',
    'identity',
    'structural',
    'behavior',
    'deletionLedger',
    'distIdentity',
  ];
  for (const key of required) {
    if (!(key in baseline)) throw new Error(`baseline missing field: ${key}`);
  }
  if (baseline.schemaVersion !== 1) throw new Error('unsupported baseline schema');
  if (baseline.distIdentity.classification === 'pass') throw new Error('dist cannot be marked pass');
  if (baseline.behavior.failureClassification.sourceFailure.observed) {
    throw new Error('baseline cannot claim an unexecuted source failure');
  }
  if (!baseline.finalMode && baseline.deletionLedger.status !== 'not-adjudicated') {
    throw new Error('M0 deletion ledger must remain unadjudicated');
  }
  if (baseline.finalMode && baseline.deletionLedger.status !== 'measured') {
    throw new Error('final baseline deletion ledger must be measured');
  }
}

function buildBaseline(featureDirectory, finalMode) {
  const audit = runAudit(featureDirectory);
  const baseline = {
    schemaVersion: 1,
    featureId: audit.featureId,
    generatedAt: new Date().toISOString(),
    identity: {
      commitSha: audit.sourceIdentity.commitSha,
      sourceSha256: audit.sourceIdentity.sha256,
      sourceFileCount: audit.sourceIdentity.fileCount,
      sourceLines: audit.sourceIdentity.lines,
      designSha256: audit.designIdentity.sha256,
      designMatchesExpected: audit.designIdentity.matchesExpected,
      base: audit.baseIdentity,
      repository: audit.repository,
      tools: audit.toolVersions,
    },
    structural: buildStructuralEvidence(audit, finalMode),
    behavior: buildBehaviorEvidence(audit),
    coldWarmDdcP95: {
      status: 'not-measured',
      baseline: null,
      reason: 'M0 does not infer performance from unrelated package benchmarks',
    },
    closeDrain: {
      status: 'not-measured',
      pendingTasks: null,
      settledTasks: null,
      reason: 'M0 records the field before ProductionSession instrumentation exists',
    },
    staleDistClassification: audit.distIdentity,
    sourceFailureClassification: {
      status: 'fixture-only',
      classification: 'real-source-failure',
      observed: false,
    },
    distIdentity: audit.distIdentity,
    protocolAnomalies: audit.protocolAnomalies,
    provenance: audit.provenance,
    baselineConflicts: audit.baselineConflicts,
    deletionLedger: buildDeletionLedger(audit, featureDirectory, finalMode),
    finalMode,
    sourceFailureAndStaleOutputAreDistinct: true,
  };
  if (finalMode) {
    const requiredReduction = baseline.structural.thresholds.netProductionLinesRemoved;
    const netRemoved = -baseline.deletionLedger.netProductionLineChange;
    if (netRemoved < requiredReduction) baseline.structural.budgetStatus = 'fail';
  }
  baseline.identity.stableFingerprint = hashStable({
    ...baseline,
    generatedAt: null,
    identity: { ...baseline.identity, repository: { ...baseline.identity.repository, statusEntries: [] } },
  });
  validateBaseline(baseline);
  return baseline;
}

function parseArgs(argv) {
  const args = {
    featureDirectory: process.env.FORGEAX_FEATURE_DIR ?? defaultFeatureDirectory,
    output: null,
    finalMode: process.env.FORGEAX_BASELINE_MODE === 'final',
    cohesion: false,
    before: null,
    runGates: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--feature-dir') args.featureDirectory = resolve(argv[++index]);
    else if (argv[index] === '--output') args.output = resolve(argv[++index]);
    else if (argv[index] === '--final') args.finalMode = true;
    else if (argv[index] === '--cohesion') args.cohesion = true;
    else if (argv[index] === '--before') args.before = resolve(argv[++index]);
    else if (argv[index] === '--run-gates') args.runGates = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.cohesion) {
  const { collectM0CohesionSnapshot, compareM0CohesionSnapshots } = await import(
    '../../../scripts/forgeax/check-format-tier1-scope.mjs'
  );
  const after = collectM0CohesionSnapshot(repositoryRoot);
  const before = args.before === null
    ? { schemaVersion: 1, metrics: {
        devkitRootExports: 38,
        packInventoryExportModules: 2,
        sceneInstanceLines: 1564,
        typesIndexLines: 4856,
      } }
    : JSON.parse(readFileSync(args.before, 'utf8'));
  const report = {
    schemaVersion: 1,
    milestone: 'M0',
    before,
    after,
    comparison: compareM0CohesionSnapshots(before, after),
    gates: [],
  };
  if (args.runGates) {
    for (const command of [['pnpm', ['test:layout']], ['pnpm', ['lint:internal']]]) {
      try {
        execFileSync(command[0], command[1], { cwd: repositoryRoot, stdio: 'pipe', encoding: 'utf8' });
        report.gates.push({ command: [command[0], ...command[1]].join(' '), status: 'pass' });
      } catch (error) {
        report.gates.push({
          command: [command[0], ...command[1]].join(' '),
          status: 'fail',
          output: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output !== null) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, serialized);
  }
  process.stdout.write(serialized);
  if (report.comparison.status !== 'pass' || report.gates.some((gate) => gate.status !== 'pass')) {
    process.exitCode = 1;
  }
} else {
const baseline = buildBaseline(args.featureDirectory, args.finalMode);
const serialized = `${JSON.stringify(baseline, null, 2)}\n`;
if (args.output !== null) {
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, serialized);
}
process.stdout.write(serialized);
}
