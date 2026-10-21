import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import {
  VIDEO_SOURCE_PROVIDER_KEY,
  VideoPlayer,
  type VideoSourceProvider,
} from '@forgeax/engine/graphics-extras';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnOrthoCamera } from './_shared/sprite';

export default defineFeature({
  title: 'Video Texture',
  catalog: 'Video Texture',
  kind: 'visual',
  summary:
    'A VideoAsset + VideoPlayer quad samples an HTMLVideoElement handed out by the Host VideoSourceProvider resource. The element plays a live canvas.captureStream(), so whatever the source canvas paints reaches the GPU texture through the per-frame external-image copy.',
  expect:
    'ON: the large quad shows magenta/cyan vertical stripes with a white bar sweeping across. OFF: the source canvas paints yellow/blue horizontal stripes, and the quad follows within a few frames. Checks: the provider was queried and the element is playing.',
  async setup({ app, world, canvas }) {
    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

    const assets = app.assets;
    if (assets === undefined) throw new Error('app.assets is undefined');
    const source = document.createElement('canvas');
    source.width = 256;
    source.height = 144;
    const ctx = source.getContext('2d');
    if (ctx === null) throw new Error('2d context unavailable');
    let on = true;
    let tick = 0;
    const alive = true;
    const paint = (): void => {
      if (!alive) return;
      tick++;
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = on
          ? i % 2 === 0
            ? '#ff20d0'
            : '#20e0ff'
          : i % 2 === 0
            ? '#ffe020'
            : '#2040ff';
        if (on) ctx.fillRect(i * 32, 0, 32, 144);
        else ctx.fillRect(0, i * 18, 256, 18);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect((tick * 3) % 256, 0, 10, 144);
      requestAnimationFrame(paint);
    };
    paint();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = source.captureStream(30);
    await video.play().catch(() => undefined);
    const requested = new Set<EntityHandle>();
    const provider: VideoSourceProvider = {
      getSource(entity) {
        requested.add(entity);
        return video;
      },
    };
    world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);

    const clip = assets.create({ kind: 'video', url: 'feature-lab://canvas-stream' }).unwrap();
    const mat = assets
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-unlit' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [1, 1, 1], baseColorTexture: clip },
      })
      .unwrap();

    spawnOrthoCamera(world, canvas);
    world
      .spawn(
        { component: MeshFilter, data: { assetHandle: primitiveQuad } as never },
        {
          component: MeshRenderer,
          data: { materials: [mat] } as never,
        },
        {
          component: VideoPlayer,
          data: {
            clip: clip,
            playing: true,
            loop: true,
            currentTime: 0,
          },
        },
        { component: Transform, data: { pos: [0, 0, 0], scale: [6.4, 3.6, 1] } },
      )
      .unwrap();
    return {
      toggle(next) {
        on = next;
      },
      checks(): FeatureCheck[] {
        return [
          {
            name: 'VideoSourceProvider was queried for the player entity',
            ok: requested.size === 1,
            detail: `entities=${requested.size}`,
          },
          {
            name: 'stream-backed video element is playing',
            ok: !video.paused && video.readyState >= 2,
            detail: `paused=${video.paused} readyState=${video.readyState}`,
          },
          { name: 'source canvas keeps painting', ok: tick > 10, detail: `tick=${tick}` },
        ];
      },
    };
  },
});
