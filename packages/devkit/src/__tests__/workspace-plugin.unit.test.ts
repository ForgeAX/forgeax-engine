import assert from 'node:assert/strict';
import type { EngineWorkspaceProvider } from '@forgeax/engine-app';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { describe, expect, it, vi } from 'vitest';
import { devKitWorkspacePlugin } from '../workspace-plugin.js';

// Native Host/ToolApi lifecycle evidence; this fixture does not render.
describe('Engine workspace capability plugin', () => {
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
      openProject: ({ root }) => ({ project: { id: root, root }, target }),
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
      openProject: ({ root }) => ({ project: { id: root, root } }),
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
      openProject: ({ root }) => ({ project: { id: root, root } }),
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
  it('routes project ownership, target queries and close to the exact frontend session', async () => {
    const backend = await createBackendHost({});
    let sequence = 0;
    const closed = vi.fn();
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => {
        const id = ++sequence;
        return {
          project: { id: root, root },
          handle: id,
          target: {
            targetId: `target-${id}`,
            sessionId: `session-${id}`,
            worldId: `world-${id}`,
            headed: true,
            width: 320,
            height: 240,
          },
        };
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
      const a = (await call(first, 'engine.project.open', { root: '/same-project' })) as {
        projectTarget: { targetId: string };
      };
      const b = (await call(second, 'engine.project.open', { root: '/same-project' })) as {
        projectTarget: { targetId: string };
      };
      expect(a.projectTarget.targetId).not.toBe(b.projectTarget.targetId);
      expect(closed).not.toHaveBeenCalled();
      expect(await call(first, 'engine.workspace.get')).toMatchObject({
        projectTarget: a.projectTarget,
      });
      expect(await call(second, 'engine.workspace.get')).toMatchObject({
        projectTarget: b.projectTarget,
      });
      const headed = backend.transport.connect({
        kind: 'frontend',
        sourceId: 'forgeax-workspace:session-1:target-1',
      });
      try {
        expect(await call(headed, 'engine.workspace.get')).toMatchObject({
          projectTarget: a.projectTarget,
        });
        await call(second, 'engine.project.close', { projectId: '/same-project' });
        expect(await call(headed, 'engine.workspace.get')).toMatchObject({
          projectTarget: a.projectTarget,
        });
        expect(closed).toHaveBeenCalledTimes(1);
      } finally {
        headed.close();
      }
      expect(backend.context.engineWorkspace.project).toBeUndefined();
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
