import { afterAll, beforeAll, it } from 'vitest';
import {
  CURVED_SHADOW_REPRESENTATIVES,
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
// Browser core witnesses every filter and both render paths through the same
// real pixel oracle. The full profile also tests every filter on both paths.
const cases =
  import.meta.env.FORGEAX_CI_CORE_VALIDATION === '1'
    ? CURVED_SHADOW_REPRESENTATIVES.filter(
        ({ filter, renderPath }) =>
          (Math.floor((filter - 1) / 2) % 2 === 0) === (renderPath === 'forward'),
      )
    : CURVED_SHADOW_REPRESENTATIVES;

it.each(
  cases,
)('$kind map$mapSize filter$filter $renderPath has no false occlusion', async (scene) => {
  await fixture.verify(scene);
}, 60000);
