import {
  spawnSync as childSpawnSync,
  execFile as execFileCallback,
  spawn,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { developmentVersion, releasePolicy } from './release-policy.mjs';
import { SDK_NPM_PACKAGE_NAMES } from './sdk-lib.mjs';

const execFile = promisify(execFileCallback);
const stateWriteQueues = new WeakMap();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const OWNER = 'forgeax-sdk-local';
const NATIVE_INPUTS = [
  'packages/physics-rapier2d/pkg',
  'packages/physics-rapier3d/pkg',
  'packages/ui-blitz/pkg',
  'packages/wgpu-wasm/pkg',
  'packages/fbx/pkg',
  'packages/codec/pkg',
];
const LANES = [
  'native',
  'build',
  'reproducibility',
  'collision',
  'npm-diagnostics',
  'npm-js',
  'project',
  'source',
];
const SUBMODULES_BY_LANE = {
  native: ['third_party/blitz', 'third_party/wgpu'],
  build: ['forgeax-engine-assets'],
  reproducibility: [],
  collision: [],
  'npm-diagnostics': [],
  'npm-js': [],
  project: [],
  source: [],
};

function option(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (result === undefined || result.startsWith('--'))
    throw new Error(`local-sdk-option-value-missing: ${name}`);
  return result;
}

function has(name) {
  return args.includes(`--${name}`);
}

function git(cwd, ...gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`local-sdk-git-failed: ${gitArgs.join(' ')}: ${String(result.stderr).trim()}`);
  }
  return result.stdout.trim();
}

function githubRepository(name) {
  const remote = git(root, 'remote', 'get-url', 'origin');
  const match = /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(remote);
  if (!match) throw new Error('local-sdk-github-origin-invalid');
  return `${match[1]}/${name ?? match[2]}`;
}

function lanePath(run, name) {
  return resolve(run.worktreesRoot, name);
}

function spawnSync(command, commandArgs, options) {
  return childSpawnSync(command, commandArgs, options);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hardlinkTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await hardlinkTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await rm(destinationPath, { force: true });
      try {
        await link(sourcePath, destinationPath);
      } catch {
        await copyFile(sourcePath, destinationPath);
      }
    } else {
      throw new Error(`local-sdk-consumer-input-file-type: ${sourcePath}`);
    }
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function execCapture(
  command,
  commandArgs,
  { cwd = root, env = process.env, maxBuffer = 4 * 1024 * 1024 } = {},
) {
  const { stdout } = await execFile(command, commandArgs, { cwd, env, maxBuffer });
  return stdout.trim();
}

function pinnedNodePaths(home, version) {
  const nvmRoot = process.env.NVM_DIR ?? resolve(home, '.nvm');
  return [
    resolve(nvmRoot, 'versions/node', `v${version}`, 'bin/node'),
    resolve(home, '.local/share/mise/installs/node', version, 'bin/node'),
    resolve(home, '.fnm/node-versions', version, 'installation/bin/node'),
    resolve('/usr/local/nvm/versions/node', `v${version}`, 'bin/node'),
  ];
}

function reexecutePinnedNode(node) {
  const result = spawnSync(
    node,
    [resolve(root, 'scripts/forgeax/local-sdk-release.mjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: 'inherit',
      env: { ...process.env, FORGEAX_LOCAL_RELEASE_REEXEC: '1' },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return 'reexecuted';
}

async function tryPinnedNode(node, expected) {
  if (!(await exists(node))) return undefined;
  try {
    const actual = await execCapture(node, ['--version'], { cwd: root, maxBuffer: 4096 });
    if (actual !== expected) return undefined;
    return reexecutePinnedNode(node);
  } catch (cause) {
    if (cause?.status !== undefined) throw cause;
    return undefined;
  }
}

async function reexecuteAvailableNode(candidates, expected) {
  for (const candidate of candidates) {
    const result = await tryPinnedNode(candidate, expected);
    if (result) return result;
  }
  return undefined;
}

async function installPinnedNode(home, version, expected) {
  const cacheRoot = resolve(home, '.cache', 'forgeax-sdk-local');
  const installRoot = resolve(cacheRoot, `node-v${version}-linux-x64`);
  const installedNode = resolve(installRoot, 'bin/node');
  if (await exists(installedNode)) {
    const actual = await execCapture(installedNode, ['--version'], { cwd: root, maxBuffer: 4096 });
    if (actual !== expected) throw new Error('local-sdk-cached-node-version-mismatch');
    return installedNode;
  }

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(resolve(cacheRoot, `.node-${version}-`));
  try {
    const archiveName = `node-v${version}-linux-x64.tar.xz`;
    const releaseUrl = `https://nodejs.org/dist/v${version}`;
    const [archiveResponse, sumsResponse] = await Promise.all([
      fetch(`${releaseUrl}/${archiveName}`),
      fetch(`${releaseUrl}/SHASUMS256.txt`),
    ]);
    if (!archiveResponse.ok || !sumsResponse.ok) throw new Error('local-sdk-node-download-failed');
    const [archiveBytes, sums] = await Promise.all([
      archiveResponse.arrayBuffer().then((bytes) => Buffer.from(bytes)),
      sumsResponse.text(),
    ]);
    const checksumLine = sums.split(/\r?\n/).find((line) => line.trim().endsWith(archiveName));
    const expectedDigest = checksumLine?.trim().split(/\s+/)[0];
    const actualDigest = createHash('sha256').update(archiveBytes).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expectedDigest ?? '') || actualDigest !== expectedDigest) {
      throw new Error('local-sdk-node-archive-checksum-mismatch');
    }
    const archivePath = resolve(stagingRoot, archiveName);
    const extractRoot = resolve(stagingRoot, 'install');
    await writeFile(archivePath, archiveBytes, { mode: 0o600 });
    await mkdir(extractRoot);
    await execFile('tar', ['-xJf', archivePath, '--strip-components=1', '-C', extractRoot], {
      cwd: root,
      maxBuffer: 16 * 1024,
    });
    const stagedNode = resolve(extractRoot, 'bin/node');
    const actual = await execCapture(stagedNode, ['--version'], { cwd: root, maxBuffer: 4096 });
    if (actual !== expected) throw new Error('local-sdk-downloaded-node-version-mismatch');
    if (await exists(installRoot)) throw new Error('local-sdk-node-cache-install-race');
    await rename(extractRoot, installRoot);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return installedNode;
}

async function ensurePinnedNode() {
  const version = (await readFile(resolve(root, '.nvmrc'), 'utf8')).trim().replace(/^v/, '');
  const expected = `v${version}`;
  if (process.version === expected) {
    process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
    return;
  }
  if (process.env.FORGEAX_LOCAL_RELEASE_REEXEC === '1') {
    throw new Error(
      `local-sdk-node-version-mismatch: expected ${expected}, got ${process.version}`,
    );
  }
  const home = process.env.HOME ?? homedir();
  const reexecuted = await reexecuteAvailableNode(pinnedNodePaths(home, version), expected);
  if (reexecuted) return reexecuted;
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `local-sdk-host-unsupported: pinned Node bootstrap supports Linux x64; got ${process.platform}-${process.arch}`,
    );
  }
  const installedNode = await installPinnedNode(home, version, expected);
  return reexecutePinnedNode(installedNode);
}

async function validateCandidateRoot(options) {
  const { validateCandidate } = await import('./sdk-candidate.mjs');
  return validateCandidate(options);
}

