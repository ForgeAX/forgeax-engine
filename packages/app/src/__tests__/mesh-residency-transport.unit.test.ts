import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  type DynamicGeometryCandidate,
  type FrameReceipt,
  type PreparedPublishedMeshResidency,
  type Renderer,
  RenderPublicationError,
} from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { RenderMeshResidency } from '../execution/render-mesh-residency';
import type {
  MeshResidencyRequest,
  MeshResidencyResponse,
} from '../execution/render-worker-protocol';
import { SourceMeshResidency } from '../execution/source-mesh-residency';

const identity = { source: 'transport-test', epoch: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function sourceFixture() {
  const world = new World();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const messages: MeshResidencyRequest[] = [];
  let session: { source: string; epoch: number; generation: number } | undefined = {
    ...identity,
    generation: 7,
  };
  const source = new SourceMeshResidency(world, () =>
    session === undefined
      ? undefined
      : {
          ...session,
          post: (message, transfers) =>
            messages.push(structuredClone(message, { transfer: [...(transfers ?? [])] })),
        },
  );
  const respond = (kind: MeshResidencyResponse['kind'], deviceGeneration = 7) =>
    source.receive({
      kind,
      requestId: 1,
      identity,
      result: { ok: true, deviceGeneration },
    });
  return {
    world,
    mesh,
    meshHandle,
    messages,
    source,
    respond,
    input: { world, entity: 42, meshHandle, mesh },
    session: (value: typeof session) => {
      session = value;
    },
  };
}
afterEach(() => vi.useRealTimers());

it('clones only mesh POD and retains source buffers through remote preparation', async () => {
  const f = sourceFixture();
  const pending = f.source.prepare(f.input);
  const message = f.messages[0];
  expect(message?.kind).toBe('mesh-prepare');
  if (message?.kind !== 'mesh-prepare') throw new Error('missing preparation');
  expect(message.input).not.toHaveProperty('world');
  expect(message.input.mesh.vertices).toEqual(f.mesh.vertices);
  expect(message.input.mesh.vertices.buffer).not.toBe(f.mesh.vertices.buffer);
  expect(f.mesh.vertices.byteLength).toBeGreaterThan(0);
  f.respond('mesh-ready');
  const lease = (await pending).unwrap();
  expect(lease.isCurrent()).toBe(true);
  const released = lease.release(true);
  expect(lease.isCurrent()).toBe(false);
  f.respond('mesh-released');
  await released;
});

it('moves an explicitly private snapshot while retaining borrowed World arrays and isolation', async () => {
  const f = sourceFixture();
  const snapshot = structuredClone(f.mesh);
  const expected = structuredClone(snapshot);
  const transfers = [snapshot.vertices.buffer as ArrayBuffer];
  const pending = f.source.prepare({ ...f.input, mesh: snapshot }, { transfers });
  const message = f.messages[0];
  if (message?.kind !== 'mesh-prepare') throw new Error('missing preparation');
  expect(snapshot.vertices.byteLength).toBe(0);
  expect(f.mesh.vertices.byteLength).toBeGreaterThan(0);
  f.mesh.vertices[0] = 123;
  expect(message.input.mesh).toEqual(expected);
  f.respond('mesh-ready');
  const lease = (await pending).unwrap();
  expect(lease.isCurrent()).toBe(true);
  const released = lease.release(true);
  f.respond('mesh-released');
  await released;
});

it.each([
  false,
  true,
])('waits for release after abort with private transfer=%s and late ready', async (owned) => {
  const f = sourceFixture();
  const abort = new AbortController();
  const settled = vi.fn();
  const snapshot = owned ? structuredClone(f.mesh) : f.mesh;
  const pending = f.source
    .prepare(
      { ...f.input, mesh: snapshot },
      {
        signal: abort.signal,
        ...(owned ? { transfers: [snapshot.vertices.buffer as ArrayBuffer] } : {}),
      },
    )
    .then((result) => {
      settled();
      return result;
    });
  abort.abort();
  expect(f.mesh.vertices.byteLength).toBeGreaterThan(0);
  expect(f.messages[1]).toMatchObject({ kind: 'mesh-release', requestId: 1, evict: true });
  f.respond('mesh-ready');
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  f.respond('mesh-released');
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-gpu-not-ready' },
  });
});

