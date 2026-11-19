import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Process usage belongs beside the backend session, never in a project registry. */
function directory(root: string) {
  return join(
    tmpdir(),
    'forgeax-backend',
    createHash('sha256').update(resolve(root)).digest('hex'),
    'usage',
  );
}
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
  if (!alive(pid)) return undefined;
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
  const base = directory(root),
    path = join(base, `${randomUUID()}.json`);
  const birth = identity(process.pid);
  if (!birth) throw new Error('Cannot establish backend user process identity.');
  const release = await lock(base);
  let closed = false;
  try {
    await writeFile(`${path}.tmp`, JSON.stringify({ pid: process.pid, identity: birth }), {
      mode: 0o600,
    });
    await rename(`${path}.tmp`, path);
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
  const base = directory(root);
  let running = false;
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
      closed = true;
      fail(error);
    } finally {
      await release();
      running = false;
      if (closed) finish();
    }
    if (!closed) {
      timer = setTimeout(() => {
        void tick().catch((error) => {
          closed = true;
          fail(error);
        });
      }, intervalMs);
      timer.unref();
    }
  };
  void tick().catch((error) => {
    closed = true;
    fail(error);
  });
  return {
    finished,
    close() {
      closed = true;
      clearTimeout(timer);
      if (!running) finish();
    },
  };
}
