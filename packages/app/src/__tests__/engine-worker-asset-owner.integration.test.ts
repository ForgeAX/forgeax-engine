import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle } from '@forgeax/engine-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workerSelection } from './execution-fixtures';

const state = vi.hoisted(() => ({
  assets: [] as AssetRegistry[],
  handles: [] as AssetHandle<string, { value: number }>[],
  rejectContext: false,
  rejectAssembly: false,
}));

vi.mock('@forgeax/engine-runtime/internal/renderer-host', async () => {
  const { AssetRegistry, defineAssetKind } = await import('@forgeax/engine-assets-runtime');
  const { ok } = await import('@forgeax/engine-types');
  const createAssets = () => {
    const assets = new AssetRegistry();
    const counter = defineAssetKind<{ value: number }>('worker-owner-counter');
    assets.installDecoder(counter, {
      decode: async ({ envelope }) => ok(envelope.payload),
      prepare: (value) => ok(value),
    });
    state.handles.push(assets.create(counter, { value: 1 }).unwrap());
    state.assets.push(assets);
    return assets;
  };
  return {
    createPublicationAssets: async () => createAssets(),
    constructRuntimeRendererHost: async () => {
      const assets = createAssets();
      return ok({
        assets,
        featureHost: {},
        renderer: {
          state: () => 'alive',
          subscribe: () => () => {},
          releaseSurface: () => ok(undefined),
          restoreSurface: () => ok(undefined),
          dispose: () => {
            assets.dispose();
            return ok(undefined);
          },
        },
      });
    },
  };
});
vi.mock('../assets-runtime-assembly', () => ({
  createAssetRuntimeAssembly: (registry: AssetRegistry) =>
    state.rejectAssembly
      ? { ok: false, error: new Error('injected assembly rejection') }
      : { ok: true, value: { registry, dispose() {} } },
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: async () => ({ ok: true, value: { plugins: [] } }),
  executionBootstrapHostPlugin: () => ({ name: 'owner-probe', apply() {} }),
}));
vi.mock('../renderer-plugin', () => ({ createRenderFeatureHost: () => ({}) }));
vi.mock('../internal/worker-engine-profile', () => ({
  workerEngineProfile: (options: unknown) => options,
}));
vi.mock('@forgeax/engine-ecs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-ecs')>()),
  createWorldContext: async (
    world: import('@forgeax/engine-ecs').World,
    options: {
      assets: AssetRegistry;
      renderer?: { dispose(): unknown };
    },
  ) => {
    world.bindAssets(options.assets).unwrap();
    if (state.rejectContext) throw new Error('injected context rejection');
    return {
      fiber: {
        async dispose() {
          options.renderer?.dispose();
        },
      },
    };
  },
}));
vi.mock('../execution/attached-world-swap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../execution/attached-world-swap')>()),
  commitAttachedWorld: async () => true,
}));
vi.mock('../execution/source-render-worker', () => ({
  SourceRenderWorker: class {
    preloadModule() {}
    async start() {}
    async dispose() {}
  },
}));

function readAsset(index: number) {
  const assets = state.assets[index];
  const handle = state.handles[index];
  if (assets === undefined || handle === undefined) throw new Error('Missing fixture asset owner');
  return assets.read(handle);
}

beforeEach(() => {
  vi.resetModules();
  state.assets = [];
  state.handles = [];
  state.rejectContext = false;
  state.rejectAssembly = false;
  vi.stubGlobal('postMessage', vi.fn());
  vi.stubGlobal('close', vi.fn());
  vi.stubGlobal('onmessage', undefined);
});
afterEach(() => {
  for (const assets of state.assets) assets.dispose();
  vi.unstubAllGlobals();
});

it.each([
  false,
  true,
])('keeps the live asset owner after failed candidate Context admission (split=%s)', async (split) => {
  await import('../execution/engine-worker-runtime');
  const receive = globalThis.onmessage as unknown as (event: { data: unknown }) => void;
  const post = vi.mocked(globalThis.postMessage);
  receive({
    data: {
      kind: 'init',
      canvas: { width: 1, height: 1 },
      bootstrapUrl: 'test://asset-owner',
      workers: workerSelection({ render: split, kernels: false }),
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' })),
  );
  const ready = post.mock.calls
    .map(([message]) => message)
    .find((message) => message.kind === 'ready');
  const worldIdentity = ready.worldIdentity;
  state.rejectContext = true;
  receive({ data: { kind: 'rebuild', worldIdentity, canvas: { width: 1, height: 1 } } });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'fault', source: 'rebuild' }),
    ),
  );
  expect(state.assets).toHaveLength(2);
  expect(readAsset(1).ok).toBe(false);
  expect(readAsset(0).unwrap().value).toBe(1);
  receive({
    data: {
      kind: 'inspect',
      requestId: 1,
      worldIdentity,
      code: `assets.update(${state.handles[0]}, { value: 7 }).unwrap(); return assets.read(${state.handles[0]}).unwrap().value;`,
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith({
      kind: 'inspect-result',
      requestId: 1,
      worldIdentity,
      result: { ok: true, value: 7 },
    }),
  );
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  expect(readAsset(0).ok).toBe(false);
});

it('retires a split-source Registry rejected before assembly acquires it', async () => {
  state.rejectAssembly = true;
  await import('../execution/engine-worker-runtime');
  const receive = globalThis.onmessage as unknown as (event: { data: unknown }) => void;
  const post = vi.mocked(globalThis.postMessage);
  receive({
    data: {
      kind: 'init',
      canvas: { width: 1, height: 1 },
      bootstrapUrl: 'test://asset-owner',
      workers: workerSelection({ render: true, kernels: false }),
    },
  });
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'fault', source: 'bootstrap' }),
    ),
  );
  expect(state.assets).toHaveLength(1);
  expect(readAsset(0).ok).toBe(false);
  receive({ data: { kind: 'dispose' } });
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
});
