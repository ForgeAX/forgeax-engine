import type { ShaderTemplateManifest } from '@forgeax/engine-shader';
import { sha256 } from '@forgeax/engine-types';
import {
  type buildEngineShaderManifest,
  type buildProjectShaderTemplateManifest,
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
  manifest: Awaited<
    ReturnType<typeof buildEngineShaderManifest | typeof buildProjectShaderTemplateManifest>
  >,
): string {
  return shaderPublicationUrl(
    'toJSON' in manifest || 'library' in manifest || 'templates' in manifest
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

/** Replace published source digests while keeping every original template recipe. */
export function rewriteShaderTemplateSources(
  manifest: ShaderTemplateManifest,
  rewrite: (source: string) => string,
) {
  const { library } = manifest;
  const replacements = new Map<string, string>();
  const sources = Object.fromEntries(
    Object.entries(library.sources).map(([digest, source]) => {
      const replacement = rewrite(source);
      if (replacement === source) return [digest, source];
      const next = sha256(replacement);
      replacements.set(digest, next);
      return [next, replacement];
    }),
  );
  if (replacements.size === 0) return { manifest, patched: 0 };

  const currentDigest = (digest: string) => replacements.get(digest) ?? digest;
  const programs = Object.fromEntries(
    Object.entries(library.programs).map(([identifier, template]) => [
      identifier,
      {
        ...template,
        source: currentDigest(template.source),
        imports: Object.fromEntries(
          Object.entries(template.imports).map(([name, digest]) => [name, currentDigest(digest)]),
        ),
      },
    ]),
  );
  return {
    manifest: { ...manifest, library: { ...library, sources, programs } },
    patched: replacements.size,
  };
}
