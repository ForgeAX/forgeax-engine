import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareBootstrapEntry } from '../execution/bootstrap-entry';
import { ssrIdentityFixture, workerSelection } from './execution-fixtures';

const mocks = vi.hoisted(() => ({ construct: vi.fn(), dispose: vi.fn() }));
vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: (...args: unknown[]) => {
    mocks.construct(...args);
    return Promise.resolve({
      ok: true,
      value: {
        renderer: {
          state: () => 'alive',
          inspect: () => ({ capabilities: {}, frame: { frameId: 0, deviceGeneration: 0 } }),
          dispose: mocks.dispose,
          subscribe: () => () => {},
        },
        assets: {},
        featureHost: {},
      },
    });
  },
}));
vi.mock('../assets-runtime-assembly', () => ({
  createAssetRuntimeAssembly: () => ({ ok: true, value: { registry: {}, dispose() {} } }),
}));
vi.mock('../renderer-plugin', () => ({ createRenderFeatureHost: () => ({}) }));
vi.mock('../internal/worker-engine-profile', () => ({ workerEngineProfile: () => ({}) }));
vi.mock('../execution/attached-world-swap', () => ({
  commitAttachedWorld: async () => true,
  SerializedRebuildQueue: class {
    enqueue<T>(job: () => Promise<T>): Promise<T> {
      return job();
    }
  },
}));
vi.mock('@forgeax/engine-ecs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-ecs')>()),
  createWorldContext: async () => ({ fiber: { async dispose() {} } }),
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['engine', false],
  ['engine', true],
  ['render', false],
  ['render', true],
] as const)('constructs the %s Worker Renderer with optional validated SSR identity: %s', async (owner, provided) => {
  const post = vi.fn();
  const close = vi.fn();
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal('close', close);
  vi.stubGlobal('onmessage', undefined);
  const bootstrapUrl = `data:text/javascript,${encodeURIComponent(`
    const identity=${JSON.stringify(ssrIdentityFixture)};
    export default () => (${provided ? '{ssrIdentity:identity}' : '{}'});
  `)}`;
  const prepared = await prepareBootstrapEntry(bootstrapUrl, undefined);
  if (!prepared.ok) throw prepared.error;
  if (owner === 'engine') await import('../execution/engine-worker-runtime');
  else await import('../execution/render-worker-runtime');
  const receive = globalThis.onmessage as unknown as (event: { data: unknown }) => void;
  receive({
    data: {
      kind: 'init',
      canvas: { width: 64, height: 64 },
      bootstrapUrl,
      ...(owner === 'engine'
        ? { workers: workerSelection({ render: false, kernels: false }) }
        : {
            identity: { source: 'fixture-publication', epoch: 1 },
            worldIdentity: 'fixture-world',
          }),
    },
  });
  try {
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' })),
    );
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    const options = mocks.construct.mock.calls[0]?.[1] as Record<string, unknown>;
    if (provided) expect(options.ssrIdentity).toBe(prepared.value.ssrIdentity);
    else expect(options).not.toHaveProperty('ssrIdentity');
  } finally {
    receive({ data: { kind: 'dispose' } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ kind: 'disposed' }));
  }
  expect(close).toHaveBeenCalledTimes(1);
});
