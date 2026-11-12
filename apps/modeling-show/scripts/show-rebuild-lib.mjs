// Pure decisions and shared file helpers of the interactive-page runner (show-rebuild.mjs, the
// detached show-journey.mjs). Everything that can be decided without a build lives here so the
// unit tests exercise the same code the live runner runs.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** A subject flagged `small` builds in the small lane; every other subject in the big lane. */
export const laneOf = (subject) => (subject.small === true ? 'small' : 'big');

/** The big lane keeps the historical `cycle.lock` name, so an older runner process still excludes a second big build. */
export const laneLockPath = (home, lane) => join(home, lane === 'small' ? 'cycle-small.lock' : 'cycle.lock');

export const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
export function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Take a pid lock file; undefined while a live process other than this one holds it. The file
 * appears atomically with the pid in it (temp file + hard link), so no reader sees it empty. A
 * dead holder's lock is replaced.
 */
export function acquirePidLock(path) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  for (let attempt = 0; attempt < 3; attempt++) {
    writeFileSync(temp, String(process.pid));
    try {
      linkSync(temp, path);
      rmSync(temp, { force: true });
      return () => {
        if (readHolder(path) === process.pid) rmSync(path, { force: true });
      };
    } catch {
      rmSync(temp, { force: true });
      const holder = readHolder(path);
      if (holder === process.pid || pidAlive(holder)) return undefined;
      // Empty or dead: replace it only if it is still the same stale file.
      rmSync(path, { force: true });
    }
  }
  return undefined;
}

/** One journey (headless Chromium, ~8-9 cores) at a time across all subjects and lanes. */
export const journeyRunLockPath = (home) => join(home, 'journey-run.lock');
export const JOURNEY_LOCK_WAIT_MS = 30 * 60e3;

/**
 * Wait (async, so signals still interrupt) until the pid lock is ours: poll every `pollMs` up to
 * `timeoutMs`. Returns the release function, or undefined on timeout. A dead holder is taken over
 * by acquirePidLock.
 */
export async function waitPidLock(path, { timeoutMs = JOURNEY_LOCK_WAIT_MS, pollMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const release = acquirePidLock(path);
    if (release !== undefined) return release;
    if (now() >= deadline) return undefined;
    await sleep(pollMs);
  }
}

const TEXT_EXT = /\.(?:m?js|html|json|css|map|wgsl|txt)$/;
const LABEL = /engine [0-9a-f]{9} \u00b7 modeling [0-9a-f]{7} \([^)]*\) \u00b7 built \d{4}-\d\d-\d\dT\d\d:\d\dZ/g;

