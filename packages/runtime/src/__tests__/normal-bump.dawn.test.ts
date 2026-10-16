import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { verifyNormalBump } from './normal-bump.fixture';

it('validates normal/bump pixels, material bytes and fresh RHI replay in Dawn', {
  timeout: 240_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const fixture = await createBarrelRendererFixture({
    width: 64,
    height: 64,
    rhi: recorder.backend.rhi,
  });
  try {
    mkdirSync('artifacts/normal-bump/dawn', { recursive: true });
    await verifyNormalBump(fixture.renderer, recorder, (name, bytes) => {
      writeFileSync(`artifacts/normal-bump/dawn/${name}`, bytes);
    });
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
    (await recorder.dispose()).unwrap();
  }
});
