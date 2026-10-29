import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Process-level helpers for the optional live owner. They keep `dev start`
 * idempotent: an owner from another DevKit build, a dead or unresponsive
 * owner and crash leftovers are replaced instead of reported to the caller.
 */

/** Browser options that change what the owner renders; compared on `dev start`. */
export interface LiveOwnerOptions {
  readonly headless: boolean;
  readonly backend: string;
  readonly rhiCapture: boolean;
  readonly workers: unknown;
  readonly animation: unknown;
}

const identities = new Map<string, Promise<string>>();

/**
 * Identity of the DevKit code that runs an owner: Node, the CLI entry and the
 * metadata of every file beside it. A rebuilt or upgraded SDK changes it, so
 * an owner never serves results from code the caller no longer runs.
 */
export function liveDevBuildIdentity(entry: string): Promise<string> {
  let identity = identities.get(entry);
  if (identity === undefined) {
    identity = (async () => {
      const directory = dirname(entry);
      const hash = createHash('sha256');
      hash.update(JSON.stringify([process.version, process.execPath, process.platform]));
      hash.update(await realpath(entry).catch(() => entry));
      const names = (await readdir(directory).catch(() => [] as string[])).sort();
      for (const name of names) {
        const info = await stat(resolve(directory, name)).catch(() => undefined);
        hash.update(JSON.stringify([name, info?.size ?? -1, info?.mtimeMs ?? -1]));
      }
      return hash.digest('hex').slice(0, 32);
    })();
    identities.set(entry, identity);
  }
  return identity;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/** Explicitly requested options that the recorded owner does not run with. */
/** Options a caller asked for explicitly; `undefined` keeps whatever the owner uses. */
export type RequestedOwnerOptions = {
  readonly [K in keyof LiveOwnerOptions]?: LiveOwnerOptions[K] | undefined;
};

export function changedLiveOptions(
  current: Partial<LiveOwnerOptions> | undefined,
  requested: RequestedOwnerOptions,
): readonly string[] {
  return Object.entries(requested)
    .filter(([, value]) => value !== undefined)
    .filter(
      ([key, value]) =>
        current === undefined ||
        JSON.stringify(canonical(value)) !==
          JSON.stringify(canonical(current[key as keyof LiveOwnerOptions])),
    )
    .map(([key]) => key);
}

/** Readers see the previous or the next complete file, never a partial one. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a recorded pid is a detached live owner of this project. A recorded
 * pid can be reused by an unrelated process after a crash or reboot; only a
 * verified `daemon` is ever signalled. `unknown` means it cannot be inspected.
 */
export async function liveDaemonProcess(
  pid: number,
  roots: readonly string[],
): Promise<'daemon' | 'other' | 'unknown'> {
  if (process.platform === 'win32') return 'unknown';
  if (pid === process.pid) return 'other';
  const command = await new Promise<string | undefined>((resolveCommand) => {
    execFile(
      'ps',
      ['-ww', '-o', 'command=', '-p', String(pid)],
      { timeout: 5_000 },
      (error, stdout) =>
        // ps exits 1 with no output when the pid does not exist.
        resolveCommand(error && stdout.trim() !== '' ? undefined : stdout),
    );
  });
  if (command === undefined) return 'unknown';
  return command.includes('--__forgeax-live-daemon') && roots.some((root) => command.includes(root))
    ? 'daemon'
    : 'other';
}

export async function exited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return true;
}

/** SIGTERM lets the owner close its browser and project child; SIGKILL is the bound. */
export async function terminateLiveDaemon(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
  if (await exited(pid, 10_000)) return true;
  // The detached owner leads its process group; include its project child.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return exited(pid, 5_000);
}

const STALE_LOCK_MS = 10_000;

async function lockHolderGone(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let pid: unknown;
  try {
    ({ pid } = JSON.parse(raw) as { pid?: unknown });
  } catch {
    // A holder writes the lock in one call; an unreadable lock that persists is debris.
    const age = await stat(path).then(
      (info) => Date.now() - info.mtimeMs,
      () => STALE_LOCK_MS,
    );
    return age >= STALE_LOCK_MS;
  }
  return !processAlive(pid);
}

/**
 * Serialize owner creation for one project, so parallel `dev start` calls
 * converge on one owner. A lock left by a crashed caller is removed.
 */
export async function acquireStartLock(
  path: string,
  deadline: number,
): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  for (;;) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, token }), {
        flag: 'wx',
        mode: 0o600,
      });
      return async () => {
        const current = await readFile(path, 'utf8').catch(() => '');
        if (current.includes(token)) await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await lockHolderGone(path)) {
      await unlink(path).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detached owners of this project that no session record names, for example
 * after the record was deleted while its owner kept running. The match is the
 * exact daemon command line, so no other process is ever selected.
 */
export async function liveDaemonOrphans(
  roots: readonly string[],
  mode: 'live' | 'snapshot',
): Promise<readonly number[]> {
  if (process.platform === 'win32') return [];
  const listing = await new Promise<string>((resolveListing) => {
    execFile(
      'ps',
      ['-ax', '-ww', '-o', 'pid=,command='],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolveListing(error ? '' : stdout),
    );
  });
  const patterns = roots.map(
    (root) => new RegExp(` --__forgeax-live-daemon ${escapeRegExp(root)} \\d+ ${mode}$`),
  );
  return listing
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter(([, , command]) => patterns.some((pattern) => pattern.test(command ?? '')))
    .map(([, pid]) => Number(pid))
    .filter((pid) => pid !== process.pid);
}
