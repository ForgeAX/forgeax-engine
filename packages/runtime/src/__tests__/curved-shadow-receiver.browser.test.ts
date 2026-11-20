import { afterAll, beforeAll, it } from 'vitest';
import {
  CURVED_SHADOW_CASES,
  CURVED_SHADOW_SIZE,
  createCurvedShadowReceiverFixture,
} from './curved-shadow-receiver.fixture';

const canvas = document.createElement('canvas');
canvas.width = canvas.height = CURVED_SHADOW_SIZE;
let fixture: Awaited<ReturnType<typeof createCurvedShadowReceiverFixture>>;
beforeAll(async () => {
  document.body.append(canvas);
  fixture = await createCurvedShadowReceiverFixture(canvas, '/shaders/manifest.json');
}, 60000);
afterAll(async () => {
  await fixture?.dispose();
  canvas.remove();
});
// Each filter still runs through both render paths. Vary mesh and shadow-map
// size across those checks instead of rasterizing all four permutations.
const cases = CURVED_SHADOW_CASES.filter(({ kind, mapSize, filter, renderPath }) => {
  const even = filter % 2 === 0;
  const forward = renderPath === 'forward';
  const large = filter % 4 < 2;
  return (
    kind === (even === forward ? 'wave' : 'fold') && mapSize === (large === forward ? 2048 : 512)
  );
});

it.each(
  cases,
)('$kind map$mapSize filter$filter $renderPath has no false occlusion', async (scene) => {
  await fixture.verify(scene);
}, 60000);
