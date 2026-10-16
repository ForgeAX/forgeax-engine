import assert from 'node:assert/strict';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createCanvasInputBoundary } from '@forgeax/engine-input';
import { Camera, setActiveCamera } from '@forgeax/engine-render';
import { Name, Transform } from '@forgeax/engine-scene';
import { createToolApi } from '@forgeax/engine-tool-runtime';
import { expect, it, vi } from 'vitest';
import { createAppObservation } from '../observation';
import type { App } from '../types';
import {
  createEngineWorkspaceAppTarget,
  createEngineWorkspaceRuntime,
  type EngineWorkspacePlay,
  type EngineWorkspacePreview,
} from '../workspace';
import { engineWorkspaceTargetToolsPlugin } from '../workspace-target-tools';
import { createEngineWorkspaceTools, snapshotEngineWorkspace } from '../workspace-tools';

it('cancels unpublished Play without waiting for a browser', async () => {
  const controller = new AbortController();
  const failure = new Error('Preparation cancelled');
  const close = vi.fn();
  const ready = vi.fn(async () => {});
  const game: EngineWorkspacePlay = {
    target: {
      targetId: 'game',
      sessionId: 'play',
      worldId: 'pending',
      headed: true,
      width: 320,
      height: 240,
    },
    phase: 'starting',
    ready,
    getCamera: () => ({}),
    close,
  };
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({ project: { id: 'project', root }, handle: {} }),
    closeProject() {},
    listAssets: () => [],
    openPreview: () => game,
    startPlay: async () => {
      controller.abort(failure);
      return game;
    },
  });
  const project = await runtime.openProject({ root: '/project' });
  await expect(runtime.startPlay?.({ ...project, signal: controller.signal })).rejects.toBe(
    failure,
  );
  expect(close).toHaveBeenCalledOnce();
  expect(ready).not.toHaveBeenCalled();
  expect(runtime.play).toBeUndefined();
  await runtime.dispose();
});

it.each([
  false,
  true,
])('retires Play without waiting for a discarded browser (parent refresh: %s)', async (parentRefresh) => {
  let browserGeneration = 0;
  let projectPhase: 'running' | 'starting' = 'running';
  const ready = vi.fn(async () => {});
  const close = vi.fn();
  const game: EngineWorkspacePlay = {
    target: {
      targetId: 'game',
      sessionId: 'play',
      worldId: 'world',
      headed: true,
      width: 320,
      height: 240,
    },
    phase: 'starting',
    get browserGeneration() {
      return browserGeneration;
    },
    ready,
    getCamera: () => ({}),
    close,
  };
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({
      project: { id: 'project', root },
      handle: {},
      browserGeneration: 1,
      get phase() {
        return projectPhase;
      },
    }),
    closeProject() {},
    listAssets: () => [],
    openPreview: () => game,
    startPlay: async () => game,
  });
  const project = await runtime.openProject({ root: '/project' });
  const play = await runtime.startPlay?.(project);
  assert(play && runtime.stopPlay);
  if (parentRefresh) projectPhase = 'starting';
  else browserGeneration = 1;
  await runtime.stopPlay(play);
  expect(ready).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(runtime.play).toBeUndefined();
  await runtime.dispose();
});

it.each([
  false,
  true,
])('keeps a starting Play alive until readiness settles (failure: %s)', async (fails) => {
  let finish!: () => void;
  let began!: () => void;
  const waiting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const loading = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('Game startup did not complete');
  const close = vi.fn();
  const game: EngineWorkspacePlay = {
    target: {
      targetId: 'game',
      sessionId: 'play',
      worldId: 'pending',
      headed: true,
      width: 320,
      height: 240,
    },
    phase: 'starting',
    ready: async () => {
      began();
      await loading;
      if (fails) throw failure;
    },
    getCamera: () => ({}),
    close,
  };
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({ project: { id: 'project', root }, handle: {} }),
    closeProject() {},
    listAssets: () => [],
    openPreview: () => game,
    startPlay: async () => game,
  });
  const project = await runtime.openProject({ root: '/project' });
  const play = await runtime.startPlay?.(project);
  assert(play && runtime.stopPlay);
  const stopped = Promise.allSettled([runtime.stopPlay(play)]);
  try {
    // A published URL may already be importing modules before its ready handshake.
    await Promise.race([waiting, stopped]);
    expect(close).not.toHaveBeenCalled();
    expect(runtime.play).toBe(play);
  } finally {
    finish();
  }
  const [result] = await stopped;
  if (fails) {
    expect(result).toEqual({ status: 'rejected', reason: failure });
    expect(close).not.toHaveBeenCalled();
    expect(runtime.play).toBe(play);
  } else {
    expect(result.status).toBe('fulfilled');
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.play).toBeUndefined();
  }
  await runtime.dispose().catch(() => {});
});

