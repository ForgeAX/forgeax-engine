import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template.js';
import { ShaderRegistry, type ShaderTemplateManifest } from '../index.js';

export const STANDARD_PBR_IDENTIFIER = 'forgeax::default-standard-pbr';

export async function loadEngineTemplateRegistry(): Promise<{
  wire: ShaderTemplateManifest;
  registry: ShaderRegistry;
}> {
  const { buildEngineShaderTemplateManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const wire = await buildEngineShaderTemplateManifest();
  const registry = new ShaderRegistry({
    manifestUrl: 'memory://shader-tests/engine.json',
    readText: async () => JSON.stringify(wire),
    prepareProgramCompiler: prepareShaderProgramCompiler,
  });
  (await registry.loadManifest()).unwrap();
  return { wire, registry };
}
