import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { verifyStandardDisplacement } from './standard-displacement.fixture';

it('validates vertex displacement pixels, material bytes and fresh RHI replay in Dawn', {
  timeout: 240_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const fixture = await createBarrelRendererFixture({
    width: 64,
    height: 64,
    rhi: recorder.backend.rhi,
  });
  try {
    mkdirSync('artifacts/standard-displacement/dawn', { recursive: true });
    await verifyStandardDisplacement(fixture.renderer, recorder, (name, bytes) => {
      writeFileSync(`artifacts/standard-displacement/dawn/${name}`, bytes);
    });
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
    (await recorder.dispose()).unwrap();
  }
});
