import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type AssetHandle, ok, type Result } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { AppLevelCandidate } from '../levels/app-level-owner';
import type { LevelCandidateError, LevelCandidateStatus } from '../levels/candidate';
import { AppLevelService } from '../levels/level-service';

const scene = '019ea55c-c729-7e26-819f-d09538a8028c';
const asset = 1 as AssetHandle<'scene'>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function fixture() {
  const load = vi.fn(() => Promise.resolve(ok(asset)));
  const release = vi.fn(() => ok(undefined));
  const assets = { load, release } as unknown as AssetRegistry;
  const candidates: ReturnType<typeof makeCandidate>[] = [];

  function makeCandidate(
    observe: (event: Result<LevelCandidateStatus, LevelCandidateError>) => void,
  ) {
    let status: LevelCandidateStatus = {
      phase: 'capture-begin',
      current: false,
      reusableSource: false,
      members: 0,
      needsStop: false,
      render: undefined,
      failure: undefined,
      cleanupFailure: undefined,
    };
    const level = {
      members: [],
      get phase() {
        return status.phase;
      },
      target: vi.fn<AppLevelCandidate['target']>(() => ok(undefined)),
      inspect: () => status,
    } satisfies AppLevelCandidate;
    return {
      level,
      report(phase: LevelCandidateStatus['phase'], current = true) {
        status = { ...status, phase, current };
        observe(ok(status));
      },
    };
  }

  const start = vi.fn<ConstructorParameters<typeof AppLevelService>[1]>((_asset, observe) => {
    const candidate = makeCandidate(observe);
    candidates.push(candidate);
    return ok(candidate.level);
  });
  const service = new AppLevelService(assets, start);
  const level = service.create({ scene }).unwrap();
  const candidate = async (count = 1) => {
    await vi.waitFor(() => expect(candidates).toHaveLength(count));
    const value = candidates.at(-1);
    if (value === undefined) throw Error('Missing test candidate');
    return value;
  };
  return { candidate, level, load, release, service, start };
}

it('loads on the first request, shares an in-flight request and waits for both activation sides', async () => {
  const f = fixture();
  expect(f.load).not.toHaveBeenCalled();
  expect(f.level.inspect().phase).toBe('unloaded');
  const prepared = f.level.request('prepared').unwrap();
  expect(f.level.request('prepared').unwrap()).toBe(prepared);
  const candidate = await f.candidate();
  candidate.report('prepared');
  expect((await prepared.done).unwrap().phase).toBe('prepared');
  const active = f.level.request('active').unwrap();
  const finished = vi.fn();
  void active.done.then(finished);
  candidate.report('activating', false);
  await Promise.resolve();
  expect(f.level.inspect()).toMatchObject({ sourceAccepted: true, renderAccepted: false });
  expect(finished).not.toHaveBeenCalled();
  candidate.report('active');
  expect((await active.done).unwrap()).toMatchObject({
    phase: 'active',
    sourceAccepted: true,
    renderAccepted: true,
  });
  expect(f.load).toHaveBeenCalledTimes(1);
});

it('settles a superseded request and rejects its late acceptance as proof for the new request', async () => {
  const f = fixture();
  const first = f.level.request('active').unwrap();
  const candidate = await f.candidate();
  candidate.report('activating', false);
  const hidden = f.level.request('prepared').unwrap();
  const active = f.level.request('active').unwrap();
  expect(await first.done).toMatchObject({
    ok: false,
    error: { code: 'level-request-superseded' },
  });
  expect(await hidden.done).toMatchObject({
    ok: false,
    error: { code: 'level-request-superseded' },
  });
  const complete = vi.fn();
  void active.done.then(complete);
  candidate.report('active');
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  expect(candidate.level.target).toHaveBeenLastCalledWith('prepared');
  candidate.report('prepared');
  expect(candidate.level.target).toHaveBeenLastCalledWith('active');
  candidate.report('active');
  expect((await active.done).unwrap().phase).toBe('active');
});

it('drains a cancelled source load without constructing a candidate or losing the late handle', async () => {
  const f = fixture();
  const returned = deferred<ReturnType<typeof ok<typeof asset>>>();
  f.load.mockReturnValueOnce(returned.promise);
  const prepared = f.level.request('prepared').unwrap();
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(1));
  const unloaded = f.level.request('unloaded').unwrap();
  expect(await prepared.done).toMatchObject({
    ok: false,
    error: { code: 'level-request-superseded' },
  });
  expect(f.level.inspect().phase).toBe('unloading');
  returned.resolve(ok(asset));
  expect((await unloaded.done).unwrap().phase).toBe('unloaded');
  expect(f.start).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledExactlyOnceWith(asset);
});

it('keeps a replacement target pending until the preceding candidate retires', async () => {
  const f = fixture();
  const first = f.level.request('active').unwrap();
  const candidate = await f.candidate();
  candidate.report('active');
  expect((await first.done).unwrap().phase).toBe('active');
  const unloaded = f.level.request('unloaded').unwrap();
  const next = f.level.request('active').unwrap();
  expect(await unloaded.done).toMatchObject({
    ok: false,
    error: { code: 'level-request-superseded' },
  });
  expect(f.load).toHaveBeenCalledTimes(1);
  candidate.report('retired', false);
  const replacement = await f.candidate(2);
  expect(f.release).toHaveBeenCalledExactlyOnceWith(asset);
  candidate.report('active');
  expect(f.level.inspect().phase).toBe('preparing');
  replacement.report('active');
  expect((await next.done).unwrap().phase).toBe('active');
});

it('requalifies a previously ready target and closes outstanding requests without a frame', async () => {
  const f = fixture();
  const first = f.level.request('prepared').unwrap();
  const candidate = await f.candidate();
  candidate.report('prepared');
  expect((await first.done).unwrap().current).toBe(true);
  candidate.report('prepared', false);
  expect(candidate.level.target).toHaveBeenLastCalledWith('unloaded');
  expect(f.level.inspect().current).toBe(false);
  const next = f.level.request('prepared').unwrap();
  f.service.stop();
  expect(await next.done).toMatchObject({ ok: false, error: { code: 'level-owner-closed' } });
  expect(f.level.request('active')).toMatchObject({
    ok: false,
    error: { code: 'level-owner-closed' },
  });
  expect((await first.done).unwrap().current).toBe(true);
});
