import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { UNLIT_AO_SIZE, verifyUnlitAo } from './helpers/unlit-ao';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('renders Unlit and PBR-Skin AO with exact rigid, masked and posed surface normals', {
  timeout: 180_000,
}, async () => {
  const target = offscreenCanvas(UNLIT_AO_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const created = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi },
    {
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()),
    },
  );
  if (!created.ok) throw created.error;
  const host = created.value;
  try {
    await verifyUnlitAo(host, recorder, async (lane, tape) => {
      mkdirSync('artifacts/ao-validation', { recursive: true });
      writeFileSync(`artifacts/ao-validation/dawn-skin-${lane}.rhitape`, tape.bytes);
    });
  } finally {
    const disposed = await host.renderer.dispose();
    expect(disposed.ok).toBe(true);
    target.destroy();
  }
});
