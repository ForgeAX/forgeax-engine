import { ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';

/** Read selected entries through the same source-template admission as a Renderer. */
export async function browserShaderEntries(identifiers: readonly string[]) {
  const registry = new ShaderRegistry({
    manifestUrl: '/shaders/manifest.json',
    prepareProgramCompiler: prepareShaderProgramCompiler,
  });
  (await registry.loadManifest()).unwrap();
  const expected = new Set(identifiers);
  return [...registry.entries()].filter(
    (entry) => entry.identifier !== undefined && expected.has(entry.identifier),
  );
}
