import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  acquirePidLock,
  adoptableJob,
  applyPatch,
  branchFailure,
  choosePrevious,
  isJourneyProcess,
  journeyRunLockPath,
  journeyUnchanged,
  pageDigest,
  waitPidLock,
  publish,
  resolveBranchHead,
  TransientRemoteError,
  engineDecision,
  journeyPaths,
  journeyResult,
  journeyVerdict,
  laneLockPath,
  laneOf,
  memoryOk,
  orderPlans,
  parseBranchHead,
  patchSubject,
  planSubject,
  sameFailure,
  swapInto,
  updateState,
} from '../scripts/show-rebuild-lib.mjs';

const H = 3600e3;
const now = Date.parse('2026-10-25T12:00:00Z');
const OLD = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const M1 = '1'.repeat(40);
const M2 = '2'.repeat(40);
let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'show-rebuild-test-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const decide = (good: object | undefined, committedHoursAgo: number | undefined, sideOnly: boolean) =>
  engineDecision({
    good,
    engineHead: HEAD,
    now,
    refreshHours: 6,
    commitTime: () => (committedHoursAgo === undefined ? undefined : now - committedHoursAgo * H),
    buildSideOnly: () => sideOnly,
  });

it('measures the Engine age from the commit the live page was built with, not from the build time', () => {
  // Built a minute ago on a 25 h old Engine commit: a build-time age would say "fresh".
  const good = { engine: OLD, builtAt: new Date(now - 60e3).toISOString() };
  expect(decide(good, 25, false)).toMatchObject({ due: true, refresh: true });
  expect(decide(good, 5, false)).toMatchObject({ due: false, refresh: false });
  expect(decide(good, undefined, false).due).toBe(true);
});

it('a build-side-only Engine change never forces a rebuild, but a build that happens uses the head Engine once old', () => {
  const good = { engine: OLD, builtAt: new Date(now).toISOString() };
  expect(decide(good, 48, true)).toMatchObject({ due: false, refresh: true });
  expect(decide(good, 2, true)).toMatchObject({ due: false, refresh: false });
});

it('a live page on the Engine head is never due; no live page always builds', () => {
  expect(decide({ engine: HEAD }, 100, false)).toMatchObject({ due: false, refresh: false });
  expect(decide(undefined, undefined, false)).toMatchObject({ due: true, refresh: true });
});

const subject = { id: 's', project: 'p', modelingBranch: 'main' };
const good = { key: `${OLD}@${M1}:p`, engine: OLD, modeling: M1, builtAt: '2026-10-24T00:00:00Z' };
const plan = (over: object, engine: ReturnType<typeof decide>, requested = false) =>
  planSubject({ subject, record: { lastGood: good, ...over }, modelingHead: M1, engineHead: HEAD, engine, requested });

it('names why a subject builds: modeling head change, engine age, forced, first build', () => {
  const sideOld = decide(good, 48, true);
  expect(plan({}, sideOld)).toMatchObject({ run: false, reason: 'up to date' });
  expect(planSubject({ subject, record: { lastGood: good }, modelingHead: M2, engineHead: HEAD, engine: decide(good, 1, false), requested: false })).toMatchObject({
    run: true,
    reason: 'modeling head change',
    key: `${OLD}@${M2}:p`,
  });
  // Same modeling head, runtime Engine change older than the threshold.
  expect(plan({}, decide(good, 48, false))).toMatchObject({ run: true, reason: 'engine age', key: `${HEAD}@${M1}:p`, useHead: true });
  expect(planSubject({ subject, record: { lastGood: good }, modelingHead: M2, engineHead: HEAD, engine: decide(good, 48, false), requested: false }).reason).toBe('modeling head change + engine age');
  expect(plan({}, decide(good, 1, false), true)).toMatchObject({ run: true, reason: 'forced' });
  expect(planSubject({ subject, record: {}, modelingHead: M1, engineHead: HEAD, engine: decide(undefined, undefined, false), requested: false })).toMatchObject({ run: true, reason: 'first build' });
});