/** Digest of a built page tree with the per-build label neutralised, so equal geometry/pack output hashes equal. */
export function pageDigest(dir) {
  const hash = createHash('sha256');
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .sort();
  for (const file of files) {
    hash.update(`${relative(dir, file)}\0`);
    const bytes = readFileSync(file);
    hash.update(TEXT_EXT.test(file) ? bytes.toString('utf8').replace(LABEL, '<label>') : bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The previous full journey still covers this build: same Engine, same page artifact digest, and it passed. */
export const journeyUnchanged = ({ good, buildEngine, digest }) =>
  good?.fullJourneyAt !== undefined && digest !== undefined && good.fullJourneyPageDigest === digest && good.engine === buildEngine;

export function readHolder(path) {
  try {
    return Number(readFileSync(path, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

/** Run `fn` while holding a short-lived lock file (spin until `timeoutMs`); the holder's pid decides staleness. */
export function withFileLock(path, fn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let release = acquirePidLock(path);
  while (release === undefined) {
    if (Date.now() > deadline) throw new Error(`lock ${path} busy for ${timeoutMs} ms`);
    sleepSync(100);
    release = acquirePidLock(path);
  }
  try {
    return fn();
  } finally {
    release();
  }
}

/** Apply a record patch: an `undefined` value deletes the key. */
export function applyPatch(record, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  return record;
}

/**
 * Read-modify-write of state.json under a lock, so the big lane, the small lane and the detached
 * journeys never overwrite one another's records.
 */
export function updateState(statePath, fn) {
  return withFileLock(`${statePath}.lock`, () => {
    const state = readJson(statePath, { subjects: {} });
    state.subjects ??= {};
    fn(state);
    writeJson(statePath, state);
    return state;
  });
}

export const patchSubject = (statePath, id, patch) =>
  updateState(statePath, (state) => {
    applyPatch((state.subjects[id] ??= {}), patch);
  });

/**
 * What the Engine commit a subject's live page was built with means for its next build. The age is
 * the commit's own date, not the last build time (modeling rebuilds reset the build time all day).
 * `due` forces a rebuild: the commit is older than the threshold and the difference to the head is
 * more than build-side packages. `refresh` makes any build of this subject use the head Engine
 * (build-side speedups and fixes), without forcing one.
 */
export function engineDecision({ good, engineHead, now, refreshHours, commitTime, buildSideOnly }) {
  if (good === undefined) return { due: true, refresh: true, why: 'no live build' };
  if (good.engine === engineHead) return { due: false, refresh: false, why: 'live page is on the Engine head' };
  const committed = commitTime(good.engine);
  const ageHours = committed === undefined ? Number.POSITIVE_INFINITY : (now - committed) / 3600e3;
  const old = ageHours > refreshHours;
  const age = `live Engine ${good.engine.slice(0, 9)} is ${Number.isFinite(ageHours) ? `${ageHours.toFixed(1)} h` : 'of unknown age'} old ${old ? '>' : '<='} ${refreshHours} h`;
  if (buildSideOnly(good.engine, engineHead)) {
    return { due: false, refresh: old, why: `${age}; build-side-only change${old ? ' (no rebuild forced; the next build uses the head Engine)' : ''}` };
  }
  return { due: old, refresh: old, why: `${age}; runtime change` };
}

/**
 * One subject's plan for this moment. `run` says whether a build starts; `reason` names why
 * (modeling head change / engine age / forced / first build / config change) or why not.
 */
export function planSubject({ subject, record, modelingHead, engineHead, engine, requested }) {
  const good = record.lastGood;
  const buildEngine = good !== undefined && !engine.refresh ? good.engine : engineHead;
  const key = `${buildEngine}@${modelingHead}:${subject.project}`;
  const base = { key, modelingHead, engineDue: engine.due, useHead: engine.refresh, engineNote: engine.why };
  if (requested) return { ...base, run: true, reason: 'forced' };
  const sameInput = good !== undefined && good.modeling === modelingHead && good.key?.endsWith(`:${subject.project}`) === true;
  if (sameInput && !engine.due) return { ...base, run: false, reason: 'up to date' };
  if (record.lastAttempt?.key === key) return { ...base, run: false, reason: 'already attempted at this key (retries on the next head change)' };
  if (good === undefined) return { ...base, run: true, reason: 'first build' };
  const reasons = [];
  if (good.modeling !== modelingHead) reasons.push('modeling head change');
  if (engine.due) reasons.push('engine age');
  if (reasons.length === 0) reasons.push('config change');
  return { ...base, run: true, reason: reasons.join(' + ') };
}

/** F1 (`fastLane`) subjects first, then config order. */
export const orderPlans = (plans) => [...plans.filter((p) => p.subject.fastLane === true), ...plans.filter((p) => p.subject.fastLane !== true)];

/** Parse `git ls-remote origin refs/heads/<branch>` output; a missing branch is a clear failure, not a crash. */
export function parseBranchHead(output, branch) {
  const sha = output.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error(`modeling branch '${branch}' is not on origin (not pushed yet, or deleted)`);
  }
  return sha;
}

/** A network or remote failure: not evidence about the branch, so it never overwrites a subject's record. */
export class TransientRemoteError extends Error {}

/** Resolve a branch head: a transport error is transient, a missing branch is a branch failure. */
export function resolveBranchHead({ lsRemote, branch }) {
  let out;
  try {
    out = lsRemote();
  } catch (error) {
    throw new TransientRemoteError(`cannot reach the modeling remote for '${branch}': ${String(error.stderr ?? error.message).slice(-200)}`);
  }
  return parseBranchHead(out, branch);
}

/** The failure record for a subject whose branch head cannot be resolved; the previous build stays live. */
export function branchFailure({ record, message, at }) {
  const good = record.lastGood;
  const kept = good === undefined ? 'no build is live yet' : `keeping the live build (modeling ${good.modeling.slice(0, 7)}, built ${good.builtAt.slice(0, 16)}Z)`;
  return { at, ok: false, reason: `${message}; ${kept}` };
}

/** True when two failure records say the same thing (so a repeated cycle does not rewrite state). */
export const sameFailure = (a, b) => a !== undefined && b !== undefined && a.ok === false && b.ok === false && a.reason === b.reason && a.key === b.key;

/** Memory guard shared by both lanes. */
export const memoryOk = (availableGb, minGb) => availableGb >= minGb;

/** A journey whose only failures are Playwright time bounds (a screenshot on a loaded host) proves nothing about the page. */
export const timeoutOnly = (summary) =>
  typeof summary === 'string' &&
  summary.trim() !== '' &&
  summary.split('\n').every((line) => /Timeout \d+ms exceeded|timed out/i.test(line));

/** A pending journey result applies only while the published build is still the one it verified. */
export function journeyVerdict({ record, job, result, at, previousAvailable = true }) {
  const live = record.lastGood;
  if (live === undefined || live.builtAt !== job.builtAt) return { stale: true };
  if (result.ok) {
    return {
      stale: false,
      rollback: false,
      patch: {
        lastGood: { ...live, fullJourneyAt: job.builtAt, fullJourneyPageDigest: live.pageDigest, journey: { state: 'ok', at, seconds: result.seconds } },
      },
    };
  }
  if (timeoutOnly(result.summary)) {
    // The 60-frame smoke already gated the publish; a timeout leaves the page live and records it.
    return {
      stale: false,
      rollback: false,
      patch: { lastGood: { ...live, journey: { state: 'timeout', at, summary: result.summary } } },
    };
  }
  if (!previousAvailable || job.previousGood === null || job.previousGood === undefined) {
    // Nothing to restore: the page stays live, marked as failed, never deleted.
    return {
      stale: false,
      rollback: false,
      patch: {
        lastGood: { ...live, journey: { state: 'failed', at, summary: result.summary } },
        lastAttempt: { at: job.builtAt, key: job.attemptKey, ok: false, reason: `journey after publish (no earlier build to roll back to; page kept): ${result.summary}`, steps: job.steps },
      },
    };
  }
  const to = job.previousGood?.modeling?.slice(0, 7);
  return {
    stale: false,
    rollback: true,
    patch: {
      lastGood: job.previousGood,
      lastAttempt: {
        at: job.builtAt,
        key: job.attemptKey,
        ok: false,
        reason: `journey after publish (rolled back to ${to}): ${result.summary}`,
        steps: job.steps,
      },
    },
  };
}

/** A pending journey whose rollback target a newer publish may take over (the last verified build). */
export const adoptableJob = (record, job) =>
  job !== undefined && record.lastGood?.builtAt === job.builtAt && record.lastGood?.journey?.state === 'pending';

export const journeyPaths = (home, id, modeling) => {
  const name = `${id}-${modeling.slice(0, 7)}`;
  return { name, dir: join(home, 'journeys', name), log: join(home, 'journeys', `${name}.log`), lock: join(home, 'journeys', `${id}.lock`) };
};

/** True when `cmdline` (NUL-separated /proc/<pid>/cmdline) is the detached journey process of `jobPath`. */
export function isJourneyProcess(cmdline, jobPath) {
  const parts = cmdline.split('\0');
  return parts.some((part) => part.endsWith('show-journey.mjs')) && parts.includes(jobPath);
}

const cmdlineOf = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Stop a subject's running journey (its whole process group) and drop its lock; returns the job
 * it was running. A recycled pid is left alone: the process must be this job's journey.
 */
export function stopJourney({ home, id, log = () => {} }) {
  const lockPath = join(home, 'journeys', `${id}.lock`);
  const lock = readJson(lockPath, undefined);
  if (lock === undefined) return undefined;
  if (pidAlive(lock.pid) && isJourneyProcess(cmdlineOf(lock.pid), lock.jobPath)) {
    log('cancel stale journey of', id, 'pid', lock.pid);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-lock.pid, signal);
      } catch {}
      for (let i = 0; i < 100 && pidAlive(lock.pid); i++) sleepSync(300);
      if (!pidAlive(lock.pid)) break;
    }
  }
  rmSync(lockPath, { force: true });
  return readJson(lock.jobPath, undefined);
}

/**
 * Which build is the rollback target of a new publish, from a FRESH record: a still-pending journey
 * of the live build hands over its own target (and its `previous` folder); otherwise the live build
 * is the target, but only when its page exists to be copied into `previous`.
 */
export function choosePrevious({ record, stopped, stoppedPreviousExists, targetExists }) {
  if (adoptableJob(record, stopped) && stoppedPreviousExists) return { adopt: true, previousGood: stopped.previousGood ?? null };
  return { adopt: false, previousGood: targetExists ? (record.lastGood ?? null) : null };
}

/** Start the detached journey under forgeax-heavy --low; the build loop never waits for it. */
export function spawnJourney({ home, job, scriptDir, env }) {
  const paths = journeyPaths(home, job.id, job.modeling);
  const jobPath = join(paths.dir, 'job.json');
  writeJson(jobPath, job);
  const fd = openSync(paths.log, 'a');
  const child = spawn('forgeax-heavy', ['--low', process.execPath, join(scriptDir, 'show-journey.mjs'), jobPath], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  child.unref();
  closeSync(fd);
  writeJson(paths.lock, { pid: child.pid, jobPath, builtAt: job.builtAt });
  return { pid: child.pid, log: paths.log };
}

/** Replace `target` with `fresh`, rewriting only changed files so publishing copies only those. */
export function swapInto(target, fresh) {
  const list = (base) =>
    (existsSync(base) ? readdirSync(base, { recursive: true, withFileTypes: true }) : [])
      .filter((e) => e.isFile())
      .map((e) => relative(base, join(e.parentPath, e.name)));
  const old = new Set(list(target));
  for (const file of list(fresh)) {
    const to = join(target, file);
    const from = join(fresh, file);
    old.delete(file);
    if (existsSync(to) && statSync(to).size === statSync(from).size && readFileSync(to).equals(readFileSync(from))) continue;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  for (const stale of old) rmSync(join(target, stale), { force: true });
}

/** The journey's final JSON: failed checks with their details, console errors and timing. */
export function journeyResult(output) {
  const start = output.lastIndexOf('\n{');
  if (start < 0) return { ok: false, summary: '' };
  try {
    const result = JSON.parse(output.slice(start + 1));
    const failed = (result.steps ?? []).filter((step) => !step.ok).map((step) => `${step.name}: ${JSON.stringify(step.detail)}`);
    const errors = (result.errors ?? []).map((e) => `console: ${e}`);
    return { ok: result.ok === true, seconds: result.seconds, summary: [...failed, ...errors].join('\n').slice(0, 1200) };
  } catch {
    return { ok: false, summary: '' };
  }
}

/**
 * Serve `dir` with the share headers and run page-journey.mjs against it. `run(argv, options)`
 * executes the journey command: the build loop wraps it in forgeax-heavy, the detached journey
 * process is already under forgeax-heavy and runs it directly.
 */
export function runJourney({ subject, dir, out, quick = false, scriptDir, env, chromeLibs, run }) {
  const port = 5800 + Math.floor(Math.random() * 1000);
  const prefix = `/share/x/files/show/${subject.id}/`;
  const server = spawn(process.execPath, [join(scriptDir, 'share-server.mjs'), dir, String(port), prefix], {
    env: { ...env, GZIP: '1' },
    stdio: 'ignore',
  });
  try {
    sleepSync(1000);
    const output = run(['node', join(scriptDir, 'page-journey.mjs'), `http://127.0.0.1:${port}${prefix}index.html`, out], {
      env: {
        ...env,
        JOURNEY: quick ? 'smoke' : (subject.journey ?? 'basic'),
        ...(quick ? {} : { THROTTLE_MBPS: '20', THROTTLE_RTT_MS: '50' }),
        LD_LIBRARY_PATH: chromeLibs,
      },
    });
    return journeyResult(output);
  } catch (error) {
    const parsed = journeyResult(String(error.stdout ?? ''));
    return parsed.summary === '' ? { ok: false, summary: String(error.message ?? error).slice(-1200) } : { ...parsed, ok: false };
  } finally {
    server.kill();
  }
}

/** Rewrite show/subjects.json from the current state and publish the share (serialized across processes). */
export const PUBLISH_LOCK_WAIT_MS = 30 * 60e3;

/** Never throws: a busy or failing publish is logged and the next publish carries the same files. */
export function publish({ config, statePath, studio, scriptDir, env, log, lockWaitMs = PUBLISH_LOCK_WAIT_MS }) {
  try {
    publishLocked({ config, statePath, studio, scriptDir, env, log, lockWaitMs });
    return true;
  } catch (error) {
    log('publish skipped (retried at the next publish):', String(error.message ?? error).slice(-300));
    return false;
  }
}

/** Serialize git operations of the lanes that share one object database. */
export const withFetchLock = (home, fn) => withFileLock(join(home, 'git-fetch.lock'), fn, 10 * 60e3);

function publishLocked({ config, statePath, studio, scriptDir, env, log, lockWaitMs }) {
  withFileLock(join(dirname(statePath), 'publish.lock'), () => {
    const state = readJson(statePath, { subjects: {} });
    const subjects = config.subjects.map((subject) => {
      const record = state.subjects[subject.id] ?? {};
      const good = record.lastGood;
      return {
        id: subject.id,
        title: subject.title,
        branch: subject.modelingBranch,
        wip: subject.wip === true,
        archive: subject.archive === true,
        ...(subject.note === undefined ? {} : { note: subject.note }),
        available: good !== undefined && existsSync(join(studio, 'show', subject.id, 'index.html')),
        ...(good === undefined ? {} : { label: good.label, builtAt: good.builtAt, modeling: good.modeling, engine: good.engine, sources: good.sources ?? {} }),
        ...(record.lastAttempt?.ok === false ? { failure: { at: record.lastAttempt.at, reason: record.lastAttempt.reason } } : {}),
      };
    });
    mkdirSync(join(studio, 'show'), { recursive: true });
    writeJson(join(studio, 'show/subjects.json'), { updatedAt: new Date().toISOString(), subjects });
    cpSync(join(scriptDir, 'show-picker.html'), join(studio, 'show/index.html'));
    // A failed publish (a concurrent board publish, a gateway hiccup) must not end the cycle;
    // the next publish carries the same show/ files.
    try {
      execFileSync(process.execPath, [join(studio, 'scripts/publish.mjs')], { cwd: studio, env, encoding: 'utf8', maxBuffer: 64 << 20 });
      log('published');
    } catch (error) {
      log('publish failed:', String(error.stderr ?? error.message ?? error).slice(-400));
    }
  }, lockWaitMs);
}
