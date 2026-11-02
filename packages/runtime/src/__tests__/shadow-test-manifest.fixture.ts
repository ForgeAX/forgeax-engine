import { readFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll } from 'vitest';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

/** Local causal controls admit a real producer publication through the normal registry. */
export async function shadowTestManifestUrl(): Promise<string> {
  const control = process.env.SHADOW_BIAS_TEST_MANIFEST;
  if (control === undefined) return shaderManifestUrl(await buildEngineShaderManifest());
  const url = URL.createObjectURL(new Blob([readFileSync(control)], { type: 'application/json' }));
  afterAll(() => URL.revokeObjectURL(url));
  return url;
}