it.each([
  'ready-generation',
  'session-generation',
] as const)('rejects %s mismatch only after cleanup', async (mode) => {
  const f = sourceFixture();
  const settled = vi.fn();
  const pending = f.source.prepare(f.input).then((result) => {
    settled();
    return result;
  });
  if (mode === 'session-generation') f.session({ ...identity, generation: 8 });
  f.respond('mesh-ready', 8);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(f.messages[1]?.kind).toBe('mesh-release');
  f.respond('mesh-released');
  expect((await pending).ok).toBe(false);
});

it('does not accept a release ACK from a different native generation', async () => {
  const f = sourceFixture();
  const pending = f.source.prepare(f.input);
  f.respond('mesh-ready');
  const released = (await pending).unwrap().release(true);
  const failed = expect(released).rejects.toMatchObject({ code: 'dynamic-geometry-gpu-not-ready' });
  f.respond('mesh-released', 8);
  await failed;
});

it('invalidates old leases when a replacement epoch keeps the same native generation', async () => {
  const f = sourceFixture();
  const pending = f.source.prepare(f.input);
  f.respond('mesh-ready');
  const lease = (await pending).unwrap();
  f.source.clear('worker replaced');
  f.session({ ...identity, epoch: 2, generation: 7 });
  expect(lease.isCurrent()).toBe(false);
  await expect(lease.release(true)).rejects.toMatchObject({
    code: 'dynamic-geometry-gpu-not-ready',
  });
});

it('escalates committed release to eviction on dispose while retaining one completion fence', async () => {
  const f = sourceFixture();
  const pending = f.source.prepare(f.input);
  f.respond('mesh-ready');
  const lease = (await pending).unwrap();
  const released = lease.release(false);
  const disposed = f.source.dispose();
  expect(
    f.messages.slice(1).map((message) => message.kind === 'mesh-release' && message.evict),
  ).toEqual([false, true]);
  f.respond('mesh-released');
  await Promise.all([released, disposed]);
});

it('settles missing release ACK as failure without leaving preparation pending', async () => {
  vi.useFakeTimers();
  const f = sourceFixture();
  const pending = f.source.prepare(f.input);
  const failed = expect(pending).rejects.toMatchObject({ code: 'dynamic-geometry-gpu-not-ready' });
  await vi.advanceTimersByTimeAsync(60_000);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects preparation when cancellation cannot prove its physical release', async () => {
  const f = sourceFixture();
  const controller = new AbortController();
  const pending = f.source.prepare(f.input, { signal: controller.signal });
  const failed = expect(pending).rejects.toMatchObject({
    code: 'dynamic-geometry-gpu-failed',
    detail: { actual: { code: 'mesh-residency-gpu-failed', actual: 'native fence rejected' } },
  });
  controller.abort();
  f.source.receive({
    kind: 'mesh-released',
    requestId: 1,
    identity,
    result: {
      ok: false,
      error: {
        code: 'mesh-residency-gpu-failed',
        expected: 'release succeeds',
        hint: 'rebuild paired owner',
        actual: 'native fence rejected',
      },
    },
  });
  await failed;
});

it('preserves a content conflict as invalid preparation after confirmed cleanup', async () => {
  const f = sourceFixture();
  const pending = f.source.prepare(f.input);
  const failure = new RenderPublicationError({ reason: 'shape', subject: 'conflicting mesh' });
  f.source.receive({
    kind: 'mesh-ready',
    requestId: 1,
    identity,
    result: { ok: false, error: failure },
  });
  f.respond('mesh-released');
  expect(await pending).toMatchObject({
    ok: false,
    error: {
      code: 'dynamic-geometry-invalid',
      detail: { actual: { code: failure.code, detail: failure.detail } },
    },
  });
});

