/** biome-ignore-all lint/suspicious/noConsole: Bounded case progress locates CI deadlines without changing the workload. */
import { afterAll, beforeAll, it } from 'vitest';
import {
  CUBE_CONTACT_CASES,
  CUBE_CONTACT_SIZE,
  createCubePlaneShadowContactFixture,
} from './cube-plane-shadow-contact.fixture';

const canvas = document.createElement('canvas');
canvas.width = canvas.height = CUBE_CONTACT_SIZE;
let fixture: Awaited<ReturnType<typeof createCubePlaneShadowContactFixture>>;
beforeAll(async () => {
  console.info('[cube-contact-progress]', JSON.stringify({ stage: 'fixture-start' }));
  document.body.append(canvas);
  fixture = await createCubePlaneShadowContactFixture(canvas, '/shaders/manifest.json');
  console.info('[cube-contact-progress]', JSON.stringify({ stage: 'fixture-ready' }));
}, 60000);
afterAll(async () => {
  console.info('[cube-contact-progress]', JSON.stringify({ stage: 'dispose-start' }));
  await fixture?.dispose();
  canvas.remove();
  console.info('[cube-contact-progress]', JSON.stringify({ stage: 'dispose-complete' }));
});
for (const renderPath of ['forward', 'deferred'] as const) {
  it.each(
    CUBE_CONTACT_CASES,
  )(`${renderPath} keeps $name contact dark and exposed surfaces clean`, async (scene) => {
    const startedAt = performance.now();
    console.info(
      '[cube-contact-progress]',
      JSON.stringify({ stage: 'case-start', renderPath, scene: scene.name }),
    );
    await fixture.verify(renderPath, scene);
    console.info(
      '[cube-contact-progress]',
      JSON.stringify({
        stage: 'case-complete',
        renderPath,
        scene: scene.name,
        elapsedMs: Math.round(performance.now() - startedAt),
      }),
    );
  }, 60000);
}
