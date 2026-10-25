import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquirePlayLock, PLAY_LOCK_STALE_MS } from '../play-lock.js';

let dir = '';
let path = '';

beforeEach(async () => {
  dir = await mkdtemp(resolve(tmpdir(), 'forgeax-play-lock-'));
  path = resolve(dir, '.forgeax/play/lock.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('project play lock', () => {
  it('makes a second play wait for the first, announce the holder once, then run', async () => {
    const first = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 5_000 });
    if (!first.ok) throw new Error('first acquire failed');
    const waits: unknown[] = [];
    const second = acquirePlayLock(path, {
      script: 'scripts/b.mjs',
      timeoutMs: 5_000,
      pollMs: 10,
      onWait: (holder) => waits.push(holder),
    });
    await new Promise((done) => setTimeout(done, 80));
    await first.release();
    const acquired = await second;
    expect(acquired.ok).toBe(true);
    expect(acquired.waitedMs).toBeGreaterThanOrEqual(60);
    expect(waits).toEqual([
      expect.objectContaining({ pid: process.pid, script: 'scripts/a.mjs', host: hostname() }),
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ script: 'scripts/b.mjs' });
    if (acquired.ok) await acquired.release();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports busy with the holder after the wait budget and never steals a live lock', async () => {
    const first = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 1_000 });
    const second = await acquirePlayLock(path, {
      script: 'scripts/b.mjs',
      timeoutMs: 50,
      pollMs: 10,
    });
    expect(second).toMatchObject({
      ok: false,
      reason: 'busy',
      holder: { pid: process.pid, script: 'scripts/a.mjs' },
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ script: 'scripts/a.mjs' });
    if (first.ok) await first.release();
  });

  it('takes over a lock left by a dead process or an abandoned unreadable file', async () => {
    await mkdir(resolve(dir, '.forgeax/play'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: 999_999, host: hostname(), script: 'old', startedAt: 0, token: 't' }),
    );
    const dead = await acquirePlayLock(path, {
      script: 'scripts/a.mjs',
      timeoutMs: 50,
      isAlive: () => false,
    });
    expect(dead.ok).toBe(true);
    if (dead.ok) await dead.release();

    // An unreadable file is abandoned once the waiter sees it unchanged (5 s; 40 ms here).
    await writeFile(path, '{');
    const unreadable = await acquirePlayLock(path, {
      script: 'scripts/a.mjs',
      timeoutMs: 2_000,
      pollMs: 10,
      staleMs: 40,
    });
    expect(unreadable.ok).toBe(true);
    if (unreadable.ok) await unreadable.release();
  });

  it('lets exactly one of several concurrent contenders take over a dead lock at a time', async () => {
    await mkdir(resolve(dir, '.forgeax/play'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: 999_999, host: hostname(), script: 'old', startedAt: 0, token: 't' }),
    );
    let active = 0;
    let peak = 0;
    const contender = async (index: number) => {
      const lock = await acquirePlayLock(path, {
        script: `scripts/${index}.mjs`,
        timeoutMs: 10_000,
        pollMs: 2,
        isAlive: (pid) => pid !== 999_999,
      });
      if (!lock.ok) throw new Error(`contender ${index} failed: ${lock.reason}`);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 15));
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        script: `scripts/${index}.mjs`,
      });
      active -= 1;
      await lock.release();
    };
    for (let round = 0; round < 5; round += 1) {
      await writeFile(
        path,
        JSON.stringify({
          pid: 999_999,
          host: hostname(),
          script: 'old',
          startedAt: 0,
          token: `t${round}`,
        }),
      );
      await Promise.all(Array.from({ length: 12 }, (_unused, index) => contender(index)));
    }
    expect(peak).toBe(1);
  });

  it('takes over a lock from another host only after observing it unchanged, and refreshes its own', async () => {
    await mkdir(resolve(dir, '.forgeax/play'), { recursive: true });
    // An old mtime alone (clock skew) is not stale: the waiter must observe it unchanged.
    await writeFile(
      path,
      JSON.stringify({ pid: 1, host: 'container-a', script: 'old', startedAt: 0, token: 't' }),
    );
    const old = new Date(Date.now() - PLAY_LOCK_STALE_MS - 1_000);
    await utimes(path, old, old);
    const fresh = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 30 });
    expect(fresh).toMatchObject({ ok: false, reason: 'busy', holder: { host: 'container-a' } });
    const taken = await acquirePlayLock(path, {
      script: 'scripts/a.mjs',
      timeoutMs: 2_000,
      pollMs: 10,
      staleMs: 80,
      heartbeatMs: 10,
    });
    expect(taken).toMatchObject({ ok: true });
    expect(taken.waitedMs).toBeGreaterThanOrEqual(80);
    await utimes(path, old, old);
    await new Promise((done) => setTimeout(done, 60));
    expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(PLAY_LOCK_STALE_MS);
    if (taken.ok) await taken.release();
  });

  it('trusts a live pid on this host over an old heartbeat', async () => {
    await mkdir(resolve(dir, '.forgeax/play'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        script: 'live',
        startedAt: 0,
        token: 't',
      }),
    );
    const old = new Date(Date.now() - PLAY_LOCK_STALE_MS - 1_000);
    await utimes(path, old, old);
    const waiter = await acquirePlayLock(path, {
      script: 'scripts/a.mjs',
      timeoutMs: 150,
      pollMs: 10,
      staleMs: 20,
    });
    expect(waiter).toMatchObject({ ok: false, reason: 'busy', holder: { script: 'live' } });
  });

  it('waits a poll instead of spinning while another contender holds the takeover mutex', async () => {
    await mkdir(resolve(dir, '.forgeax/play'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: 999_999, host: hostname(), script: 'old', startedAt: 0, token: 't' }),
    );
    await writeFile(`${path}.takeover`, 'other contender\n');
    let reads = 0;
    const lock = acquirePlayLock(path, {
      script: 'scripts/a.mjs',
      timeoutMs: 5_000,
      pollMs: 25,
      isAlive: (pid) => {
        reads += 1;
        return pid !== 999_999;
      },
    });
    await new Promise((done) => setTimeout(done, 200));
    await rm(`${path}.takeover`);
    const acquired = await lock;
    expect(acquired.ok).toBe(true);
    // About one liveness probe per 25 ms poll, not a busy loop.
    expect(reads).toBeLessThan(20);
    if (acquired.ok) await acquired.release();
  });

  it('retries transient permission errors for a few polls before unavailable', async () => {
    const locked = resolve(dir, 'ro');
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      const result = await acquirePlayLock(resolve(locked, 'lock.json'), {
        script: 'scripts/a.mjs',
        timeoutMs: 5_000,
        pollMs: 10,
      });
      expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(result.waitedMs).toBeGreaterThanOrEqual(90);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("a resumed old holder cannot release a newer holder's lock", async () => {
    const first = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 100 });
    await rm(path);
    const second = await acquirePlayLock(path, { script: 'scripts/b.mjs', timeoutMs: 100 });
    if (first.ok) await first.release();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ script: 'scripts/b.mjs' });
    if (second.ok) await second.release();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns unavailable instead of throwing, and release never throws', async () => {
    await writeFile(resolve(dir, 'file'), 'x');
    const blocked = await acquirePlayLock(resolve(dir, 'file/lock.json'), {
      script: 'scripts/a.mjs',
      timeoutMs: 10,
    });
    expect(blocked).toMatchObject({ ok: false, reason: 'unavailable' });
    const lock = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 10 });
    await rm(resolve(dir, '.forgeax'), { recursive: true });
    await mkdir(path, { recursive: true });
    if (lock.ok) await expect(lock.release()).resolves.toBeUndefined();
  });

  it('stops waiting on cancellation and leaves the holder in place', async () => {
    const first = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 1_000 });
    const abort = new AbortController();
    const second = acquirePlayLock(path, {
      script: 'scripts/b.mjs',
      timeoutMs: 10_000,
      pollMs: 5_000,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 20);
    expect(await second).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ script: 'scripts/a.mjs' });
    if (first.ok) await first.release();
  });

  it('release never removes a lock that another run took over', async () => {
    const first = await acquirePlayLock(path, { script: 'scripts/a.mjs', timeoutMs: 1_000 });
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, host: hostname(), script: 'b', startedAt: 0, token: 'b' }),
    );
    if (first.ok) await first.release();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ token: 'b' });
  });
});