it('bounds source standalone preparation requests before allocating a 33rd transport owner', async () => {
  const f = sourceFixture();
  const pending = Array.from({ length: 32 }, () =>
    f.source.prepare(f.input).catch((cause) => cause),
  );
  expect(await f.source.prepare(f.input)).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-budget-exceeded', detail: { used: 32, limit: 32 } },
  });
  expect(f.messages).toHaveLength(32);
  f.source.clear('test ended');
  await Promise.all(pending);
});

it('preserves receiver refusal details and escalates unknown throws without a ready response', async () => {
  const f = sourceFixture();
  const conflict = new RenderPublicationError({
    reason: 'shape',
    subject: 'mesh identity mismatch',
  });
  const prepare = vi
    .fn()
    .mockResolvedValueOnce(err(conflict))
    .mockRejectedValueOnce(new Error('uncertain physical ownership'));
  const post = vi.fn();
  const receiver = new RenderMeshResidency(
    { preparePublishedMeshResidency: prepare } as unknown as Renderer,
    identity,
    post,
  );
  const input = { ...identity, meshHandle: f.meshHandle, mesh: f.mesh };
  await receiver.receive({ kind: 'mesh-prepare', requestId: 1, input });
  expect(prepare).toHaveBeenCalledWith(input, 'received');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'mesh-ready',
      result: {
        ok: false,
        error: {
          code: conflict.code,
          expected: conflict.expected,
          hint: conflict.hint,
          detail: conflict.detail,
        },
      },
    }),
  );
  post.mockClear();
  await expect(receiver.receive({ kind: 'mesh-prepare', requestId: 2, input })).rejects.toThrow(
    'uncertain physical ownership',
  );
  expect(post).not.toHaveBeenCalled();
  await receiver.dispose();
});

it('bounds receiver preparations independently from source admission', async () => {
  const f = sourceFixture();
  const upload = deferred<ReturnType<typeof ok<PreparedPublishedMeshResidency>>>();
  const prepare = vi.fn(() => upload.promise);
  const post = vi.fn();
  const receiver = new RenderMeshResidency(
    { preparePublishedMeshResidency: prepare } as unknown as Renderer,
    identity,
    post,
  );
  const input = { ...identity, meshHandle: f.meshHandle, mesh: f.mesh };
  const pending = Array.from({ length: 32 }, (_, index) =>
    receiver.receive({ kind: 'mesh-prepare', requestId: index + 1, input }),
  );
  await receiver.receive({ kind: 'mesh-prepare', requestId: 33, input });
  expect(prepare).toHaveBeenCalledTimes(32);
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 33,
      result: {
        ok: false,
        error: expect.objectContaining({ code: 'dynamic-geometry-budget-exceeded' }),
      },
    }),
  );
  upload.resolve(
    ok({
      deviceGeneration: 7,
      release: () => undefined,
    } as unknown as PreparedPublishedMeshResidency),
  );
  await Promise.all(pending);
  await receiver.receive({ kind: 'mesh-prepare', requestId: 34, input });
  expect(prepare).toHaveBeenCalledTimes(32);
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      requestId: 34,
      result: {
        ok: false,
        error: expect.objectContaining({ code: 'dynamic-geometry-budget-exceeded' }),
      },
    }),
  );
  await receiver.dispose();
});

