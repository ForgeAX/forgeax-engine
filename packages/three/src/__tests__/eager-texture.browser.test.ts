import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyEagerTexture } from './eager-texture.fixture';
import { browserRendererFixture } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
it('eagerly uploads textures without drawing, reuses versions, updates and replays actual bytes', {
  timeout: 120000,
}, async () => {
  await verifyEagerTexture(rendererFor(), renderReference, saveBrowserEvidence);
});
