#!/usr/bin/env node
// The full throttled journey of one published subject, run detached by show-rebuild.mjs under
// `forgeax-heavy --low` (so the build loop never waits for it and the cycle lock is not held).
// usage: node show-journey.mjs <job.json>
//
// The job names the published build (builtAt is its identity). The verdict is written into
// state.json atomically; a failure rolls the share back to the previous build. A verdict for a
// build that a newer publish has replaced meanwhile is dropped.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, journeyRunLockPath, journeyVerdict, publish, readJson, runJourney, swapInto, updateState, waitPidLock } from './show-rebuild-lib.mjs';

const job = readJson(process.argv[2], undefined);
if (job === undefined) {
  console.error('usage: show-journey.mjs <job.json>');
  process.exit(2);
}
const scriptDir = import.meta.dirname;
const home = job.home;
const env = { ...process.env, PATH: `${join(home, 'bin')}:${join(homedir(), '.cargo/bin')}:${join(homedir(), '.local/bin')}:${process.env.PATH}` };
const log = (...parts) => console.log(new Date().toISOString(), `[journey ${job.id}]`, ...parts);
let releaseRun = () => {};
const done = () => {
  releaseRun();
  rmSync(job.dir, { recursive: true, force: true });
  const lock = join(home, 'journeys', `${job.id}.lock`);
  if (readJson(lock, undefined)?.builtAt === job.builtAt) rmSync(lock, { force: true });
};
process.on('SIGTERM', () => {
  log('cancelled');
  releaseRun();
  process.exit(143);
});

// At most one journey process at a time (a waiting one holds no CPU; a dead holder is taken over).
const release = await waitPidLock(journeyRunLockPath(home), { pollMs: 2000 });
if (release === undefined) {
  log('gave up waiting for the journey lock; the build stays pending');
  process.exit(75);
}
releaseRun = release;
log('start', job.key);
const result = runJourney({
  subject: { id: job.id, journey: job.journey },
  dir: join(job.dir, 'page'),
  out: join(job.dir, 'out'),
  scriptDir,
  env,
  chromeLibs: join(home, 'chrome-libs/root/usr/lib/x86_64-linux-gnu'),
  run: (argv, options) => execFileSync(argv[0], argv.slice(1), { env: options.env, encoding: 'utf8', maxBuffer: 64 << 20 }).trim(),
});
log(result.ok ? 'PASS' : 'FAIL', result.seconds ?? '', result.summary);

let verdict;
updateState(job.statePath, (state) => {
  const record = (state.subjects[job.id] ??= {});
  verdict = journeyVerdict({ record, job, result, at: new Date().toISOString(), previousAvailable: existsSync(join(job.dir, 'previous')) });
  if (!verdict.stale) applyPatch(record, verdict.patch);
});
if (verdict.stale) {
  log('ignored: a newer build replaced this one');
} else if (verdict.rollback) {
  const target = join(job.studio, 'show', job.id);
  const previous = join(job.dir, 'previous');
  swapInto(target, previous);
  log('rolled back', job.previousGood.modeling.slice(0, 7));
}
if (!verdict.stale) {
  try {
    publish({ config: readJson(join(job.studio, 'ops/show-subjects.json'), { subjects: [] }), statePath: job.statePath, studio: job.studio, scriptDir, env, log });
  } catch (error) {
    log('publish error:', String(error.message ?? error));
  }
}
done();