it.each([
  'ready',
  'preparing',
] as const)('keeps a receiver credit until the release fence completes for a %s mesh', async (stage) => {
  const f = sourceFixture();
  const first = deferred<ReturnType<typeof ok<PreparedPublishedMeshResidency>>>();
  const upload = deferred<ReturnType<typeof ok<PreparedPublishedMeshResidency>>>();
  const fence = deferred<void>();
  const prepare = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(() => upload.promise);
  const post = vi.fn();
  const receiver = new RenderMeshResidency(
    {
      preparePublishedMeshResidency: prepare,
      inspect: () => ({ frame: { deviceGeneration: 7 } }),
    } as unknown as Renderer,
    identity,
    post,
  );
  const input = { ...identity, meshHandle: f.meshHandle, mesh: f.mesh };
  const firstLease = ok({
    deviceGeneration: 7,
    release: () => fence.promise,
  } as unknown as PreparedPublishedMeshResidency);
  const preparing = receiver.receive({ kind: 'mesh-prepare', requestId: 1, entity: 1, input });
  if (stage === 'ready') {
    first.resolve(firstLease);
    await preparing;
  }
  const released = receiver.receive({ kind: 'mesh-release', requestId: 1, identity, evict: true });
  if (stage === 'preparing') {
    first.resolve(firstLease);
    await Promise.resolve();
  }
  const pending = Array.from({ length: 31 }, (_, index) =>
    receiver.receive({ kind: 'mesh-prepare', requestId: index + 2, entity: index + 2, input }),
  );
  await receiver.receive({ kind: 'mesh-prepare', requestId: 33, entity: 33, input });
  expect(prepare).toHaveBeenCalledTimes(32);
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({
      requestId: 33,
      result: {
        ok: false,
        error: expect.objectContaining({
          code: 'dynamic-geometry-budget-exceeded',
          detail: expect.objectContaining({ used: 32 }),
        }),
      },
    }),
  );
  fence.resolve();
  await Promise.all([preparing, released]);
  const replacement = receiver.receive({ kind: 'mesh-prepare', requestId: 34, entity: 34, input });
  expect(prepare).toHaveBeenCalledTimes(33);
  upload.resolve(
    ok({
      deviceGeneration: 7,
      release: () => undefined,
    } as unknown as PreparedPublishedMeshResidency),
  );
  await Promise.all([...pending, replacement]);
  await receiver.dispose();
});

it.each([
  'source',
  'receiver',
] as const)('does not scan ready retained meshes for a new %s preparation credit', async (endpoint) => {
  const f = sourceFixture();
  const receiver = new RenderMeshResidency(
    {
      preparePublishedMeshResidency: async () =>
        ok({ deviceGeneration: 7, release: () => undefined }),
    } as unknown as Renderer,
    identity,
    () => {},
  );
  const prepare = async (requestId: number) => {
    if (endpoint === 'receiver') {
      await receiver.receive({
        kind: 'mesh-prepare',
        requestId,
        entity: requestId,
        input: { ...identity, meshHandle: f.meshHandle, mesh: f.mesh },
      });
    } else {
      const pending = f.source.prepare({ ...f.input, entity: requestId });
      f.source.receive({
        kind: 'mesh-ready',
        requestId,
        identity,
        result: { ok: true, deviceGeneration: 7 },
      });
      (await pending).unwrap();
    }
  };
  for (let requestId = 1; requestId <= 512; requestId++) await prepare(requestId);

  // Count visited owners rather than elapsed time, so runner load cannot
  // hide the quadratic startup cost of retaining already-ready meshes.
  let visited = 0;
  const values = Map.prototype.values;
  const spy = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
    this: Map<unknown, unknown>,
  ) {
    for (const value of values.call(this)) {
      visited++;
      yield value;
    }
    return undefined;
  });
  try {
    await prepare(513);
  } finally {
    spy.mockRestore();
    f.source.clear('test complete');
    await receiver.dispose();
  }
  expect(visited).toBeLessThanOrEqual(32);
});

it('fails preparation immediately before a Render session exists', async () => {
  const f = sourceFixture();
  f.session(undefined);
  expect(await f.source.prepare(f.input)).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-gpu-not-ready' },
  });
  expect(f.messages).toEqual([]);
});

