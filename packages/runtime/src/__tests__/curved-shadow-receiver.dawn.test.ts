import { afterAll, beforeAll, it } from 'vitest';
import {
  CURVED_SHADOW_CASES,
  CURVED_SHADOW_SIZE,
  createCurvedShadowReceiverFixture,
} from './curved-shadow-receiver.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shadowTestManifestUrl } from './shadow-test-manifest.fixture';

const manifestUrl = await shadowTestManifestUrl();
const target = offscreenCanvas(CURVED_SHADOW_SIZE);
let fixture: Awaited<ReturnType<typeof createCurvedShadowReceiverFixture>>;
beforeAll(async () => {
  fixture = await createCurvedShadowReceiverFixture(target.canvas, manifestUrl);
}, 60000);
afterAll(async () => {
  await fixture?.dispose();
  target.destroy();
});
it.each(
  CURVED_SHADOW_CASES,
)('$kind map$mapSize filter$filter $renderPath has no false occlusion', async (scene) => {
  await fixture.verify(scene);
}, 60000);
