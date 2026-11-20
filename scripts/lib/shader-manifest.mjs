import { readFileSync } from 'node:fs';

export {
  decodeArtifactJsonText as decodeShaderManifestText,
  readArtifactJsonText as readShaderManifestText,
} from './artifact-json.mjs';

/** One owned URL transports the original plain/zstd bytes without expanding a data URL. */
export function openShaderManifestPublication(path) {
  const url = URL.createObjectURL(
    new Blob([readFileSync(path)], { type: 'application/octet-stream' }),
  );
  return { url, dispose: () => URL.revokeObjectURL(url) };
}

/** Short-lived native smoke processes own this publication until their bounded exit. */
export function processShaderManifestUrl(path) {
  const publication = openShaderManifestPublication(path);
  process.once('exit', publication.dispose);
  return publication.url;
}

/** Inspect cooked rows while retaining support for compiled-only publications. */
export async function readCookedShaderManifestPublication(publication) {
  const { readShaderManifestPublication, SHADER_PROJECT_MANIFEST_VERSION } = await import(
    '@forgeax/engine-shader'
  );
  return readShaderManifestPublication(
    publication?.schemaVersion === SHADER_PROJECT_MANIFEST_VERSION
      ? publication.cooked
      : publication,
  );
}

/** Admit the same publication bytes and compiler as the runtime smoke. */
export async function readShaderManifestRegistry(text) {
  const { ShaderRegistry } = await import('@forgeax/engine-shader');
  // Resolve the owning package's ESM entry even in an app-only install.
  const compilerPackage = new URL('../../packages/shader-compiler/package.json', import.meta.url);
  const programExport = JSON.parse(readFileSync(compilerPackage, 'utf8')).exports['./program']
    .import;
  const { prepareShaderProgramCompiler } = await import(
    new URL(programExport, compilerPackage).href
  );
  const registry = new ShaderRegistry({
    manifestUrl: '/shaders/manifest.json',
    readText: async () => text,
    prepareProgramCompiler: prepareShaderProgramCompiler,
  });
  (await registry.loadManifest()).unwrap();
  return registry;
}

/** Read only the named built-ins in a diagnostic or GPU fixture. */
export async function readBuiltinShaderEntries(text, roles) {
  const registry = await readShaderManifestRegistry(text);
  const entries = [...registry.entries()];
  return roles.map((role) => entries.find((entry) => entry.role === role));
}
