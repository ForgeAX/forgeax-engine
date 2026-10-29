import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** The process that holds a project's play lock. */
export interface PlayLockHolder {
  readonly pid: number;
  readonly host: string;
  readonly script: string;
  readonly startedAt: number;
  readonly token: string;
}

export type PlayLockResult =
  | { readonly ok: true; readonly waitedMs: number; release(): Promise<void> }
  | {
      readonly ok: false;
      readonly reason: 'busy' | 'cancelled';
      readonly waitedMs: number;
      readonly holder?: PlayLockHolder;
    }
  | {
      /** The lock file could not be created, inspected or taken over (permissions, read-only disk). */
      readonly ok: false;
      readonly reason: 'unavailable';
      readonly waitedMs: number;
      readonly message: string;
    };

export interface PlayLockOptions {
  readonly script: string;
  /** Longest wait for another holder before `busy`; 0 fails at once when held. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Called once, when the lock is first found held by a live process. */
  readonly onWait?: (holder: PlayLockHolder | undefined) => void;
  readonly pollMs?: number;
  /** @internal Liveness probe; defaults to signal 0. */
  readonly isAlive?: (pid: number) => boolean;
  /** @internal Holder heartbeat interval; default {@link PLAY_LOCK_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  /** @internal Unchanged-heartbeat observation for another host; default {@link PLAY_LOCK_STALE_MS}. */
  readonly staleMs?: number;
}

/** A holder refreshes the lock file's mtime this often while it runs. */
export const PLAY_LOCK_HEARTBEAT_MS = 30_000;
/**
 * A lock held from another host (container, network file system) is stale once
 * the waiter itself has seen its content and mtime unchanged this long: four
 * missed heartbeats, measured on the waiter's clock so clock skew cannot matter.
 * On this host the holder's pid decides instead.
 */
export const PLAY_LOCK_STALE_MS = 120_000;
/** A lock file being written by its creator is unreadable only briefly. */
const UNREADABLE_STALE_MS = 5_000;
/**
 * Windows reports a file that is being deleted (or briefly opened by a scanner)
 * as EPERM/EBUSY/EACCES; these retry for this many polls before `unavailable`.
 */
const TRANSIENT_RETRIES = 10;
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

type HolderRead =
  | { readonly kind: 'holder'; readonly holder: PlayLockHolder; readonly text: string }
  | { readonly kind: 'unreadable'; readonly text: string }
  | { readonly kind: 'missing' };

async function readHolder(path: string): Promise<HolderRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<PlayLockHolder>;
    if (typeof value.pid === 'number' && typeof value.token === 'string')
      return { kind: 'holder', holder: value as PlayLockHolder, text };
  } catch {
    // Partially written or foreign content.
  }
  return { kind: 'unreadable', text };
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** A takeover mutex older than this was left by a contender that died mid-takeover. */
const TAKEOVER_STALE_MS = 10_000;

/**
 * Runs `work` under the short `<lock>.takeover` mutex, which serializes every
 * removal of the lock file (stale takeovers and releases). Returns false when
 * another process holds the mutex; a mutex left by a dead contender is removed
 * only if it still carries the token read before judging it stale.
 */