it.each([true, false])('drains preparation cancelled before ready with evict=%s', async (evict) => {
  const f = sourceFixture();
  const upload = deferred<ReturnType<typeof ok<PreparedPublishedMeshResidency>>>();
  const fence = deferred<void>();
  const release = vi.fn(() => fence.promise);
  const post = vi.fn();
  const renderer = {
    preparePublishedMeshResidency: () => upload.promise,
    inspect: () => ({ frame: { deviceGeneration: 7 } }),
  } as unknown as Renderer;
  const receiver = new RenderMeshResidency(renderer, identity, post);
  const preparation = receiver.receive({
    kind: 'mesh-prepare',
    requestId: 1,
    entity: 42,
    input: { ...identity, meshHandle: f.meshHandle, mesh: f.mesh },
  });
  const released = receiver.receive({ kind: 'mesh-release', requestId: 1, identity, evict });
  upload.resolve(ok({ deviceGeneration: 7, release } as unknown as PreparedPublishedMeshResidency));
  await vi.waitFor(() => expect(release).toHaveBeenCalledWith(evict));
  expect(post).not.toHaveBeenCalled();
  const disposed = receiver.dispose();
  if (!evict) expect(release).toHaveBeenLastCalledWith(true);
  fence.resolve();
  await Promise.all([preparation, released, disposed]);
  expect(post).toHaveBeenCalledExactlyOnceWith({
    kind: 'mesh-released',
    requestId: 1,
    identity,
    result: { ok: true, deviceGeneration: 7 },
  });
});

it.each([
  'ready',
  'release',
  'abort',
  'replace',
  'clear',
] as const)('uses the shared in-flight credits while a batch member waits for %s', async (action) => {
  const f = sourceFixture(),
    controller = new AbortController();
  const pending = Array.from({ length: 32 }, () =>
    f.source.prepare(f.input).catch((cause) => cause),
  );
  const respond = (kind: MeshResidencyResponse['kind'], requestId: number) =>
    f.source.receive({
      kind,
      requestId,
      identity,
      result: { ok: true, deviceGeneration: 7 },
    });
  let released: Promise<void> | undefined;
  if (action === 'release') {
    respond('mesh-ready', 1);
    const lease = (await pending[0]).unwrap();
    released = lease.release(true);
  }
  const waiting = f.source.prepare(f.input, { signal: controller.signal, waitForCapacity: true });
  const outcome = waiting.then(
    (value) => value,
    (cause) => cause,
  );
  expect(f.messages.filter((m) => m.kind === 'mesh-prepare')).toHaveLength(32);
  if (action === 'abort') controller.abort();
  if (action === 'replace') f.session({ ...identity, epoch: 2, generation: 7 });
  if (action === 'clear') f.source.clear('paired owner retired');
  else {
    respond(action === 'release' ? 'mesh-released' : 'mesh-ready', 1);
    if (action === 'replace') respond('mesh-released', 1);
  }
  if (action === 'ready' || action === 'release') {
    await vi.waitFor(() =>
      expect(f.messages.filter((m) => m.kind === 'mesh-prepare')).toHaveLength(33),
    );
    respond('mesh-ready', 33);
    expect((await outcome).ok).toBe(true);
  } else {
    expect(await outcome).toMatchObject(
      action === 'clear' ? { code: 'dynamic-geometry-gpu-not-ready' } : { ok: false },
    );
    expect(f.messages.filter((m) => m.kind === 'mesh-prepare')).toHaveLength(32);
  }
  await released;
  f.source.clear('test complete');
  await Promise.all(pending);
});

it('refuses a batch member when every credit is a held standalone lease', async () => {
  const f = sourceFixture(),
    input = { world: f.world, meshHandle: f.meshHandle, mesh: f.mesh };
  const pending = Array.from({ length: 32 }, () => f.source.prepare(input));
  for (let requestId = 1; requestId <= 32; requestId++)
    f.source.receive({
      kind: 'mesh-ready',
      requestId,
      identity,
      result: { ok: true, deviceGeneration: 7 },
    });
  await Promise.all(pending);
  expect(await f.source.prepare(f.input, { waitForCapacity: true })).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-budget-exceeded', detail: { used: 32, limit: 32 } },
  });
  expect(f.messages).toHaveLength(32);
  f.source.clear('test complete');
});