it.each([
  false,
  true,
])('retains the presented Play until close settles (failure: %s)', async (fails) => {
  let finish!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const acknowledgement = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('Native cleanup failed');
  const close = vi.fn(async () => {
    began();
    await acknowledgement;
    if (fails) throw failure;
  });
  const game: EngineWorkspacePlay = {
    target: {
      targetId: 'game',
      sessionId: 'play',
      worldId: 'world',
      headed: true,
      width: 320,
      height: 240,
    },
    phase: 'running',
    ready: async () => {},
    getCamera: () => ({}),
    close,
  };
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({ project: { id: 'project', root }, handle: {} }),
    closeProject() {},
    listAssets: () => [],
    openPreview: () => game,
    startPlay: async () => game,
  });
  const project = await runtime.openProject({ root: '/project' });
  const play = await runtime.startPlay?.(project);
  assert(play && runtime.stopPlay && runtime.startPlay);
  const first = runtime.stopPlay(play);
  const second = runtime.stopPlay(play);
  const starting = runtime.startPlay(project);
  const next = Promise.allSettled([starting]);
  const settled = Promise.allSettled([first, second]);
  try {
    await started;
    // View uses this existing owner projection to retain or destroy its iframe.
    expect(snapshotEngineWorkspace(runtime).play?.target?.targetId).toBe('game');
    expect(runtime.play).toBe(play);
  } finally {
    finish();
  }
  const results = await settled;
  if (fails) {
    expect(results[0]).toEqual({ status: 'rejected', reason: failure });
    expect(runtime.play).toBe(play);
    expect((await next)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'engine-workspace-target-busy' },
    });
  } else {
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect((await next)[0]).toMatchObject({ status: 'fulfilled', value: runtime.play });
  }
  await runtime.dispose().catch(() => {});
});

it('routes the same API to edit and Play owners and rejects unrelated run targets', async () => {
  const closeEditor = vi.fn();
  const closeGame = vi.fn();
  const target = (id: string) => ({
    targetId: id,
    sessionId: id,
    worldId: id,
    headed: true,
    width: 320,
    height: 240,
  });
  const editor: EngineWorkspacePreview = {
    target: target('editor'),
    getCamera: () => ({ camera: 'editor' }),
    close: closeEditor,
  };
  let gameTarget = target('game');
  const resizeGame = vi.fn(async ({ width, height }: { width: number; height: number }) => {
    gameTarget = { ...gameTarget, width, height };
    return gameTarget;
  });
  const game: EngineWorkspacePlay = {
    get target() {
      return gameTarget;
    },
    phase: 'running',
    ready: async () => {},
    getCamera: () => ({ camera: 'game' }),
    resize: resizeGame,
    close: closeGame,
  };
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({ project: { id: 'project', root }, handle: {} }),
    closeProject() {},
    listAssets: () => [{ guid: 'scene', kind: 'scene' }],
    openPreview: () => editor,
    startPlay: async () => game,
  });
  const api = createToolApi();
  const owner = api.registerProvider({
    sourceId: 'engine',
    providerId: 'workspace',
    realm: 'host',
    tools: createEngineWorkspaceTools(runtime),
  });
  const invoke = async (operation: string, args: Record<string, unknown>) => {
    const terminal = await api.run(`engine.${operation}`, args, { sourceId: 'engine' }).terminal;
    if (terminal.outcome === 'failed') throw new Error(JSON.stringify(terminal.failure));
    return terminal.result;
  };
  try {
    await invoke('project.open', { root: '/project' });
    await invoke('asset.open', { projectId: 'project', guid: 'scene' });
    const boundEditor = runtime.preview;
    await invoke('play.start', { projectId: 'project' });
    await invoke('play.ready', { targetId: 'game', targetGeneration: 1 });
    expect(
      await invoke('preview.resize', {
        targetId: 'game',
        targetGeneration: 1,
        width: 640,
        height: 360,
      }),
    ).toMatchObject({
      target: { targetId: 'game', width: 640, height: 360, generation: 1 },
    });
    expect(resizeGame).toHaveBeenCalledOnce();
    expect(await invoke('camera.get', { targetId: 'game', targetGeneration: 1 })).toEqual({
      camera: 'game',
    });
    await expect(
      invoke('camera.get', { targetId: 'independent-ai-run', targetGeneration: 1 }),
    ).rejects.toThrow(/mismatch/);
    await expect(
      invoke('preview.close', { targetId: 'game', targetGeneration: 1 }),
    ).rejects.toThrow(/play.stop/);
    await invoke('play.stop', { targetId: 'game', targetGeneration: 1 });
    expect(closeGame).toHaveBeenCalledOnce();
    expect(runtime.preview).toBe(boundEditor);
    expect(closeEditor).not.toHaveBeenCalled();
    await expect(invoke('camera.get', { targetId: 'game', targetGeneration: 1 })).rejects.toThrow(
      /mismatch/,
    );
  } finally {
    await owner.revoke();
    await runtime.dispose();
    await api.dispose();
  }
});

