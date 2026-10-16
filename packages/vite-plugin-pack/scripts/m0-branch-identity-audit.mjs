import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = resolve(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const packageRoot = resolve(repositoryRoot, 'packages/vite-plugin-pack');
const defaultFeatureDirectory = resolve(
  repositoryRoot,
  'artifacts/pack-baseline',
);

function run(command, args = [], options = {}) {
  try {
    return {
      ok: true,
      value: execFileSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      value: error instanceof Error ? error.message : String(error),
    };
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectFiles(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...collectFiles(entryPath, predicate));
    } else if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function digestFiles(files) {
  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    const content = readFileSync(file);
    const relativePath = relative(repositoryRoot, file);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
    bytes += content.byteLength;
    lines += content.toString('utf8').split('\n').length - 1;
  }
  return { sha256: hash.digest('hex'), bytes, lines, fileCount: files.length };
}

function digestDirectory(directory) {
  return digestFiles(collectFiles(directory));
}

function digestBytes(file) {
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function gitValue(args) {
  const result = run('git', args);
  return result.ok ? result.value : null;
}

function hasGitRef(ref) {
  return run('git', ['show-ref', '--verify', '--quiet', ref]).ok;
}

function parseCount(value) {
  const [ahead, behind] = value.split(/\s+/).map(Number);
  return Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : null;
}

function readToolVersion(command, args) {
  let resolvedCommand = command;
  let resolvedArgs = args;
  if (command === 'pnpm' && args[0] === 'exec' && args[1] !== undefined) {
    const localBinary = resolve(repositoryRoot, 'node_modules/.bin', args[1]);
    if (existsSync(localBinary)) {
      resolvedCommand = localBinary;
      resolvedArgs = args.slice(2);
    }
  }
  const result = run(resolvedCommand, resolvedArgs);
  return result.ok ? result.value : `unavailable: ${result.value}`;
}

function readProtocolAnomalies(featureDirectory) {
  const path = resolve(featureDirectory, 'research-ingest-log.jsonl');
  if (!existsSync(path)) return { status: 'unavailable', records: [] };

  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((record) => record.gapId === 'g2' || record.gapId === 'g6')
    .map((record) => ({
      gapId: record.gapId,
      recordedStatus: record.status,
      workerStatus: record.workerStatus ?? null,
      protocolError: record.error ?? null,
      resultPaths: record.resultPaths ?? [],
    }));
  return { status: 'read', records };
}

function readUnresolvedProvenance(featureDirectory) {
  const designPath = resolve(featureDirectory, 'design.md');
  if (!existsSync(designPath)) return { status: 'unavailable', paths: [] };

  const paths = readFileSync(designPath, 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s+- (\.\.\/reports\/.*)$/)?.[1])
    .filter((path) => path !== undefined);
  return {
    status: paths.every((path) => existsSync(resolve(featureDirectory, path))) ? 'resolved' : 'unresolved',
    paths,
  };
}

function buildBaseIdentity() {
  const baseCandidates = ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
  const baseRef = baseCandidates.find((candidate) => hasGitRef(candidate)) ?? null;
  if (baseRef === null) {
    return { status: 'unresolved', ref: null, sha: null, mergeBase: null, ancestry: null };
  }

  const baseSha = gitValue(['rev-parse', baseRef]);
  const mergeBase = gitValue(['merge-base', 'HEAD', baseRef]);
  const counts = gitValue(['rev-list', '--left-right', '--count', `HEAD...${baseRef}`]);
  const isAncestor = run('git', ['merge-base', '--is-ancestor', baseRef, 'HEAD']).ok;
  return {
    status: baseSha === null || mergeBase === null || counts === null ? 'unresolved' : 'read',
    ref: baseRef,
    sha: baseSha,
    mergeBase,
    ancestry: counts === null ? null : { ...parseCount(counts), baseIsAncestorOfHead: isAncestor },
  };
}

function classifyDist(directory, sourceIdentity) {
  if (!existsSync(directory)) {
    return { status: 'absent', classification: 'not-present', identity: null, digest: null };
  }

  const digest = digestDirectory(directory);
  const identityPath = resolve(directory, '.forgeax-source-identity.json');
  if (!existsSync(identityPath)) {
    return {
      status: 'present',
      classification: 'unverified-stale-candidate',
      identity: null,
      digest,
    };
  }

  const identity = readJson(identityPath);
  const matches = identity.sourceSha256 === sourceIdentity.sha256;
  return {
    status: 'present',
    classification: matches ? 'identity-matched' : 'identity-mismatch',
    identity,
    digest,
  };
}

function validateAudit(audit) {
  const required = [
    'schemaVersion',
    'featureId',
    'generatedAt',
    'repository',
    'sourceIdentity',
    'baseIdentity',
    'toolVersions',
    'distIdentity',
    'protocolAnomalies',
    'provenance',
    'baselineConflicts',
  ];
  for (const key of required) {
    if (!(key in audit)) throw new Error(`identity audit missing field: ${key}`);
  }
  if (audit.schemaVersion !== 1) throw new Error('unsupported identity audit schema');
  if (audit.repository.worktreeRoot !== repositoryRoot) throw new Error('worktree root mismatch');
  if (!/^[0-9a-f]{40}$/.test(audit.sourceIdentity.commitSha)) {
    throw new Error('source commit is not a full SHA');
  }
  if (!/^[0-9a-f]{64}$/.test(audit.sourceIdentity.sha256)) {
    throw new Error('source digest is not SHA-256');
  }
  if (!Array.isArray(audit.protocolAnomalies.records)) throw new Error('protocol records must be an array');
  if (audit.distIdentity.classification === 'pass') throw new Error('dist classification cannot be pass');
}

function buildAudit(featureDirectory) {
  const sourceFiles = collectFiles(resolve(packageRoot, 'src'), (file) => file.endsWith('.ts'));
  const sourceIdentity = digestFiles(sourceFiles);
  const packageManifest = readJson(resolve(packageRoot, 'package.json'));
  const requirements = readJson(resolve(featureDirectory, 'requirements.json'));
  const designPath = resolve(featureDirectory, 'design.md');
  const designDigest = digestBytes(designPath);
  const expectedDesignSha = requirements.designAuthority?.sha256 ?? null;
  const status = gitValue(['status', '--short', '--untracked-files=all']);

  const audit = {
    schemaVersion: 1,
    featureId: 'feat-20260822-vite-plugin-pack-core-80-percent-architecture-redu',
    generatedAt: new Date().toISOString(),
    repository: {
      worktreeRoot: repositoryRoot,
      branch: gitValue(['branch', '--show-current']),
      commitSha: gitValue(['rev-parse', 'HEAD']),
      status: status === '' ? 'clean' : 'dirty',
      statusEntries: status === '' ? [] : status.split('\n'),
      upstream: gitValue(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    },
    sourceIdentity: {
      commitSha: gitValue(['rev-parse', 'HEAD']),
      ...sourceIdentity,
      files: sourceFiles.map((file) => relative(repositoryRoot, file)),
    },
    baseIdentity: buildBaseIdentity(),
    toolVersions: {
      node: readToolVersion('node', ['--version']),
      pnpm: readToolVersion('pnpm', ['--version']),
      git: readToolVersion('git', ['--version']),
      typescript: readToolVersion('pnpm', ['exec', 'tsc', '--version']),
      vite: readToolVersion('pnpm', ['exec', 'vite', '--version']),
      packageViteRange: packageManifest.peerDependencies?.vite ?? null,
      packageViteDevDependency: packageManifest.devDependencies?.vite ?? null,
    },
    distIdentity: {
      directory: relative(repositoryRoot, resolve(packageRoot, 'dist')),
      ...classifyDist(resolve(packageRoot, 'dist'), sourceIdentity),
    },
    designIdentity: {
      path: relative(repositoryRoot, designPath),
      sha256: designDigest,
      expectedSha256: expectedDesignSha,
      matchesExpected: expectedDesignSha === designDigest,
    },
    provenance: readUnresolvedProvenance(featureDirectory),
    protocolAnomalies: readProtocolAnomalies(featureDirectory),
    baselineConflicts: {
      historicalDesign: { productionFiles: 39, productionLines: 11972, status: 'historical-not-adjudicated' },
      partialResearch: { productionFiles: 31, productionLines: 9612, status: 'partial-not-adjudicated' },
      currentCheckout: { productionFiles: sourceIdentity.fileCount, productionLines: sourceIdentity.lines },
      decision: 'preserve-conflict-until-authority-adjudicates',
    },
    packageSurface: {
      productionSourceFiles: sourceIdentity.fileCount,
      productionSourceLines: sourceIdentity.lines,
      rootExportDeclarations: null,
      packageExportKeys: Object.keys(packageManifest.exports ?? {}).length,
    },
  };
  validateAudit(audit);
  return audit;
}

function parseArgs(argv) {
  const args = { featureDirectory: process.env.FORGEAX_FEATURE_DIR ?? defaultFeatureDirectory, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--feature-dir') args.featureDirectory = resolve(argv[++index]);
    else if (argv[index] === '--output') args.output = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const audit = buildAudit(args.featureDirectory);
const serialized = `${JSON.stringify(audit, null, 2)}\n`;
if (args.output !== null) {
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, serialized);
}
process.stdout.write(serialized);
