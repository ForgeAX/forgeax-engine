import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  VIDEO_SOURCE_PROVIDER_KEY,
  type VideoSourceProvider,
  videoSourceExtent,
} from '@forgeax/engine-graphics-extras';
import type { Handle } from '@forgeax/engine-types';
import type { RenderPublication } from './contract';

/** Native VideoFrame cloning shares decoded pixels; it never copies source ECS storage. */
export function publicationVideoFrames(
  world: World,
  consumers: ReadonlyMap<number, readonly number[]>,
): RenderPublication['videoFrames'] {
  if (consumers.size === 0 || !world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)) return [];
  const provider = world.getResource<VideoSourceProvider>(VIDEO_SOURCE_PROVIDER_KEY);
  const frames: RenderPublication['videoFrames'][number][] = [];
  try {
    for (const [entity, clips] of consumers)
      for (const clip of clips) {
        const source = provider.getSource(
          entity as EntityHandle,
          clip as Handle<'VideoAsset', 'shared'>,
        );
        if (source === undefined || videoSourceExtent(source) === undefined) continue;
        frames.push({ entity, clip, frame: new VideoFrame(source) });
      }
    return frames;
  } catch (cause) {
    for (const row of frames) row.frame.close();
    throw cause;
  }
}
