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
it.each(
  CURVED_SHADOW_CASES,
)('$kind map$mapSize filter$filter $renderPath has no false occlusion', async (scene) => {
  await fixture.verify(scene);
}, 60000);
