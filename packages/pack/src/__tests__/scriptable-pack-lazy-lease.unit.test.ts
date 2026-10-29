import { err, ok } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type AnyScriptablePackDefinition,
  definePack,
  definePackageId,
  type PackBuildContextWithoutParameters,
  type PackOutputMap,
} from '../pack-authoring.js';
import {
  createLazyScriptablePackDefinition,
  type ScriptablePackModuleExecutorPool,
  type ScriptablePackSourceSnapshot,
} from '../scriptable-pack-node.js';

const packageId = definePackageId('01900000-0000-7000-8000-000000000321');
const sourcePath = '/packs/owner.pack.ts';
const sourceClosure = [{ path: sourcePath, digest: 'sha256:original' }];
const context: PackBuildContextWithoutParameters = {
  packageId,
  readByGuid: async () =>
    err({
      code: 'asset-not-found',
      expected: 'a fixture with no external reads',
      hint: 'use the explicit reader fixture',
    }),
};

afterEach(() => vi.useRealTimers());

function fixture(
  definition: AnyScriptablePackDefinition = definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: () => ok({}),
  }),
) {
  let active = 0;
  let maximum = 0;
  const snapshot: ScriptablePackSourceSnapshot = {
    inputs: new Map(),
    paths: [],
    observePaths: vi.fn(async () => []),
    observeFile: vi.fn(async () => false),
    inventory: vi.fn(async () => sourceClosure),
    readText: vi.fn(async () => 'captured source'),
    digest: vi.fn(async () => 'sha256:original'),
    moduleSources: vi.fn(async () => ({
      entry: sourcePath,
      sources: { [sourcePath]: 'captured source' },
    })),
    metadata: vi.fn(async (_sourcePath, evaluate) => evaluate()),
    releaseResolvers: vi.fn(),
    verify: vi.fn(async () => ok(undefined)),
  };
  const load = vi.fn(async () => ({ default: definition }));
  const releases: string[] = [];
  const executors: ScriptablePackModuleExecutorPool = {
    acquire: vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      let disposed = false;
      return {
        load,
        dispose: async (reason: 'complete' | 'timeout' | 'failure') => {
          if (disposed) return;
          disposed = true;
          active -= 1;
          releases.push(reason);
        },
      };
    }),
    dispose: vi.fn(async () => {}),
  };
  const lazy = () =>
    createLazyScriptablePackDefinition({
      sourcePath,
      definition,
      sourceClosure,
      executors,
      sourceSnapshot: snapshot,
    });
  return {
    snapshot,
    load,
    executors,
    lazy,
    releases,
    active: () => active,
    maximum: () => maximum,
  };
}

it('lets trusted production finish a build beyond the low-level fifteen-second default', async () => {
  vi.useFakeTimers();
  let finish!: (value: ReturnType<typeof ok<PackOutputMap>>) => void;
  const f = fixture(
    definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  );
  let settled = false;
  const pending = f
    .lazy()
    .build(context as never)
    .then((value) => {
      settled = true;
      return value;
    });
  await vi.advanceTimersByTimeAsync(16_000);
  expect(settled).toBe(false);
  expect(f.active()).toBe(1);
  finish(ok({}));
  expect(await pending).toEqual(ok({}));
  expect(f.releases).toEqual(['complete']);
  expect(f.active()).toBe(0);
});

it('does not retain an executor for inventory and bounds serial execution to one live lease', async () => {
  const f = fixture();
  const definitions = Array.from({ length: 80 }, f.lazy);
  expect(f.executors.acquire).not.toHaveBeenCalled();
  expect(f.load).not.toHaveBeenCalled();
  for (const definition of definitions) {
    expect(await definition.build(context as never)).toEqual(ok({}));
    expect(f.active()).toBe(0);
  }
  expect(f.maximum()).toBe(1);
  expect(f.releases).toHaveLength(80);
  expect(new Set(f.releases)).toEqual(new Set(['complete']));
  expect(f.load).toHaveBeenCalledWith(sourcePath, { [sourcePath]: 'captured source' });
});

it('rejects an imported helper change before acquiring or publishing a stale revision', async () => {
  const f = fixture();
  vi.mocked(f.snapshot.inventory).mockResolvedValue([
    ...sourceClosure,
    { path: '/packs/helper.ts', digest: 'sha256:new-helper' },
  ]);
  expect(await f.lazy().build(context as never)).toMatchObject({
    ok: false,
    error: { code: 'pack-source-revision-conflict', detail: { sourcePath } },
  });
  expect(f.executors.acquire).not.toHaveBeenCalled();
});