it('a build-side-only old Engine builds on the head only when another input changed', () => {
  const p = planSubject({ subject, record: { lastGood: good }, modelingHead: M2, engineHead: HEAD, engine: decide(good, 48, true), requested: false });
  expect(p).toMatchObject({ run: true, reason: 'modeling head change', key: `${HEAD}@${M2}:p`, useHead: true });
});

it('does not retry a key that already failed', () => {
  const p = plan({ lastAttempt: { key: `${HEAD}@${M1}:p`, ok: false } }, decide(good, 48, false));
  expect(p).toMatchObject({ run: false });
  expect(p.reason).toContain('already attempted');
});

it('puts F1 fastLane subjects first and keeps config order otherwise', () => {
  const ids = (list: { subject: { id: string } }[]) => list.map((p) => p.subject.id);
  const plans = [{ subject: { id: 'a' } }, { subject: { id: 'f', fastLane: true } }, { subject: { id: 'b' } }, { subject: { id: 'g', fastLane: true } }];
  expect(ids(orderPlans(plans))).toEqual(['f', 'g', 'a', 'b']);
});

it('assigns small subjects to the small lane with its own lock', () => {
  expect(laneOf({ small: true })).toBe('small');
  expect(laneOf({})).toBe('big');
  expect(laneOf({ small: false })).toBe('big');
  expect(laneLockPath('/h', 'big')).toBe('/h/cycle.lock');
  expect(laneLockPath('/h', 'small')).not.toBe(laneLockPath('/h', 'big'));
});

it('a lane lock excludes a second holder in that lane only; a dead holder is replaced', () => {
  const big = join(tmp, 'cycle.lock');
  const small = join(tmp, 'cycle-small.lock');
  const releaseBig = acquirePidLock(big);
  expect(releaseBig).toBeDefined();
  // Our own pid holds it: a second cycle in another process sees a live holder (modelled by a live foreign pid).
  writeFileSync(small, String(process.ppid));
  expect(acquirePidLock(small)).toBeUndefined();
  writeFileSync(small, '2147483000');
  const releaseSmall = acquirePidLock(small);
  expect(releaseSmall).toBeDefined();
  releaseSmall?.();
  releaseBig?.();
  expect(() => readFileSync(big)).toThrow();
});

it('a branch that does not exist keeps the previous build with a clear reason', () => {
  expect(() => parseBranchHead('', 'feat/x')).toThrow(/'feat\/x' is not on origin/);
  expect(parseBranchHead(`${M1}\trefs/heads/main\n`, 'main')).toBe(M1);
  const live = branchFailure({ record: { lastGood: good }, message: "modeling branch 'feat/x' is not on origin", at: 't' });
  expect(live).toMatchObject({ ok: false });
  expect(live.reason).toContain('keeping the live build (modeling 1111111');
  expect(branchFailure({ record: {}, message: 'm', at: 't' }).reason).toContain('no build is live yet');
  expect(sameFailure(live, { ...live, at: 'later' })).toBe(true);
});

const job = { builtAt: 'B1', attemptKey: 'k', steps: { smoke: 1 }, previousGood: { ...good, modeling: M1 } };
it('applies a journey verdict only to the build it verified', () => {
  const live = { lastGood: { builtAt: 'B1', modeling: M2, journey: { state: 'pending' } } };
  expect(journeyVerdict({ record: { lastGood: { builtAt: 'B2' } }, job, result: { ok: false, summary: 'x' }, at: 't' })).toEqual({ stale: true });
  const ok = journeyVerdict({ record: live, job, result: { ok: true, seconds: 9 }, at: 't' });
  expect(ok).toMatchObject({ stale: false, rollback: false });
  expect(ok.patch.lastGood).toMatchObject({ fullJourneyAt: 'B1', journey: { state: 'ok' } });
  const bad = journeyVerdict({ record: live, job, result: { ok: false, summary: 'boom' }, at: 't' });
  expect(bad.rollback).toBe(true);
  expect(bad.patch.lastGood).toBe(job.previousGood);
  expect(bad.patch.lastAttempt).toMatchObject({ ok: false, key: 'k' });
  expect(bad.patch.lastAttempt.reason).toContain('rolled back to 1111111');
  const first = journeyVerdict({ record: live, job: { ...job, previousGood: null }, result: { ok: false, summary: 'boom' }, at: 't' });
  expect(first.rollback).toBe(false);
  expect(first.patch.lastGood.journey.state).toBe('failed');
  const slow = journeyVerdict({ record: live, job, result: { ok: false, summary: 'journey: {"error":"TimeoutError: page.screenshot: Timeout 180000ms exceeded."}' }, at: 't' });
  expect(slow.rollback).toBe(false);
  expect(slow.patch.lastGood).toMatchObject({ builtAt: 'B1', journey: { state: 'timeout' } });
  expect(slow.patch.lastAttempt).toBeUndefined();
  expect(journeyVerdict({ record: live, job, result: { ok: false, summary: 'u slider: {}\njourney: Timeout 5ms exceeded' }, at: 't' }).rollback).toBe(true);
  expect(applyPatch({ lastGood: 1, a: 2 }, { lastGood: undefined })).not.toHaveProperty('lastGood');
});

