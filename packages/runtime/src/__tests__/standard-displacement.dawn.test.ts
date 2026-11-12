import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { verifyStandardDisplacement } from './standard-displacement.fixture';
import {
  PARALLAX_SIZE,
  verifyParallaxTiledPits,
  verifyStandardParallax,
} from './standard-parallax.fixture';

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

it('validates parallax displacement off/on, zero identity and the analytic edge shift in Dawn', {
  timeout: 240_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const fixture = await createBarrelRendererFixture({
    width: PARALLAX_SIZE,
    height: PARALLAX_SIZE,
    rhi: recorder.backend.rhi,
  });
  try {
    mkdirSync('artifacts/standard-parallax/dawn', { recursive: true });
    await verifyStandardParallax(
      fixture.renderer,
      (name, bytes) => {
        writeFileSync(`artifacts/standard-parallax/dawn/${name}`, bytes);
      },
      { recorder },
    );
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
    (await recorder.dispose()).unwrap();
  }
});

it('hides tiled pit floors below the critical angle like the C-401 perforated panel in Dawn', {
  timeout: 240_000,
}, async () => {
  const fixture = await createBarrelRendererFixture({
    width: PARALLAX_SIZE,
    height: PARALLAX_SIZE,
  });
  try {
    mkdirSync('artifacts/standard-parallax/dawn', { recursive: true });
    await verifyParallaxTiledPits(fixture.renderer, (name, bytes) => {
      writeFileSync(`artifacts/standard-parallax/dawn/${name}`, bytes);
    });
  } finally {
    await fixture.renderer.dispose();
    fixture.renderTarget.destroy();
  }
});
