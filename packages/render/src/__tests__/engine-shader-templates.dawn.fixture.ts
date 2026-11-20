import { ShaderRegistry, type ShaderTemplateManifest } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';

/** Read the same template publication through the registry used by a renderer. */
export async function readEngineTemplates(wire?: ShaderTemplateManifest) {
  const manifest = wire ?? (await buildEngineShaderTemplateManifest());
  const registry = new ShaderRegistry({
    manifestUrl: 'memory://dawn/engine-shaders.json',
    readText: async () => JSON.stringify(manifest),
    prepareProgramCompiler: prepareShaderProgramCompiler,
  });
  (await registry.loadManifest()).unwrap();
  return registry;
}
