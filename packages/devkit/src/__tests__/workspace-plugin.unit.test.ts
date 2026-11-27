import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineWorkspaceError, type EngineWorkspaceProvider } from '@forgeax/engine-app';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSelection } from '../backend-lifetime.js';
import { createOperationHistoryStore } from '../operation-history.js';
import { devKitWorkspacePlugin } from '../workspace-plugin.js';

const opened = (
  root: string,
  target?: import('@forgeax/engine-app').EngineWorkspaceTarget,
  handle?: unknown,
) => {
  const sessionId = target?.sessionId ?? `session:${root}`;
  const status = target
    ? {
        phase: 'running' as const,
        sessionId,
        generation: 1,
        document: {
          sessionId,
          targetId: target.targetId,
          url: 'http://localhost:4173',
          browserGeneration: 1,
        },
        target,
        browserGeneration: 1,
      }
    : { phase: 'preparing' as const, sessionId, generation: 1 };
  return {
    project: { id: root, root },
    status,
    subscribeStatus: () => () => {},
    ...(handle === undefined ? {} : { handle }),
  };
};

// Native Host/ToolApi lifecycle evidence; this fixture does not render.
describe('Engine workspace capability plugin', () => {
  it('reads only the admitted frontend project history and ignores a forged root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-history-access-'));
    const first = join(root, 'first'),
      second = join(root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    vi.stubEnv('FORGEAX_HISTORY_DIR', join(root, 'history'));
    const backend = await createBackendHost({});
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => opened(root),
      closeProject() {},
      listAssets: () => [],
      openPreview() {
        throw new Error('unused');
      },
    };
    const client = backend.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    const foreign = backend.transport.connect({ kind: 'frontend', sourceId: 'unadmitted' });
    try {
      for (const project of [first, second])
        await (await createOperationHistoryStore(project)).track(project, {}, async () => ({
          outcome: 'succeeded',
          result: {},
          artifacts: [],
        }));
      const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
        provider,
        hostBinding: { backend },
      });
      await fiber.await();
      const call = (operation: string, args: Record<string, unknown>) =>
        client.request('engine.workspace.call', { operation, args });
      await expect(call('engine.history.list', { root: second })).rejects.toThrow();
      await call('engine.project.open', { root: first });
      expect(await call('engine.history.list', { root: second })).toMatchObject({
        root: await realpath(first),
        items: [{ operation: first }],
      });
      await expect(
        foreign.request('engine.workspace.call', {
          operation: 'engine.history.list',
          args: { root: first },
        }),
      ).rejects.toThrow();
    } finally {
      client.close();
      foreign.close();
      await backend.dispose();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('derives plugin ownership from Host callers and releases a disconnected project connection before any preview', async () => {
    const backend = await createBackendHost({});
    const target = {
      targetId: 'project-target',
      sessionId: 'session',
      worldId: 'project-world',
      headed: true,
      width: 320,
      height: 240,
    };
    const runtimePack = vi.fn(async () => ({ marker: 'runtime-content' }));
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => opened(root, target),
      closeProject() {},
      listAssets: () => [],
      openPreview: () => {
        throw new Error('unused');
      },
      runtimePack,
    };
    const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
      provider,
      hostBinding: { backend },
    });
    await fiber.await();
    const a = backend.transport.connect({ kind: 'frontend', sourceId: 'view-a' });
    const b = backend.transport.connect({ kind: 'frontend', sourceId: 'view-b' });
    try {
      await a.request('engine.workspace.call', {
        operation: 'engine.project.open',
        args: { root: '/project' },
      });
      const args = {
        projectId: '/project',
        targetId: target.targetId,
        worldId: target.worldId,
        guid: 'plugin-guid',
        connectionId: 'forged',
      };
      for (const client of [a, b])
        await client.request('engine.workspace.call', {
          operation: 'engine.runtime-pack.plugin-install',
          args,
        });
      const calls = runtimePack.mock.calls as unknown as [
        { connectionId: string; request: { operation: string } },
      ][];
      assert(calls[0] && calls[1]);
      const first = calls[0][0].connectionId;
      const second = calls[1][0].connectionId;
      expect(first).not.toBe('forged');
      expect(second).not.toBe(first);
      a.close();
      await vi.waitFor(() => expect(runtimePack).toHaveBeenCalledTimes(3));
      expect(calls[2]?.[0]).toMatchObject({
        connectionId: first,
        request: { operation: 'release' },
        targetId: target.targetId,
        worldId: target.worldId,
      });
      expect(backend.context.engineWorkspace?.previews).toEqual([]);
      await b.request('engine.workspace.call', {
        operation: 'engine.runtime-pack.plugin-inspect',
        args,
      });
      expect(calls[3]?.[0]).toMatchObject({
        connectionId: second,
        request: { operation: 'plugin-inspect' },
      });
    } finally {
      a.close();
      b.close();
      await backend.dispose();
    }
  });
  it('rejects run control through both transport and direct ToolApi in an observer workspace', async () => {
    const backend = await createBackendHost({});
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => opened(root),
      closeProject() {},
      listAssets: () => [],
      openPreview: () => {
        throw new Error('unused');
      },
      inspectAsset: ({ guid }) => ({ guid }),
      dispose() {},
    };
    const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
      provider,
      runAccess: 'observe',
      authorize: () => true,
      hostBinding: { backend },
    });
    await fiber.await();
    const client = backend.transport.connect({ kind: 'cli', sourceId: 'view-client' });
    const api = backend.context.get('toolApi');
    if (!api) throw new Error('workspace must install ToolApi');
    try {
      for (const operation of ['start', 'stop', 'reload', 'capture', 'eval', 'camera.set']) {
        const args = { root: '/nonexistent-observer-run' };
        await expect(
          client.request('engine.workspace.call', { operation: `engine.run.${operation}`, args }),
        ).rejects.toThrow();
        const result = await api.run(`engine.run.${operation}`, args, {
          sourceId: 'engine-workspace',
        }).terminal;
        expect(result.outcome).toBe('failed');
      }
      expect(
        await client.request('engine.workspace.call', {
          operation: 'engine.run.observe',
          args: { root: '/nonexistent-observer-run' },
        }),
      ).toMatchObject({ status: { phase: 'stopped' }, image: null });
    } finally {
      client.close();
      await backend.dispose();
    }
  });

  it('owns discoverable domain operations independently of UI entries and releases only its resources', async () => {
    const backend = await createBackendHost({});
    const closeProject = vi.fn();
    const dispose = vi.fn();
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => opened(root),
      closeProject,
      listAssets: () => [{ guid: 'asset', kind: 'mesh' }],
      openPreview: () => {
        throw new Error('unused');
      },
      inspectAsset: ({ guid }) => ({ guid, kind: 'mesh' }),
      dispose,
    };
    const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
      provider,
      authorize: ({ caller }) => caller?.sourceId === 'test-cli',
      hostBinding: { backend },
    });
    await fiber.await();
    const client = backend.transport.connect({ kind: 'cli', sourceId: 'test-cli' });
    try {
      const capabilities = await client.request('engine.workspace.capabilities', {});
      expect(JSON.parse(JSON.stringify(capabilities))).toEqual(capabilities);
      const call = (operation: string, args: unknown) =>
        client.request('engine.workspace.call', { operation, args });
      await call('engine.project.open', { root: '/project' });
      const toolApi = backend.context.get('toolApi');
      if (!toolApi) throw new Error('workspace must install ToolApi');
      const direct = await toolApi.run(
        'engine.project.close',
        { projectId: '/project' },
        { sourceId: 'engine-workspace' },
      ).terminal;
      expect(direct.outcome).toBe('failed');
      const denied = backend.transport.connect({ kind: 'cli', sourceId: 'denied' });
      await expect(
        denied.request('engine.workspace.call', {
          operation: 'engine.project.close',
          args: { projectId: '/project' },
        }),
      ).rejects.toThrow();
      denied.close();
      await backend.update({});
      expect(await call('engine.assets.list', { projectId: '/project' })).toMatchObject({
        assets: [{ guid: 'asset' }],
      });
      expect(
        await call('engine.asset.inspect', { projectId: '/project', guid: 'asset' }),
      ).toMatchObject({ inspection: { guid: 'asset' } });
      await fiber.dispose();
      expect(closeProject).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      await expect(call('engine.workspace.get', {})).rejects.toThrow();
      const remove = backend.transport.register('owner.alive', () => true);
      expect(await client.request('owner.alive', {})).toBe(true);
      remove();
    } finally {
      client.close();
      await backend.dispose();
    }
  });
});

