import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  rhi as nullRhi,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
} from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { standardPbrManifestRow } from '../../__tests__/shader-manifest-fixture';
import { Camera, perspective } from '../../components/camera';
import { constructRendererHost } from '../../construct-renderer';
import type { RenderFeature } from '../../features/types';
import { createRenderPublisher } from '../publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';

type LostInfo = { readonly reason: 'unknown'; readonly message: string };
class RecoverableDevice extends RhiNullDevice {
  readonly loss: {
    readonly promise: Promise<LostInfo>;
    readonly resolve: (info: LostInfo) => void;
  };
  constructor() {
    let resolveLoss!: (info: LostInfo) => void;
    const promise = new Promise<LostInfo>((resolve) => {
      resolveLoss = resolve;
    });
    super(
      new RhiNullQueue(),
      (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
    );
    this.loss = { promise, resolve: resolveLoss };
  }
  override get lost() {
    return this.loss.promise;
  }
}

it('recovers without replaying submitted feature data and plans the next publication cold', async () => {
  const devices: RecoverableDevice[] = [];
  const backend = {
    ...nullRhi,
    requestAdapter: async () =>
      ok({
        features: new Set<GPUFeatureName>(),
        limits: {},
        requestDevice: async () => {
          const device = new RecoverableDevice();
          devices.push(device);
          return ok(device);
        },
      }),
  };
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 1 }) },
    )
    .unwrap();
  const handle = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const asset = runtimeAssets(assets).resolveAsset<MeshAsset>(handle).unwrap();
  const seen: unknown[] = [];
  const plannedGenerations: number[] = [];
  let receiverExtracts = 0;
  let submitted = 0;
  let marker = 1;
  const source: RenderFeature<{ handle: typeof handle; marker: number }> = {
    identity: 'published-exact-asset',
    extract: () => ok({ handle, marker }),
    assetDependencies: () => [handle],
    plan: () => ok({ work: [] }),
  };
  const consumer: RenderFeature<{ handle: typeof handle; marker: number }> = {
    identity: source.identity,
    shaderModuleMode: 'immediate',
    onFrameSubmitted: () => {
      submitted++;
    },
    extract: () => {
      receiverExtracts++;
      return ok({ handle, marker });
    },
    plan: (data, context) => {
      plannedGenerations.push(context.generation);
      const resolved = context.resolveAsset?.(0, data.handle);
      if (resolved === undefined || !resolved.ok) throw new Error('Missing exact published asset');
      expect(resolved.value).toEqual(asset);
      seen.push(data);
      return ok({
        work: [
          {
            scope: 'frame',
            resources: [
              {
                kind: 'compute-program',
                name: 'program',
                program: {
                  wgsl: '@compute @workgroup_size(1) fn main() {}',
                  entryPoints: ['main'],
                  bindings: [{ entries: [] }],
                },
              },
              { kind: 'compute-bindings', name: 'bindings', program: 'program', entries: [] },
            ],
            passes: [
              {
                kind: 'compute',
                name: 'simulate',
                program: 'program',
                bindings: 'bindings',
                dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
              },
            ],
          },
        ],
      });
    },
  };
  const identity = { source: 'feature-recovery', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [source]);
  const canvas = {
    width: 4,
    height: 4,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const shaderManifestUrl = `data:application/json,${encodeURIComponent(
    JSON.stringify({
      entries: [
        { hash: 'pbr', wgsl: 'f_schlick', glsl: '', bindings: '' },
        { hash: 'unlit', wgsl: 'unlit', glsl: '', bindings: '' },
        { hash: 'tonemap', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
      ],
      materialShaders: [standardPbrManifestRow('f_schlick')],
    }),
  )}`;
  const created = await constructRendererHost(
    canvas,
    { rhi: backend, publicationSource: identity, features: [consumer] },
    { shaderManifestUrl },
  );
  if (!created.ok) throw created.error;
  const { renderer } = created.value;
  try {
    world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const drawn = renderer.draw({ publication: encodeRenderPublication(packet) });
    if (!drawn.ok) throw drawn.error;
    const frame = drawn.value;
    expect((await frame.completed).ok).toBe(true);
    expect(frame.presentation).toBe('ready');
    expect(seen).toHaveLength(1);
    expect(receiverExtracts).toBe(0);
    expect(submitted).toBe(1);
    marker = 2;
    const successor = publisher.prepare(0).unwrap();
    const unsubmitted = structuredClone(successor.packet, {
      transfer: renderPublicationTransfers(successor.message),
    });
    successor.accept();
    expect(unsubmitted.features[0]?.data).toMatchObject({ marker: 2 });
    const device = devices[0];
    if (device === undefined) throw new Error('Missing initial device');
    device.loss.resolve({ reason: 'unknown', message: 'published feature recovery test' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.state()).toBe('device-lost');
    const recovered = await renderer.recover();
    expect(receiverExtracts).toBe(0);
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(devices).toHaveLength(2);
    expect(submitted).toBe(1);
    const next = renderer.draw({ publication: encodeRenderPublication(unsubmitted) });
    if (!next.ok) throw next.error;
    expect((await next.value.completed).ok).toBe(true);
    expect(receiverExtracts).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(unsubmitted.features[0]?.data);
    expect(plannedGenerations).toEqual([0, 1]);
    expect(submitted).toBe(2);
    expect(
      devices[1]?.bookkeeper.allRecords().some((record) => record.kind === 'ComputePipeline'),
    ).toBe(true);
  } finally {
    renderer.dispose();
    publisher.dispose();
  }
});
