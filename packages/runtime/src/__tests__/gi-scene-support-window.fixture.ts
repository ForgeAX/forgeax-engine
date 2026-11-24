import { averageFrames, SCENE_HEIGHT, SCENE_WIDTH, type SceneImage } from './gi-scenes.fixture';

/** I/O-only substitute; all aggregation stays in the actual averageFrames owner. */
export async function averageSupportImages(samples: readonly SceneImage[]) {
  let cursor = 0;
  const saved = new Map<string, Uint8Array>();
  const next = async () => {
    const image = samples[cursor++];
    if (image === undefined) throw Error('Unexpected extra scene observation');
    return image;
  };
  const io: Parameters<typeof averageFrames>[0] = {
    image: next,
    captureFrameImage: next,
    save: (name, bytes) => {
      if (!(bytes instanceof Uint8Array)) throw Error('The average must save raw image bytes');
      saved.set(name, bytes.slice());
    },
  };
  const image = await averageFrames(io, 'support-window', samples.length);
  if (cursor !== samples.length) throw Error('The actual owner did not consume every observation');
  return { image, saved };
}

export function supportImage(
  coveredPixels: readonly number[],
  support: number | undefined,
  rgb = 0,
): SceneImage {
  const covered = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT);
  for (const pixel of coveredPixels) covered[pixel] = 1;
  return {
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    rgb: new Float32Array(SCENE_WIDTH * SCENE_HEIGHT * 3).fill(rgb),
    covered,
    ...(support === undefined
      ? {}
      : { support: new Float32Array(SCENE_WIDTH * SCENE_HEIGHT).fill(support) }),
  };
}
