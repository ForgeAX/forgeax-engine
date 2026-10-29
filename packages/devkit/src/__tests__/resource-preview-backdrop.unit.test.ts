import { describe, expect, it, vi } from 'vitest';
import { resourcePresentationSource } from '../host/resource-presentation-source.js';

type ComponentData = { component: string; data: Record<string, unknown> };

async function assemble(
  kind: 'mesh' | 'material',
  handles: number[],
  presentation = {},
  closeDisplay?: () => Promise<void>,
) {
  const entities: ComponentData[][] = [];
  const despawn = vi.fn((_entity: number): { ok: boolean; error?: Error } => ({ ok: true }));
  const release = vi.fn((_handle: number): { ok: boolean; error?: Error } => ({ ok: true }));
  const payload = { kind, aabb: [-1, -1, -1, 1, 1, 1], materialSlots: [] };
  const app = {
    assets: {
      release,
      load: async (guid: string) => ({ unwrap: () => (guid === 'environment' ? 1 : 2) }),
      create: () => ({ unwrap: () => 3 }),
      read: (handle: number) => ({
        unwrap: () =>
          handle === 1
            ? { kind: 'equirect', width: 1, height: 1, data: new Uint8Array(16) }
            : payload,
      }),
    },
    world: {
      despawn,
      identity: 'preview-world',
      spawn: (...components: ComponentData[]) => {
        entities.push(components);
        return { ok: true, value: entities.length };
      },
    },
  };
  const dependencies = {
    canvas: {},
    previewVfxHosts: new WeakMap(),
    prepareAssetRegistry: async () => {},
    canonicalEnvironmentGuid: 'environment',
    captureEngineWorkspaceAssetBinding: () => ({}),
    loadEngineWorkspaceMaterialSlots: async () => handles,
    createPrimitiveMesh: () => ({ unwrap: () => ({ kind: 'mesh' }) }),
    fitToolPreviewCameraToAabb: () => ({
      center: [0, 0, 0],
      radius: 1,
      near: 0.01,
      far: 10,
      distance: 3,
    }),
    createWorkspaceMeshDisplay: async () => (closeDisplay ? { close: closeDisplay } : undefined),
    createWorkspaceMaterialPreview: async () => ({ material: {}, close: async () => {} }),
    previewCameraEntities: new WeakMap(),
    previewCameraTargets: new WeakMap(),
    materialSampledTextureBudget: () => undefined,
    TONEMAP_REINHARD_EXTENDED: 1,
    ...Object.fromEntries(
      [
        'Transform',
        'MeshFilter',
        'MeshRenderer',
        'Camera',
        'DirectionalLight',
        'Skylight',
        'SkyboxBackground',
      ].map((name) => [name, name]),
    ),
  };
  const prepare = new Function(
    ...Object.keys(dependencies),
    `${resourcePresentationSource}; return prepareResourcePreview;`,
  )(...Object.values(dependencies)) as (
    app: unknown,
    resource: unknown,
    canvas: unknown,
    presentation: unknown,
  ) => Promise<{ close: () => Promise<void> }>;
  const owner = await prepare(
    app,
    { kind, guid: 'subject' },
    {},
    { evidence: false, ...presentation },
  );
  const components = entities.flat();
  return {
    owner,
    despawn,
    release,
    camera: components.find((value) => value.component === 'Camera')?.data,
    skybox: components.find((value) => value.component === 'SkyboxBackground'),
    skylight: components.find((value) => value.component === 'Skylight')?.data,
    renderer: components.find((value) => value.component === 'MeshRenderer')?.data,
  };
}

describe('native neutral mesh preview backdrop', () => {
  it('retries failed display cleanup without retiring successful resources twice', async () => {
    const closeDisplay = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('display cleanup failed'))
      .mockResolvedValue(undefined);
    const result = await assemble('mesh', [0], {}, closeDisplay);
    await expect(result.owner.close()).rejects.toThrow('display cleanup failed');
    const despawnCount = result.despawn.mock.calls.length;
    const releaseCount = result.release.mock.calls.length;
    expect(despawnCount).toBeGreaterThan(0);
    expect(releaseCount).toBeGreaterThan(0);
    await expect(result.owner.close()).resolves.toBeUndefined();
    await result.owner.close();
    expect(closeDisplay).toHaveBeenCalledTimes(2);
    expect(result.despawn).toHaveBeenCalledTimes(despawnCount);
    expect(result.release).toHaveBeenCalledTimes(releaseCount);
  });

  it('retains failed entity and asset cleanup for retry and forgets completed cleanup', async () => {
    const closeDisplay = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const result = await assemble('mesh', [0], {}, closeDisplay);
    result.despawn.mockReturnValueOnce({ ok: false, error: new Error('despawn failed') });
    result.release.mockReturnValueOnce({ ok: false, error: new Error('release failed') });
    await expect(result.owner.close()).rejects.toThrow('despawn failed');
    const failedEntity = result.despawn.mock.calls[0]?.[0];
    const failedHandle = result.release.mock.calls[0]?.[0];
    result.despawn.mockClear();
    result.release.mockClear();
    await expect(result.owner.close()).resolves.toBeUndefined();
    expect(result.despawn.mock.calls).toEqual([[failedEntity]]);
    expect(result.release.mock.calls).toEqual([[failedHandle]]);
    expect(closeDisplay).toHaveBeenCalledTimes(1);
  });

  it.each(
    [[], [0], [0, 0]].map((handles) => ({ handles })),
  )('contrasts engine-default materials $handles while retaining environment lighting', async ({
    handles,
  }) => {
    const result = await assemble('mesh', handles);
    expect(result.camera?.clearColor).toEqual([0.02, 0.02, 0.02, 1]);
    expect(result.skybox).toBeUndefined();
    expect(result.skylight).toEqual({ equirect: 1 });
    expect(result.renderer?.materials).toEqual(handles);
  });

  it.each(
    [[3], [0, 3]].map((handles) => ({ handles })),
  )('retains the canonical backdrop for authored materials $handles', async ({ handles }) => {
    const result = await assemble('mesh', handles);
    expect(result.camera?.clearColor).toBeUndefined();
    expect(result.skybox).toBeDefined();
  });

  it('preserves transparent output for an engine-default mesh', async () => {
    const result = await assemble('mesh', [0], { background: 'transparent' });
    expect(result.camera?.clearColor).toEqual([0, 0, 0, 0]);
    expect(result.skybox).toBeUndefined();
    expect(result.skylight).toEqual({ equirect: 1 });
  });

  it('retains material-preview presentation', async () => {
    const result = await assemble('material', []);
    expect(result.camera?.clearColor).toBeUndefined();
    expect(result.skybox).toBeDefined();
  });
});