async function withMutex(path: string, work: () => Promise<void>): Promise<boolean> {
  const mutex = `${path}.takeover`;
  try {
    await writeFile(mutex, `${process.pid} ${randomUUID()}\n`, { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const seen = await readFile(mutex, 'utf8').catch(() => undefined);
    const age = await stat(mutex).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (seen !== undefined && age > TAKEOVER_STALE_MS) {
      const again = await readFile(mutex, 'utf8').catch(() => undefined);
      if (again === seen) await rm(mutex, { force: true });
    }
    return false;
  }
  try {
    await work();
  } finally {
    await rm(mutex, { force: true });
  }
  return true;
}

/** Removes the lock file only while it still holds exactly `expected`. */
async function removeIf(path: string, expected: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (current === expected) await rm(path, { force: true });
}

/** On this host the pid decides; otherwise how long this waiter saw the file unchanged. */
function isStale(
  read: Exclude<HolderRead, { kind: 'missing' }>,
  unchangedMs: number,
  host: string,
  isAlive: (pid: number) => boolean,
  staleMs: number,
): boolean {
  if (read.kind === 'unreadable') return unchangedMs > Math.min(UNREADABLE_STALE_MS, staleMs);
  return read.holder.host === host ? !isAlive(read.holder.pid) : unchangedMs > staleMs;
}

/** Creates the lock exclusively; false when it already exists. */
async function create(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
}

/** The current lock content and mtime; ENOENT reads as missing. */
async function inspect(path: string): Promise<{ read: HolderRead; mtimeMs: number }> {
  const read = await readHolder(path);
  if (read.kind === 'missing') return { read, mtimeMs: 0 };
  try {
    return { read, mtimeMs: (await stat(path)).mtimeMs };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { read: { kind: 'missing' }, mtimeMs: 0 };
    throw error;
  }
}

/**
 * Serializes `project play` runs of one project: they share the play-owned Vite
 * dependency cache (a second optimizer invalidates the first page's modules with
 * `ERR_OUTDATED_OPTIMIZED_DEP`) and a script's output directory. The holder
 * refreshes the file's mtime every {@link PLAY_LOCK_HEARTBEAT_MS}. A lock is
 * taken over when its holder is a dead pid on this host, or, from another host,
 * after the waiter saw it unchanged for {@link PLAY_LOCK_STALE_MS}. Takeovers and
 * releases remove the file only under a takeover mutex and only while it holds
 * the content they expect, so neither a racing waiter nor a resumed old holder
 * can delete a newer lock. A waiter gives up after `timeoutMs`; file-system
 * failures (after transient Windows retries) return `unavailable` instead of throwing.
 */
export async function acquirePlayLock(
  path: string,
  options: PlayLockOptions,
): Promise<PlayLockResult> {
  const started = Date.now();
  const isAlive = options.isAlive ?? processAlive;
  const self: PlayLockHolder = {
    pid: process.pid,
    host: hostname(),
    script: options.script,
    startedAt: started,
    token: randomUUID(),
  };
  const ownText = `${JSON.stringify(self)}\n`;
  let announced = false;
  let transient = 0;
  /** What this waiter last saw and since when, on its own clock. */
  let observed: { text: string; mtimeMs: number; since: number } | undefined;
  const poll = (ms = options.pollMs ?? 500) =>
    pause(Math.min(ms, Math.max(1, options.timeoutMs - (Date.now() - started))), options.signal);
  /** Retries a transient error for a few polls; any other error ends the attempt. */
  const retryable = (error: unknown) => {
    if (!TRANSIENT_CODES.has(errorCode(error) ?? '') || transient >= TRANSIENT_RETRIES)
      return false;
    transient += 1;
    return true;
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    while (true) {
      let inspected: 'created' | Awaited<ReturnType<typeof inspect>>;
      try {
        inspected = (await create(path, ownText)) ? 'created' : await inspect(path);
      } catch (error) {
        if (!retryable(error)) throw error;
        await poll();
        continue;
      }
      if (inspected === 'created')
        return held(path, ownText, started, options.heartbeatMs ?? PLAY_LOCK_HEARTBEAT_MS);
      const { read, mtimeMs } = inspected;
      transient = 0;
      if (read.kind === 'missing') continue;
      if (observed?.text !== read.text || observed.mtimeMs !== mtimeMs)
        observed = { text: read.text, mtimeMs, since: Date.now() };
      const unchangedMs = Date.now() - observed.since;
      if (isStale(read, unchangedMs, self.host, isAlive, options.staleMs ?? PLAY_LOCK_STALE_MS)) {
        const text = read.text;
        // A contended mutex means another contender is removing it: wait one poll.
        if (!(await withMutex(path, () => removeIf(path, text)))) await poll();
        continue;
      }
      const known = read.kind === 'holder' ? read.holder : undefined;
      const waited = (reason: 'busy' | 'cancelled') => ({
        ok: false as const,
        reason,
        waitedMs: Date.now() - started,
        ...(known === undefined ? {} : { holder: known }),
      });
      if (options.signal?.aborted === true) return waited('cancelled');
      if (Date.now() - started >= options.timeoutMs) return waited('busy');
      if (!announced) {
        announced = true;
        options.onWait?.(known);
      }
      await poll();
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'unavailable',
      waitedMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function held(path: string, ownText: string, started: number, heartbeatMs: number) {
  // A resumed old holder never refreshes a newer holder's lock.
  const owned = async () => (await readFile(path, 'utf8').catch(() => undefined)) === ownText;
  const heartbeat = setInterval(() => {
    void owned()
      .then((mine) => (mine ? utimes(path, new Date(), new Date()) : undefined))
      .catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    ok: true as const,
    waitedMs: Date.now() - started,
    /**
     * Best effort, under the takeover mutex and only while the file is still
     * this holder's: a lock that cannot be removed goes stale once its heartbeat stops.
     */
    release: async () => {
      clearInterval(heartbeat);
      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (await withMutex(path, () => removeIf(path, ownText))) return;
          await pause(50, undefined);
        }
      } catch {
        // Never lose the play result to lock cleanup.
      }
    },
  };
}