it('borrows one running World across control handoffs and tool unload, preserving game input policy', async () => {
  const world = new World();
  const camera = world
    .spawn({ component: Camera, data: {} }, { component: Transform, data: {} })
    .unwrap();
  const entity = world.spawn({ component: Name, data: { value: 'Game' } }).unwrap();
  setActiveCamera(world, camera);
  const observation = createAppObservation(world, {} as never, { report: () => ({}) });
  const source = {
    sample: vi.fn((): never => {
      throw new Error('The game must not sample during observation');
    }),
    detach: vi.fn(),
    clear: vi.fn(),
    setPointerLockAllowed: vi.fn(),
    setInputAllowed: vi.fn(),
  };
  const input = createCanvasInputBoundary(source);
  input.grantGame();
  input.game.setInputAllowed?.(false);
  const context = await createWorldContext(world);
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      const fiber = await context.plugin(engineWorkspaceTargetToolsPlugin, {
        targetId: 'game',
        observation,
        input,
      });
      await fiber.await();
      const tools = context.engineWorkspaceTargetTools;
      assert(tools);
      const target = createEngineWorkspaceAppTarget({
        app: { world, observation } as App,
        tools,
        target: {
          targetId: 'game',
          sessionId: 'play',
          worldId: world.identity,
          width: 320,
          height: 240,
          headed: true,
        },
      });
      assert(
        target.beginCameraInteraction &&
          target.setControl &&
          target.revokeConnection &&
          target.close,
      );
      const ref = `game:${world.identity}:${entity}`;
      expect(await tools.inspect({ entityId: ref })).toMatchObject({ name: 'Game' });
      expect(() => tools.inspect({ entityId: `editor:${world.identity}:${entity}` })).toThrow();
      await expect(
        target.beginCameraInteraction({
          targetId: 'game',
          clientId: 'one',
          interactionId: 'drag',
        }),
      ).rejects.toThrow(/Eject/);
      target.setControl({ targetId: 'game', mode: 'observer', connectionId: 'one' });
      source.sample.mockClear();
      input.game.sample();
      expect(source.sample).not.toHaveBeenCalled();
      expect(() =>
        target.setControl?.({ targetId: 'game', mode: 'player', connectionId: 'two' }),
      ).toThrow(/owner/);
      await target.revokeConnection({ targetId: 'game', connectionId: 'one' });
      expect(input.owner()).toBe('game');
      expect(source.setInputAllowed).toHaveBeenLastCalledWith(false);
      expect(observation.camera.get()).toMatchObject({ entity: camera, control: 'game' });
      target.setControl({ targetId: 'game', mode: 'observer', connectionId: 'one' });
      await target.close();
      await fiber.dispose();
      expect(input.owner()).toBe('game');
      expect(world.get(entity, Name).unwrap().value).toBe('Game');
      expect([...world.query({}).unwrap()]).toHaveLength(2);
    }
  } finally {
    await context.fiber.dispose();
  }
});

it('owns concurrent preview allocations without losing earlier targets or cleanup', async () => {
  const closes = [vi.fn(), vi.fn(), vi.fn()];
  let next = 0;
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({ project: { id: 'project', root }, handle: {} }),
    closeProject() {},
    listAssets: () => [],
    openPreview: ({ asset }) => {
      const index = next++;
      const close = closes[index];
      if (!close) throw new Error('Unexpected preview allocation');
      return {
        target: {
          targetId: `preview-${index}`,
          sessionId: 'session',
          worldId: `world-${index}`,
          headed: true,
          width: 320,
          height: 240,
        },
        asset,
        getCamera: () => ({ camera: index }),
        close,
      };
    },
  });
  const opened = await runtime.openProject({ root: '/project' });
  const previews = await Promise.all(
    [0, 1, 2].map((index) =>
      runtime.openPreview({
        project: opened.project,
        projectHandle: opened.handle,
        asset: { guid: String(index), kind: 'mesh' },
        width: 320,
        height: 240,
      }),
    ),
  );
  expect(runtime.previews).toEqual(previews);
  expect(runtime.preview).toBe(previews[2]);
  const [first, second] = previews;
  if (!first || !second) throw new Error('Missing allocated previews');
  await runtime.closePreview(second);
  await runtime.closePreview(second);
  expect(runtime.previews).toEqual([previews[0], previews[2]]);
  expect(await first.getCamera({ targetId: 'preview-0' })).toEqual({ camera: 0 });
  expect(closes.map((close) => close.mock.calls.length)).toEqual([0, 1, 0]);
  await runtime.closeProject(opened);
  await runtime.dispose();
  expect(runtime.previews).toEqual([]);
  expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1, 1]);
});
