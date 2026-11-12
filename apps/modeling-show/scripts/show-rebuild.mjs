#!/usr/bin/env node
// One rebuild cycle of the interactive 3D pages on the Modeling Studio board share.
//
// Subjects come from <studio>/ops/show-subjects.json: { "subjects": [{ id, title, project,
// modelingBranch, journey?, wip?, small?, fastLane?, note? }] }. A subject is one Show project
// under apps/modeling-show/<project>; its web build goes to <studio>/show/<id>/. The file is
// re-read before every build, so a subject added mid-cycle is picked up.
//
// A subject builds when its modeling branch head changed, or when the Engine commit its live page
// was built with is older than ENGINE_REFRESH_HOURS and differs from the integration/modeling head
// by more than build-side packages. The build is gated by the quick smoke; on success it is swapped
// in and published, and the full throttled journey then runs in a separate detached process
// (show-journey.mjs, forgeax-heavy --low) that rolls back to the previous build when it fails. On a
// build failure the last good build stays and the failure reason is recorded.
//
// Lanes: subjects flagged `small` build in the small lane (its own Engine worktree and lock), all
// others in the big lane. At most one build per lane runs at a time, so at most one small build
// beside one big build; each is still under forgeax-heavy --low.
//
// Guards: a pause file skips the cycle, one process per lane (pid lock files), and a lane stops
// while MemAvailable < 16 GB. Heavy steps run under forgeax-heavy --low.
// usage: node show-rebuild.mjs [--force <id>] [--only <id>] [--lane big|small] [--publish] [--dry-run]
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquirePidLock,
  branchFailure,
  choosePrevious,
  engineDecision,
  journeyPaths,
  laneLockPath,
  laneOf,
  memoryOk,
  orderPlans,
  resolveBranchHead,
  stopJourney,
  TransientRemoteError,
  withFetchLock,
  patchSubject,
  pidAlive,
  planSubject,
  publish as publishShare,
  readHolder,
  readJson,
  runJourney,
  sameFailure,
  spawnJourney,
  swapInto,
  updateState,
  journeyUnchanged,
  pageDigest,
} from './show-rebuild-lib.mjs';

const scriptDir = import.meta.dirname;
const repo = resolve(scriptDir, '../../..');
const studio = process.env.FORGEAX_STUDIO ?? siblingRepository('modeling-studio');
function siblingRepository(name) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return join(dirname(dirname(resolve(repo, common))), name);
}
const home = join(homedir(), '.local/share/forgeax-show-rebuild');
const pauseFile = join(homedir(), '.config/forgeax/show-rebuild.pause');
const statePath = join(home, 'state.json');
const args = process.argv.slice(2);
const argOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const force = argOf('--force');
// --only <id>: this cycle builds that subject alone (for example a requested rebuild).
const only = argOf('--only');
const laneArg = argOf('--lane');
const dryRun = args.includes('--dry-run');
const MIN_FREE_GB = Number(process.env.FORGEAX_SHOW_MIN_FREE_GB ?? 16);
const ENGINE_REFRESH_HOURS = Number(process.env.FORGEAX_SHOW_ENGINE_REFRESH_HOURS ?? 6);
const FULL_JOURNEY_HOURS = Number(process.env.FORGEAX_SHOW_FULL_JOURNEY_HOURS ?? 3);
/** Packaged engine shader profile of `forgeax project package` (no point shadows, with SSAO). */
const SHADER_PROFILE = 'base-ssao';
/** Engine packages that only build, cook or package (never in the page's runtime bundle). */
const BUILD_SIDE = new Set([
  'devkit', 'import', 'pack', 'ddc', 'shader-compiler', 'naga', 'vfx-compiler', 'mesh-io', 'image',
  'vite-plugin-pack', 'vite-plugin-shader', 'vite-plugin-rhi-debug', 'modeling',
]);
const env = {
  ...process.env,
  PATH: `${join(home, 'bin')}:${join(homedir(), '.cargo/bin')}:${join(homedir(), '.local/bin')}:${process.env.PATH}`,
};
const chromeLibs = join(home, 'chrome-libs/root/usr/lib/x86_64-linux-gnu');

