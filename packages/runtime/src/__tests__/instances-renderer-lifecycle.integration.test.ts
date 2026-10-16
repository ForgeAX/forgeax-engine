import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, Instances, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { standardPbrManifestRow } from '../../../render/src/__tests__/shader-manifest-fixture';
import { constructRendererHost } from '../../../render/src/construct-renderer';

function requireValue<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      { hash: 'pbr00000', wgsl: 'f_schlick(', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: 'unlit', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::default-unlit',
        sourcePath: 'unlit.wgsl',
        composedWgsl: '/* null backend shader */',
        paramSchema: '[]',
        variants: [],
      },
      standardPbrManifestRow('f_schlick('),
    ],
  }),
)}`;
function canvas(): HTMLCanvasElement {
  return { width: 32, height: 32, getContext: () => null } as unknown as HTMLCanvasElement;
}
function matrices(x: number, count = 1): Float32Array {
  const result = new Float32Array(16 * count);
  for (let i = 0; i < count; i++)
    result.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1], i * 16);
  return result;
}

// Coverage instrumentation plus a contended heavy runner can make the
// 20,000-instance recovery case exceed the normal one-minute budget even
// though the operation remains bounded and completes quickly uninstrumented.
it.each([
  1, 129, 20000,
])('renders %i World instances after replacing and recovering the Renderer', async (count) => {
  const adapter = new RhiNullAdapter();
  const device = (await adapter.requestDevice()).unwrap();
  const replacementDevice = (await adapter.requestDevice()).unwrap();
  const replacement = new Proxy(replacementDevice, {
    get(target, property) {
      if (property === 'caps' && count < 20000)
        return { ...target.caps, storageBuffer: false, compute: false };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let lose!: (reason: unknown) => void;
  const lost = new Promise<never>((_, reject) => {
    lose = reject;
  });
  const first = new Proxy(device, {
    get(target, property) {
      if (property === 'lost') return lost;
      if (property === 'caps' && count < 20000)
        return { ...target.caps, storageBuffer: false, compute: false };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let requests = 0;
  const recoverable = {
    // Recorder-wrapped backends expose only the asynchronous shader factory.
    acquireCanvasContext: rhi.acquireCanvasContext,
    createShaderModule: rhi.createShaderModule,
    requestAdapter: async () =>
      ok({
        features: adapter.features,
        limits: adapter.limits,
        requestDevice: async () => ok(++requests === 1 ? first : replacement),
      } as never),
  } as never;
  const world = new World();
  const material = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 0, 0] },
  });
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: Instances, data: { transforms: matrices(0, count) } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const a = requireValue(
    await constructRendererHost(canvas(), { rhi }, { shaderManifestUrl: manifest }),
  ).renderer;
  const b = requireValue(
    await constructRendererHost(canvas(), { rhi: recoverable }, { shaderManifestUrl: manifest }),
  ).renderer;
  const la = requireValue(a.attach(world));
  const lb = requireValue(b.attach(world));
  const ra = { leases: [la], camera: { lease: la }, environment: { lease: la } };
  const rb = { leases: [lb], camera: { lease: lb }, environment: { lease: lb } };
  world.update(0).unwrap();
  requireValue(a.draw(ra));
  requireValue(b.draw(rb));
  expect(a.inspect().instanceCollections[0]?.count).toBe(count);
  expect(b.inspect().instanceCollections[0]?.count).toBe(count);
  expect(b.inspect().instanceCollections[0]?.uploadedBytes).toBeGreaterThan(0);
  requireValue(b.draw(rb));
  expect(b.inspect().instanceCollections[0]?.uploadedBytes).toBe(0);
  const firstRevision = b.inspect().instanceCollections[0]?.revision;
  world.set(entity, Instances, { transforms: matrices(0.25, count) }).unwrap();
  requireValue(a.draw(ra));
  world.set(entity, Instances, { transforms: matrices(0.5, count) }).unwrap();
  requireValue(a.draw(ra));
  await a.dispose();
  expect(world.get(entity, Instances).unwrap().transforms[12]).toBe(0.5);
  requireValue(b.draw(rb));
  expect(b.inspect().instanceCollections[0]?.revision).toBeGreaterThan(firstRevision ?? 0);
  lose({ reason: 'unknown', message: 'instance recovery regression' });
  await Promise.resolve();
  await Promise.resolve();
  expect(b.state()).toBe('device-lost');
  const finalX = count === 129 ? 0.75 : 0.5;
  if (count === 129) world.set(entity, Instances, { transforms: matrices(finalX, count) }).unwrap();
  const recovered = await b.recover();
  expect(recovered.ok, recovered.ok ? '' : JSON.stringify(recovered.error)).toBe(true);
  requireValue(b.draw(rb));
  expect(b.inspect().instanceCollections[0]?.uploadedBytes).toBe(count === 129 ? count * 64 : 0);
  expect(b.inspect().recoveryEvidence.submissions.lastGeneration).toBe(1);
  expect(b.inspect().frame.deviceGeneration).toBe(1);
  // The GPU-driven primary lane owns no legacy instance buffer; its published
  // device generation is evidenced by the submitted frame above.
  if (count < 20000) expect(b.inspect().instanceCollections[0]?.residentGeneration).toBe(1);
  const retained = world.get(entity, Instances).unwrap().transforms;
  expect(retained.length).toBe(count * 16);
  expect(retained[12]).toBe(finalX);
  expect(retained[(count - 1) * 16 + 12]).toBe(finalX);
  expect(b.inspect().instanceCollections[0]?.count).toBe(count);
  await b.dispose();
}, 120_000);
