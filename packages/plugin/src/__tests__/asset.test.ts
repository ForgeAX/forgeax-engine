import { Context, type Plugin } from '@deepseek-ai/cordis';
import { defineToolCommandContract } from '@forgeax/engine-tool-runtime';
import { err, ok, type PluginAssetDefinition } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  joinPluginFiber,
  mountPluginAsset,
  type PluginAssetReader,
  type PluginPrograms,
  pluginAssetOrigin,
} from '../asset.js';
import { registerAssetTools } from '../register-tools.js';
import { disposePluginFiber, startNativePlugin, startPluginAsset } from '../startup.js';
import { createToolApiPlugin } from '../tool-api.js';

const left = '00000000-0000-4000-8000-000000000001';
const right = '00000000-0000-4000-8000-000000000002';

function fixture(plugin: Plugin) {
  const context = new Context();
  const definitions = new Map(
    [left, right].map((guid, index) => [
      guid,
      {
        guid,
        asset: { kind: 'plugin', program: 'project:game.ts#default', config: { speed: 3 } },
        evidence: {
          kind: 'publication',
          publication: {
            scopeId: 'project',
            generation: index + 4,
            digest: `pack:${index}`,
            outputSetDigest: `set:${index}`,
          },
        },
      } satisfies PluginAssetDefinition,
    ]),
  );
  const load = vi.fn(async () => plugin);
  const programs: PluginPrograms = {
    sessionId: 'game',
    contextId: 'engine',
    sessionGeneration: 91,
    target: 'engine',
    tools: new Map([left, right].map((guid) => [guid, defineToolCommandContract([])])),
    definitions: new Map([...definitions].map(([guid, value]) => [guid, value.evidence])),
    programs: new Map([['project:game.ts#default', { load }]]),
  };
  context.provide('assets', {
    readPluginDefinition: async (guid: string) => {
      const value = definitions.get(guid);
      if (!value) throw new Error('required fixture value missing');
      return ok(value);
    },
  });
  context.provide('pluginPrograms', programs);
  return { context, definitions, programs, load };
}