it('only a still-pending journey of the live build hands its rollback target to a newer publish', () => {
  const rec = (state: string, builtAt = 'B1') => ({ lastGood: { builtAt, journey: { state } } });
  expect(adoptableJob(rec('pending'), job)).toBe(true);
  expect(adoptableJob(rec('ok'), job)).toBe(false);
  expect(adoptableJob(rec('pending', 'B9'), job)).toBe(false);
  expect(adoptableJob(rec('pending'), undefined)).toBe(false);
});

it('keeps each journey in its own log, directory and per-subject lock', () => {
  const p = journeyPaths('/h', 'f1-rig', `${M1}`);
  expect(p.log).toBe('/h/journeys/f1-rig-1111111.log');
  expect(p.dir).toBe('/h/journeys/f1-rig-1111111');
  expect(p.lock).toBe('/h/journeys/f1-rig.lock');
});

it('patches and updates state.json atomically without losing other records', () => {
  const path = join(tmp, 'state.json');
  writeFileSync(path, JSON.stringify({ subjects: { a: { lastGood: { x: 1 } } }, modelingDist: 'd' }));
  patchSubject(path, 'b', { lastAttempt: { ok: true } });
  patchSubject(path, 'a', { lastGood: undefined });
  updateState(path, (s: { subjects: object }) => Object.assign(s.subjects, { c: {} }));
  const state = JSON.parse(readFileSync(path, 'utf8'));
  expect(Object.keys(state.subjects)).toEqual(['a', 'b', 'c']);
  expect(state.subjects.a).toEqual({});
  expect(state.modelingDist).toBe('d');
});

it('reads the journey result and swaps only changed files', () => {
  expect(journeyResult('log\n{"ok":true,"seconds":3}')).toEqual({ ok: true, seconds: 3, summary: '' });
  expect(journeyResult('log\n{"ok":false,"steps":[{"name":"s","ok":false,"detail":1}],"errors":["e"]}').summary).toBe('s: 1\nconsole: e');
  expect(journeyResult('nothing')).toEqual({ ok: false, summary: '' });
  const fresh = join(tmp, 'fresh');
  const target = join(tmp, 'target');
  mkdirSync(fresh);
  mkdirSync(target);
  writeFileSync(join(fresh, 'a'), '1');
  writeFileSync(join(target, 'a'), '0');
  writeFileSync(join(target, 'stale'), 'x');
  swapInto(target, fresh);
  expect(readFileSync(join(target, 'a'), 'utf8')).toBe('1');
  expect(() => readFileSync(join(target, 'stale'))).toThrow();
});

it('the memory guard applies per lane', () => {
  expect(memoryOk(15.9, 16)).toBe(false);
  expect(memoryOk(16, 16)).toBe(true);
});

it('a lock file never exists without its pid', () => {
  const path = join(tmp, 'a.lock');
  const release = acquirePidLock(path);
  expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  release?.();
  writeFileSync(path, '');
  expect(acquirePidLock(path)).toBeDefined();
});