let laneName = 'cycle';
const log = (...parts) => console.log(new Date().toISOString(), `[${laneName}]`, ...parts);
const sh = (cmd, argv, options = {}) =>
  execFileSync(cmd, argv, { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 << 20, ...options }).trim();
// Requested rebuilds (FORGEAX_SHOW_LANE=normal) take the normal forgeax-heavy lane; cycles stay --low.
const heavyArgs = process.env.FORGEAX_SHOW_LANE === 'normal' ? [] : ['--low'];
/** Wall time of each step of a subject build (logged, kept with lastAttempt). */
const timed = (steps, name, fn) => {
  const start = Date.now();
  try {
    return fn();
  } finally {
    steps[name] = Math.round((Date.now() - start) / 1000);
  }
};
const loadConfig = () => readJson(join(studio, 'ops/show-subjects.json'), { subjects: [] });
const memAvailableGb = () => {
  const line = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
  return line ? Number(line[1]) / 1024 / 1024 : 0;
};

if (!dryRun && existsSync(pauseFile)) {
  log('paused:', pauseFile);
  process.exit(0);
}

// ---- planning (read-only apart from the Engine fetch; shared by dry-run and the lanes) ----

const modelingUrl = sh('git', ['config', '-f', '.gitmodules', '--get', 'submodule.packages/modeling.url']);
const remoteHead = (branch) =>
  resolveBranchHead({ lsRemote: () => sh('git', ['ls-remote', modelingUrl, `refs/heads/${branch}`], { timeout: 60_000 }), branch });
