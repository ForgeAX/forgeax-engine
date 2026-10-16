import { HANDLE_QUAD } from '@forgeax/engine/assets-runtime';
import type { EntityHandle } from '@forgeax/engine/ecs';
import {
  VIDEO_SOURCE_PROVIDER_KEY,
  VideoPlayer,
  type VideoSourceProvider,
} from '@forgeax/engine/graphics-extras';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { MaterialAsset, VideoAsset } from '@forgeax/engine/types';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnOrthoCamera } from './_shared/sprite';

const VIDEO_GUID = '019f2d10-0000-7000-8000-00000000b701';
const MATERIAL_GUID = '019f2d10-0000-7000-8000-00000000b702';

export default defineFeature({
  title: 'Video Texture',
  catalog: 'Video Texture',
  kind: 'visual',
  summary:
    'A VideoAsset + VideoPlayer quad samples an HTMLVideoElement handed out by the Host VideoSourceProvider resource. The element plays a live canvas.captureStream(), so whatever the source canvas paints reaches the GPU texture through the per-frame external-image copy.',
  expect:
    'ON: the large quad shows magenta/cyan vertical stripes with a white bar sweeping across. OFF: the source canvas paints yellow/blue horizontal stripes, and the quad follows within a few frames. Checks: the provider was queried and the element is playing.',
  async setup({ app, world, canvas }) {
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

    const videoGuid = AssetGuid.parse(VIDEO_GUID);
    const materialGuid = AssetGuid.parse(MATERIAL_GUID);
    if (!videoGuid.ok || !materialGuid.ok) throw new Error('guid parse failed');
    const catalogedVideo = assets.catalog<VideoAsset>(videoGuid.value, {
      kind: 'video',
      url: 'feature-lab://canvas-stream',
    });
    if (!catalogedVideo.ok) throw new Error(`catalog video: ${catalogedVideo.error.code}`);
    const clip = await assets.loadByGuid<VideoAsset>(videoGuid.value);
    if (!clip.ok) throw new Error(`loadByGuid video: ${clip.error.code}`);
    const catalogedMaterial = assets.catalog<MaterialAsset>(materialGuid.value, {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 1, 1], baseColorTexture: VIDEO_GUID },
    } as MaterialAsset);
    if (!catalogedMaterial.ok) throw new Error(`catalog material: ${catalogedMaterial.error.code}`);
    const mat = await assets.loadByGuid<MaterialAsset>(materialGuid.value);
    if (!mat.ok) throw new Error(`loadByGuid material: ${mat.error.code}`);

    spawnOrthoCamera(world, canvas);
    world
      .spawn(
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } as never },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', mat.value)] } as never,
        },
        {
          component: VideoPlayer,
          data: {
            clip: world.allocSharedRef('VideoAsset', clip.value),
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
