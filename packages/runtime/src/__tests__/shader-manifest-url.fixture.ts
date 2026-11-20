import {
  publishShaderProgramTemplates,
  readShaderProgramTemplates,
  type ShaderProgramTemplate,
  type ShaderTemplateManifest,
} from '@forgeax/engine-shader';
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

/** Change each distinct source once and republish every original template recipe. */
export function rewriteShaderTemplateSources(
  manifest: ShaderTemplateManifest,
  rewrite: (source: string) => string,
) {
  const programs = readShaderProgramTemplates(manifest.library).unwrap();
  const changedSources = new Map<string, string>();
  let patched = 0;
  const replace = (source: string): string => {
    const found = changedSources.get(source);
    if (found !== undefined) return found;
    const replacement = rewrite(source);
    if (replacement !== source) patched++;
    changedSources.set(source, replacement);
    return replacement;
  };
  const templates = new Map<string, ShaderProgramTemplate>();
  for (const [identifier, { template }] of programs) {
    templates.set(identifier, {
      ...template,
      source: replace(template.source),
      imports: Object.fromEntries(
        Object.entries(template.imports).map(([name, source]) => [name, replace(source)]),
      ),
    });
  }
  return {
    manifest: { ...manifest, library: publishShaderProgramTemplates(templates).unwrap() },
    patched,
  };
}