it('uses captured source bytes without adding disk verification around each execution', async () => {
  const f = fixture();
  const conflict = err({
    code: 'pack-source-revision-conflict' as const,
    expected: 'unchanged captured sources',
    hint: 'rebuild',
    detail: { sourcePath, reason: 'source changed during load' },
  });
  vi.mocked(f.snapshot.verify).mockResolvedValue(conflict);
  expect(await f.lazy().build(context as never)).toEqual(ok({}));
  expect(f.load).toHaveBeenCalledWith(sourcePath, { [sourcePath]: 'captured source' });
  expect(f.snapshot.verify).not.toHaveBeenCalled();
  expect(f.active()).toBe(0);
  expect(f.releases).toEqual(['complete']);
});

it('fences package identity before build and releases the mismatched module', async () => {
  const f = fixture();
  f.load.mockResolvedValueOnce({
    default: definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000322'),
      build: () => {
        throw new Error('mismatched source must never build');
      },
    }),
  });
  expect(await f.lazy().build(context as never)).toMatchObject({
    ok: false,
    error: { code: 'pack-source-revision-conflict', detail: { sourcePath } },
  });
  expect(f.active()).toBe(0);
  expect(f.releases).toEqual(['failure']);
});

it('keeps parameter schema and effective instance context when acquiring a fresh execution lease', async () => {
  const build = vi.fn(async (input: { readonly values: { readonly size: number } }) => {
    expect(input.values.size).toBe(7);
    return ok({} as PackOutputMap);
  });
  const metadata = definePack({
    schemaVersion: '2.0.0',
    packageId,
    parameters: [{ name: 'size', type: 'u32', default: 3 }],
    build,
  });
  const f = fixture(metadata);
  const definition = f.lazy();
  expect('parameters' in definition && definition.parameters).toEqual(metadata.parameters);
  const instance = definePackageId('01900000-0000-7000-8000-000000000333');
  await definition.build({ ...context, packageId: instance, values: { size: 7 } } as never);
  expect(build).toHaveBeenCalledWith(
    expect.objectContaining({ packageId: instance, values: { size: 7 } }),
  );
  expect(f.active()).toBe(0);
});

it('preserves blocked read errors and reacquires a lease for a later worklist retry', async () => {
  const missing = err({
    code: 'plugin-bootstrap-read-blocked',
    expected: 'source-only bootstrap inputs',
    hint: 'defer this Pack to normal cooking',
    detail: { guid: '01900000-0000-7000-8000-000000000444' },
  });
  const reader = vi.fn(async () => missing);
  const metadata = definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: async (input) => {
      const result = await input.readByGuid(new Uint8Array(16) as never);
      return result.ok ? ok({}) : result;
    },
  });
  const f = fixture(metadata);
  const definition = f.lazy();
  for (let i = 0; i < 2; i += 1) {
    expect(await definition.build({ ...context, readByGuid: reader } as never)).toEqual(missing);
    expect(f.active()).toBe(0);
  }
  expect(f.executors.acquire).toHaveBeenCalledTimes(2);
  expect(f.releases).toEqual(['complete', 'complete']);
});

it.each([
  // Both trusted phases stay finite under the busy-host authoring policy.
  ['module-load', 120_000],
  ['build', 120_000],
] as const)('bounds the %s phase at %i ms and releases its lease', async (phase, timeoutMs) => {
  vi.useFakeTimers();
  const f = fixture(
    definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: () => new Promise<never>(() => {}),
    }),
  );
  if (phase === 'module-load') f.load.mockImplementationOnce(() => new Promise<never>(() => {}));
  const pending = f.lazy().build(context as never);
  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(f.active()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({
    ok: false,
    error: {
      code: 'pack-parameter-invalid',
      detail: { reason: 'timeout', phase, timeoutMs },
    },
  });
  expect(f.active()).toBe(0);
  expect(f.releases).toEqual(['timeout']);
});

it('releases throwing builds without replacing their original failure', async () => {
  const cause = new Error('fixture author failure');
  const f = fixture(
    definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: () => {
        throw cause;
      },
    }),
  );
  await expect(f.lazy().build(context as never)).rejects.toBe(cause);
  expect(f.active()).toBe(0);
  expect(f.releases).toEqual(['failure']);
});

it('releases a failed module load through the original structured loader error', async () => {
  const f = fixture();
  f.load.mockRejectedValueOnce(new Error('fixture module failure'));
  expect(await f.lazy().build(context as never)).toMatchObject({
    ok: false,
    error: {
      code: 'pack-parameter-invalid',
      detail: { phase: 'module-load', diagnostic: 'fixture module failure' },
    },
  });
  expect(f.active()).toBe(0);
  expect(f.releases).toEqual(['failure']);
});