function candidateFor(
  f: ReturnType<typeof sourceFixture>,
  entity = f.input.entity,
): DynamicGeometryCandidate {
  return {
    candidateId: `candidate-${entity}`,
    generation: 7,
    owner: f.source,
    world: f.world,
    entity,
    gpuReady: true,
    meshBytes: f.mesh.vertices.byteLength,
    revision: 1,
    topologyRevision: 1,
    meshHandle: f.meshHandle,
    fixedStep: 1,
    state: 'accepted',
  };
}

it('does not scan unrelated consumed entities for each candidate in a completed frame', async () => {
  const f = sourceFixture();
  const candidates: DynamicGeometryCandidate[] = [];
  const bindings = new Float64Array(512 * 2);
  for (let index = 0; index < 512; index++) {
    const candidate = candidateFor(f, index);
    const prepared = f.source.prepare({ ...f.input, entity: index });
    f.source.receive({
      kind: 'mesh-ready',
      requestId: index + 1,
      identity,
      result: { ok: true, deviceGeneration: 7 },
    });
    (await prepared).unwrap();
    candidates.push(candidate);
    bindings[index * 2] = index + 1;
  }
  f.source.complete({ frameId: 1, deviceGeneration: 7, sourceFixedStep: 1, bindings });
  // Count actual lookups, not elapsed time: host load must not make the
  // cross-entity quadratic regression nondeterministic.
  let lookups = 0;
  const get = Map.prototype.get;
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
  ) {
    lookups++;
    return get.call(this, key);
  });
  let lanes: unknown[];
  try {
    lanes = candidates.map((candidate) => f.source.recordStageLane(candidate));
  } finally {
    spy.mockRestore();
    f.source.clear('test complete');
  }
  expect(lanes).toEqual(candidates.map(() => 'cpu'));
  expect(lookups).toBeLessThanOrEqual(candidates.length * 8);
});

it('keeps exact entity and mesh evidence across duplicate leases and release fences', async () => {
  const f = sourceFixture();
  const leases = [];
  for (let requestId = 1; requestId <= 2; requestId++) {
    const prepared = f.source.prepare(f.input);
    f.source.receive({
      kind: 'mesh-ready',
      requestId,
      identity,
      result: { ok: true, deviceGeneration: 7 },
    });
    leases.push((await prepared).unwrap());
  }
  const [firstLease, secondLease] = leases;
  if (firstLease === undefined || secondLease === undefined) throw new Error('missing mesh lease');
  const candidate = candidateFor(f);
  const proof = {
    frameId: 1,
    deviceGeneration: 7,
    sourceFixedStep: 1,
    bindings: new Float64Array([1, 0, 2, 1]),
  };
  f.source.complete(proof);
  expect(f.source.recordStageLane(candidate)).toBe('cpu');
  f.source.complete({ ...proof, bindings: new Float64Array([2, 1, 1, 0]) });
  expect(f.source.recordStageLane(candidate)).toBe('gpu');
  f.source.complete({
    ...proof,
    bindings: new Float64Array([1, 0, 2, 1, 1, 2]),
  });
  expect(f.source.recordStageLane(candidate)).toBe('mixed');
  f.source.complete({ ...proof, bindings: new Float64Array([1, 99]) });
  expect(f.source.recordStageLane(candidate)).toBeUndefined();
  f.source.complete({ ...proof, bindings: new Float64Array([1]) });
  expect(f.source.publishedFixedStep(f.world)).toBeUndefined();
  expect(f.source.recordStageLane(candidate)).toBeUndefined();
  f.source.complete(proof);
  expect(f.source.recordStageLane({ ...candidate, world: new World() })).toBeUndefined();
  expect(f.source.recordStageLane({ ...candidate, entity: 43 })).toBeUndefined();
  const otherMesh = f.world.allocSharedRef('MeshAsset', createBoxGeometry(2, 1, 1).unwrap());
  expect(f.source.recordStageLane({ ...candidate, meshHandle: otherMesh })).toBeUndefined();
  const first = firstLease.release(true);
  expect(f.source.recordStageLane(candidate)).toBe('gpu');
  f.respond('mesh-released');
  await first;
  f.source.complete(proof);
  expect(f.source.recordStageLane(candidate)).toBe('gpu');
  f.source.complete({ ...proof, deviceGeneration: 8 });
  expect(f.source.publishedFixedStep(f.world)).toBeUndefined();
  expect(f.source.recordStageLane(candidate)).toBeUndefined();
  f.source.complete(proof);
  expect(f.source.recordStageLane(candidate)).toBe('gpu');
  f.source.complete({ ...proof, bindings: new Float64Array() });
  expect(f.source.recordStageLane(candidate)).toBeUndefined();
  f.source.complete(proof);
  const second = secondLease.release(true);
  expect(f.source.recordStageLane(candidate)).toBeUndefined();
  f.source.receive({
    kind: 'mesh-released',
    requestId: 2,
    identity,
    result: { ok: true, deviceGeneration: 7 },
  });
  await second;
  f.source.clear('test complete');
});