describe('admitted independent workspace sessions', () => {
  it.each([
    false,
    true,
  ])('retains the original failed project diagnostic with a published target: %s', async (publishedTarget) => {
    const backend = await createBackendHost({});
    const target = {
      targetId: 'failed-target',
      sessionId: 'failed-session',
      worldId: 'failed-world',
      headed: true,
      width: 320,
      height: 240,
    };
    const admitted = opened('/failed-project', target);
    const failure = new EngineWorkspaceError(
      'engine-workspace-bootstrap-failed',
      'graphics unavailable',
      'Inspect the renderer failure.',
    );
    const listAssets = vi.fn(() => {
      throw failure;
    });
    const provider: EngineWorkspaceProvider = {
      openProject: () => ({
        ...admitted,
        status: {
          phase: 'failed',
          sessionId: target.sessionId,
          generation: 1,
          document: {
            sessionId: target.sessionId,
            targetId: target.targetId,
            url: 'http://localhost:4173',
            browserGeneration: 1,
          },
          ...(publishedTarget ? { target } : {}),
          failure,
        },
      }),
      closeProject() {},
      listAssets,
      openPreview() {
        throw new Error('unused');
      },
    };
    const fiber = backend.context.plugin(devKitWorkspacePlugin, {
      provider,
      hostBinding: { backend },
    });
    try {
      await fiber.await();
      const runtime = backend.context.engineWorkspace;
      await runtime.openProject({ root: '/failed-project' });
      const api = backend.context.get('toolApi');
      assert.ok(api);
      const request = (targetId: string) =>
        api.run(
          'engine.assets.list',
          { projectId: '/failed-project', targetId },
          { sourceId: 'engine-workspace' },
        ).terminal;
      const failed = await request(target.targetId);
      expect(failed.outcome).toBe('failed');
      if (failed.outcome === 'failed')
        expect(failed.failure).toMatchObject({
          expected: failure.expected,
          hint: failure.hint,
          detail: { code: failure.code },
        });
      expect(listAssets).toHaveBeenCalledTimes(1);
      expect(
        await api.run('engine.workspace.get', {}, { sourceId: 'engine-workspace' }).terminal,
      ).toMatchObject({
        outcome: 'succeeded',
        result: { projectTarget: null, projectPhase: 'failed' },
      });
      const foreign = await request('foreign-target');
      if (foreign.outcome === 'failed')
        expect(foreign.failure.detail).toMatchObject({ code: 'engine-workspace-target-mismatch' });
      expect(foreign.outcome).toBe('failed');
      expect(listAssets).toHaveBeenCalledTimes(1);
    } finally {
      await fiber.dispose();
      await backend.dispose();
    }
  });

  it('shares the backend project owner across View frontend connections', async () => {
    const backend = await createBackendHost({});
    let sequence = 0;
    const closed = vi.fn();
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => {
        const id = ++sequence;
        const target = {
          targetId: `target-${id}`,
          sessionId: `session-${id}`,
          worldId: `world-${id}`,
          headed: true,
          width: 320,
          height: 240,
        };
        return opened(root, target, id);
      },
      closeProject: closed,
      listAssets: ({ handle }) => [
        { guid: `asset-${handle}`, kind: 'scene', name: `owner-${handle}` },
      ],
      openPreview: () => {
        throw new Error('unused');
      },
    };
    const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
      provider,
      hostBinding: { backend },
    });
    await fiber.await();
    const first = backend.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    const second = backend.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    const call = (client: typeof first, operation: string, args: unknown = {}) =>
      client.request('engine.workspace.call', { operation, args });
    try {
      const a = (await call(first, 'engine.project.open', {
        root: '/same-project',
        expectedProject: { kind: 'empty' },
      })) as {
        projectTarget: { targetId: string };
      };
      await expect(
        call(second, 'engine.project.open', {
          root: '/same-project',
          expectedProject: { kind: 'empty' },
        }),
      ).rejects.toThrow();
      expect(sequence).toBe(1);
      expect(closed).not.toHaveBeenCalled();
      expect(await call(first, 'engine.workspace.get')).toMatchObject({
        projectTarget: a.projectTarget,
      });
      expect(await call(second, 'engine.workspace.get')).toMatchObject({
        projectTarget: a.projectTarget,
      });
      const headed = backend.transport.connect({
        kind: 'frontend',
        sourceId: 'forgeax-workspace:session-1:target-1',
      });
      try {
        expect(await call(headed, 'engine.workspace.get')).toMatchObject({
          projectTarget: a.projectTarget,
        });
      } finally {
        headed.close();
      }
      first.close();
      second.close();
      expect(backend.context.engineWorkspace.project?.project.root).toBe('/same-project');
      expect(closed).not.toHaveBeenCalled();
      const api = backend.context.get('toolApi');
      if (!api) throw new Error('workspace must install ToolApi');
      const invalid = await api.run(
        'engine.scene.tree.get',
        {
          targetId: 'absent-target',
          targetGeneration: 1,
        },
        { sourceId: 'engine-workspace' },
      ).terminal;
      expect(invalid.outcome).toBe('failed');
      if (invalid.outcome === 'failed')
        expect(invalid.failure.detail).toMatchObject({
          code: 'engine-workspace-target-mismatch',
        });
    } finally {
      first.close();
      second.close();
      await fiber.dispose();
      await backend.dispose();
    }
  });
});