const gitFetch = (run) => withFetchLock(home, run);
const fetchEngineHead = () => {
  gitFetch(() => sh('git', ['fetch', '-q', 'origin', 'integration/modeling']));
  return sh('git', ['rev-parse', 'FETCH_HEAD']);
};
const commitTime = (sha) => {
  try {
    return Number(sh('git', ['show', '-s', '--format=%ct', sha])) * 1000;
  } catch {
    return undefined;
  }
};
/** True when no Engine runtime package changed between two commits (apps and build-side packages may). */
function buildSideOnly(from, to) {
  if (from === to) return true;
  let files;
  try {
    files = sh('git', ['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  } catch {
    return false;
  }
  return files.every((file) => {
    // Show app edits are smoke-gated too: the journey right after publication still checks them.
    if (file.startsWith('apps/')) return true;
    const owner = file.match(/^packages\/([^/]+)/)?.[1];
    return owner === undefined || BUILD_SIDE.has(owner) || file.includes('/__tests__/') || file.endsWith('.md');
  });
}
// Builds started by this process per subject: a requested subject builds once, and an F1 subject whose
// branch moved meanwhile builds again (a head's key is attempted once, so only a newer head repeats).
const builds = new Map();
/**
 * Every subject's plan (build or not, and why) from the branch heads as of now, re-reading the
 * subject list and state. Called before every build, so a subject never builds on a head older than
 * the moment its build starts.
 */
function planAll() {
  const config = loadConfig();
  const state = readJson(statePath, { subjects: {} });
  const engineHead = fetchEngineHead();
  const plans = [];
  for (const subject of config.subjects) {
    if (only !== undefined && subject.id !== only) continue;
    const lane = laneOf(subject);
    const record = state.subjects?.[subject.id] ?? {};
    let modelingHead;
    try {
      modelingHead = remoteHead(subject.modelingBranch);
    } catch (error) {
      if (error instanceof TransientRemoteError) {
        log('transient remote error, skipping', subject.id, String(error.message).slice(0, 200));
        plans.push({ subject, lane, record, run: false, reason: `transient remote error (skipped): ${error.message}`, engineHead });
        continue;
      }
      const failure = branchFailure({ record, message: String(error.message ?? error), at: new Date().toISOString() });
      plans.push({ subject, lane, record, run: false, reason: failure.reason, failure, engineHead });
      continue;
    }
    const engine = engineDecision({
      good: record.lastGood,
      engineHead,
      now: Date.now(),
      refreshHours: ENGINE_REFRESH_HOURS,
      commitTime,
      buildSideOnly,
    });
    const requested = (force === subject.id || only === subject.id) && !builds.has(subject.id);
    plans.push({ subject, lane, record, engineHead, ...planSubject({ subject, record, modelingHead, engineHead, engine, requested }) });
  }
  return { config, engineHead, plans };
}

// ---- dry run ----

if (dryRun) {
  const { engineHead, plans } = planAll();
  const lockLine = (lane) => {
    const holder = readHolder(laneLockPath(home, lane));
    return pidAlive(holder) ? `held by pid ${holder}` : 'free';
  };
  console.log(`dry-run: nothing is built, locked or written`);
  console.log(`engine head ${engineHead.slice(0, 9)} (integration/modeling), refresh after ${ENGINE_REFRESH_HOURS} h of live Engine age`);
  console.log(`lanes: big ${lockLine('big')}; small ${lockLine('small')}; MemAvailable ${memAvailableGb().toFixed(1)} GB (guard ${MIN_FREE_GB} GB)`);
  for (const lane of ['big', 'small']) {
    const own = orderPlans(plans.filter((p) => p.lane === lane));
    console.log(`[${lane}] ${own.length === 0 ? 'no subjects' : ''}`);
    for (const p of own) {
      const live = p.record.lastGood === undefined ? 'no live build' : `live engine ${p.record.lastGood.engine.slice(0, 9)} modeling ${p.record.lastGood.modeling.slice(0, 7)}`;
      console.log(`  ${p.run ? 'BUILD' : 'skip '} ${p.subject.id.padEnd(10)} reason: ${p.reason}`);
      console.log(`        ${live}${p.modelingHead === undefined ? '' : `; branch ${p.subject.modelingBranch} head ${p.modelingHead.slice(0, 7)}`}${p.engineNote === undefined ? '' : `; engine: ${p.engineNote}`}`);
    }
  }
  process.exit(0);
}

// ---- lanes ----

mkdirSync(join(home, 'journeys'), { recursive: true });

/** One Engine checkout per lane: the big lane uses this worktree, the small lane its sibling worktree. */
function makeLane(name) {
  const dir =
    name === 'big' ? repo : (process.env.FORGEAX_SHOW_SMALL_REPO ?? resolve(repo, '..', `${basename(repo)}-small`));
  const laneSh = (cmd, argv, options = {}) => execFileSync(cmd, argv, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20, ...options }).trim();
  return {
    name,
    repo: dir,
    modelingDir: join(dir, 'packages/modeling'),
    distKey: name === 'big' ? 'modelingDist' : 'modelingDistSmall',
    sh: laneSh,
    heavy: (argv, options = {}, normal = false) => laneSh('forgeax-heavy', [...(normal ? [] : heavyArgs), ...argv], options),
  };
}

function ensureLaneRepo(lane) {
  if (lane.repo === repo || existsSync(join(lane.repo, '.git'))) return;
  log('create lane worktree', lane.repo);
  sh('git', ['worktree', 'add', '--detach', '--force', lane.repo, 'HEAD']);
  // The git-ignored WASM payload is not part of a fresh checkout.
  const wasm = 'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm';
  if (existsSync(join(repo, wasm))) {
    mkdirSync(dirname(join(lane.repo, wasm)), { recursive: true });
    sh('cp', ['-a', join(repo, wasm), join(lane.repo, wasm)]);
  }
}

function prepareEngine(lane, head) {
  const current = lane.sh('git', ['rev-parse', 'HEAD']);
  if (current === head && existsSync(join(lane.repo, 'packages/app/dist'))) return;
  log('engine checkout', head.slice(0, 9));
  gitFetch(() => lane.sh('git', ['fetch', '-q', 'origin', 'integration/modeling']));
  lane.sh('git', ['checkout', '-q', '--force', '--detach', head]);
  // The Engine installs and builds against its modeling pin (the root lockfile lists the pin's
  // dependencies); subjects check out their own modeling heads afterwards.
  lane.sh('git', ['submodule', 'update', '--init', '--force', 'packages/modeling', 'tools/view', 'third_party/wgpu', 'third_party/blitz']);
  updateState(statePath, (state) => {
    delete state[lane.distKey];
  });
  lane.heavy(['pnpm', 'install', '--frozen-lockfile']);
  lane.heavy(['pnpm', 'build:engine']);
}

/**
 * The package build reuses the packaged engine shader profile instead of compiling every engine
 * shader from source (about 80 s per build). Prepare it only when its recorded source digest is
 * not the current one: the same check the shader plugin makes before trusting the profile.
 */
async function prepareShaderProfile(lane) {
  const plugin = join(lane.repo, 'packages/vite-plugin-shader/dist');
  const { engineShaderSourceDigest, PACKAGED_SOURCE_RECORD } = await import(pathToFileURL(join(plugin, 'source-digest.mjs')).href);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(join(plugin, 'engine-inputs', SHADER_PROFILE, PACKAGED_SOURCE_RECORD), 'utf8')).shaderSourceDigest;
  } catch {
    recorded = undefined;
  }
  const current = engineShaderSourceDigest(join(lane.repo, 'packages/shader/src'));
  if (current !== undefined && recorded === current) return;
  log('shader profile', SHADER_PROFILE, 'prepare');
  lane.heavy(['node', 'scripts/forgeax/prepare-shader-release-inputs.mjs', '--build', '--profile', SHADER_PROFILE]);
}