async function runCommand(run, stepName, command, commandArgs, options = {}) {
  const logPath = resolve(run.root, 'logs', `${stepName.replace(/[^0-9A-Za-z._-]/g, '-')}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const fullArgs = [
    'run',
    '--mode',
    options.mode ?? 'shared',
    '--owner',
    OWNER,
    '--',
    command,
    ...commandArgs,
  ];
  const childEnvironment = { ...process.env, ...options.env };
  if (!options.npmAuth) {
    delete childEnvironment.NPM_TOKEN;
    delete childEnvironment.NODE_AUTH_TOKEN;
    delete childEnvironment.NPM_CONFIG_USERCONFIG;
  }
  if (!options.githubAuth) {
    delete childEnvironment.GH_TOKEN;
    delete childEnvironment.GITHUB_TOKEN;
    delete childEnvironment.FORGEAX_GAMES_GITHUB_TOKEN;
  }
  process.stdout.write(`[local SDK] ${stepName}\n`);
  const child = spawn('forgeax-task-gate', fullArgs, {
    cwd: options.cwd ?? root,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    log.write(chunk);
    if (!options.quietStdout) process.stdout.write(chunk);
    if (stdout.length < 2_000_000) stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    log.write(chunk);
    process.stderr.write(chunk);
    if (stderr.length < 200_000) stderr += chunk.toString();
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', accept);
  });
  await new Promise((accept, reject) => log.end((error) => (error ? reject(error) : accept())));
  if (code !== 0)
    throw new Error(`local-sdk-step-failed: ${stepName}; log=${logPath}; exit=${code}`);
  return { stdout, stderr, logPath };
}

async function step(run, name, action, verify = async () => true) {
  if (run.state.steps[name]?.status === 'passed' && (await verify())) {
    process.stdout.write(`[local SDK] reuse ${name}\n`);
    return;
  }
  run.state.steps[name] = { status: 'running', startedAt: new Date().toISOString() };
  run.state.lastFailure = undefined;
  await saveState(run);
  try {
    await action();
    run.state.steps[name] = { status: 'passed', completedAt: new Date().toISOString() };
    run.state.lastFailure = undefined;
    await saveState(run);
  } catch (cause) {
    run.state.steps[name] = {
      status: 'failed',
      failedAt: new Date().toISOString(),
      message: cause instanceof Error ? cause.message : String(cause),
    };
    run.state.lastFailure = { step: name, at: new Date().toISOString() };
    await saveState(run);
    throw cause;
  }
}

async function saveState(run) {
  const previous = stateWriteQueues.get(run) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      run.state.updatedAt = new Date().toISOString();
      await atomicJson(run.statePath, run.state);
      await atomicJson(resolve(run.base, 'current.json'), {
        schemaVersion: 1,
        version: run.version,
        sourceCommit: run.sourceCommit,
        runId: run.state.localRunId,
        status: run.state.status,
        statePath: run.statePath,
        updatedAt: run.state.updatedAt,
      });
    });
  stateWriteQueues.set(run, next);
  await next;
}

async function readRegistryTags(packageName) {
  const raw = await execCapture('npm', ['view', packageName, 'dist-tags', '--json'], { cwd: root });
  const result = JSON.parse(raw);
  const tags = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (typeof tags.latest !== 'string' || typeof tags.next !== 'string') {
    throw new Error(`local-sdk-registry-tags-invalid: ${packageName}`);
  }
  return tags;
}

async function findCommitByPrefix(branchTip, prefix) {
  if (!/^[0-9a-f]{12}$/.test(prefix)) throw new Error('local-sdk-source-sha-prefix-invalid');
  const commits = await execCapture('git', ['rev-list', branchTip], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  const matches = commits.split('\n').filter((commit) => commit.startsWith(prefix));
  if (matches.length !== 1)
    throw new Error(`local-sdk-source-prefix-match-count: ${prefix}: ${matches.length}`);
  return matches[0];
}

async function resumeCurrentRelease(base, requestedVersion) {
  if (requestedVersion) return undefined;
  const currentPath = resolve(base, 'current.json');
  if (!(await exists(currentPath))) return undefined;
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  if (current.status === 'complete') return undefined;
  const statePath = resolve(current.statePath);
  if (!(await exists(statePath))) return undefined;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  return { base, version: state.version, sourceCommit: state.sourceCommit, state };
}

async function resumeSelectedVersion(base, version, sourceCommit) {
  if (version === undefined) return undefined;
  if (releasePolicy(version).channel !== 'next')
    throw new Error('local-sdk-only-development-channel');
  const statePath = resolve(base, version, 'local-release-state.json');
  if (!(await exists(statePath))) return undefined;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (sourceCommit && sourceCommit !== state.sourceCommit)
    throw new Error('local-sdk-pinned-source-cannot-change');
  return { base, version, sourceCommit: state.sourceCommit, state };
}

async function resolveMainSource(version, requestedSource) {
  await execCapture(
    'git',
    ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    { cwd: root },
  );
  const branchTip = git(root, 'rev-parse', 'origin/main');
  let sourceCommit = requestedSource;
  if (version && sourceCommit === undefined) {
    const shaPrefix = version.match(/-dev\.[0-9]+\.([0-9a-f]{12})$/)?.[1];
    if (!shaPrefix) throw new Error('local-sdk-development-version-source-missing');
    sourceCommit = await findCommitByPrefix(branchTip, shaPrefix);
  }
  sourceCommit ??= branchTip;
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('local-sdk-source-sha-invalid');
  try {
    git(root, 'merge-base', '--is-ancestor', sourceCommit, branchTip);
  } catch {
    throw new Error(`local-sdk-source-not-on-main: ${sourceCommit}`);
  }
  return { sourceCommit, branchTip };
}

async function nextDevelopmentVersion(sourceCommit) {
  const [engineTags, sdkTags] = await Promise.all([
    readRegistryTags('@forgeax/engine'),
    readRegistryTags('@forgeax/engine-sdk'),
  ]);
  if (engineTags.latest !== sdkTags.latest || engineTags.next !== sdkTags.next) {
    throw new Error('local-sdk-registry-channel-tags-diverged');
  }
  return developmentVersion(engineTags.latest, engineTags.next, sourceCommit);
}

function assertVersionSource(version, sourceCommit) {
  releasePolicy(version);
  if (!version.endsWith(`.${sourceCommit.slice(0, 12)}`)) {
    throw new Error('local-sdk-version-source-mismatch');
  }
}

async function selectRelease() {
  const base = resolve(root, option('output') ?? 'artifacts/sdk-local');
  const requestedVersion = option('version');
  const requestedSha = option('source-sha');
  const current = await resumeCurrentRelease(base, requestedVersion);
  if (current) return current;
  const existing = await resumeSelectedVersion(base, requestedVersion, requestedSha);
  if (existing) return existing;

  const { sourceCommit, branchTip } = await resolveMainSource(requestedVersion, requestedSha);
  const version = requestedVersion || (await nextDevelopmentVersion(sourceCommit));
  assertVersionSource(version, sourceCommit);
  return { base, version, sourceCommit, branchTip };
}

async function createRun(selection) {
  const runRoot = resolve(selection.base, selection.version);
  const statePath = resolve(runRoot, 'local-release-state.json');
  if (!selection.state && (await exists(runRoot))) {
    const entries = await readdir(runRoot);
    if (entries.length > 0) throw new Error(`local-sdk-run-directory-unlocked: ${runRoot}`);
  }
  await mkdir(runRoot, { recursive: true });
  const state = selection.state ?? {
    schemaVersion: 1,
    localRunId: randomUUID(),
    version: selection.version,
    channel: 'next',
    sourceBranch: 'main',
    sourceCommit: selection.sourceCommit,
    sourceBranchTipAtSelection: selection.branchTip ?? selection.sourceCommit,
    witnessCommit: option('witness-sha') ?? selection.sourceCommit,
    controllerCommit: git(root, 'rev-parse', 'HEAD'),
    worktreesRoot: resolve(
      process.env.HOME ?? homedir(),
      '.worktrees',
      `forgeax-sdk-local-${selection.version}-${randomUUID().slice(0, 8)}`,
    ),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'candidate',
    steps: {},
    worktrees: {},
  };
  if (
    state.version !== selection.version ||
    state.sourceCommit !== selection.sourceCommit ||
    state.channel !== 'next'
  )
    throw new Error('local-sdk-run-lock-mismatch');
  state.worktreesRoot ??= resolve(
    process.env.HOME ?? homedir(),
    '.worktrees',
    `forgeax-sdk-local-${selection.version}-${state.localRunId.slice(0, 8)}`,
  );
  const run = {
    base: selection.base,
    root: runRoot,
    statePath,
    version: selection.version,
    sourceCommit: selection.sourceCommit,
    state,
    worktreesRoot: state.worktreesRoot,
    candidateRoot: resolve(runRoot, 'candidate'),
    seedPath: resolve(runRoot, 'candidate-seed/manifest.json'),
    reportsRoot: resolve(runRoot, 'consumer-results'),
  };
  await saveState(run);
  return run;
}

async function materializePinnedSource(run, worktree, relativePath, repository) {
  const treeEntry = git(worktree, 'ls-tree', 'HEAD', relativePath);
  const match = /^160000 commit ([0-9a-f]{40})\t/.exec(treeEntry);
  if (!match) return;
  const commit = match[1];
  const path = resolve(worktree, relativePath);
  if (await exists(resolve(path, '.git'))) {
    try {
      if (git(path, 'rev-parse', 'HEAD') === commit) return;
    } catch {}
  }
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  const label = relativePath.replaceAll('/', '-');
  await runCommand(run, `pin-${label}-init`, 'git', ['init', '--quiet', path], { cwd: worktree });
  await runCommand(
    run,
    `pin-${label}-remote`,
    'git',
    ['-C', path, 'remote', 'add', 'origin', `https://github.com/${repository}.git`],
    { cwd: worktree },
  );
  await runCommand(
    run,
    `pin-${label}-fetch`,
    'git',
    ['-C', path, 'fetch', '--quiet', '--depth=1', 'origin', commit],
    { cwd: worktree, env: releaseEnvironment() },
  );
  await runCommand(
    run,
    `pin-${label}-checkout`,
    'git',
    ['-C', path, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    { cwd: worktree },
  );
  if (git(path, 'rev-parse', 'HEAD') !== commit)
    throw new Error(`local-sdk-pinned-source-mismatch: ${relativePath}`);
}

async function assertWorktreeIdentity(run, name, path, errorCode) {
  const actual = git(path, 'rev-parse', 'HEAD');
  const expectedCommon = resolve(root, git(root, 'rev-parse', '--git-common-dir'));
  const actualCommon = resolve(path, git(path, 'rev-parse', '--git-common-dir'));
  if (actual !== run.sourceCommit || actualCommon !== expectedCommon) {
    throw new Error(`${errorCode}: ${name}`);
  }
}

async function ensureLaneWorktree(run, name, path) {
  if (run.state.worktrees[name] && (await exists(resolve(path, '.git')))) {
    await assertWorktreeIdentity(run, name, path, 'local-sdk-worktree-identity-mismatch');
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    if (!(await exists(resolve(path, '.git'))))
      throw new Error(`local-sdk-worktree-path-already-exists: ${path}`);
    await assertWorktreeIdentity(run, name, path, 'local-sdk-worktree-recovery-identity-mismatch');
  } else {
    await execCapture('git', ['worktree', 'add', '--detach', path, run.sourceCommit], {
      cwd: root,
    });
  }
  run.state.worktrees[name] = { path, sourceCommit: run.sourceCommit };
  await saveState(run);
}

async function prepareWorktreeSubmodules(run, name, path, stateKey) {
  if (!(await exists(resolve(path, '.gitmodules')))) return;
  const submodulePaths = name === 'mirror' ? undefined : (SUBMODULES_BY_LANE[name] ?? []);
  if (submodulePaths !== undefined && submodulePaths.length === 0) return;
  const submoduleArgs = ['submodule', 'update', '--init', '--recursive'];
  if (submodulePaths !== undefined) submoduleArgs.push('--', ...submodulePaths);
  await runCommand(run, `${stateKey}.submodules`, 'git', submoduleArgs, {
    cwd: path,
    env: releaseEnvironment(),
  });
}

async function prepareWorktreeLfs(run, name, path, stateKey) {
  if (name !== 'build' && name !== 'reproducibility' && name !== 'collision' && name !== 'mirror')
    return;
  if (!(await exists(resolve(path, '.gitattributes')))) return;
  const attributes = await readFile(resolve(path, '.gitattributes'), 'utf8');
  if (!attributes.includes('filter=lfs')) return;
  await runCommand(run, `${stateKey}.lfs`, 'git', ['lfs', 'pull'], {
    cwd: path,
    env: releaseEnvironment(),
  });
}

async function prepareMirrorSubmoduleLfs(run, name, path, stateKey) {
  if (name !== 'mirror') return;
  await runCommand(
    run,
    `${stateKey}.submodule-lfs`,
    'git',
    ['submodule', 'foreach', '--recursive', 'git lfs pull'],
    {
      cwd: path,
      env: releaseEnvironment(),
    },
  );
}

async function prepareWorktree(run, name) {
  const path = lanePath(run, name);
  const stateKey = `worktree.${name}`;
  await ensureLaneWorktree(run, name, path);
  await prepareWorktreeSubmodules(run, name, path, stateKey);
  await prepareWorktreeLfs(run, name, path, stateKey);
  await prepareMirrorSubmoduleLfs(run, name, path, stateKey);
  const sourceNode = (await readFile(resolve(path, '.nvmrc'), 'utf8')).trim().replace(/^v/, '');
  if (`v${sourceNode}` !== process.version)
    throw new Error(`local-sdk-source-node-version-mismatch: ${name}`);
  await materializePinnedSource(run, path, 'tools/view', githubRepository('forgeax-view'));
  await materializePinnedSource(
    run,
    path,
    'packages/modeling',
    githubRepository('forgeax-modeling'),
  );
  await preparePinnedNpm(run, path);
  const modulesPath = resolve(path, 'node_modules');
  const pnpmVersion = (await readFile(resolve(path, '.pnpm-version'), 'utf8')).trim();
  await step(run, `${stateKey}.pnpm`, () =>
    runCommand(
      run,
      `${stateKey}.pnpm`,
      'corepack',
      ['prepare', `pnpm@${pnpmVersion}`, '--activate'],
      { cwd: path },
    ),
  );
  await step(
    run,
    `${stateKey}.install`,
    () =>
      runCommand(
        run,
        `${stateKey}.install`,
        'pnpm',
        ['install', '--frozen-lockfile', '--ignore-scripts'],
        {
          cwd: path,
          env: releaseEnvironment(),
        },
      ),
    () => exists(resolve(modulesPath, '.modules.yaml')),
  );
  return path;
}

function releaseEnvironment() {
  const environment = { ...process.env };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) {
    environment.GH_TOKEN = token;
    environment.GITHUB_TOKEN = token;
  }
  const configIndex = Number(environment.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(configIndex) || configIndex < 0) {
    throw new Error('local-sdk-git-config-count-invalid');
  }
  environment.GIT_CONFIG_COUNT = String(configIndex + 1);
  environment[`GIT_CONFIG_KEY_${configIndex}`] = 'credential.helper';
  environment[`GIT_CONFIG_VALUE_${configIndex}`] = '!gh auth git-credential';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

async function sourceMirrorEnvironment(githubToken) {
  const environment = releaseEnvironment();
  const sourceToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? githubToken;
  let publicToken = process.env.FORGEAX_GAMES_GITHUB_TOKEN;
  const tokenFile = process.env.FORGEAX_GAMES_GITHUB_TOKEN_FILE;
  if (!publicToken && tokenFile) {
    const path = resolve(tokenFile);
    const info = await stat(path);
    if (!info.isFile()) throw new Error('local-sdk-public-mirror-token-file-invalid');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('local-sdk-public-mirror-token-file-must-be-private');
    }
    publicToken = (await readFile(path, 'utf8')).trim();
    if (!publicToken || /\s/.test(publicToken)) {
      throw new Error('local-sdk-public-mirror-token-file-invalid');
    }
  }
  publicToken ??= githubToken;
  if (!sourceToken || !publicToken) throw new Error('local-sdk-source-mirror-auth-required');
  environment.GH_TOKEN = sourceToken;
  environment.GITHUB_TOKEN = sourceToken;
  environment.FORGEAX_GAMES_GITHUB_TOKEN = publicToken;
  return environment;
}

