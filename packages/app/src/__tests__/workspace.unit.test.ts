import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  perspective,
  SceneInstance,
} from '@forgeax/engine-render';
import { ChildOf, Children, GlobalTransform, Transform } from '@forgeax/engine-scene';
import { createToolApi } from '@forgeax/engine-tool-runtime';
import { type Asset, type AssetHandle, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createAppObservation, rotateObservationCamera } from '../observation';
import type { App } from '../types';
import {
  createEngineWorkspaceAppPreview,
  createEngineWorkspaceProvider,
  createEngineWorkspaceRuntime,
  EngineWorkspaceError,
  type EngineWorkspacePreview,
  engineWorkspacePlugin,
  inspectEngineWorkspaceAsset,
  loadEngineWorkspaceMaterialSlots,
  projectEngineWorkspaceAssets,
} from '../workspace';
import { workspaceAssetFacts } from '../workspace-asset-facts';
import { createEngineWorkspaceTools } from '../workspace-tools';
import { publishWorkspaceAssets } from './workspace-asset-fixture';

const SCENE_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fixtureApp(withCamera = true) {
  const assets = new AssetRegistry({ shaderRegistry: {} as never });
  const world = new World({ assets });
  for (const component of [Camera, SceneInstance, ChildOf, Children, GlobalTransform, Transform]) {
    world.components.register(component).unwrap();
  }
  const scene = { kind: 'scene' as const, entities: { root: { components: {} } } };
  publishWorkspaceAssets(assets, [{ guid: SCENE_GUID, asset: scene }]);
  if (withCamera) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 5] } },
        { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 16 / 9 }) },
      )
      .unwrap();
  }
  const app = {
    world,
    observation: createAppObservation(world, {} as never, { report: () => ({}) }),
  } as unknown as App;
  return { app, assets };
}