/** Subjects whose Show project is newer than the checkout (a subject added mid-cycle) need the current Show app. */
function overlayShowApp(lane) {
  try {
    lane.sh('git', ['checkout', '-q', 'FETCH_HEAD', '--', 'apps/modeling-show']);
  } catch (error) {
    log('show app refresh skipped:', String(error.stderr ?? error.message ?? error).slice(-200));
  }
}

async function prepareLane(lane, job) {
  ensureLaneRepo(lane);
  gitFetch(() => lane.sh('git', ['fetch', '-q', 'origin', 'integration/modeling']));
  // Subjects with only a modeling change build on the Engine already checked out in the lane.
  lane.buildEngine = job.useHead ? job.engineHead : lane.sh('git', ['rev-parse', 'HEAD']);
  prepareEngine(lane, lane.buildEngine);
  overlayShowApp(lane);
  await prepareShaderProfile(lane);
}

/** The geometry sources the project's Show program declares (subject name -> source line), via the program table. */
function programSources(lane, project) {
  try {
    const file = readFileSync(join(project, 'assets/show.pack.ts'), 'utf8');
    const program = file.match(/program:\s*'([^']+)'/)?.[1];
    if (program === undefined) return {};
    const code = `const { SHOW_PROGRAMS } = await import(${JSON.stringify(join(lane.repo, 'apps/modeling-show/assets/show/programs.ts'))});` +
      `console.log(JSON.stringify(Object.fromEntries((SHOW_PROGRAMS[${JSON.stringify(program)}]?.subjects ?? []).map((s) => [s.name, s.source ?? '']))));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: project, env, encoding: 'utf8', timeout: 60_000 });
    return JSON.parse(out.trim().split('\n').at(-1));
  } catch {
    return {};
  }
}

/** True when both commits carry the same kernel sources (the modeling dist stays valid). */
function sameKernel(lane, from, to) {
  if (from === undefined) return false;
  try {
    lane.sh('git', ['diff', '--quiet', from, to, '--', 'src', 'package.json'], { cwd: lane.modelingDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Imports each Pack module of `project` and evaluates its build() (pack-preflight.mjs, fresh
 * Node process each) within the Pack build's 15 s module budget.
 */
function preflightPacks(project) {
  const budgetMs = 15_000;
  for (const file of readdirSync(join(project, 'assets')).filter((f) => f.endsWith('.pack.ts'))) {
    let result;
    try {
      const output = execFileSync(process.execPath, [join(scriptDir, 'pack-preflight.mjs'), join(project, 'assets', file)], {
        cwd: project,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: budgetMs * 3,
      });
      result = JSON.parse(output.trim().split('\n').at(-1));
    } catch (error) {
      throw new Error(`preflight: ${file} did not finish within ${budgetMs * 3} ms: ${String(error.stderr ?? error.message).slice(-400)}`);
    }
    if (!result.ok) throw new Error(`preflight: ${file}: ${result.error}`);
    if (result.importMs + result.buildMs > budgetMs) {
      throw new Error(`preflight: ${file} import ${result.importMs} ms + build ${result.buildMs} ms exceeds the ${budgetMs} ms Pack budget`);
    }
  }
}

const publishAll = () => {
  try {
    publishShare({ config: loadConfig(), statePath, studio, scriptDir, env, log });
  } catch (error) {
    log('publish skipped:', String(error.message ?? error).slice(-300));
  }
};

function build(lane, { subject, key: attemptKey, modelingHead }) {
  const key = `${lane.buildEngine}@${modelingHead}:${subject.project}`;
  const started = new Date().toISOString();
  const project = join(lane.repo, 'apps/modeling-show', subject.project);
  const work = join(home, 'work', subject.id);
  const steps = {};
  const fail = (reason) => {
    // Nested structured errors end in their root cause (a producer message such as a modeling
    // error); lead with it, since stack traces fill the rest.
    const plain = reason.replaceAll('\\', '');
    const causes = [
      ...[...plain.matchAll(/"sourcePath":\s*"([^"]+)"/g)].map((m) => `source ${m[1]}`),
      ...[...plain.matchAll(/"(?:producer|reason|message)":\s*"([^"{][^"]*)"/g)].map((m) => m[1]),
    ];
    const cause = causes.length === 0 ? undefined : [...new Set(causes)].slice(-4).join(' | ');
    const text = cause === undefined ? reason.slice(-1500) : `${cause}\n${reason.slice(-1200)}`;
    log('FAIL', subject.id, JSON.stringify(steps), (cause ?? reason).slice(0, 400));
    patchSubject(statePath, subject.id, { lastAttempt: { at: started, key: attemptKey, ok: false, reason: text, steps } });
  };
  try {
    const record = readJson(statePath, { subjects: {} }).subjects?.[subject.id] ?? {};
    const good = record.lastGood;
    log('build', subject.id, 'modeling', modelingHead.slice(0, 7));
    // By commit: a branch can move or be deleted between ls-remote and fetch.
    timed(steps, 'fetch', () => {
      gitFetch(() => lane.sh('git', ['fetch', '-q', 'origin', modelingHead], { cwd: lane.modelingDir }));
      lane.sh('git', ['checkout', '-q', '--detach', '--force', modelingHead], { cwd: lane.modelingDir });
    });
    // The modeling package dist feeds Pack builds; rebuild it only when the kernel changed
    // (a geometry-only change touches examples/, which Pack builds import from source).
    if (!sameKernel(lane, readJson(statePath, {})[lane.distKey], modelingHead)) {
      timed(steps, 'modelingDist', () => lane.heavy(['pnpm', '--filter', '@forgeax/engine-modeling', 'build']));
      updateState(statePath, (state) => {
        state[lane.distKey] = modelingHead;
      });
    }
    // The quick smoke (loads, first frames, no errors) gates publication. The full throttled
    // journey follows in a detached process unless the Engine is unchanged and a full journey
    // passed within FULL_JOURNEY_HOURS. Subjects marked `fastLane` (user-facing F1) package and
    // smoke in the normal forgeax-heavy lane; full journeys always stay in the --low lane.
    const windowFresh =
      good?.fullJourneyAt !== undefined && Date.now() - Date.parse(good.fullJourneyAt) < FULL_JOURNEY_HOURS * 3600e3;
    const fast = subject.fastLane === true;
    const label = `engine ${lane.buildEngine.slice(0, 9)} · modeling ${modelingHead.slice(0, 7)} (${subject.modelingBranch}) · built ${started.slice(0, 16)}Z`;
    // Fail in seconds what the package would report after minutes: every Pack module must
    // import within the Pack build's 15 s module budget (heavy work belongs in cook jobs).
    timed(steps, 'preflight', () => preflightPacks(project));
    const labelFile = join(project, 'assets/build-label.ts');
    const original = existsSync(labelFile) ? readFileSync(labelFile, 'utf8') : undefined;
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      writeFileSync(labelFile, `export const BUILD_LABEL = ${JSON.stringify(label)};\n`);
      timed(steps, 'package', () =>
        lane.heavy(['../../../node_modules/.bin/forgeax', 'project', 'package', '--format', 'web-zip', '--output', join(work, 'page.zip'), '--json'], { cwd: project }, fast),
      );
    } finally {
      if (original !== undefined) writeFileSync(labelFile, original);
    }
    lane.sh('unzip', ['-q', '-DD', join(work, 'page.zip'), '-d', join(work, 'page')]);
    // A kernel-only merge that leaves the built page and the Engine identical needs no new journey.
    const digest = pageDigest(join(work, 'page'));
    const quick = good?.engine === lane.buildEngine && (windowFresh || journeyUnchanged({ good, buildEngine: lane.buildEngine, digest }));
    const smoke = timed(steps, 'smoke', () =>
      runJourney({ subject, dir: join(work, 'page'), out: join(work, 'smoke'), quick: true, scriptDir, env, chromeLibs, run: (argv, options) => lane.heavy(argv, options, fast) }),
    );
    if (!smoke.ok) return fail(`smoke: ${smoke.summary}`);

    const journeyDue = !quick;
    const target = join(studio, 'show', subject.id);
    const paths = journeyPaths(home, subject.id, modelingHead);
    // A journey still running for the previous publish is stale from here on. The rollback target is
    // decided from a record read now (not the one read when this build started): the old journey
    // may have finished meanwhile, and its target (the last verified build) carries over.
    let previousGood = null;
    if (journeyDue) {
      const stopped = stopJourney({ home, id: subject.id, log });
      const fresh = readJson(statePath, { subjects: {} }).subjects?.[subject.id] ?? {};
      const stoppedPrevious = stopped === undefined ? undefined : join(stopped.dir, 'previous');
      const choice = choosePrevious({
        record: fresh,
        stopped,
        stoppedPreviousExists: stoppedPrevious !== undefined && existsSync(stoppedPrevious),
        targetExists: existsSync(target),
      });
      previousGood = choice.previousGood;
      const kept = join(work, 'previous-kept');
      rmSync(kept, { recursive: true, force: true });
      if (choice.adopt) renameSync(stoppedPrevious, kept);
      if (stopped !== undefined) rmSync(stopped.dir, { recursive: true, force: true });
      rmSync(paths.dir, { recursive: true, force: true });
      mkdirSync(paths.dir, { recursive: true });
      if (choice.adopt) renameSync(kept, join(paths.dir, 'previous'));
      else if (existsSync(target)) cpSync(target, join(paths.dir, 'previous'), { recursive: true });
      if (!existsSync(join(paths.dir, 'previous'))) previousGood = null;
    }
    timed(steps, 'swap', () => swapInto(target, join(work, 'page')));
    if (journeyDue) renameSync(join(work, 'page'), join(paths.dir, 'page'));
    patchSubject(statePath, subject.id, {
      lastGood: {
        key,
        engine: lane.buildEngine,
        modeling: modelingHead,
        branch: subject.modelingBranch,
        builtAt: started,
        label,
        journeySeconds: smoke.seconds,
        sources: programSources(lane, project),
        pageDigest: digest,
        ...(quick ? { fullJourneyAt: good.fullJourneyAt, fullJourneyPageDigest: good.fullJourneyPageDigest } : { journey: { state: 'pending', at: started } }),
      },
      lastAttempt: { at: started, key, ok: true, steps },
    });
    log('OK', subject.id, JSON.stringify(steps));
    publishAll();
    if (journeyDue) {
      const job = { id: subject.id, journey: subject.journey ?? 'basic', key, attemptKey, builtAt: started, modeling: modelingHead, previousGood, dir: paths.dir, home, studio, statePath, steps };
      try {
        const child = spawnJourney({ home, job, scriptDir, env });
        log('journey detached', subject.id, 'pid', child.pid, child.log);
      } catch (error) {
        log('journey spawn failed:', String(error.message ?? error));
        updateState(statePath, (state) => {
          const live = state.subjects[subject.id]?.lastGood;
          if (live?.builtAt === started) live.journey = { state: 'not-started', at: started };
        });
      }
    }
  } catch (error) {
    // forgeax --json reports its structured error on stdout; keep its tail with stderr.
    fail(`${String(error.stdout ?? '').slice(-2000)}\n${String(error.stderr ?? '')}${String(error.message ?? error)}`);
  } finally {
    rmSync(join(work, 'page.zip'), { force: true });
  }
}

/** Record branch failures (a branch not pushed yet, or deleted) and clear a stale one once the branch is back. */
function recordBranchState(plans) {
  for (const p of plans) {
    const last = p.record.lastAttempt;
    if (p.failure !== undefined) {
      if (!sameFailure(last, p.failure)) patchSubject(statePath, p.subject.id, { lastAttempt: p.failure });
    } else if (!p.run && p.reason === 'up to date' && last?.ok === false && last.key === undefined) {
      patchSubject(statePath, p.subject.id, { lastAttempt: { at: new Date().toISOString(), key: p.key, ok: true } });
    }
  }
}

async function runLane(name) {
  laneName = name;
  const lane = makeLane(name);
  for (let first = true; ; first = false) {
    let engineHead;
    let own;
    try {
      const planned = planAll();
      engineHead = planned.engineHead;
      own = planned.plans.filter((p) => p.lane === name);
      recordBranchState(own);
    } catch (error) {
      log('planning failed, lane ends until the next cycle:', String(error.stderr ?? error.message ?? error).slice(-300));
      return;
    }
    const pending = orderPlans(own.filter((p) => p.run)).filter((p) => (builds.get(p.subject.id) ?? 0) < (p.subject.fastLane === true ? 20 : 1));
    if (first) log('engine', engineHead.slice(0, 9), 'pending', pending.map((p) => `${p.subject.id}(${p.reason})`).join(',') || 'none');
    if (first && own.some((p) => p.failure !== undefined)) publishAll();
    const job = pending[0];
    if (job === undefined) return;
    if (!memoryOk(memAvailableGb(), MIN_FREE_GB)) {
      log(`stopping: MemAvailable ${memAvailableGb().toFixed(1)} GB < ${MIN_FREE_GB} GB`);
      return;
    }
    builds.set(job.subject.id, (builds.get(job.subject.id) ?? 0) + 1);
    try {
      await prepareLane(lane, job);
    } catch (error) {
      log('engine preparation failed:', String(error.stderr ?? error.message ?? error).slice(-600));
      process.exitCode = 1;
      return;
    }
    build(lane, job);
    // Publish each finished subject at once (build() publishes successes); a failure shows in the picker too.
    publishAll();
  }
}

// ---- cycle: take the lane locks, run the lane(s) ----

const lockFor = (lane) => acquirePidLock(laneLockPath(home, lane));
if (laneArg === 'big' || laneArg === 'small') {
  const release = lockFor(laneArg);
  if (release === undefined) log(`another ${laneArg} cycle runs, pid`, readHolder(laneLockPath(home, laneArg)));
  else {
    process.on('exit', release);
    await runLane(laneArg);
  }
} else {
  const releaseBig = lockFor('big');
  if (releaseBig === undefined) {
    // The big lane is busy: this cycle can still serve the small lane.
    laneName = 'small';
    const releaseSmall = lockFor('small');
    if (releaseSmall === undefined) log('big and small cycles run, pids', readHolder(laneLockPath(home, 'big')), readHolder(laneLockPath(home, 'small')));
    else {
      process.on('exit', releaseSmall);
      await runLane('small');
    }
  } else {
    process.on('exit', releaseBig);
    // The small lane runs in its own process beside the big one (each build blocks its process).
    const small = spawn(process.execPath, [join(scriptDir, 'show-rebuild.mjs'), ...args.filter((a) => a !== '--publish'), '--lane', 'small'], { stdio: 'inherit', env });
    const smallDone = new Promise((done) => small.on('exit', done));
    await runLane('big');
    // A second cycle may start its big lane while the small child still runs.
    releaseBig();
    await smallDone;
  }
}
if (!existsSync(join(studio, 'show/subjects.json')) || args.includes('--publish')) publishAll();
laneName = 'cycle';
log('cycle done');