async function ensureGitHubAuth() {
  const configuredToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (configuredToken) return configuredToken;
  try {
    const token = await execCapture('gh', ['auth', 'token'], { cwd: root, maxBuffer: 4096 });
    if (!token) throw new Error('empty-token');
    return token;
  } catch {
    throw new Error('local-sdk-github-auth-required: run gh auth login');
  }
}

async function verifyLocalHost(run) {
  run.xdgRuntimeDir = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-xdg-runtime-'));
  process.env.XDG_RUNTIME_DIR = run.xdgRuntimeDir;
  const required = ['Xvfb', 'google-chrome-beta', 'zip'];
  for (const command of required) {
    try {
      await execFile('which', [command], { cwd: root, maxBuffer: 4096 });
    } catch {
      throw new Error(`local-sdk-host-tool-missing: ${command}`);
    }
  }
  const icd = await runCommand(
    run,
    'resolve-lavapipe',
    process.execPath,
    ['scripts/ci/resolve-lavapipe-icd.mjs'],
    { cwd: root },
  );
  const path = icd.stdout.trim().split('\n').at(-1);
  if (!path) throw new Error('local-sdk-lavapipe-icd-missing');
  process.env.VK_ICD_FILENAMES = path;
  process.env.VK_DRIVER_FILES = path;
  process.env.LP_NUM_THREADS = '4';
  process.env.FORGEAX_CHROME_CHANNEL = 'chrome-beta';
  process.env.FORGEAX_BROWSER_HEADLESS = '0';
  process.env.FORGEAX_TEMPLATE_SMOKE_SERVER_STARTUP_TIMEOUT_MS = '180000';
}