describe('Engine workspace public runtime', () => {
  it('reopens a Scene from its newly saved publication instead of the retained runtime asset', async () => {
    const { app, assets } = fixtureApp();
    app.world.components.register(DirectionalLight).unwrap();
    const saved = (intensity: number) =>
      publishWorkspaceAssets(assets, [
        {
          guid: SCENE_GUID,
          asset: {
            kind: 'scene',
            entities: {
              sun: { components: { DirectionalLight: { direction: [0, -1, 0], intensity } } },
            },
          },
        },
      ]);
    const open = () =>
      createEngineWorkspaceAppPreview({
        app,
        assets,
        asset: { guid: SCENE_GUID, kind: 'scene' },
        target: {
          targetId: 'scene',
          sessionId: 'session',
          worldId: app.world.identity,
          width: 320,
          height: 240,
          headed: true,
        },
      });
    saved(3.2);
    const first = await open();
    const retained = (await assets.load(SCENE_GUID, 'scene')).unwrap();
    await first.close?.();
    saved(1);
    const reopened = await open();
    try {
      const rows = [...app.world.query({ read: [DirectionalLight] }).unwrap()];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.get(DirectionalLight).intensity).toBe(1);
      expect(reopened.assetBinding?.publication?.digest).toBe(
        assets.catalogEntry(SCENE_GUID)?.publication?.digest,
      );
    } finally {
      await reopened.close?.();
      assets.release(retained);
      assets.dispose();
    }
  });

  it('forwards 100 draft edits without publishing full workspace state', async () => {
    const { app, assets } = fixtureApp();
    const runtime = createEngineWorkspaceRuntime(
      createEngineWorkspaceProvider({
        openProjectSession: () => ({
          project: { id: 'author', root: '/author' },
          app,
          assets,
          target: {
            targetId: 'author-target',
            sessionId: 'session',
            worldId: app.world.identity,
            headed: false,
            width: 320,
            height: 240,
          },
          authorPack: async ({ request }) => ({ closed: String(request.value) }),
        }),
      }),
    );
    await runtime.openProject({ root: '/author' });
    const changed = vi.fn();
    const api = createToolApi();
    api.registerProvider({
      providerId: 'workspace',
      sourceId: 'engine',
      realm: 'host',
      tools: createEngineWorkspaceTools(runtime, changed),
    });
    const enumerate = vi.spyOn(assets, 'enumerateCatalog').mockImplementation(() => {
      throw new Error('Edit must not enumerate Catalog');
    });
    try {
      for (let i = 0; i < 100; i++) {
        const terminal = await api.run(
          'engine.asset.source.draft',
          {
            projectId: 'author',
            request: { action: 'edit', draftId: 'draft', field: 'color', value: i },
          },
          { sourceId: 'engine' },
        ).terminal;
        expect(terminal.outcome).toBe('succeeded');
      }
      expect(changed).not.toHaveBeenCalled();
      expect(enumerate).not.toHaveBeenCalled();
    } finally {
      enumerate.mockRestore();
      await api.dispose();
      await runtime.dispose();
    }
  });

  it('inspects Material, Texture and Equirect payload facts without opening a preview', async () => {
    const assets = new AssetRegistry({});
    const payloads: Asset[] = [
      Materials.unlit([1, 0, 0, 1]),
      {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array(8),
      },
      {
        kind: 'equirect',
        width: 2,
        height: 1,
        format: 'rgba16float',
        colorSpace: 'linear',
        data: new Uint8Array(16),
      },
    ];
    for (const [index, payload] of payloads.entries()) {
      const guid = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
      publishWorkspaceAssets(assets, [{ guid, asset: payload }]);
      expect(await inspectEngineWorkspaceAsset(assets, guid)).toMatchObject({
        asset: { guid, kind: payload.kind },
        meta: { kind: payload.kind },
      });
    }
  });

  it('retries native resource cleanup after a failure and coalesces successful retirement', async () => {
    const { app, assets } = fixtureApp();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error('resource cleanup incomplete'))
      .mockResolvedValue(undefined);
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'mesh' },
      target: {
        targetId: 'retry',
        sessionId: 'session',
        worldId: app.world.identity,
        width: 320,
        height: 240,
        headed: true,
      },
      openResourcePreview: () => ({ close }),
    });
    await expect(preview.close?.()).rejects.toThrow('resource cleanup incomplete');
    expect(() => preview.getCamera({ targetId: 'retry' })).toThrow('closed');
    await preview.close?.();
    await preview.close?.();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('projects the resource owners actual binding instead of the current project asset', async () => {
    const { app, assets } = fixtureApp();
    const meta = workspaceAssetFacts(createBoxGeometry(2, 2, 2).unwrap());
    if (!meta) throw new Error('Missing mesh fixture metadata');
    const assetBinding = { meta };
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'mesh' },
      target: {
        targetId: 'bound-mesh',
        sessionId: 'session',
        worldId: app.world.identity,
        width: 320,
        height: 240,
        headed: true,
      },
      openResourcePreview: () => ({ assetBinding, close() {} }),
    });
    expect(preview).toMatchObject({ assetBinding });
    await preview.close?.();
  });

  it('preserves non-Mesh catalog inspection without requiring a payload loader', async () => {
    const assets = new AssetRegistry({ shaderRegistry: {} as never });
    const entry = {
      guid: SCENE_GUID,
      kind: 'host/blob',
      packageUrl: '/assets/blob.bin',
      sourcePath: 'assets/blob.source',
    };
    assets.setCatalogSource(createCatalogSource({ entries: [entry] }));
    const load = vi.spyOn(assets, 'load');
    expect(await inspectEngineWorkspaceAsset(assets, SCENE_GUID)).toMatchObject({
      guid: SCENE_GUID,
      asset: { kind: 'host/blob' },
      source: { path: entry.sourcePath },
    });
    expect(load).not.toHaveBeenCalled();
    await expect(
      inspectEngineWorkspaceAsset(assets, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ).rejects.toMatchObject({ code: 'asset-not-found' });
  });
  it('inspects current Mesh payload facts through the existing asset operation', async () => {
    const { app, assets } = fixtureApp();
    const guid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    publishWorkspaceAssets(assets, [{ guid, asset: createBoxGeometry(2, 3, 4).unwrap() }]);
    const project = { id: 'mesh-project', root: '/mesh-project' };
    const provider = createEngineWorkspaceProvider({
      openProjectSession: () => ({
        project,
        app,
        assets,
        target: {
          targetId: 'mesh-target',
          sessionId: 'session',
          worldId: app.world.identity,
          headed: true,
          width: 320,
          height: 240,
        },
      }),
    });
    const opened = await provider.openProject({ root: project.root });
    const inspectAsset = provider.inspectAsset;
    if (!inspectAsset) throw new Error('Concrete sessions must expose asset inspection');
    const inspect = () => inspectAsset({ project, handle: opened.handle, guid });
    expect(await inspect()).toMatchObject({
      guid,
      meta: {
        vertexCount: 24,
        indexCount: 36,
        aabb: [-1, -1.5, -2, 1, 1.5, 2],
        materialSlots: [{ slotName: 'Default' }],
      },
    });
    const handle = (await assets.load(guid, 'mesh')).unwrap();
    assets.replace(handle, createBoxGeometry(4, 3, 4).unwrap()).unwrap();
    assets.release(handle).unwrap();
    expect(await inspect()).toMatchObject({ meta: { aabb: [-2, -1.5, -2, 2, 1.5, 2] } });
    const runtimeInspection = (await inspect()) as {
      publication?: unknown;
      source?: { publication?: unknown };
    };
    publishWorkspaceAssets(assets, [{ guid, asset: createBoxGeometry(6, 3, 4).unwrap() }]);
    const currentSource = (await assets.enumerateCatalog())
      .unwrap()
      .find((entry) => String(entry.guid) === guid)?.publication;
    expect(currentSource).toBeDefined();
    expect(await inspect()).toMatchObject({
      meta: { aabb: [-2, -1.5, -2, 2, 1.5, 2] },
      publication: runtimeInspection.publication,
      source: { publication: currentSource },
    });
    const controller = new AbortController();
    controller.abort(new Error('inspection cancelled'));
    await expect(
      inspectAsset({ project, handle: opened.handle, guid, signal: controller.signal }),
    ).rejects.toThrow('inspection cancelled');
    await expect(
      inspectAsset({ project: { ...project, id: 'other' }, handle: opened.handle, guid }),
    ).rejects.toMatchObject({ code: 'engine-workspace-project-mismatch' });
    await provider.closeProject({ project, handle: opened.handle });
  });
  it('guards recovery against live, changed and concurrently replaced project targets', async () => {
    let counter = 0;
    let lost = false;
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({
        get failure() {
          return lost ? new EngineWorkspaceError('engine-workspace-page-lost', 'lost') : undefined;
        },
        project: { id: root, root },
        target: {
          targetId: `target-${++counter}`,
          sessionId: 's',
          worldId: 'w',
          headed: true,
          width: 10,
          height: 10,
        },
      }),
      closeProject() {},
      listAssets() {
        throw new Error('Liveness must not query assets');
      },
      openPreview: () => {
        throw new Error('not used');
      },
    });
    await runtime.openProject({ root: '/game', expectedTargetId: null });
    await expect(
      runtime.openProject({
        root: '/game',
        expectedTargetId: 'target-1',
        expectedTargetState: 'lost',
      }),
    ).rejects.toMatchObject({ code: 'engine-workspace-target-busy' });
    await expect(
      runtime.openProject({
        root: '/game',
        expectedTargetId: 'stale',
        expectedTargetState: 'lost',
      }),
    ).rejects.toMatchObject({ code: 'engine-workspace-target-mismatch' });
    await expect(
      runtime.openProject({ root: '/game', expectedTargetState: 'lost' }),
    ).rejects.toThrow('exact target identity');
    await expect(
      runtime.openProject({ root: '/game', expectedTargetId: null, expectedTargetState: 'lost' }),
    ).rejects.toThrow('exact target identity');
    expect(counter).toBe(1);
    lost = true;
    const attempts = await Promise.allSettled([
      runtime.openProject({
        root: '/game',
        expectedTargetId: 'target-1',
        expectedTargetState: 'lost',
      }),
      runtime.openProject({
        root: '/game',
        expectedTargetId: 'target-1',
        expectedTargetState: 'lost',
      }),
    ]);
    expect(attempts.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(counter).toBe(2);
    expect(runtime.project?.target?.targetId).toBe('target-2');
    await runtime.dispose();
  });
  it('exposes project, asset and camera operations without a View plugin or tab', async () => {
    const { app, assets } = fixtureApp();
    const runtime = createEngineWorkspaceRuntime(
      createEngineWorkspaceProvider({
        openProjectSession: ({ root }) => ({
          project: { id: root, root },
          app,
          assets,
          listAssets: () => [
            {
              guid: SCENE_GUID,
              kind: 'scene',
              sourceKey: 'scene/main',
              packageId: 'game',
              lifecycle: 'current' as const,
            },
            ...Array.from({ length: 59 }, (_, index) => ({
              guid: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}`,
              kind: 'texture',
              sourceKey: `texture/${index}`,
            })),
          ],
          target: {
            targetId: 'api-target',
            sessionId: 'session',
            worldId: app.world.identity,
            headed: false,
            width: 320,
            height: 240,
          },
        }),
      }),
    );
    const api = createToolApi();
    const owner = api.registerProvider({
      providerId: 'workspace',
      sourceId: 'engine',
      realm: 'host',
      tools: createEngineWorkspaceTools(runtime),
    });
    const invoke = async (operation: string, args: Record<string, unknown>) => {
      const terminal = await api.run(
        operation,
        {
          ...(runtime.preview ? { targetGeneration: runtime.preview.target.generation } : {}),
          ...args,
        },
        { sourceId: 'engine' },
      ).terminal;
      if (terminal.outcome === 'failed')
        throw new Error(JSON.stringify({ operation, failure: terminal.failure }));
      return terminal.result;
    };
    await invoke('engine.project.open', { root: '/api' });
    expect(await invoke('engine.assets.list', { projectId: '/api' })).toMatchObject({
      assets: expect.arrayContaining([
        expect.objectContaining({
          guid: SCENE_GUID,
          kind: 'scene',
          sourceKey: 'scene/main',
          packageId: 'game',
          lifecycle: 'current',
        }),
      ]),
    });
    expect(
      await invoke('engine.assets.search', { projectId: '/api', query: 'scene/main' }),
    ).toMatchObject({
      assets: [
        {
          guid: SCENE_GUID,
          kind: 'scene',
          packageId: 'game',
          sourceKey: 'scene/main',
          publicationState: 'current',
        },
      ],
      hasMore: false,
      nextOffset: null,
    });
    expect(await invoke('engine.assets.search', { projectId: '/api', limit: 50 })).toMatchObject({
      assets: expect.arrayContaining([
        {
          guid: SCENE_GUID,
          kind: 'scene',
          packageId: 'game',
          sourceKey: 'scene/main',
          publicationState: 'current',
        },
      ]),
      hasMore: true,
      nextOffset: 50,
    });
    expect(
      (
        (await invoke('engine.assets.search', { projectId: '/api', offset: 50, limit: 50 })) as {
          assets: unknown[];
          hasMore: boolean;
        }
      ).assets,
    ).toHaveLength(10);
    const invalidSearch = await api.run(
      'engine.assets.search',
      { projectId: '/api', limit: 51 },
      { sourceId: 'engine' },
    ).terminal;
    expect(invalidSearch.outcome).toBe('failed');
    await invoke('engine.asset.open', { projectId: '/api', guid: SCENE_GUID });
    await invoke('engine.camera.begin', {
      targetId: 'api-target',
      interactionId: 'gesture',
      clientId: 'cli',
      baseVersion: 0,
    });
    await invoke('engine.camera.commit', {
      targetId: 'api-target',
      interactionId: 'gesture',
      clientId: 'cli',
      operationId: 'commit',
      expectedVersion: 0,
    });
    expect(await invoke('engine.camera.get', { targetId: 'api-target' })).toMatchObject({
      version: 1,
    });
    const oldGeneration = runtime.preview?.target.generation;
    await invoke('engine.asset.open', { projectId: '/api', guid: SCENE_GUID });
    const stale = await api.run(
      'engine.preview.close',
      { targetId: 'api-target', targetGeneration: oldGeneration },
      { sourceId: 'engine' },
    ).terminal;
    expect(stale.outcome).toBe('failed');
    expect(runtime.preview).toBeDefined();
    const wrongProject = await api.run(
      'engine.assets.list',
      { projectId: '/other' },
      { sourceId: 'engine' },
    ).terminal;
    expect(wrongProject.outcome).toBe('failed');
    expect(runtime.project?.project.id).toBe('/api');
    await invoke('engine.project.close', { projectId: '/api' });
    await owner.revoke();
    expect(
      (await api.run('engine.workspace.get', {}, { sourceId: 'engine' }).terminal).outcome,
    ).toBe('failed');
    await runtime.dispose();
    await api.dispose();
  });

  it('fences camera transactions by trusted connection and rolls back only that connection', async () => {
    const { app, assets } = fixtureApp();
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      target: {
        targetId: 'connected-target',
        sessionId: 'session',
        worldId: app.world.identity,
        headed: true,
        width: 320,
        height: 240,
      },
    });
    const owner = {
      targetId: preview.target.targetId,
      clientId: 'shared-name',
      connectionId: 'one',
      interactionId: 'gesture',
    };
    await preview.beginCameraInteraction?.({ ...owner, baseVersion: 0 });
    await expect(
      preview.updateCameraDraft?.({
        ...owner,
        connectionId: 'two',
        camera: { position: [8, 8, 8] },
      }),
    ).rejects.toThrow('owner mismatch');
    await preview.updateCameraDraft?.({
      ...owner,
      camera: { position: [1, 2, 3], target: [0, 0, 0] },
    });
    await preview.revokeConnection?.({ targetId: owner.targetId, connectionId: 'two' });
    expect(app.observation?.camera.get()).toMatchObject({ transform: { pos: [1, 2, 3] } });
    await preview.revokeConnection?.({ targetId: owner.targetId, connectionId: 'one' });
    expect(app.observation?.camera.get()).toMatchObject({ transform: { pos: [0, 1, 5] } });
    await preview.beginCameraInteraction?.({ ...owner, baseVersion: 0 });
    const commit = { ...owner, operationId: 'commit', expectedVersion: 0 };
    const result = await preview.commitCamera?.(commit);
    await expect(preview.commitCamera?.(commit)).resolves.toEqual(result);
    await expect(preview.commitCamera?.({ ...commit, connectionId: 'two' })).rejects.toThrow(
      'missing',
    );
    await preview.close?.();
  });

  it('releases late material grants when another slot fails', async () => {
    const assets = new AssetRegistry();
    const handle = assets
      .create({
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
        values: {},
      })
      .unwrap();
    const delayed = deferred<AssetHandle<'material'>>();
    const failed = new Error('material slot failed');
    let calls = 0;
    vi.spyOn(assets, 'load').mockImplementation(async () => {
      if (++calls === 1) throw failed;
      return ok(await delayed.promise) as never;
    });
    const pending = loadEngineWorkspaceMaterialSlots(assets, [
      { slotName: 'failed', defaultMaterial: assets.parseGuid(SCENE_GUID) },
      { slotName: 'delayed', defaultMaterial: assets.parseGuid(SCENE_GUID) },
    ]);
    const settled = vi.fn();
    void pending.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    delayed.resolve(handle);
    await expect(pending).rejects.toBe(failed);
    expect(assets.validate(handle).ok).toBe(false);
    assets.dispose();
  });

  it('returns loaded material handles directly and preserves unassigned slots', async () => {
    const assets = new AssetRegistry();
    publishWorkspaceAssets(assets, [
      {
        guid: SCENE_GUID,
        asset: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
          values: {},
        },
      },
    ]);
    const handles = await loadEngineWorkspaceMaterialSlots(assets, [
      { slotName: 'first', defaultMaterial: assets.parseGuid(SCENE_GUID) },
      { slotName: 'second', defaultMaterial: assets.parseGuid(SCENE_GUID) },
      { slotName: 'default' },
    ]);
    expect(handles[0]).toBe(handles[1]);
    expect(handles[2]).toBe(0);
    expect(assets.read(handles[0] as AssetHandle<'material'>).unwrap().kind).toBe('material');
    for (const handle of handles) if (handle !== 0) assets.release(handle).unwrap();
    assets.dispose();
  });

  it('ignores a stale preview close after replacing the stable target', async () => {
    const previews: EngineWorkspacePreview[] = [];
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [],
      openPreview: ({ asset, width, height }) => {
        const preview: EngineWorkspacePreview = {
          asset,
          target: {
            targetId: 'stable-target',
            sessionId: 'session',
            worldId: 'world',
            headed: true,
            width,
            height,
          },
          getCamera: () => ({ camera: { guid: asset.guid }, version: 0 }),
          capture: () => ({ guid: asset.guid }),
          close: vi.fn(),
        };
        previews.push(preview);
        return preview;
      },
    });
    const project = await runtime.openProject({ root: '/replacement' });
    const first = await runtime.openPreview({
      project: project.project,
      asset: { guid: 'asset-a', kind: 'mesh' },
      width: 320,
      height: 240,
    });
    const replacement = await runtime.openPreview({
      project: project.project,
      asset: { guid: 'asset-b', kind: 'mesh' },
      width: 320,
      height: 240,
    });

    expect(previews[0]?.close).toHaveBeenCalledOnce();
    await runtime.closePreview(first);
    expect(previews[0]?.close).toHaveBeenCalledOnce();
    expect(await replacement.getCamera({ targetId: replacement.target.targetId })).toEqual({
      camera: { guid: 'asset-b' },
      version: 0,
    });
    expect(await replacement.capture?.({ targetId: replacement.target.targetId })).toEqual({
      guid: 'asset-b',
    });
    await runtime.closePreview(replacement);
    expect(previews[1]?.close).toHaveBeenCalledOnce();
  });

  it('retains the preview identity until asynchronous cleanup is acknowledged', async () => {
    const cleanup = deferred<void>();
    const started = deferred<void>();
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [],
      openPreview: ({ asset, width, height }) => ({
        asset,
        target: {
          targetId: 'retiring',
          sessionId: 'session',
          worldId: 'world',
          headed: false,
          width,
          height,
        },
        getCamera: () => ({ camera: {}, version: 0 }),
        capture: () => undefined,
        close: () => {
          started.resolve();
          return cleanup.promise;
        },
      }),
    });
    const project = await runtime.openProject({ root: '/retiring' });
    const preview = await runtime.openPreview({
      project: project.project,
      asset: { guid: 'mesh', kind: 'mesh' },
      width: 320,
      height: 240,
    });
    const snapshots: number[] = [];
    const api = createToolApi();
    const owner = api.registerProvider({
      providerId: 'workspace',
      sourceId: 'engine',
      realm: 'host',
      tools: createEngineWorkspaceTools(runtime, () => snapshots.push(runtime.previews.length)),
    });
    const closing = api.run(
      'engine.preview.close',
      {
        targetId: preview.target.targetId,
        targetGeneration: preview.target.generation,
      },
      { sourceId: 'engine' },
    ).terminal;
    await started.promise;
    expect(snapshots).toEqual([1]);
    expect(runtime.previews).toContain(preview);
    cleanup.resolve();
    expect((await closing).outcome).toBe('succeeded');
    expect(runtime.previews).toEqual([]);
    await owner.revoke();
    await runtime.dispose();
    await api.dispose();
  });

  it('retains a failed preview close for retry and fences late cleanup from a replacement', async () => {
    const cleanup = deferred<void>();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error('cleanup incomplete'))
      .mockImplementationOnce(() => cleanup.promise)
      .mockResolvedValue(undefined);
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [],
      openPreview: ({ asset, width, height }) => ({
        asset,
        target: {
          targetId: 'same-target',
          sessionId: 'session',
          worldId: 'world',
          headed: false,
          width,
          height,
        },
        getCamera: () => ({ camera: {} }),
        close,
      }),
    });
    const project = await runtime.openProject({ root: '/cleanup' });
    const input = {
      project: project.project,
      asset: { guid: 'mesh', kind: 'mesh' },
      width: 100,
      height: 100,
    };
    const first = await runtime.openPreview(input);
    await expect(runtime.closePreview(first)).rejects.toThrow('cleanup incomplete');
    expect(runtime.previews).toContain(first);
    const retry = runtime.closePreview(first);
    const replacement = await runtime.openPreview(input);
    cleanup.resolve();
    await retry;
    expect(runtime.previews).toEqual([replacement]);
    await runtime.closePreview(first);
    expect(runtime.previews).toEqual([replacement]);
    await runtime.dispose();
  });

  it('returns the exact opened preview when another owner becomes latest before the reply', async () => {
    let sequence = 0;
    const asset = { guid: SCENE_GUID, kind: 'mesh' };
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [asset],
      openPreview: ({ asset, width, height }) => ({
        asset,
        target: {
          targetId: `preview-${++sequence}`,
          sessionId: 'session',
          worldId: 'world',
          headed: false,
          width,
          height,
        },
        getCamera: () => ({ camera: {} }),
        close: () => undefined,
      }),
    });
    await runtime.openProject({ root: '/exact' });
    const open = runtime.openPreview.bind(runtime);
    vi.spyOn(runtime, 'openPreview').mockImplementation(async (input) => {
      const requested = await open(input);
      await open({ ...input, asset: { guid: 'other', kind: 'material' } });
      return requested;
    });
    const api = createToolApi();
    const owner = api.registerProvider({
      providerId: 'exact',
      sourceId: 'engine',
      realm: 'host',
      tools: createEngineWorkspaceTools(runtime),
    });
    try {
      const reply = await api.run<{
        preview: { target: { targetId: string }; asset: { guid: string } };
        previews: unknown[];
      }>('engine.asset.open', { projectId: '/exact', guid: SCENE_GUID }, { sourceId: 'engine' })
        .terminal;
      expect(reply.outcome).toBe('succeeded');
      if (reply.outcome !== 'succeeded') throw new Error('Expected successful asset open');
      expect(reply.result.preview.target.targetId).toBe('preview-1');
      expect(reply.result.preview.asset.guid).toBe(SCENE_GUID);
      expect(reply.result.previews).toHaveLength(2);
      expect(runtime.preview?.target.targetId).toBe('preview-2');
    } finally {
      await owner.revoke();
      await api.dispose();
      await runtime.dispose();
    }
  });

  it('rejects an old project handle without clearing the replacement owner', async () => {
    const close = vi.fn();
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root }, handle: {} }),
      closeProject: close,
      listAssets: () => [],
      openPreview: () => {
        throw new Error('unused');
      },
    });
    const first = await runtime.openProject({ root: '/same-project' });
    const replacement = await runtime.openProject({ root: '/same-project' });
    await expect(runtime.closeProject(first)).rejects.toMatchObject({
      code: 'engine-workspace-project-stale',
    });
    expect(runtime.project).toBe(replacement);
    expect(close).toHaveBeenCalledTimes(1);
    await runtime.closeProject({ project: replacement.project });
    expect(close).toHaveBeenLastCalledWith(replacement);
    expect(runtime.project).toBeUndefined();
  });

  it('owns replacement and cleanup behind one generation-fenced runtime', async () => {
    const closed: string[] = [];
    const previews: EngineWorkspacePreview[] = [];
    const runtime = createEngineWorkspaceRuntime({
      async openProject({ root }) {
        return { project: { id: root, root }, handle: { root } };
      },
      async closeProject({ project }) {
        closed.push(project.id);
      },
      listAssets: () => [],
      async openPreview({ asset, project, width, height }) {
        const preview: EngineWorkspacePreview = {
          asset,
          target: {
            targetId: `${project.id}:${asset.guid}`,
            sessionId: `session:${project.id}`,
            worldId: `world:${project.id}`,
            headed: true,
            width,
            height,
          },
          getCamera: () => ({ camera: {}, version: 0 }),
          close: vi.fn(),
        };
        previews.push(preview);
        return preview;
      },
    });
    const first = await runtime.openProject({ root: '/one' });
    await runtime.openPreview({
      project: first.project,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      width: 640,
      height: 480,
    });
    await runtime.openProject({ root: '/two' });
    expect(closed).toEqual(['/one']);
    expect(previews[0]?.close).toHaveBeenCalledOnce();
    await runtime.dispose();
    expect(closed).toEqual(['/one', '/two']);
  });

  it('closes an acquired project when cancellation wins before adoption', async () => {
    const controller = new AbortController();
    const opened = {
      project: { id: '/cancelled', root: '/cancelled' },
      handle: { resource: true },
    };
    const closed: string[] = [];
    const runtime = createEngineWorkspaceRuntime({
      openProject: () => {
        // Simulate a host allocating its session and then observing
        // cancellation before handing the handle back to the runtime.
        controller.abort(new Error('cancelled by test'));
        return opened;
      },
      closeProject: ({ project }) => {
        closed.push(project.id);
      },
      listAssets: () => [],
      openPreview: () => ({
        target: {
          targetId: 'unused-target',
          sessionId: 'unused-session',
          worldId: 'unused-world',
          headed: true,
          width: 1,
          height: 1,
        },
        getCamera: () => ({ camera: {}, version: 0 }),
      }),
    });
    const pending = runtime.openProject({ root: '/cancelled', signal: controller.signal });
    await expect(pending).rejects.toThrow('cancelled by test');
    expect(closed).toEqual(['/cancelled']);
    await runtime.dispose();
    expect(closed).toEqual(['/cancelled']);
  });

  it('clears an explicitly closed preview so runtime disposal is idempotent', async () => {
    const close = vi.fn();
    const preview: EngineWorkspacePreview = {
      target: {
        targetId: 'runtime-target',
        sessionId: 'runtime-session',
        worldId: 'runtime-world',
        headed: true,
        width: 1,
        height: 1,
      },
      getCamera: () => ({ camera: {}, version: 0 }),
      close,
    };
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [],
      openPreview: () => preview,
    });
    const project = await runtime.openProject({ root: '/runtime' });
    const opened = await runtime.openPreview({
      project: project.project,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      width: 1,
      height: 1,
    });
    await runtime.closePreview(opened);
    await runtime.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a preview acquired before an abort signal is observed', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const preview: EngineWorkspacePreview = {
      target: {
        targetId: 'aborted-target',
        sessionId: 'aborted-session',
        worldId: 'aborted-world',
        headed: true,
        width: 1,
        height: 1,
      },
      getCamera: () => ({ camera: {}, version: 0 }),
      close,
    };
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [],
      openPreview: () => {
        controller.abort(new Error('preview cancelled by test'));
        return preview;
      },
    });
    const project = await runtime.openProject({ root: '/preview-cancelled' });
    await expect(
      runtime.openPreview({
        project: project.project,
        asset: { guid: SCENE_GUID, kind: 'scene' },
        width: 1,
        height: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow('preview cancelled by test');
    expect(close).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it('loads and instantiates a real SceneAsset into an App World and delegates observation', async () => {
    const { app, assets } = fixtureApp();
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene', name: 'Main scene' },
      target: {
        targetId: 'workspace-target',
        sessionId: 'workspace-session',
        worldId: app.world.identity,
        headed: true,
        width: 640,
        height: 480,
      },
    });
    expect(preview.scene?.kind).toBe('scene');
    expect(preview.target.worldId).toBe(app.world.identity);
    expect(preview.handle).not.toHaveProperty('getCamera');
    const begun = await preview.beginCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'gesture-1',
      baseVersion: 0,
      clientId: 'view',
    });
    expect(begun).toMatchObject({ version: 0 });
    await preview.updateCameraDraft?.({
      targetId: preview.target.targetId,
      interactionId: 'gesture-1',
      clientId: 'view',
      camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0] },
    });
    await preview.abortCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'gesture-1',
      clientId: 'view',
      reason: 'test-rollback',
    });
    expect(app.observation?.camera.get()).toMatchObject({ transform: { pos: [0, 1, 5] } });
    await preview.beginCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'gesture-2',
      baseVersion: 0,
      clientId: 'view',
    });
    await preview.updateCameraDraft?.({
      targetId: preview.target.targetId,
      interactionId: 'gesture-2',
      clientId: 'view',
      camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0] },
    });
    const committed = await preview.commitCamera?.({
      targetId: preview.target.targetId,
      interactionId: 'gesture-2',
      operationId: 'commit-1',
      expectedVersion: 0,
      clientId: 'view',
    });
    expect(committed).toMatchObject({ committed: true, version: 1 });
    await expect(
      preview.commitCamera?.({
        targetId: preview.target.targetId,
        interactionId: 'gesture-2',
        operationId: 'commit-1',
        expectedVersion: 0,
        clientId: 'view',
      }),
    ).resolves.toEqual(committed);
    expect(() => preview.getCamera({ targetId: 'wrong-target' })).toThrow('target mismatch');
    await preview.close?.({ targetId: preview.target.targetId });
    expect(Array.from(app.world.query({ with: [SceneInstance] }).unwrap())).toHaveLength(0);
  });

  it('creates and releases a temporary observation camera for a camera-less SceneAsset', async () => {
    const { app, assets } = fixtureApp(false);
    expect(Array.from(app.world.query({ with: [Camera] }).unwrap())).toHaveLength(0);
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      target: {
        targetId: 'camera-less-target',
        sessionId: 'camera-less-session',
        worldId: app.world.identity,
        headed: false,
        width: 640,
        height: 480,
      },
    });

    const camera = preview.getCamera({ targetId: preview.target.targetId }) as {
      readonly camera?: {
        readonly control?: string;
        readonly transform?: { readonly pos?: readonly number[] };
      };
    };
    expect(camera.camera?.control).toBe('game');
    expect(camera.camera?.transform?.pos?.[0]).toBeCloseTo(0);
    expect(camera.camera?.transform?.pos?.[1]).toBeCloseTo(0.6);
    expect(camera.camera?.transform?.pos?.[2]).toBeCloseTo(5);
    expect(Array.from(app.world.query({ with: [Camera] }).unwrap())).toHaveLength(1);
    await preview.close?.({ targetId: preview.target.targetId });
    expect(Array.from(app.world.query({ with: [Camera] }).unwrap())).toHaveLength(0);
  });

  it('restores the pose of an already-acquired observation camera on abort', async () => {
    const { app, assets } = fixtureApp();
    const authored = app.observation?.camera.get();
    expect(authored).toMatchObject({ control: 'game', transform: { pos: [0, 1, 5] } });
    const acquired = app.observation?.camera.set({
      position: [9, 8, 7],
      target: [0, 0, 0],
      up: [0, 1, 0],
    });
    expect(acquired).toMatchObject({ control: 'observer', transform: { pos: [9, 8, 7] } });
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      target: {
        targetId: 'observer-target',
        sessionId: 'observer-session',
        worldId: app.world.identity,
        headed: true,
        width: 320,
        height: 240,
      },
    });
    await preview.beginCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'observer-gesture',
      baseVersion: 0,
      clientId: 'test',
    });
    await preview.updateCameraDraft?.({
      targetId: preview.target.targetId,
      interactionId: 'observer-gesture',
      clientId: 'test',
      camera: { position: [11, 12, 13], target: [0, 0, 0], up: [0, 1, 0] },
    });
    await preview.abortCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'observer-gesture',
      clientId: 'test',
      reason: 'test-rollback',
    });
    expect(app.observation?.camera.get()).toMatchObject({
      control: 'observer',
      transform: { pos: [9, 8, 7] },
    });
    await preview.close?.({ targetId: preview.target.targetId });
  });

  it('uses the Engine default pointer input controller when a host provides none', async () => {
    const { app, assets } = fixtureApp();
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      target: {
        targetId: 'default-input-target',
        sessionId: 'default-input-session',
        worldId: app.world.identity,
        headed: true,
        width: 320,
        height: 240,
      },
    });
    const authored = app.observation?.camera.get();
    await preview.beginCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'default-abort',
      baseVersion: 0,
      clientId: 'view',
    });
    const moved = await preview.updateCameraDraft?.({
      targetId: preview.target.targetId,
      interactionId: 'default-abort',
      clientId: 'view',
      input: { type: 'look', yaw: -0.12, pitch: 0.036 },
    });
    const movedCamera = (
      moved as { camera?: { control?: string; transform?: unknown } } | undefined
    )?.camera;
    const authoredTransform = (authored as { transform?: unknown } | undefined)?.transform;
    expect(movedCamera).toMatchObject({ control: 'observer' });
    expect(movedCamera?.transform).not.toEqual(authoredTransform);
    await preview.abortCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'default-abort',
      clientId: 'view',
      reason: 'test-rollback',
    });
    expect(app.observation?.camera.get()).toMatchObject({
      transform: { pos: [0, 1, 5] },
    });

    await preview.beginCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'default-commit',
      baseVersion: 0,
      clientId: 'view',
    });
    await preview.updateCameraDraft?.({
      targetId: preview.target.targetId,
      interactionId: 'default-commit',
      clientId: 'view',
      input: { type: 'look', yaw: 0.06, pitch: -0.024 },
    });
    await expect(
      preview.commitCamera?.({
        targetId: preview.target.targetId,
        interactionId: 'default-commit',
        operationId: 'default-commit-op',
        expectedVersion: 0,
        clientId: 'view',
      }),
    ).resolves.toMatchObject({ committed: true, version: 1 });
    expect(app.observation?.camera.get()).toMatchObject({ control: 'observer' });
    await preview.close?.({ targetId: preview.target.targetId });
  });

  it('keeps unrestricted observation rotation independent of editor pitch policy', () => {
    const rolled = quat.fromEuler(quat.create(), 0.2, 0.3, 0.4, 'YXZ');
    expect(Array.from(rotateObservationCamera(rolled, 0, 0))).toEqual(Array.from(rolled));
  });

  it('executes semantic pan, orbit and zoom and rolls back all camera state', async () => {
    const { app, assets } = fixtureApp();
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      target: {
        targetId: 'navigation',
        sessionId: 'session',
        worldId: app.world.identity,
        headed: true,
        width: 320,
        height: 240,
      },
    });
    const identity = { targetId: 'navigation', interactionId: 'gesture', clientId: 'view' };
    const read = async () =>
      (
        (await preview.getCamera(identity)) as {
          camera: {
            transform: { pos: number[]; quat: number[] };
            pivot: number[] | null;
            lens: { right: number; left: number };
          };
        }
      ).camera;
    const sample = (input: unknown) => preview.updateCameraDraft?.({ ...identity, input });
    const initial = await read();
    expect(initial.pivot).toBeNull();
    await preview.beginCameraInteraction?.({ ...identity, baseVersion: 0 });
    await sample({ type: 'pan', x: -0.02, y: 0.01, distance: 5 });
    const pan = await read();
    expect(pan.pivot?.[0]).toBeLessThan(0);
    expect(pan.transform.pos[0]).toBeCloseTo(Number(pan.pivot?.[0]));
    const radius = (state: typeof pan) =>
      Math.hypot(...state.transform.pos.map((v, i) => v - Number(state.pivot?.[i])));
    await sample({ type: 'orbit', yaw: -0.15, pitch: -0.06, pitchLimit: Math.PI / 2 - 0.01 });
    const orbit = await read();
    expect(radius(orbit)).toBeCloseTo(radius(pan));
    const [x, y, z, w] = orbit.transform.quat as [number, number, number, number];
    expect(2 * (x * y + w * z)).toBeCloseTo(0);
    await sample({ type: 'dolly', amount: -0.05 });
    expect(radius(await read())).toBeLessThan(radius(orbit));
    await preview.abortCameraInteraction?.(identity);
    expect(await read()).toEqual({ ...initial, control: 'observer', entity: expect.any(Number) });
    expect(app.observation?.camera.get()).not.toHaveProperty('pivot');

    const beforeProjectionChange = await read();
    await preview.beginCameraInteraction?.({ ...identity, baseVersion: 0 });
    await preview.updateCameraDraft?.({
      ...identity,
      camera: {
        lens: { projection: 'orthographic', left: -2, right: 2, top: 2, bottom: -2 },
      },
    });
    await sample({ type: 'dolly', amount: -0.1, distance: 5 });
    await preview.abortCameraInteraction?.(identity);
    expect(await read()).toEqual(beforeProjectionChange);

    app.observation?.camera.set({
      lens: { projection: 'orthographic', left: -2, right: 2, top: 2, bottom: -2 },
    });
    const beforeZoom = await read();
    await preview.beginCameraInteraction?.({ ...identity, baseVersion: 0 });
    await preview.updateCameraDraft?.({ ...identity, camera: { pivot: [1, 2, 3] } });
    await sample({ type: 'dolly', amount: -0.1, distance: 5 });
    expect((await read()).lens.right).toBeLessThan(2);
    await preview.abortCameraInteraction?.(identity);
    expect(await read()).toEqual(beforeZoom);
    await preview.close?.({ targetId: 'navigation' });
  });

  it('integrates semantic velocity until stopped and disposes its World system', async () => {
    vi.useFakeTimers();
    try {
      const { app, assets } = fixtureApp();
      const preview = await createEngineWorkspaceAppPreview({
        app,
        assets,
        asset: { guid: SCENE_GUID, kind: 'scene' },
        target: {
          targetId: 'held-input-target',
          sessionId: 'held-input-session',
          worldId: app.world.identity,
          headed: true,
          width: 320,
          height: 240,
        },
      });
      const initial = app.observation?.camera.get();
      await preview.beginCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'held-move',
        baseVersion: 0,
        clientId: 'view',
      });
      await preview.updateCameraDraft?.({
        targetId: preview.target.targetId,
        interactionId: 'held-move',
        clientId: 'view',
        input: { type: 'move', velocity: [0, 0, -4] },
      });
      app.world.update(0.05).unwrap();
      app.world.update(0.05).unwrap();
      const moved = app.observation?.camera.get();
      const initialPosition = (
        initial as { readonly transform?: { readonly pos?: readonly number[] } }
      ).transform?.pos;
      const movedPosition = (moved as { readonly transform?: { readonly pos?: readonly number[] } })
        .transform?.pos;
      expect(initialPosition?.[2]).toBe(5);
      expect(movedPosition?.[2]).toBeLessThan(5);

      await preview.updateCameraDraft?.({
        targetId: preview.target.targetId,
        interactionId: 'held-move',
        clientId: 'view',
        input: { type: 'move', velocity: [0, 0, 0] },
      });
      const released = app.observation?.camera.get();
      app.world.update(0.05).unwrap();
      app.world.update(0.05).unwrap();
      const releasedPosition = (
        released as { readonly transform?: { readonly pos?: readonly number[] } }
      ).transform?.pos;
      expect(app.observation?.camera.get()).toMatchObject({
        transform: { pos: releasedPosition },
      });
      await preview.commitCamera?.({
        targetId: preview.target.targetId,
        interactionId: 'held-move',
        operationId: 'held-move-commit',
        expectedVersion: 0,
        clientId: 'view',
      });
      await preview.close?.({ targetId: preview.target.targetId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears motion when commit or abort ends a camera interaction', async () => {
    vi.useFakeTimers();
    try {
      const { app, assets } = fixtureApp();
      const preview = await createEngineWorkspaceAppPreview({
        app,
        assets,
        asset: { guid: SCENE_GUID, kind: 'scene' },
        target: {
          targetId: 'held-reset-target',
          sessionId: 'held-reset-session',
          worldId: app.world.identity,
          headed: true,
          width: 320,
          height: 240,
        },
      });
      const position = (): readonly number[] => {
        const camera = app.observation?.camera.get() as {
          readonly transform?: { readonly pos?: readonly number[] };
        };
        return camera.transform?.pos ?? [];
      };
      await preview.beginCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'commit-held',
        baseVersion: 0,
        clientId: 'view',
      });
      await preview.updateCameraDraft?.({
        targetId: preview.target.targetId,
        interactionId: 'commit-held',
        clientId: 'view',
        input: { type: 'move', velocity: [0, 0, -4] },
      });
      app.world.update(0.05).unwrap();
      app.world.update(0.05).unwrap();
      const beforeCommit = position();
      expect(beforeCommit[2]).toBeLessThan(5);
      await preview.commitCamera?.({
        targetId: preview.target.targetId,
        interactionId: 'commit-held',
        operationId: 'commit-held-op',
        expectedVersion: 0,
        clientId: 'view',
      });
      const committed = position();
      await preview.beginCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'after-commit',
        baseVersion: 1,
        clientId: 'view',
      });
      app.world.update(0.05).unwrap();
      app.world.update(0.05).unwrap();
      expect(position()).toEqual(committed);
      await preview.abortCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'after-commit',
        clientId: 'view',
      });

      await preview.beginCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'abort-held',
        baseVersion: 1,
        clientId: 'view',
      });
      await preview.updateCameraDraft?.({
        targetId: preview.target.targetId,
        interactionId: 'abort-held',
        clientId: 'view',
        input: { type: 'move', velocity: [4, 0, 0] },
      });
      app.world.update(0.05).unwrap();
      app.world.update(0.05).unwrap();
      const beforeAbort = position();
      await preview.abortCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'abort-held',
        clientId: 'view',
      });
      const restored = position();
      expect(restored).not.toEqual(beforeAbort);
      await preview.beginCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'after-abort',
        baseVersion: 1,
        clientId: 'view',
      });
      app.world.update(0.05).unwrap();
      app.world.update(0.05).unwrap();
      expect(position()).toEqual(restored);
      await preview.abortCameraInteraction?.({
        targetId: preview.target.targetId,
        interactionId: 'after-abort',
        clientId: 'view',
      });
      await preview.close?.({ targetId: preview.target.targetId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects capture while a camera draft is active before invoking the host hook', async () => {
    const { app, assets } = fixtureApp();
    const capture = vi.fn(async () => ({
      targetId: 'capture-target',
      frameId: 2,
      width: 320,
      height: 240,
      png: 'data:image/png;base64,fixture',
    }));
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      target: {
        targetId: 'capture-target',
        sessionId: 'capture-session',
        worldId: app.world.identity,
        headed: true,
        width: 320,
        height: 240,
      },
      capture,
    });
    await preview.beginCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'capture-draft',
      baseVersion: 0,
      clientId: 'view',
    });
    if (preview.capture === undefined) throw new Error('capture hook was not installed');
    await expect(preview.capture({ targetId: preview.target.targetId })).rejects.toThrow('busy');
    expect(capture).not.toHaveBeenCalled();
    await preview.abortCameraInteraction?.({
      targetId: preview.target.targetId,
      interactionId: 'capture-draft',
      clientId: 'view',
    });
    await expect(preview.capture({ targetId: preview.target.targetId })).resolves.toMatchObject({
      width: 320,
      height: 240,
    });
    expect(capture).toHaveBeenCalledOnce();
    await preview.close?.({ targetId: preview.target.targetId });
  });

  it('reports preview capability for Engine-owned built-in asset owners', () => {
    const assets = projectEngineWorkspaceAssets([
      {
        guid: SCENE_GUID,
        kind: 'scene',
        sourcePath: 'scenes/main.pack.ts',
        sourceKey: 'scene/main',
      },
      { guid: 'mesh-guid', kind: 'mesh', sourcePath: 'meshes/cube.mesh' },
      { guid: 'effect-guid', kind: 'particle-effect', sourcePath: 'effects/particles.pack.json' },
    ] as never);
    expect(assets).toEqual([
      expect.objectContaining({
        guid: SCENE_GUID,
        kind: 'scene',
        sourceKey: 'scene/main',
        previewable: true,
      }),
      expect.objectContaining({ guid: 'mesh-guid', kind: 'mesh', previewable: true }),
      expect.objectContaining({ guid: 'effect-guid', kind: 'vfx', previewable: true }),
    ]);
    expect(assets[1]).not.toHaveProperty('sourceKey');
  });

  it('keeps non-scene resources in the same App and World through the common preview seam', async () => {
    const { app, assets } = fixtureApp();
    const target = {
      targetId: 'resource-target',
      sessionId: 'resource-session',
      worldId: app.world.identity,
      headed: true as const,
      width: 320,
      height: 240,
    };
    const close = vi.fn();
    const openResourcePreview = vi.fn((input) => {
      expect(input.app).toBe(app);
      expect(input.assets).toBe(assets);
      expect(input.target).toBe(target);
      return { close };
    });
    const preview = await createEngineWorkspaceAppPreview({
      app,
      assets,
      asset: { guid: 'mesh-guid', kind: 'mesh' },
      target,
      openResourcePreview,
    });
    expect(openResourcePreview).toHaveBeenCalledOnce();
    expect(preview.scene).toBeUndefined();
    expect(preview.handle).toMatchObject({ app, world: app.world });
    await preview.close?.({ targetId: target.targetId });
    expect(close).toHaveBeenCalledOnce();
  });

  it('connects a concrete App/AssetRegistry/headed target session through the public provider', async () => {
    const { app, assets } = fixtureApp();
    const project = { id: '/project', root: '/project' };
    const target = {
      targetId: 'session-target',
      sessionId: 'session',
      worldId: app.world.identity,
      headed: true as const,
      width: 640,
      height: 480,
    };
    const provider = createEngineWorkspaceProvider({
      openProjectSession: () => ({
        project,
        app,
        assets,
        target,
        listAssets: () => [{ guid: SCENE_GUID, kind: 'scene' }],
      }),
    });
    const opened = await provider.openProject({ root: project.root });
    expect(await provider.listAssets({ project, handle: opened.handle })).toEqual([
      expect.objectContaining({ guid: SCENE_GUID, kind: 'scene' }),
    ]);
    const preview = await provider.openPreview({
      project,
      projectHandle: opened.handle,
      asset: { guid: SCENE_GUID, kind: 'scene' },
      width: 320,
      height: 240,
    });
    expect(preview.target).toMatchObject({ targetId: target.targetId, width: 320, height: 240 });
    await preview.close?.({ targetId: target.targetId });
    await provider.closeProject({ project, handle: opened.handle });
  });

  it('delegates non-scene preview kinds to the project session capability', async () => {
    const { app, assets } = fixtureApp();
    const project = { id: '/project', root: '/project' };
    const target = {
      targetId: 'mesh-target',
      sessionId: 'mesh-session',
      worldId: app.world.identity,
      headed: true as const,
      width: 640,
      height: 480,
    };
    const preview: EngineWorkspacePreview = {
      target,
      getCamera: () => ({ camera: {}, version: 0 }),
    };
    const openPreview = vi.fn(() => preview);
    const provider = createEngineWorkspaceProvider({
      openProjectSession: () => ({ project, app, assets, target, openPreview }),
    });
    const opened = await provider.openProject({ root: project.root });
    const result = await provider.openPreview({
      project,
      projectHandle: opened.handle,
      asset: { guid: 'mesh-guid', kind: 'mesh' },
      width: 320,
      height: 240,
    });
    expect(result).toBe(preview);
    expect(openPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: { guid: 'mesh-guid', kind: 'mesh' },
        width: 320,
        height: 240,
      }),
    );
  });

  it('projects the actual session World after browser readiness replaces the pending target', async () => {
    let target = {
      targetId: 'target',
      sessionId: 'session',
      worldId: 'pending:session',
      headed: true,
      width: 640,
      height: 480,
    };
    const provider = createEngineWorkspaceProvider({
      openProjectSession: () => ({
        project: { id: '/project', root: '/project' },
        get target() {
          return target;
        },
        listAssets: () => [],
      }),
    });
    const runtime = createEngineWorkspaceRuntime(provider);
    await runtime.openProject({ root: '/project' });
    expect(runtime.project?.target?.worldId).toBe('pending:session');
    target = { ...target, worldId: 'actual-world' };
    expect(runtime.project?.target?.worldId).toBe('actual-world');
    await runtime.dispose();
  });

  it('retains project identity and propagates incomplete cleanup through close, replacement and repeated disposal', async () => {
    const failure = new Error('native cleanup incomplete');
    let sequence = 0;
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root }, handle: ++sequence }),
      closeProject: () => {
        throw failure;
      },
      listAssets: () => [],
      openPreview: () => {
        throw new Error('unused');
      },
    });
    const opened = await runtime.openProject({ root: '/project' });
    await expect(runtime.closeProject(opened)).rejects.toBe(failure);
    expect(runtime.project).toBe(opened);
    await expect(runtime.openProject({ root: '/replacement' })).rejects.toThrow(
      'Workspace replacement cleanup failed',
    );
    expect(runtime.project).toBe(opened);
    await expect(runtime.dispose()).rejects.toBe(failure);
    await expect(runtime.dispose()).rejects.toBe(failure);
    expect(runtime.project).toBe(opened);
  });

  it('reports unconfirmed retirement while allowing the existing exact lost-target reopen', async () => {
    let failure = new EngineWorkspaceError(
      'engine-workspace-page-lost',
      'The target connection was lost',
    );
    let generation = 0;
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => {
        const current = ++generation;
        return {
          project: { id: root, root },
          handle: current,
          target: {
            targetId: `target-${current}`,
            sessionId: `session-${current}`,
            worldId: `world-${current}`,
            width: 1,
            height: 1,
            headed: true,
          },
          get failure() {
            return current === 1 ? failure : undefined;
          },
        };
      },
      closeProject: ({ handle }) => {
        if (handle === 1)
          failure = new EngineWorkspaceError(
            'engine-workspace-page-lost',
            'Retired connection',
            'Cleanup is unconfirmed',
            {
              targetId: 'target-1',
              sessionId: 'session-1',
              cleanup: 'unconfirmed',
              reason: 'transport-lost',
            },
          );
      },
      listAssets: () => [],
      openPreview: () => {
        throw new Error('unused');
      },
    });
    const api = createToolApi();
    api.registerProvider({
      providerId: 'workspace',
      sourceId: 'engine',
      realm: 'host',
      tools: createEngineWorkspaceTools(runtime),
    });
    try {
      await runtime.openProject({ root: '/project' });
      const result = await api.run(
        'engine.project.open',
        { root: '/project', expectedTargetId: 'target-1', expectedTargetState: 'lost' },
        { sourceId: 'engine' },
      ).terminal;
      expect(result).toMatchObject({
        outcome: 'succeeded',
        result: {
          projectTarget: { targetId: 'target-2' },
          retiredTarget: { targetId: 'target-1', cleanup: 'unconfirmed', reason: 'transport-lost' },
        },
      });
    } finally {
      await api.dispose();
      await runtime.dispose();
    }
  });

  it('exposes the runtime through the Engine-owned Cordis plugin seam', () => {
    const runtime = createEngineWorkspaceRuntime({
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject: () => undefined,
      listAssets: () => [],
      openPreview: () => ({
        target: {
          targetId: 'target',
          sessionId: 'session',
          worldId: 'world',
          headed: true,
          width: 1,
          height: 1,
        },
        getCamera: () => ({ camera: {}, version: 0 }),
      }),
    });
    const plugin = engineWorkspacePlugin(runtime);
    expect(plugin.name).toBe('forgeax:engine-workspace');
    expect(plugin.provide).toContain('engineWorkspace');
  });
});

it('refuses assets without a preview owner before allocating a browser App', async () => {
  const openPreview = vi.fn(() => {
    throw new Error('no preview should be allocated');
  });
  const runtime = createEngineWorkspaceRuntime({
    openProject: ({ root }) => ({ project: { id: root, root }, handle: root }),
    closeProject: () => {},
    listAssets: () => [{ guid: SCENE_GUID, kind: 'ui', previewable: false }],
    openPreview,
  });
  const api = createToolApi();
  const provider = api.registerProvider({
    providerId: 'preview-admission',
    sourceId: 'engine',
    realm: 'host',
    tools: createEngineWorkspaceTools(runtime),
  });
  try {
    await runtime.openProject({ root: '/ui' });
    const result = await api.run(
      'engine.asset.open',
      { projectId: '/ui', guid: SCENE_GUID },
      { sourceId: 'engine' },
    ).terminal;
    expect(result).toMatchObject({
      outcome: 'failed',
      failure: { expected: 'A preview owner for asset kind ui' },
    });
    expect(openPreview).not.toHaveBeenCalled();
  } finally {
    await provider.revoke();
    await runtime.dispose();
  }
});
