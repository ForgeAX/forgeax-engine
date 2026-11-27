import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from '@forgeax/engine-types';
import { writeFileAtomic } from './filesystem-path.js';

/** Process usage belongs beside the backend session, never in a project registry. */
export function backendStateDirectory(root: string): string {
  return join(tmpdir(), 'forgeax-backend', sha256(resolve(root)));
}
/** Signal zero treats a process owned by another user as alive. */
export function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function lock(base: string): Promise<() => Promise<void>> {
  await mkdir(base, { recursive: true });
  const path = join(base, 'lock');
  const id = randomUUID();
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(
        join(path, 'owner.tmp'),
        JSON.stringify({ pid: process.pid, identity: identity(process.pid), id }),
      );
      await rename(join(path, 'owner.tmp'), join(path, 'owner'));
      return async () => {
        await rm(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await readFile(join(path, 'owner'), 'utf8'));
        if (!owner.identity || identity(owner.pid) !== owner.identity)
          await rm(path, { recursive: true, force: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        const metadata = await stat(path).catch(() => undefined);
        // Recover a crash between mkdir and publishing its identity.
        if (metadata && Date.now() - metadata.mtimeMs > 5000)
          await rm(path, { recursive: true, force: true });
      }
      await wait(25);
    }
  }
}
function identity(pid: number): string | undefined {
  if (!processAlive(pid)) return undefined;
  // A recycled PID must never retain a dead Codex process's usage. The portable
  // macOS/Linux distribution records the OS process birth time, not a timeout.
  try {
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
async function active(base: string) {
  let count = 0;
  for (const file of await readdir(base)) {
    if (!file.endsWith('.json')) continue;
    const path = join(base, file);
    let value: { pid: number; identity: string };
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (value.identity && identity(value.pid) === value.identity) count++;
    else await rm(path, { force: true });
  }
  return count;
}
export async function retainBackendLifetime(root: string) {
  const base = join(backendStateDirectory(root), 'usage'),
    path = join(base, `${randomUUID()}.json`);
  const birth = identity(process.pid);
  if (!birth) throw new Error('Cannot establish backend user process identity.');
  const release = await lock(base);
  let closed = false;
  try {
    await writeFileAtomic(path, JSON.stringify({ pid: process.pid, identity: birth }), {
      mode: 0o600,
    });
  } finally {
    await release();
  }
  return {
    async close() {
      if (closed) return;
      closed = true;
      const unlock = await lock(base);
      try {
        await rm(path, { force: true });
      } finally {
        await unlock();
      }
    },
  };
}

/** The daemon watches its own users, including while its plugins are preparing. */
export function watchBackendLifetime(
  root: string,
  stop: () => Promise<void>,
  { intervalMs = 1000, graceMs = 3000 } = {},
) {
  let closed = false,
    idleSince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void, fail!: (error: unknown) => void;
  const finished = new Promise<void>((done, reject) => {
    finish = done;
    fail = reject;
  });
  const base = join(backendStateDirectory(root), 'usage');
  let running = false;
  const failTick = (error: unknown) => {
    closed = true;
    fail(error);
  };
  const tick = async () => {
    running = true;
    const release = await lock(base);
    try {
      if (closed) return;
      if (await active(base)) idleSince = undefined;
      else {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= graceMs) {
          closed = true;
          // Hold admission through disposal: a replacement user waits for this
          // exact daemon to retire before acquiring usage and ensuring a new one.
          await stop();
          return;
        }
      }
    } catch (error) {
      failTick(error);
    } finally {
      await release();
      running = false;
      if (closed) finish();
    }
    if (!closed) {
      timer = setTimeout(() => void tick().catch(failTick), intervalMs);
      timer.unref();
    }
  };
  void tick().catch(failTick);
  return {
    finished,
    close() {
      closed = true;
      clearTimeout(timer);
      if (!running) finish();
    },
  };
}

/** Durable authoring selection only; runtime handles and tokens never persist. */
export function createWorkspaceSelection(root: string) {
  const path = join(root, '.forgeax', 'host', 'workspace-selection.json');
  return {
    async read(): Promise<string | null | undefined> {
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (
          !value ||
          typeof value !== 'object' ||
          !('schemaVersion' in value) ||
          value.schemaVersion !== 1 ||
          !('project' in value) ||
          (value.project !== null && typeof value.project !== 'string')
        )
          throw new Error('Invalid persisted workspace project selection.');
        return value.project as string | null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(project: string | null) {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, JSON.stringify({ schemaVersion: 1, project }), { mode: 0o600 });
    },
  };
}