async function preparePinnedNpm(run, worktree) {
  const npmVersion = (await readFile(resolve(worktree, '.npm-version'), 'utf8')).trim();
  const installRoot = resolve(run.root, 'tools', `npm-${npmVersion}`);
  const npmPath = resolve(installRoot, 'node_modules/.bin/npm');
  let actual;
  if (await exists(npmPath)) {
    try {
      actual = await execCapture(npmPath, ['--version'], { cwd: worktree });
    } catch {
      actual = undefined;
    }
  }
  if (actual !== npmVersion) {
    await rm(installRoot, { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });
    await runCommand(
      run,
      'install-pinned-npm',
      'npm',
      [
        'install',
        '--prefix',
        installRoot,
        '--no-save',
        '--ignore-scripts',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        `npm@${npmVersion}`,
      ],
      { cwd: worktree },
    );
    actual = await execCapture(npmPath, ['--version'], { cwd: worktree });
  }
  if (actual !== npmVersion) throw new Error('local-sdk-pinned-npm-version-mismatch');
  process.env.PATH = `${dirname(npmPath)}:${process.env.PATH}`;
}

async function prepareNativeInputs(run) {
  const native = await prepareWorktree(run, 'native');
  const env = releaseEnvironment();
  for (const dimension of ['2d', '3d']) {
    const verifyArgs = ['scripts/forgeax/build-rapier-native.mjs', dimension, '--verify'];
    let ready = true;
    try {
      await runCommand(run, `rapier-${dimension}-verify`, process.execPath, verifyArgs, {
        cwd: native,
        env,
      });
    } catch {
      ready = false;
    }
    if (!ready) {
      try {
        await runCommand(
          run,
          `rapier-${dimension}-hydrate`,
          process.execPath,
          ['scripts/ci/rapier-release-payload.mjs', '--hydrate', dimension],
          { cwd: native, env },
        );
        await runCommand(run, `rapier-${dimension}-verify-hydrated`, process.execPath, verifyArgs, {
          cwd: native,
          env,
        });
        ready = true;
      } catch {
        ready = false;
      }
      if (!ready) {
        await runCommand(
          run,
          `rapier-${dimension}-build`,
          process.execPath,
          ['scripts/forgeax/build-rapier-native.mjs', dimension],
          { cwd: native, env },
        );
        await runCommand(run, `rapier-${dimension}-verify-final`, process.execPath, verifyArgs, {
          cwd: native,
          env,
        });
      }
    }
  }
  const uiPackage = resolve(native, 'packages/ui-blitz/Cargo.toml');
  if (await exists(uiPackage)) {
    try {
      await runCommand(
        run,
        'ui-blitz-verify',
        process.execPath,
        ['packages/ui-blitz/scripts/verify-current.mjs'],
        { cwd: native, env },
      );
    } catch {
      try {
        await runCommand(
          run,
          'ui-blitz-ensure',
          process.execPath,
          ['packages/ui-blitz/scripts/ensure-wasm.mjs'],
          { cwd: native, env },
        );
      } catch {}
      try {
        await runCommand(
          run,
          'ui-blitz-verify-hydrated',
          process.execPath,
          ['packages/ui-blitz/scripts/verify-current.mjs'],
          { cwd: native, env },
        );
      } catch {
        await runCommand(
          run,
          'ui-blitz-build',
          process.execPath,
          ['packages/ui-blitz/scripts/build-wasm.mjs'],
          { cwd: native, env },
        );
        await runCommand(
          run,
          'ui-blitz-verify-final',
          process.execPath,
          ['packages/ui-blitz/scripts/verify-current.mjs'],
          { cwd: native, env },
        );
      }
    }
  }
  try {
    await runCommand(
      run,
      'wgpu-wasm-fetch',
      'pnpm',
      ['-F', '@forgeax/engine-wgpu-wasm', 'fetch-wasm'],
      { cwd: native, env },
    );
  } catch {}
  try {
    await runCommand(
      run,
      'wgpu-wasm-verify',
      process.execPath,
      ['packages/wgpu-wasm/scripts/verify-current.mjs'],
      { cwd: native, env },
    );
  } catch {
    await runCommand(
      run,
      'wgpu-wasm-build',
      'pnpm',
      ['-F', '@forgeax/engine-wgpu-wasm', 'build:wasm'],
      { cwd: native, env },
    );
    await runCommand(
      run,
      'wgpu-wasm-verify-final',
      process.execPath,
      ['packages/wgpu-wasm/scripts/verify-current.mjs'],
      { cwd: native, env },
    );
  }
  for (const owner of ['fbx', 'codec']) {
    await runCommand(
      run,
      `${owner}-wasm-ensure`,
      process.execPath,
      [`packages/${owner}/scripts/ensure-wasm.mjs`],
      { cwd: native, env },
    );
  }
  const availableInputs = [];
  for (const path of NATIVE_INPUTS) {
    if (await exists(resolve(native, path))) availableInputs.push(path);
  }
  await writeFile(
    resolve(run.root, 'native-inputs-ready.json'),
    `${JSON.stringify({ sourceCommit: run.sourceCommit, completedAt: new Date().toISOString(), inputs: availableInputs })}\n`,
  );
  return native;
}

