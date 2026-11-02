import { afterAll, beforeAll, it } from 'vitest';
import {
  CUBE_CONTACT_CASES,
  CUBE_CONTACT_SIZE,
  createCubePlaneShadowContactFixture,
} from './cube-plane-shadow-contact.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shadowTestManifestUrl } from './shadow-test-manifest.fixture';

const manifestUrl = await shadowTestManifestUrl();
const target = offscreenCanvas(CUBE_CONTACT_SIZE);
let fixture: Awaited<ReturnType<typeof createCubePlaneShadowContactFixture>>;
beforeAll(async () => {
  fixture = await createCubePlaneShadowContactFixture(target.canvas, manifestUrl);
}, 60000);
afterAll(async () => {
  await fixture?.dispose();
  target.destroy();
});
for (const renderPath of ['forward', 'deferred'] as const) {
  it.each(
    CUBE_CONTACT_CASES,
  )(`${renderPath} keeps $name contact dark and exposed surfaces clean`, async (scene) => {
    await fixture.verify(renderPath, scene);
  }, 60000);
}