describe('plugin asset native installation', () => {
  it('retains a structured domain failure thrown by an async effect', async () => {
    const ctx = new Context();
    let disposed = false;
    const failure = {
      code: 'fixture-domain-unavailable',
      expected: 'the authored resource',
      hint: 'repair the resource',
      detail: { resource: 'guide.ui.html' },
    };
    try {
      const result = await startNativePlugin(ctx, {
        async apply(ctx: Context) {
          await ctx.effect(async function* () {
            yield () => {
              disposed = true;
            };
            throw failure;
          });
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { detail: { reason: 'failed', cleanup: 'completed', cause: { cause: failure } } },
      });
      expect(disposed).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('bounds ACTIVE native cleanup and does not claim a pending effect was released', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { context } = fixture({
      apply(ctx) {
        ctx.effect(() => () => pending);
      },
    });
    try {
      const fiber = (await startPluginAsset(context, left)).unwrap();
      expect(fiber.state).toBe(2);
      expect(await disposePluginFiber(fiber, 30)).toEqual({ cleanup: 'timeout' });
      expect(fiber.inertia).toBeDefined();
      release();
      await fiber.await();
      expect(fiber.state).toBe(4);
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it('keeps a concurrent sibling cleanup error outside the disposed native tree', async () => {
    const context = new Context();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const owned = (
        await startNativePlugin(context, {
          apply(ctx) {
            ctx.effect(() => () => pending);
          },
        })
      ).unwrap();
      const sibling = (
        await startNativePlugin(context, {
          apply(ctx) {
            ctx.effect(() => () => {
              throw new Error('unrelated active cleanup');
            });
          },
        })
      ).unwrap();
      const disposal = disposePluginFiber(owned);
      await sibling.dispose();
      release();
      expect(await disposal).toEqual({ cleanup: 'completed' });
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it('refuses a metadata-only asset even when an eligible asset shares its program', async () => {
    const { context, programs, load } = fixture({ apply() {} });
    context.pluginPrograms = {
      ...programs,
      tools: new Map([[left, defineToolCommandContract([])]]),
    };
    try {
      const missing = await mountPluginAsset(context, right);
      expect(missing).toMatchObject({
        ok: false,
        error: { code: 'plugin-program-unavailable', detail: { guid: right, target: 'engine' } },
      });
      expect(load).not.toHaveBeenCalled();
      const available = (await mountPluginAsset(context, left)).unwrap();
      await available.dispose();
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      await context.fiber.dispose();
    }
  });

  it('cancels a pending mount when execution membership is revoked without changing shared code or evidence', async () => {
    const apply = vi.fn();
    const { context, programs, load } = fixture({ apply });
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    load.mockImplementation(async () => {
      entered();
      await gate;
      return { apply };
    });
    try {
      const pending = mountPluginAsset(context, right);
      await loading;
      context.pluginPrograms = {
        ...programs,
        tools: new Map([[left, defineToolCommandContract([])]]),
      };
      resume();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'plugin-mount-cancelled' } });
      expect(apply).not.toHaveBeenCalled();
    } finally {
      resume();
      await context.fiber.dispose();
    }
  });

  it('keeps tool declarations serializable and loads the pinned executor only during a native tool run', async () => {
    const { context, programs } = fixture({
      inject: ['toolApi'],
      apply(ctx) {
        ctx.effect(() => registerAssetTools(ctx));
      },
    });
    const executor = vi.fn(async () => () => 42);
    const replacement = vi.fn(async () => () => 99);
    const declarations = defineToolCommandContract([
      {
        id: 'asset.run',
        title: 'Run',
        summary: 'Run the delivered executor',
        realm: 'engine',
        executor: 'project:tools.js#run',
      },
      {
        id: 'asset.unavailable',
        title: 'Unavailable',
        summary: 'A valid declaration without an executor',
        realm: 'engine',
      },
    ]);
    context.pluginPrograms = {
      ...programs,
      programs: new Map([...programs.programs, ['project:tools.js#run', { load: executor }]]),
      tools: new Map([[left, JSON.parse(JSON.stringify(declarations))]]),
    };
    try {
      (await startNativePlugin(context, createToolApiPlugin())).unwrap();
      const api = context.toolApi;
      if (!api) throw new Error('required fixture toolApi missing');
      expect(api.list()).toEqual([]);
      expect(executor).not.toHaveBeenCalled();
      const installed = (await startPluginAsset(context, left)).unwrap();
      expect(api.list()).toHaveLength(2);
      expect(executor).not.toHaveBeenCalled();
      const current = context.pluginPrograms;
      if (!current) throw new Error('required fixture programs missing');
      context.pluginPrograms = {
        ...current,
        programs: new Map([...current.programs, ['project:tools.js#run', { load: replacement }]]),
      };
      expect(await api.run('asset.run', {}).terminal).toMatchObject({
        outcome: 'succeeded',
        result: 42,
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(replacement).not.toHaveBeenCalled();
      expect(await api.run('asset.unavailable', {}).terminal).toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-capability-unavailable' },
      });
      await installed.dispose();
      expect(api.list().every((entry) => !entry.callable)).toBe(true);
      expect((await api.run('asset.run', {}).terminal).outcome).toBe('failed');
      expect(executor).toHaveBeenCalledOnce();
    } finally {
      await context.fiber.dispose();
    }
  });

  it('rejects a missing declared executor before registering any tool provider', async () => {
    const { context, programs } = fixture({
      inject: ['toolApi'],
      apply(ctx) {
        ctx.effect(() => registerAssetTools(ctx));
      },
    });
    const load = vi.fn(async () => () => 42);
    context.pluginPrograms = {
      ...programs,
      programs: new Map([...programs.programs, ['present', { load }]]),
      tools: new Map([
        [
          left,
          defineToolCommandContract([
            { id: 'first', title: 'First', summary: '', realm: 'engine', executor: 'present' },
            { id: 'missing', title: 'Missing', summary: '', realm: 'engine', executor: 'absent' },
          ]),
        ],
      ]),
    };
    try {
      (await startNativePlugin(context, createToolApiPlugin())).unwrap();
      const api = context.toolApi;
      if (!api) throw new Error('required fixture toolApi missing');
      const installed = await startPluginAsset(context, left);
      expect(installed.ok).toBe(false);
      expect(api.list()).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    } finally {
      await context.fiber.dispose();
    }
  });

  it('rechecks referenced asset evidence after a pending module load before creating its Fiber', async () => {
    const apply = vi.fn();
    const { context, programs } = fixture({ apply });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: (plugin: Plugin) => void;
    (programs.programs as Map<string, unknown>).set('project:game.ts#default', {
      load: () => {
        enter();
        return new Promise<Plugin>((resolve) => {
          resume = resolve;
        });
      },
    });
    const pending = mountPluginAsset(context, left);
    await entered;
    (context.get('assets') as PluginAssetReader).readPluginDefinition = async () =>
      err({
        code: 'asset-dependency-failed',
        expected: 'the recorded material version',
        hint: 'restore the fixed reference',
        detail: { guid: left, dependencyGuid: right },
      });
    resume({ apply });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'plugin-asset-read-failed' } });
    expect(apply).not.toHaveBeenCalled();
    expect([...context.registry.values()].flatMap((runtime) => runtime.fibers)).toHaveLength(0);
    await context.fiber.dispose();
  });
  it('waits externally for a child that injects its parent service', async () => {
    const applied = vi.fn();
    const { context } = fixture({
      apply(ctx) {
        ctx.provide('parentService', 42);
        ctx.plugin({ inject: ['parentService'], apply: applied });
      },
    });
    const result = await startPluginAsset(context, left, { timeoutMs: 200 });
    expect(result.ok).toBe(true);
    expect(applied).toHaveBeenCalledOnce();
    await context.fiber.dispose();
  });

  it('reports pending dependencies and disposes the failed candidate', async () => {
    const { context } = fixture({ inject: ['absent'], apply: vi.fn() });
    const result = await startPluginAsset(context, left, { timeoutMs: 20 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'plugin-startup-failed',
        detail: {
          reason: 'timeout',
          cleanup: 'completed',
          fibers: [{ state: 'pending', missingServices: ['absent'] }],
        },
      },
    });
    expect([...context.registry.values()].flatMap((runtime) => runtime.fibers)).toHaveLength(0);
    await context.fiber.dispose();
  });

  it('allows startup timeout to be disabled without disabling cancellation', async () => {
    vi.useFakeTimers();
    const { context } = fixture({ inject: ['absent'], apply: vi.fn() });
    const controller = new AbortController();
    try {
      let settled = false;
      const pending = startPluginAsset(context, left, {
        timeoutMs: null,
        signal: controller.signal,
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'plugin-startup-failed', detail: { reason: 'cancelled' } },
      });
      expect([...context.registry.values()].flatMap((runtime) => runtime.fibers)).toHaveLength(0);
    } finally {
      controller.abort();
      await context.fiber.dispose();
      vi.useRealTimers();
    }
  });

  it('bounds a slow import without installing its late result', async () => {
    const applied = vi.fn();
    const { context, programs } = fixture({ apply: applied });
    let resolve!: (value: Plugin) => void;
    (programs.programs as Map<string, unknown>).set('project:game.ts#default', {
      load: () =>
        new Promise<Plugin>((done) => {
          resolve = done;
        }),
    });
    const result = await startPluginAsset(context, left, { timeoutMs: 20 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'plugin-startup-failed', detail: { reason: 'timeout' } },
    });
    resolve({ apply: applied });
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(applied).not.toHaveBeenCalled();
    await context.fiber.dispose();
  });

  it.each([
    'throw',
    'reject',
    'nested-cause',
    'muted-logger',
  ] as const)('reports a real PluginAsset effect cleanup %s instead of safe completion', async (mode) => {
    const cleanupFailure = new Error(
      'plugin-owned lease could not be released',
      mode === 'nested-cause' ? { cause: new Error('underlying release failure') } : undefined,
    );
    const cleanup = vi.fn(() => {
      if (mode === 'reject') return Promise.reject(cleanupFailure);
      throw cleanupFailure;
    });
    const { context } = fixture({
      apply(ctx) {
        ctx.logger.exporter({ export() {} });
        ctx.effect(() => cleanup);
        ctx.plugin({ inject: ['absent'], apply() {} });
      },
    });
    const remaining = vi.fn();
    const stopRemaining = context.logger.exporter({ export: remaining });
    const exporterCount = context.logger.exporters.size;
    try {
      const startContext =
        mode === 'muted-logger' ? context.intercept('logger', { level: -1 }) : context;
      const result = await startPluginAsset(startContext, left, {
        timeoutMs: 50,
        cleanupTimeoutMs: 50,
      });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'plugin-startup-failed',
          detail: { cleanup: 'failed', cause: cleanupFailure },
        },
      });
      if (!result.ok) expect(result.error.hint).toContain('before retrying');
      if (!result.ok && result.error.code === 'plugin-startup-failed') {
        expect(result.error.detail.cause).toBe(cleanupFailure);
      }
      expect(context.logger.exporters.size).toBe(exporterCount);
      remaining.mockClear();
      context.logger.info('the unrelated exporter remains installed');
      expect(remaining).toHaveBeenCalledOnce();
    } finally {
      stopRemaining();
      await context.fiber.dispose();
    }
  });

  it('does not attribute another native Fiber cleanup failure to the candidate', async () => {
    const { context } = fixture({
      async apply(ctx) {
        const sibling = context.plugin({
          apply(other) {
            other.effect(() => () => {
              throw new Error('unrelated owner cleanup');
            });
          },
        }).ctx.fiber;
        await sibling.await();
        await sibling.dispose();
        ctx.plugin({ inject: ['absent'], apply() {} });
      },
    });
    try {
      const result = await startPluginAsset(context, left, { timeoutMs: 50, cleanupTimeoutMs: 50 });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'plugin-startup-failed', detail: { cleanup: 'completed' } },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  it.each([
    'pending-child',
    'failed-apply',
  ] as const)('bounds real pending effect cleanup after %s without reporting completion', async (trigger) => {
    let release!: () => void;
    const lease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = vi.fn(() => lease);
    const { context } = fixture({
      apply(ctx) {
        ctx.effect(() => cleanup);
        if (trigger === 'failed-apply') throw new Error('startup failed after acquiring lease');
        ctx.plugin({ inject: ['absent'], apply() {} });
      },
    });
    try {
      const result = await startPluginAsset(context, left, { timeoutMs: 50, cleanupTimeoutMs: 50 });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'plugin-startup-failed', detail: { cleanup: 'timeout' } },
      });
      if (!result.ok) expect(result.error.hint).toContain('before retrying');
    } finally {
      release();
      await context.fiber.dispose();
    }
  });

  it('shares implementation while preserving atomic source identity and private configurations', async () => {
    const seen: unknown[] = [];
    const { context } = fixture({
      apply(ctx) {
        seen.push(ctx[pluginAssetOrigin]);
      },
    });
    const created: unknown[] = [];
    context.on('internal/plugin', (fiber) => {
      created.push(fiber.ctx[pluginAssetOrigin]);
    });
    const a = (await mountPluginAsset(context, left)).unwrap();
    const b = (await mountPluginAsset(context, right)).unwrap();
    await a.await();
    await b.await();
    expect(a.runtime).toBe(b.runtime);
    expect(a.config).not.toBe(b.config);
    expect(created.slice(0, 2).map((origin) => (origin as { guid: string }).guid)).toEqual([
      left,
      right,
    ]);
    expect(seen).toHaveLength(2);
    await a.dispose();
    expect(b.state).toBe(2);
    await context.fiber.dispose();
    expect(b.state).toBe(4);
  });

  it('returns the actual PENDING Fiber without awaiting unresolved injection', async () => {
    const { context } = fixture({ inject: ['missing'], apply: vi.fn() });
    const result = await mountPluginAsset(context, left);
    expect(result.ok).toBe(true);
    expect(result.unwrap().state).toBe(0);
    expect(result.unwrap()).toBe(result.unwrap().ctx.fiber);
    await context.fiber.dispose();
  });

  it('rejects mismatched publication bytes before evaluating code', async () => {
    const { context, definitions, load } = fixture({ apply() {} });
    const definition = definitions.get(left);
    if (!definition) throw new Error('required fixture definition missing');
    definitions.set(left, {
      ...definition,
      evidence: {
        kind: 'publication',
        publication: {
          scopeId: 'project',
          generation: 4,
          digest: 'changed',
          outputSetDigest: 'set:0',
        },
      },
    });
    expect(await mountPluginAsset(context, left)).toMatchObject({
      ok: false,
      error: { code: 'plugin-publication-mismatch' },
    });
    expect(load).not.toHaveBeenCalled();
    await context.fiber.dispose();
  });

  it.each([
    'definition',
    'module',
  ] as const)('keeps a pending %s when an unrelated program is admitted', async (stage) => {
    const applied = vi.fn();
    const { context, programs } = fixture({ apply: applied });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    if (stage === 'definition') {
      const assets = context.get('assets') as {
        readPluginDefinition: (
          guid: string,
        ) => Promise<ReturnType<typeof ok<PluginAssetDefinition>>>;
      };
      const read = assets.readPluginDefinition;
      assets.readPluginDefinition = async (guid) => {
        entered();
        await paused;
        return read(guid);
      };
    } else {
      const entry = programs.programs.get('project:game.ts#default');
      if (!entry) throw new Error('missing fixture program');
      vi.spyOn(entry, 'load').mockImplementation(async () => {
        entered();
        await paused;
        return { apply: applied };
      });
    }
    const mounting = mountPluginAsset(context, left);
    await started;
    context.pluginPrograms = {
      ...programs,
      definitions: new Map(programs.definitions),
      programs: new Map([
        ...programs.programs,
        ['project:new.mjs#default', { load: async () => ({ apply() {} }) }],
      ]),
    };
    resume();
    const result = await mounting;
    expect(result.ok).toBe(true);
    if (result.ok) await result.value.await();
    expect(applied).toHaveBeenCalledOnce();
    await context.fiber.dispose();
  });

  it.each([
    'session',
    'target',
    'definition',
    'program',
  ] as const)('rejects a late mount after its own %s changes', async (change) => {
    const applied = vi.fn();
    const { context, programs } = fixture({ apply: applied });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const entry = programs.programs.get('project:game.ts#default');
    if (!entry) throw new Error('missing fixture program');
    vi.spyOn(entry, 'load').mockImplementation(async () => {
      entered();
      await paused;
      return { apply: applied };
    });
    const mounting = mountPluginAsset(context, left);
    await started;
    context.pluginPrograms = {
      ...programs,
      ...(change === 'session' ? { sessionGeneration: programs.sessionGeneration + 1 } : {}),
      ...(change === 'target' ? { target: 'host' as const } : {}),
      ...(change === 'definition' ? { definitions: new Map() } : {}),
      ...(change === 'program' ? { programs: new Map() } : {}),
    };
    resume();
    expect(await mounting).toMatchObject({ ok: false, error: { code: 'plugin-mount-cancelled' } });
    expect(applied).not.toHaveBeenCalled();
    await context.fiber.dispose();
  });

  it('does not create a late child after its owning Fiber is disposed', async () => {
    const applied = vi.fn();
    const { context, programs } = fixture({ apply: applied });
    let resolve!: (value: Plugin) => void;
    const pending = new Promise<Plugin>((done) => {
      resolve = done;
    });
    (programs.programs as Map<string, unknown>).set('project:game.ts#default', {
      load: () => pending,
    });
    const result = mountPluginAsset(context, left);
    await Promise.resolve();
    await context.fiber.dispose();
    resolve({ apply: applied });
    expect(await result).toMatchObject({ ok: false, error: { code: 'plugin-mount-cancelled' } });
    expect(applied).not.toHaveBeenCalled();
  });
  it('does not create a native Fiber for an already cancelled startup', async () => {
    const ctx = new Context();
    const applied = vi.fn();
    const result = await startNativePlugin(ctx, { apply: applied }, undefined, {
      signal: AbortSignal.abort(),
    });
    expect(result.ok).toBe(false);
    expect(applied).not.toHaveBeenCalled();
    expect([...ctx.registry.values()].flatMap((runtime) => runtime.fibers)).toHaveLength(0);
    await ctx.fiber.dispose();
  });

  it('releases partial initialization in reverse generator order and retains the failure', async () => {
    const ctx = new Context();
    const events: string[] = [];
    const result = await startNativePlugin(ctx, {
      async apply(ctx: Context) {
        await ctx.effect(async function* () {
          events.push('lease');
          yield () => {
            events.push('release-lease');
          };
          events.push('data');
          yield () => {
            events.push('remove-data');
          };
          throw new Error('partial initialization');
        });
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { reason: 'failed', cleanup: 'completed' } },
    });
    expect(events).toEqual(['lease', 'data', 'remove-data', 'release-lease']);
    await ctx.fiber.dispose();
  });
  it('joins a mounted child before earlier async generator cleanup', async () => {
    const ctx = new Context();
    const events: string[] = [];
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const player: Plugin = {
      async apply(ctx: Context) {
        await ctx.effect(async function* () {
          await wait(2);
          yield async () => {
            await wait(5);
            events.push('player');
          };
        });
      },
    };
    const fiber = ctx.plugin({
      async apply(ctx: Context) {
        await ctx.effect(async function* () {
          yield () => {
            events.push('scene-data');
          };
          const child = ctx.plugin(player);
          await wait(1);
          yield joinPluginFiber(child);
        });
      },
    });
    await wait(50);
    await fiber.dispose();
    await wait(50);
    expect(events).toEqual(['player', 'scene-data']);
    await ctx.fiber.dispose();
  });
});
