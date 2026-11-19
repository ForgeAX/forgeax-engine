import {
  type buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { afterAll } from 'vitest';

const urls: string[] = [];
afterAll(() => {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.length = 0;
});

/** Use the real publication format: every program survives, repeated source bytes are shared. */
export function shaderManifestUrl(
  manifest: Awaited<ReturnType<typeof buildEngineShaderManifest>>,
): string {
  return shaderPublicationUrl(
    'toJSON' in manifest
      ? manifest
      : publishShaderManifest(manifest.entries, manifest.materialShaders),
  );
}

export function shaderPublicationUrl(publication: object): string {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(publication)], { type: 'application/json' }),
  );
  urls.push(url);
  return url;
}