async function copyNativeInputs(run, native, laneName, lane) {
  for (const relative of NATIVE_INPUTS) {
    const source = resolve(native, relative);
    if (!(await exists(source))) continue;
    const destination = resolve(lane, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  }
  run.state.worktrees[laneName].nativeInputsCopied = true;
  await saveState(run);
}

async function mountSharedSubmodule(run, sourceLaneName, targetLaneName, relativePath) {
  const source = resolve(lanePath(run, sourceLaneName), relativePath);
  if (!(await exists(resolve(source, '.git'))))
    throw new Error(`local-sdk-shared-submodule-missing: ${relativePath}`);
  const expectedEntry = git(lanePath(run, targetLaneName), 'ls-tree', 'HEAD', relativePath);
  const expectedCommit = /^160000 commit ([0-9a-f]{40})\t/.exec(expectedEntry)?.[1];
  const actualCommit = git(source, 'rev-parse', 'HEAD');
  if (!expectedCommit || expectedCommit !== actualCommit) {
    throw new Error(`local-sdk-shared-submodule-pin-mismatch: ${relativePath}`);
  }
  const target = resolve(lanePath(run, targetLaneName), relativePath);
  await mkdir(dirname(target), { recursive: true });
  const registered = await execCapture('git', ['-C', source, 'worktree', 'list', '--porcelain'], {
    cwd: source,
  });
  const registeredTarget = registered.split(/\n\s*\n/).some((entry) => {
    const fields = Object.fromEntries(
      entry.split('\n').map((line) => {
        const separator = line.indexOf(' ');
        return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    return resolve(fields.worktree ?? '') === target && fields.HEAD === expectedCommit;
  });
  if (!registeredTarget) {
    await rm(target, { recursive: true, force: true });
    await runCommand(
      run,
      `shared-${targetLaneName}-${relativePath.replaceAll('/', '-')}`,
      'git',
      ['-C', source, 'worktree', 'add', '--detach', target, expectedCommit],
      { cwd: source, env: releaseEnvironment() },
    );
  }
  if (git(target, 'rev-parse', 'HEAD') !== expectedCommit) {
    throw new Error(`local-sdk-shared-submodule-worktree-pin-mismatch: ${relativePath}`);
  }
  run.state.sharedSubmoduleWorktrees ??= {};
  run.state.sharedSubmoduleWorktrees[`${targetLaneName}:${relativePath}`] = {
    sourcePath: source,
    targetPath: target,
    commit: expectedCommit,
  };
  await saveState(run);
}

async function prepareController(run) {
  await ensureGitHubAuth();
  await materializePinnedSource(run, root, 'tools/view', githubRepository('forgeax-view'));
  await materializePinnedSource(
    run,
    root,
    'packages/modeling',
    githubRepository('forgeax-modeling'),
  );
  const controllerPnpm = (await readFile(resolve(root, '.pnpm-version'), 'utf8')).trim();
  await step(run, 'controller-pnpm', () =>
    runCommand(
      run,
      'controller-pnpm',
      'corepack',
      ['prepare', `pnpm@${controllerPnpm}`, '--activate'],
      { cwd: root },
    ),
  );
  await preparePinnedNpm(run, root);
  await step(
    run,
    'controller-install',
    () =>
      runCommand(
        run,
        'controller-install',
        'pnpm',
        ['install', '--frozen-lockfile', '--ignore-scripts'],
        {
          cwd: root,
          env: releaseEnvironment(),
        },
      ),
    () => exists(resolve(root, 'node_modules/.modules.yaml')),
  );
}

async function prepareLanes(run) {
  await verifyLocalHost(run);
  await prepareController(run);
  for (const name of LANES) await prepareWorktree(run, name);
  const native = lanePath(run, 'native');
  await step(
    run,
    'native-inputs',
    () => prepareNativeInputs(run),
    async () => {
      try {
        const receipt = JSON.parse(
          await readFile(resolve(run.root, 'native-inputs-ready.json'), 'utf8'),
        );
        const required = [
          'packages/physics-rapier2d/pkg',
          'packages/physics-rapier3d/pkg',
          'packages/wgpu-wasm/pkg',
          'packages/fbx/pkg',
          'packages/codec/pkg',
        ];
        const current = await Promise.all(required.map((path) => exists(resolve(native, path))));
        return (
          receipt.sourceCommit === run.sourceCommit &&
          required.every((path, index) => receipt.inputs.includes(path) && current[index])
        );
      } catch {
        return false;
      }
    },
  );
  for (const name of LANES.filter((item) => item !== 'native')) {
    const lane = lanePath(run, name);
    if (!run.state.worktrees[name].nativeInputsCopied)
      await copyNativeInputs(run, native, name, lane);
  }
  for (const lane of ['build', 'reproducibility', 'collision']) {
    await mountSharedSubmodule(run, 'native', lane, 'third_party/blitz');
    await mountSharedSubmodule(run, 'native', lane, 'third_party/wgpu');
  }
  for (const lane of ['reproducibility', 'collision']) {
    await mountSharedSubmodule(run, 'build', lane, 'forgeax-engine-assets');
  }
}

async function hashNpmArchives(directory) {
  const npmRoot = resolve(directory, 'npm');
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.tgz')) files.push(entryPath);
    }
  }
  await visit(npmRoot);
  files.sort();
  if (files.length === 0) throw new Error('local-sdk-npm-archives-missing');
  const entries = [];
  for (const path of files) {
    const bytes = await readFile(path);
    entries.push({
      name: basename(path),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  if (entries.length !== SDK_NPM_PACKAGE_NAMES.length)
    throw new Error('local-sdk-npm-package-count-mismatch');
  return entries;
}

async function runCandidate(run) {
  const buildLane = lanePath(run, 'build');
  const reproLane = lanePath(run, 'reproducibility');
  const collisionLane = lanePath(run, 'collision');
  const reproRoot = resolve(run.root, 'reproducibility-build');
  const templateReportPath = resolve(run.root, 'template-smoke/report.json');

  const buildChecks = await Promise.allSettled([
    step(
      run,
      'seed-build',
      async () => {
        await rm(resolve(run.root, 'consumer-inputs'), { recursive: true, force: true });
        await rm(run.reportsRoot, { recursive: true, force: true });
        await rm(run.seedPath, { force: true });
        await rm(resolve(run.root, 'gates/consumers'), { recursive: true, force: true });
        for (const name of [
          'candidate-seed-manifest',
          'aggregate-consumers',
          'seal-candidate',
          ...['npm-diagnostics', 'npm-js', 'project', 'source'].map((item) => `consumer.${item}`),
        ]) {
          delete run.state.steps[name];
        }
        await saveState(run);
        await runCommand(
          run,
          'seed-build',
          'pnpm',
          ['sdk:build', '--', '--version', run.version, '--output', run.candidateRoot],
          { cwd: buildLane },
        );
      },
      async () => {
        try {
          const receipt = JSON.parse(
            await readFile(resolve(run.candidateRoot, 'sdk-build-result.json'), 'utf8'),
          );
          return (
            receipt.ok === true &&
            receipt.sdkVersion === run.version &&
            receipt.engineCommit === run.sourceCommit
          );
        } catch {
          return false;
        }
      },
    ),
    step(
      run,
      'collision-journey',
      async () => {
        const collisionEnv = {
          FORGEAX_TEMPLATE_SMOKE_SLUGS: 'game-3d',
          FORGEAX_TEMPLATE_SMOKE_GAME3D_COLLISION_MODE: 'required',
          FORGEAX_TEMPLATE_SMOKE_DIR: resolve(run.root, 'template-smoke'),
        };
        await runCommand(run, 'collision-build-engine', 'pnpm', ['build:engine'], {
          cwd: collisionLane,
        });
        await runCommand(run, 'collision-build-preview', 'pnpm', ['build:app', 'preview'], {
          cwd: collisionLane,
        });
        const witness = {
          sourceCommit: run.sourceCommit,
          witnessCommit: run.state.witnessCommit,
          witnessScriptBlob: git(
            collisionLane,
            'hash-object',
            'apps/preview/scripts/smoke-templates.mjs',
          ),
        };
        await mkdir(resolve(run.root, 'gates'), { recursive: true });
        await writeFile(
          resolve(run.root, 'gates/collision-witness.json'),
          `${JSON.stringify(witness)}\n`,
        );
        await runCommand(
          run,
          'collision-template-smoke',
          'xvfb-run',
          ['-a', 'pnpm', '--filter', '@forgeax/preview', 'smoke:templates'],
          { cwd: collisionLane, env: collisionEnv },
        );
        const template = JSON.parse(await readFile(templateReportPath, 'utf8'));
        if (template.status !== 'passed')
          throw new Error(`local-sdk-template-collision-status: ${template.status}`);
        await writeFile(
          resolve(run.root, 'gates/collision-template.json'),
          `${JSON.stringify({ template, witness }, null, 2)}\n`,
        );
      },
      async () => {
        try {
          return JSON.parse(await readFile(templateReportPath, 'utf8')).status === 'passed';
        } catch {
          return false;
        }
      },
    ),
  ]);
  const buildFailures = buildChecks.filter((result) => result.status === 'rejected');
  if (buildFailures.length > 0) {
    throw new AggregateError(
      buildFailures.map((result) => result.reason),
      'local-sdk-independent-candidate-gates-failed',
    );
  }

  // build-sdk starts a loopback npm registry on a fixed port. Keep the two
  // independent SDK builds sequential while allowing collision acceptance to
  // run beside the seed build.
  await step(
    run,
    'reproducibility-build',
    () =>
      runCommand(
        run,
        'reproducibility-build',
        'pnpm',
        ['sdk:build', '--', '--version', run.version, '--output', reproRoot],
        { cwd: reproLane },
      ),
    async () => {
      try {
        const receipt = JSON.parse(
          await readFile(resolve(reproRoot, 'sdk-build-result.json'), 'utf8'),
        );
        return (
          receipt.ok === true &&
          receipt.sdkVersion === run.version &&
          receipt.engineCommit === run.sourceCommit
        );
      } catch {
        return false;
      }
    },
  );

  await step(
    run,
    'candidate-seed-manifest',
    () =>
      runCommand(
        run,
        'candidate-seed-manifest',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/sdk-candidate-consumers.mjs'),
          '--write-seed',
          '--sdk',
          run.candidateRoot,
          '--expected-head',
          run.sourceCommit,
          '--version',
          run.version,
          '--output',
          run.seedPath,
        ],
        { cwd: root },
      ),
    async () => exists(run.seedPath),
  );

  await step(
    run,
    'reproducibility',
    async () => {
      const [seed, rebuilt] = await Promise.all([
        hashNpmArchives(run.candidateRoot),
        hashNpmArchives(reproRoot),
      ]);
      if (JSON.stringify(seed) !== JSON.stringify(rebuilt))
        throw new Error('local-sdk-reproducibility-npm-bytes-mismatch');
      const report = {
        ok: true,
        status: 'passed',
        version: run.version,
        source: 'npm-tarball-byte-comparison',
        packages: seed,
      };
      const path = resolve(run.root, 'gates/reproducibility.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    },
    async () => {
      try {
        return (
          JSON.parse(await readFile(resolve(run.root, 'gates/reproducibility.json'), 'utf8')).ok ===
          true
        );
      } catch {
        return false;
      }
    },
  );

  await step(
    run,
    'collision',
    async () => {
      const remoteTag = await execCapture(
        'git',
        ['ls-remote', '--tags', 'origin', `refs/tags/sdk-v${run.version}`],
        { cwd: root },
      );
      if (remoteTag) throw new Error(`local-sdk-tag-conflict: sdk-v${run.version}`);
      const versionCollision = await runCommand(
        run,
        'version-collision',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/check-sdk-version-collision.mjs'),
          '--output',
          run.candidateRoot,
          '--version',
          run.version,
        ],
        { cwd: root },
      );
      const versionReport = JSON.parse(versionCollision.stdout.trim().split('\n').at(-1));
      const { template, witness } = JSON.parse(
        await readFile(resolve(run.root, 'gates/collision-template.json'), 'utf8'),
      );
      const report = {
        ok: true,
        status: 'passed',
        versionCollision: versionReport,
        template,
        witness,
      };
      await writeFile(
        resolve(run.root, 'gates/version-collision.json'),
        `${JSON.stringify(versionReport, null, 2)}\n`,
      );
      await writeFile(
        resolve(run.root, 'gates/collision.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    },
    async () => {
      try {
        return (
          JSON.parse(await readFile(resolve(run.root, 'gates/collision.json'), 'utf8')).ok === true
        );
      } catch {
        return false;
      }
    },
  );

  const consumerResults = await Promise.allSettled([
    runConsumer(run, 'npm-diagnostics', 'npm', 'diagnostics'),
    runConsumer(run, 'npm-js', 'npm', 'js'),
    runConsumer(run, 'project', 'archive', 'project'),
    runConsumer(run, 'source', 'archive', 'source'),
  ]);
  const consumerFailures = consumerResults.filter((result) => result.status === 'rejected');
  if (consumerFailures.length > 0) {
    throw new AggregateError(
      consumerFailures.map((result) => result.reason),
      'local-sdk-consumer-gates-failed',
    );
  }

  await step(
    run,
    'aggregate-consumers',
    async () => {
      const result = await runCommand(
        run,
        'aggregate-consumers',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/sdk-candidate-consumers.mjs'),
          '--sdk',
          run.candidateRoot,
          '--reports',
          run.reportsRoot,
          '--seed-manifest',
          run.seedPath,
          '--archive',
          resolve(run.candidateRoot, `forgeax-sdk-v${run.version}.zip`),
          '--expected-head',
          run.sourceCommit,
          '--version',
          run.version,
          '--output',
          resolve(run.root, 'gates/consumers'),
        ],
        { cwd: root },
      );
      process.stdout.write(
        `[local SDK] consumer aggregate ${result.stdout.trim().split('\n').at(-1)}\n`,
      );
    },
    async () => exists(resolve(run.root, 'gates/consumers/sdk-verify-result.json')),
  );

  await step(
    run,
    'seal-candidate',
    async () => {
      const collisionPath = resolve(run.root, 'gates/collision.json');
      const collision = JSON.parse(await readFile(collisionPath, 'utf8'));
      if (collision.status !== 'passed') throw new Error('local-sdk-collision-gate-not-passed');
      const reproPath = resolve(run.root, 'gates/reproducibility.json');
      await runCommand(
        run,
        'seal-candidate',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/sdk-candidate.mjs'),
          'seal',
          '--candidate',
          run.candidateRoot,
          '--version',
          run.version,
          '--local-run-id',
          run.state.localRunId,
          '--gate',
          `npm-consumer=${resolve(run.root, 'gates/consumers/npm-consumer.json')}`,
          '--gate',
          `archive-browser=${resolve(run.root, 'gates/consumers/sdk-verify-result.json')}`,
          '--gate',
          `reproducibility=${reproPath}`,
          '--gate',
          `collision=${collisionPath}`,
        ],
        { cwd: root, quietStdout: true },
      );
      const candidate = JSON.parse(
        await readFile(resolve(run.candidateRoot, 'sdk-candidate.json'), 'utf8'),
      );
      await runCommand(
        run,
        'verify-sealed-candidate',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/sdk-candidate.mjs'),
          'verify',
          '--candidate',
          run.candidateRoot,
          '--version',
          run.version,
          '--engine-commit',
          run.sourceCommit,
        ],
        { cwd: root },
      );
      run.state.candidateId = candidate.candidateId;
      run.state.status = 'candidate-ready';
      await saveState(run);
    },
    async () => {
      try {
        const candidate = await validateCandidateRoot({
          candidateRoot: run.candidateRoot,
          expectedVersion: run.version,
          expectedEngineCommit: run.sourceCommit,
        });
        return candidate.origin === 'local' && candidate.localRunId === run.state.localRunId;
      } catch {
        return false;
      }
    },
  );
}

async function runConsumer(run, name, kind, group) {
  const lane = lanePath(run, name === 'npm-diagnostics' || name === 'npm-js' ? name : group);
  const consumerRoot = resolve(run.root, 'consumer-inputs', name);
  const outputFile = resolve(
    run.reportsRoot,
    `sdk-verify-${name === 'npm-diagnostics' || name === 'npm-js' ? name : group}-result.json`,
  );
  const sourceReport = resolve(
    consumerRoot,
    kind === 'npm' ? `sdk-verify-npm-${group}-result.json` : `sdk-verify-${group}-result.json`,
  );
  const verifyReport = async () => {
    try {
      const report = JSON.parse(await readFile(outputFile, 'utf8'));
      return report.ok === true;
    } catch {
      return false;
    }
  };
  const recoverExistingReport = async () => {
    try {
      await runCommand(
        run,
        `consumer-${name}-resume-seed-identity`,
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/sdk-candidate-consumers.mjs'),
          '--verify-seed',
          '--sdk',
          consumerRoot,
          '--seed-manifest',
          run.seedPath,
          '--group',
          kind === 'npm' ? 'npm' : 'archive',
          '--expected-head',
          run.sourceCommit,
          '--version',
          run.version,
        ],
        { cwd: root },
      );
      const report = JSON.parse(await readFile(sourceReport, 'utf8'));
      const identityMatches =
        report.ok === true &&
        report.engineCommit === run.sourceCommit &&
        (kind === 'npm'
          ? report.group === 'npm' && report.version === run.version && report.partition === group
          : report.sdkVersion === run.version && report.group === group);
      if (!identityMatches) return false;
      await mkdir(run.reportsRoot, { recursive: true });
      await copyFile(sourceReport, outputFile);
      run.state.steps[`consumer.${name}`] = {
        status: 'passed',
        completedAt: new Date().toISOString(),
      };
      await saveState(run);
      process.stdout.write(`[local SDK] recovered consumer.${name} from verified report\n`);
      return true;
    } catch {
      return false;
    }
  };
  if (run.state.steps[`consumer.${name}`]?.status !== 'passed' && (await recoverExistingReport()))
    return;
  await step(
    run,
    `consumer.${name}`,
    async () => {
      await mkdir(run.reportsRoot, { recursive: true });
      if (!(await exists(resolve(consumerRoot, 'sdk-build-result.json')))) {
        await hardlinkTree(run.candidateRoot, consumerRoot);
      }
      await runCommand(
        run,
        `consumer-${name}-seed-identity`,
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/sdk-candidate-consumers.mjs'),
          '--verify-seed',
          '--sdk',
          consumerRoot,
          '--seed-manifest',
          run.seedPath,
          '--group',
          kind === 'npm' ? 'npm' : 'archive',
          '--expected-head',
          run.sourceCommit,
          '--version',
          run.version,
        ],
        { cwd: root },
      );
      if (kind === 'npm') {
        await runCommand(
          run,
          `consumer-${name}`,
          'xvfb-run',
          [
            '-a',
            'pnpm',
            'sdk:check:npm',
            '--',
            '--version',
            run.version,
            '--partition',
            group,
            '--output',
            consumerRoot,
          ],
          { cwd: lane },
        );
      } else {
        await runCommand(
          run,
          `consumer-${name}`,
          'xvfb-run',
          [
            '-a',
            'pnpm',
            'sdk:verify',
            '--',
            '--archive',
            resolve(consumerRoot, `forgeax-sdk-v${run.version}.zip`),
            '--group',
            group,
          ],
          { cwd: lane },
        );
      }
      const report = JSON.parse(await readFile(sourceReport, 'utf8'));
      const passed = report.ok === true;
      if (!passed) throw new Error(`local-sdk-consumer-not-passed: ${name}`);
      await copyFile(sourceReport, outputFile);
    },
    verifyReport,
  );
}

async function setupNpmToken() {
  const tokenFile = option('npm-token-file') ?? process.env.NPM_TOKEN_FILE;
  let configDir;
  try {
    if (tokenFile) {
      const tokenPath = resolve(tokenFile);
      const info = await stat(tokenPath);
      if (!info.isFile()) throw new Error('local-sdk-npm-token-file-invalid');
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        throw new Error('local-sdk-npm-token-file-must-be-private');
      }
      const token = (await readFile(tokenPath, 'utf8')).trim();
      if (!token || /\s/.test(token)) throw new Error('local-sdk-npm-token-file-invalid');
      process.env.NPM_TOKEN = token;
      process.env.NODE_AUTH_TOKEN = token;
    }
    if (!process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN) {
      throw new Error('local-sdk-npm-auth-required: set NPM_TOKEN_FILE or log in with npm');
    }
    const token = process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN;
    process.env.NODE_AUTH_TOKEN = token;
    process.env.NPM_TOKEN = token;
    configDir = await mkdtemp(resolve(tmpdir(), 'forgeax-npm-auth-'));
    const configPath = resolve(configDir, 'npmrc');
    await writeFile(
      configPath,
      [
        'registry=https://registry.npmjs.org/',
        '@forgeax:registry=https://registry.npmjs.org/',
        `//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}`,
        'always-auth=true',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    process.env.NPM_CONFIG_USERCONFIG = configPath;
    return configDir;
  } catch (cause) {
    if (configDir) await rm(configDir, { recursive: true, force: true });
    delete process.env.NPM_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
    delete process.env.NPM_CONFIG_USERCONFIG;
    throw cause;
  }
}

async function prepareNpmAuth(run) {
  run.npmAuthConfigDir ??= await setupNpmToken();
  await runCommand(
    run,
    'npm-auth-check',
    'npm',
    ['whoami', '--registry=https://registry.npmjs.org'],
    {
      cwd: root,
      npmAuth: true,
    },
  );
}

async function sourceMirrorEnabled() {
  try {
    const raw = await execCapture(
      'gh',
      ['api', `repos/${githubRepository()}/actions/variables/ENGINE_SOURCE_MIRROR_ENABLED`],
      { cwd: root },
    );
    return JSON.parse(raw).value === 'true';
  } catch (cause) {
    if (/HTTP 404|Not Found/.test(String(cause.stderr ?? cause.message))) return false;
    if (process.env.ENGINE_SOURCE_MIRROR_ENABLED === 'true') return true;
    throw new Error('local-sdk-source-mirror-setting-unavailable');
  }
}

async function runPromotion(run, { preflightOnly = false } = {}) {
  const githubToken = await ensureGitHubAuth();
  await prepareController(run);
  await prepareWorktree(run, 'mirror');
  await validateCandidateRoot({
    candidateRoot: run.candidateRoot,
    expectedVersion: run.version,
    expectedEngineCommit: run.sourceCommit,
  });
  const policy = releasePolicy(run.version);
  const mirrorEnabled = policy.mirror !== null && (await sourceMirrorEnabled());
  const mirrorProof = resolve(run.root, 'mirror-preflight.json');
  if (policy.mirror !== null) {
    await step(
      run,
      'source-mirror-preflight',
      async () => {
        await rm(resolve(run.root, 'source-mirror-preflight'), { recursive: true, force: true });
        await rm(mirrorProof, { force: true });
        return runCommand(
          run,
          'source-mirror-preflight',
          'pnpm',
          [
            'source:export',
            '--',
            '--root',
            lanePath(run, 'mirror'),
            '--ref',
            run.sourceCommit,
            '--version',
            run.version,
            '--candidate',
            run.candidateRoot,
            '--output',
            resolve(run.root, 'source-mirror-preflight'),
            '--preflight-output',
            mirrorProof,
          ],
          { cwd: root, env: await sourceMirrorEnvironment(githubToken), githubAuth: true },
        );
      },
      async () => exists(mirrorProof),
    );
  }

  if (preflightOnly) {
    process.stdout.write(
      `[local SDK] promotion preflight ready${mirrorEnabled ? ' (source mirror enabled)' : ''}\n`,
    );
    return;
  }

  await mkdir(resolve(run.root, 'proofs'), { recursive: true });
  if (!run.npmAuthConfigDir) throw new Error('local-sdk-npm-auth-not-preflighted');
  await step(
    run,
    'npm-publish-candidate',
    async () => {
      const result = await runCommand(
        run,
        'npm-publish-candidate',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/publish-sdk-npm.mjs'),
          '--stage',
          'publish',
          '--version',
          run.version,
          '--candidate',
          run.candidateRoot,
        ],
        {
          cwd: root,
          npmAuth: true,
          env: { FORGEAX_DEV_HEADLESS: 'true', NPM_CONFIG_LOGLEVEL: 'error' },
        },
      );
      await writeFile(
        resolve(run.root, 'proofs/npm-publication.json'),
        `${result.stdout.trim().split('\n').at(-1)}\n`,
      );
    },
    async () => exists(resolve(run.root, 'proofs/npm-publication.json')),
  );

  await step(
    run,
    'github-release',
    async () => {
      const notesPath = resolve(run.root, 'release-notes.md');
      await writeFile(
        notesPath,
        `Self-contained ForgeAX browser game SDK.\n\nThis release contains sealed local Candidate ${run.state.candidateId}. The exact archive, npm tarballs, reproducibility, npm consumer, archive/browser, and collision evidence were verified before publication. npm channel promotion verifies public registry bytes and a fresh consumer.\n`,
      );
      const assets = [
        `forgeax-sdk-v${run.version}.zip`,
        'SHA256SUMS',
        `forgeax-sdk-v${run.version}.spdx.json`,
        `forgeax-sdk-v${run.version}.provenance.json`,
        'sdk-verify-result.json',
        'sdk-candidate.json',
      ].map((name) => resolve(run.candidateRoot, name));
      const result = await runCommand(
        run,
        'github-release',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/finalize-sdk-release.mjs'),
          '--tag',
          `sdk-v${run.version}`,
          '--title',
          `ForgeAX SDK v${run.version}`,
          '--notes-file',
          notesPath,
          '--commit',
          run.sourceCommit,
          ...assets.flatMap((path) => ['--asset', path]),
        ],
        {
          cwd: root,
          env: {
            ...releaseEnvironment(),
            GH_TOKEN: githubToken,
            GITHUB_REPOSITORY: githubRepository(),
          },
          githubAuth: true,
        },
      );
      await mkdir(resolve(run.root, 'proofs'), { recursive: true });
      await writeFile(
        resolve(run.root, 'proofs/github-release.json'),
        `${result.stdout.trim().split('\n').at(-1)}\n`,
      );
    },
    async () => exists(resolve(run.root, 'proofs/github-release.json')),
  );

  await step(
    run,
    'npm-promote-next',
    async () => {
      const result = await runCommand(
        run,
        'npm-promote-next',
        process.execPath,
        [
          resolve(root, 'scripts/forgeax/publish-sdk-npm.mjs'),
          '--stage',
          'promote',
          '--version',
          run.version,
          '--candidate',
          run.candidateRoot,
          ...(policy.mirror !== null ? ['--preflight-proof', mirrorProof] : []),
        ],
        { cwd: root, npmAuth: true, env: { NPM_CONFIG_LOGLEVEL: 'error' } },
      );
      await writeFile(
        resolve(run.root, 'proofs/npm-promotion.json'),
        `${result.stdout.trim().split('\n').at(-1)}\n`,
      );
    },
    async () => exists(resolve(run.root, 'proofs/npm-promotion.json')),
  );

  if (mirrorEnabled) {
    await step(
      run,
      'public-source-mirror',
      async () => {
        await rm(resolve(run.root, 'source-mirror-publish'), { recursive: true, force: true });
        const result = await runCommand(
          run,
          'public-source-mirror',
          process.execPath,
          [
            resolve(root, 'scripts/forgeax/publish-source-from-preflight.mjs'),
            '--output',
            resolve(run.root, 'source-mirror-preflight'),
            '--candidate',
            run.candidateRoot,
            '--preflight-proof',
            mirrorProof,
            '--version',
            run.version,
            '--source-sha',
            run.sourceCommit,
          ],
          { cwd: root, env: await sourceMirrorEnvironment(githubToken), githubAuth: true },
        );
        await mkdir(resolve(run.root, 'proofs'), { recursive: true });
        await writeFile(
          resolve(run.root, 'proofs/public-source-mirror.json'),
          `${result.stdout.trim().split('\n').at(-1)}\n`,
        );
      },
      async () => exists(resolve(run.root, 'proofs/public-source-mirror.json')),
    );
  }

  run.state.status = 'complete';
  run.state.completedAt = new Date().toISOString();
  await saveState(run);
  await cleanupWorktrees(run);
}

async function cleanupWorktrees(run) {
  for (const [key, entry] of Object.entries(run.state.sharedSubmoduleWorktrees ?? {})) {
    try {
      await execCapture(
        'git',
        ['-C', entry.sourcePath, 'worktree', 'remove', '--force', entry.targetPath],
        { cwd: root },
      );
      delete run.state.sharedSubmoduleWorktrees[key];
    } catch {
      process.stderr.write(
        `[local SDK] retained shared submodule worktree ${key}; remove it with git worktree remove after inspection\n`,
      );
    }
  }
  await saveState(run);
  for (const [name, entry] of Object.entries(run.state.worktrees)) {
    if (!(await exists(resolve(entry.path, '.git')))) continue;
    try {
      await execCapture('git', ['worktree', 'remove', '--force', entry.path], { cwd: root });
      delete run.state.worktrees[name];
    } catch {
      process.stderr.write(
        `[local SDK] retained worktree ${name}; remove it with git worktree remove after inspection\n`,
      );
    }
  }
  await saveState(run);
}

async function main() {
  const nodeBootstrap = await ensurePinnedNode();
  if (nodeBootstrap === 'reexecuted') return;
  if (has('help')) {
    process.stdout.write(
      'Usage: pnpm sdk:release:local -- [--version <dev-version>] [--source-sha <full-sha>] [--stage candidate|preflight|promote|all] [--npm-token-file <path>] [--output <path>]\n',
    );
    return;
  }
  const stageName = option('stage') ?? 'all';
  if (!['candidate', 'preflight', 'promote', 'all'].includes(stageName))
    throw new Error(`local-sdk-stage-invalid: ${stageName}`);
  const selection = await selectRelease();
  const run = await createRun(selection);
  try {
    process.stdout.write(
      `[local SDK] pinned ${run.version} to ${run.sourceCommit}; run ${run.state.localRunId}\n`,
    );
    if (stageName === 'preflight' || stageName === 'promote' || stageName === 'all')
      await prepareNpmAuth(run);
    if (stageName === 'candidate' || stageName === 'all') {
      run.state.status = 'candidate';
      await saveState(run);
      await prepareLanes(run);
      await runCandidate(run);
    }
    if (stageName === 'preflight') {
      await validateCandidateRoot({
        candidateRoot: run.candidateRoot,
        expectedVersion: run.version,
        expectedEngineCommit: run.sourceCommit,
      });
      await runPromotion(run, { preflightOnly: true });
      process.stdout.write(
        `${JSON.stringify({ ok: true, version: run.version, sourceCommit: run.sourceCommit, candidateId: run.state.candidateId, status: run.state.status, preflight: 'passed', candidate: run.candidateRoot })}\n`,
      );
      return;
    }
    if (stageName === 'promote' || stageName === 'all') {
      if (!run.state.steps['seal-candidate']?.status || run.state.status === 'candidate') {
        await validateCandidateRoot({
          candidateRoot: run.candidateRoot,
          expectedVersion: run.version,
          expectedEngineCommit: run.sourceCommit,
        });
      }
      run.state.status = 'promotion';
      await saveState(run);
      await runPromotion(run);
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, version: run.version, sourceCommit: run.sourceCommit, candidateId: run.state.candidateId, status: run.state.status, candidate: run.candidateRoot })}\n`,
    );
  } finally {
    if (run.npmAuthConfigDir) await rm(run.npmAuthConfigDir, { recursive: true, force: true });
    if (run.xdgRuntimeDir) await rm(run.xdgRuntimeDir, { recursive: true, force: true });
    delete process.env.NPM_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
    delete process.env.NPM_CONFIG_USERCONFIG;
  }
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