it('treats a network error as transient and a missing branch as a branch failure', () => {
  const boom = () => {
    throw new Error('network down');
  };
  expect(() => resolveBranchHead({ lsRemote: boom, branch: 'b' })).toThrow(TransientRemoteError);
  expect(() => resolveBranchHead({ lsRemote: () => '', branch: 'b' })).toThrow(/not on origin/);
  expect(() => resolveBranchHead({ lsRemote: () => '', branch: 'b' })).not.toThrow(TransientRemoteError);
  expect(resolveBranchHead({ lsRemote: () => `${M1}\trefs/heads/b`, branch: 'b' })).toBe(M1);
});

it('signals a journey group only when the pid is that job\'s journey process', () => {
  const ok = ['forgeax-heavy', '--low', 'node', '/x/show-journey.mjs', '/j/job.json'].join('\0');
  expect(isJourneyProcess(ok, '/j/job.json')).toBe(true);
  expect(isJourneyProcess(ok, '/other/job.json')).toBe(false);
  expect(isJourneyProcess(['sshd', '/j/job.json'].join('\0'), '/j/job.json')).toBe(false);
  expect(isJourneyProcess('', '/j/job.json')).toBe(false);
});

it('chooses the rollback target from the fresh record; a missing previous folder gives null', () => {
  const stopped = { builtAt: 'B1', previousGood: { modeling: 'old' } };
  const pending = { lastGood: { builtAt: 'B1', modeling: 'cur', journey: { state: 'pending' } } };
  expect(choosePrevious({ record: pending, stopped, stoppedPreviousExists: true, targetExists: true })).toEqual({ adopt: true, previousGood: { modeling: 'old' } });
  // The old journey finished while this build ran: the live build is verified and becomes the target.
  const finished = { lastGood: { builtAt: 'B1', modeling: 'cur', journey: { state: 'ok' } } };
  expect(choosePrevious({ record: finished, stopped, stoppedPreviousExists: true, targetExists: true })).toEqual({ adopt: false, previousGood: finished.lastGood });
  expect(choosePrevious({ record: pending, stopped, stoppedPreviousExists: false, targetExists: true }).adopt).toBe(false);
  expect(choosePrevious({ record: finished, stopped: undefined, stoppedPreviousExists: false, targetExists: false })).toEqual({ adopt: false, previousGood: null });
});

it('a failed journey without a previous folder keeps the page and records the failure', () => {
  const live = { lastGood: { builtAt: 'B1', modeling: M2, journey: { state: 'pending' } } };
  const v = journeyVerdict({ record: live, job, result: { ok: false, summary: 'boom' }, at: 't', previousAvailable: false });
  expect(v.rollback).toBe(false);
  expect(v.patch.lastGood.journey.state).toBe('failed');
  expect(v.patch.lastGood.modeling).toBe(M2);
  expect(v.patch.lastAttempt.reason).toContain('page kept');
  const none = journeyVerdict({ record: live, job: { ...job, previousGood: null }, result: { ok: false, summary: 'x' }, at: 't' });
  expect(none.rollback).toBe(false);
});

it('publish shows the already recorded lastGood and never throws on a busy lock', () => {
  const scriptDir = join(dirname(new URL(import.meta.url).pathname), '../scripts');
  const studio = join(tmp, 'studio');
  const statePath = join(tmp, 'state.json');
  mkdirSync(studio);
  const config = { subjects: [{ id: 's', title: 'S', project: 'p', modelingBranch: 'main' }] };
  writeFileSync(statePath, JSON.stringify({ subjects: { s: { lastGood: { engine: OLD, modeling: M2, label: 'L', builtAt: 'T' } } } }));
  const logs: string[] = [];
  expect(publish({ config, statePath, studio, scriptDir, env: process.env, log: (...a: unknown[]) => logs.push(a.join(' ')) })).toBe(true);
  const listed = JSON.parse(readFileSync(join(studio, 'show/subjects.json'), 'utf8')).subjects[0];
  expect(listed).toMatchObject({ modeling: M2, engine: OLD, label: 'L', builtAt: 'T' });
  writeFileSync(join(tmp, 'publish.lock'), String(process.ppid));
  expect(publish({ config, statePath, studio, scriptDir, env: process.env, log: (...a: unknown[]) => logs.push(a.join(' ')), lockWaitMs: 300 })).toBe(false);
  expect(logs.join('\n')).toContain('publish skipped');
});