it('persists only successful backend project selections and retains the chooser on closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-workspace-selection-'));
  const selection = createWorkspaceSelection(root);
  const backend = await createBackendHost({});
  const provider: EngineWorkspaceProvider = {
    openProject: ({ root, generation }) => {
      if (root === 'broken') throw new Error('failed admission');
      const value = opened(root);
      return { ...value, status: { ...value.status, generation } };
    },
    closeProject() {},
    listAssets: () => [],
    openPreview() {
      throw new Error('unused');
    },
  };
  const client = backend.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
  try {
    const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
      provider,
      selection,
      hostBinding: { backend },
    });
    await fiber.await();
    const call = (operation: string, args: Record<string, unknown>) =>
      client.request('engine.workspace.call', { operation, args });
    expect(await selection.read()).toBeUndefined();
    await call('engine.project.open', { root: 'first' });
    expect(await selection.read()).toBe('first');
    await expect(
      call('engine.project.open', {
        root: 'broken',
        expectedProject: { kind: 'session', sessionId: 'session:first', generation: 1 },
      }),
    ).rejects.toThrow();
    expect(await selection.read()).toBe('first');
    const current = backend.context.engineWorkspace.project;
    assert.ok(current);
    await call('engine.project.open', {
      root: 'second',
      expectedProject: {
        kind: 'session',
        sessionId: current.status.sessionId,
        generation: current.status.generation,
      },
    });
    expect(await selection.read()).toBe('second');
    await call('engine.project.close', { projectId: 'second' });
    expect(await selection.read()).toBeNull();
    expect(await createWorkspaceSelection(root).read()).toBeNull();
  } finally {
    client.close();
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