it('seals transferable mesh evidence without truncating safe-integer request identities', async () => {
  const f = sourceFixture();
  let lane: 'cpu' | 'gpu' = 'cpu';
  const receiver = new RenderMeshResidency(
    {
      preparePublishedMeshResidency: async () =>
        ok({
          deviceGeneration: 7,
          isCurrent: () => true,
          release: () => undefined,
          recordStageLane: () => ok(lane),
        }),
    } as unknown as Renderer,
    identity,
    () => {},
  );
  await receiver.receive({
    kind: 'mesh-prepare',
    requestId: Number.MAX_SAFE_INTEGER,
    entity: 42,
    input: { ...identity, meshHandle: f.meshHandle, mesh: f.mesh },
  });
  const frame = { frameId: 1, deviceGeneration: 7 } as FrameReceipt;
  const first = receiver.consumed(frame, 1);
  lane = 'gpu';
  const second = receiver.consumed({ ...frame, frameId: 2 }, 2);
  expect(Array.from(first.bindings)).toEqual([Number.MAX_SAFE_INTEGER, 0]);
  expect(Array.from(second.bindings)).toEqual([Number.MAX_SAFE_INTEGER, 1]);
  expect(first.bindings.buffer).not.toBe(second.bindings.buffer);
  const transferred = structuredClone(first, { transfer: [first.bindings.buffer] });
  expect(first.bindings.byteLength).toBe(0);
  expect(Array.from(transferred.bindings)).toEqual([Number.MAX_SAFE_INTEGER, 0]);
  expect(Array.from(receiver.consumed({ ...frame, frameId: 3 }, 3).bindings)).toEqual([
    Number.MAX_SAFE_INTEGER,
    1,
  ]);
  await receiver.dispose();
});

it('reads mesh release generation after its fence without constructing diagnostics', async () => {
  const f = sourceFixture();
  const fence = deferred<void>();
  let generation = 7;
  const inspect = vi.fn(() => {
    throw new Error('full diagnostics are unavailable');
  });
  const post = vi.fn();
  const receiver = new RenderMeshResidency(
    {
      currentDeviceGeneration: () => generation,
      inspect,
      preparePublishedMeshResidency: async () =>
        ok({ deviceGeneration: 7, release: () => fence.promise }),
    } as unknown as Renderer,
    identity,
    post,
  );
  await receiver.receive({
    kind: 'mesh-prepare',
    requestId: 1,
    input: { ...identity, meshHandle: f.meshHandle, mesh: f.mesh },
  });
  post.mockClear();
  const releasing = receiver.receive({ kind: 'mesh-release', requestId: 1, identity, evict: true });
  await Promise.resolve();
  expect(post).not.toHaveBeenCalled();
  generation = 8;
  fence.resolve();
  await releasing;
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'mesh-released',
      result: { ok: true, deviceGeneration: 8 },
    }),
  );
  expect(inspect).not.toHaveBeenCalled();
  await receiver.receive({ kind: 'mesh-release', requestId: 1, identity, evict: true });
  expect(inspect).not.toHaveBeenCalled();
  await receiver.dispose();
});
