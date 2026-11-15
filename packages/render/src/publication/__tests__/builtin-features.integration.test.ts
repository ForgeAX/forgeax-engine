import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { WATER_SYSTEM_RESOURCE, WaterSystem } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { abortFeatureFrame, prepareFeatureFrame } from '../../__tests__/feature-frame-driver';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../../cloud/contracts';
import { BarrelDistortion, MotionBlur } from '../../components';
import { Camera } from '../../components/camera';
import { CameraView } from '../../components/camera-view';
import { withBuiltinRenderFeatures } from '../../features/builtins';
import { createRenderFeatureHost } from '../../features/host';
import { resolveStandardRenderFeatureTargets } from '../../features/targets';
import type { RenderFeature, RenderFeatureExtractContext } from '../../features/types';
import { renderFeatureViewIdentity } from '../../features/view';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { renderPublicationTransfers } from '../record';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

it.each([
  false,
  true,
])('extracts the builtin roster once and plans without a receiver World (active=%s)', async (active) => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  world.insertResource(WATER_SYSTEM_RESOURCE, new WaterSystem(() => undefined));
  for (let index = 0; index < 2; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [index, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
        { component: CameraView, data: { viewport: [index / 2, 0, 0.5, 1] } },
        ...(active
          ? [
              { component: BarrelDistortion, data: { strength: 0.2 } },
              { component: MotionBlur, data: {} },
            ]
          : []),
      )
      .unwrap();
  const caps = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps;
  let extracted = 0;
  const roster = withBuiltinRenderFeatures([], caps);
  const sources: RenderFeature<unknown>[] = roster.map((feature) => ({
    ...feature,
    ...(feature.source === undefined
      ? {}
      : {
          source: {
            ...feature.source,
            extract(context: RenderFeatureExtractContext) {
              expect(context.world).toBe(world);
              expect(context.views).toHaveLength(2);
              extracted++;
              return requiredFixtureValue(feature.source).extract(context);
            },
          },
        }),
    extract(context: RenderFeatureExtractContext) {
      expect(context.world).toBe(world);
      expect(context.views).toHaveLength(2);
      extracted++;
      return feature.extract(context);
    },
  }));
  const identity = { source: 'builtin-source-roster', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, caps, sources);
  const receiver = new RenderPublicationReceiver(identity);
  let receiverReads = 0;
  const host = createRenderFeatureHost(
    roster.map((feature) => ({
      ...feature,
      extract() {
        receiverReads++;
        throw new Error('A receiver must consume the published source input');
      },
    })),
  ).unwrap();
  try {
    world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(1 / 60).unwrap();
    const message = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(message).unwrap();
    expect(extracted).toBe(roster.length);
    const published = accepted.packet.features.map((feature) => feature.identity);
    expect(published).not.toContain('forgeax.editor-assistance');
    expect(published).not.toContain(CLOUD_LAYER_FEATURE_IDENTITY);
    for (const feature of roster.filter((feature) => feature.identity.startsWith('water-')))
      expect(published).toContain(feature.identity);
    expect(published.includes('fullscreen.forgeax.barrel-distortion')).toBe(active);
    expect(published.includes('forgeax.motion-blur')).toBe(active);
    expect(
      accepted.packet.features.find((feature) => feature.identity === 'water-info-producer')?.data,
    ).toMatchObject({ kind: 'forgeax-water-info-input', version: 6 });
    const targets = resolveStandardRenderFeatureTargets({
      tonemap: 'aces',
      antialias: 'none',
      storageBuffer: caps.storageBuffer,
      multisample: true,
      colorAttachmentFormat: 'rgba8unorm',
    });
    const frame = prepareFeatureFrame(
      host,
      accepted.frame.cameras.map((camera) => ({
        identity: renderFeatureViewIdentity(camera),
        render: true,
        world: undefined,
        publishedFeatures: accepted.packet.features,
        frameNumber: 1,
        caps,
        targets,
        frameSize: { width: 32, height: 32 },
      })),
    );
    expect(frame.frame.errors).toEqual([]);
    expect(receiverReads).toBe(0);
    expect(extracted).toBe(roster.length);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
    receiver.dispose();
    publisher.dispose();
    assets.dispose();
  }
});

it('omits inactive Water rows while the unchanged roster plans without a receiver World', async () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  const caps = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps;
  const roster = withBuiltinRenderFeatures([], caps);
  const identity = { source: 'inactive-water-roster', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, caps);
  const receiver = new RenderPublicationReceiver(identity);
  const host = createRenderFeatureHost(
    roster.map((feature) => ({
      ...feature,
      extract() {
        throw new Error('The receiver must use the feature-owned inactive value');
      },
    })),
  ).unwrap();
  try {
    const candidate = publisher.prepare(1 / 60).unwrap();
    const message = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(message).unwrap();
    expect(roster.filter((feature) => feature.identity.startsWith('water-'))).toHaveLength(5);
    expect(accepted.packet.features).toEqual([]);
    const targets = resolveStandardRenderFeatureTargets({
      tonemap: 'aces',
      antialias: 'none',
      storageBuffer: caps.storageBuffer,
      multisample: true,
      colorAttachmentFormat: 'rgba8unorm',
    });
    const frame = prepareFeatureFrame(
      host,
      accepted.frame.cameras.map((camera) => ({
        identity: renderFeatureViewIdentity(camera),
        render: true,
        world: undefined,
        publishedFeatures: accepted.packet.features,
        frameNumber: 1,
        caps,
        targets,
        frameSize: { width: 32, height: 32 },
      })),
    );
    expect(frame.frame.errors).toEqual([]);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
    receiver.dispose();
    publisher.dispose();
    assets.dispose();
  }
});
