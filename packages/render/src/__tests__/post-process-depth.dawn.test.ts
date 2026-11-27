import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { verifyPostProcessDepth } from './post-process-depth.gpu-fixture';

it.each([
  'forward',
  'deferred',
] as const)('projects displaced %s output-domain coverage on both geometry lanes', async (renderPath) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderTemplateManifest())]),
  );
  const recorder = attachRecorder(webgpu).unwrap();
  try {
    expect(await verifyPostProcessDepth(url, { recorder, renderPath })).toHaveLength(2);
  } finally {
    URL.revokeObjectURL(url);
    (await recorder.dispose()).unwrap();
  }
}, 120_000);