it('journey run lock: a second journey waits, then proceeds; a dead owner is taken over', async () => {
  const path = journeyRunLockPath(tmp);
  const first = acquirePidLock(path);
  expect(first).toBeDefined();
  let polls = 0;
  const waited = await waitPidLock(path, {
    pollMs: 1,
    sleep: async () => {
      if (++polls === 3) first?.();
    },
  });
  expect(polls).toBe(3);
  expect(waited).toBeDefined();
  waited?.();
  const held = acquirePidLock(path);
  let clock = 0;
  const gaveUp = await waitPidLock(path, { timeoutMs: 10, pollMs: 4, sleep: async () => void (clock += 4), now: () => clock });
  expect(gaveUp).toBeUndefined();
  held?.();
  writeFileSync(path, '2147483646');
  const taken = await waitPidLock(path, { timeoutMs: 0 });
  expect(taken).toBeDefined();
  taken?.();
});

it('journey skip rule: only identical page digest + engine after a passed journey', () => {
  const dir = join(tmp, 'page');
  mkdirSync(dir, { recursive: true });
  const page = (label: string, body: string) => {
    writeFileSync(join(dir, 'main.js'), `const L=${JSON.stringify(label)};${body}`);
    return pageDigest(dir);
  };
  const label = (m: string, t: string) => `engine ${'a'.repeat(9)} \u00b7 modeling ${m} (b) \u00b7 built ${t}`;
  const d1 = page(label('1234567', '2026-10-26T01:02Z'), 'x();');
  expect(page(label('7654321', '2026-10-27T03:04Z'), 'x();')).toBe(d1);
  const d2 = page(label('7654321', '2026-10-27T03:04Z'), 'y();');
  expect(d2).not.toBe(d1);
  const good = { engine: OLD, fullJourneyAt: 't', pageDigest: d1, fullJourneyPageDigest: d1 };
  expect(journeyUnchanged({ good, buildEngine: OLD, digest: d1 })).toBe(true);
  expect(journeyUnchanged({ good, buildEngine: OLD, digest: d2 })).toBe(false);
  expect(journeyUnchanged({ good, buildEngine: HEAD, digest: d1 })).toBe(false);
  expect(journeyUnchanged({ good: { ...good, fullJourneyAt: undefined }, buildEngine: OLD, digest: d1 })).toBe(false);
  expect(journeyUnchanged({ good: { engine: OLD, fullJourneyAt: 't', pageDigest: d1 }, buildEngine: OLD, digest: d1 })).toBe(false);
});

it('does not reuse page A full-journey coverage for a smoke-only page B', () => {
  const smokeOnly = { engine: OLD, fullJourneyAt: 'A-time', fullJourneyPageDigest: 'A', pageDigest: 'B' };
  expect(journeyUnchanged({ good: smokeOnly, buildEngine: OLD, digest: 'B' })).toBe(false);
  expect(journeyUnchanged({ good: smokeOnly, buildEngine: OLD, digest: 'A' })).toBe(true);
  const record = { lastGood: { engine: OLD, builtAt: 'B1', pageDigest: 'B', journey: { state: 'pending' } } };
  const passed = journeyVerdict({ record, job, result: { ok: true }, at: 't' }).patch.lastGood;
  expect(passed.fullJourneyPageDigest).toBe('B');
  expect(journeyUnchanged({ good: passed, buildEngine: OLD, digest: 'B' })).toBe(true);
  for (const summary of ['boom', 'Timeout 100ms exceeded']) {
    const failed = journeyVerdict({ record, job: { ...job, previousGood: null }, result: { ok: false, summary }, at: 't' }).patch.lastGood;
    expect(failed.fullJourneyPageDigest).toBeUndefined();
    expect(journeyUnchanged({ good: failed, buildEngine: OLD, digest: 'B' })).toBe(false);
  }
});
