import type { BundlerOptions } from '@forgeax/engine-render/internal/construct-renderer';
import { ShaderRegistry, type ShaderRegistryOptions } from '@forgeax/engine-shader';

export const prepareProgramCompiler: NonNullable<
  ShaderRegistryOptions['prepareProgramCompiler']
> = async () =>
  (await import('@forgeax/engine-shader-compiler/program')).prepareShaderProgramCompiler();

/** Begin CPU admission independently of a device or World. */
export function stagePublicationShaders(bundler?: BundlerOptions) {
  const catalog = new ShaderRegistry({
    prepareProgramCompiler: bundler?.prepareShaderProgramCompiler ?? prepareProgramCompiler,
    ...(bundler?.readShaderManifest === undefined ? {} : { readText: bundler.readShaderManifest }),
    manifestUrl:
      bundler !== undefined && 'shaderManifestUrl' in bundler
        ? bundler.shaderManifestUrl
        : '/shaders/manifest.json',
  });
  const ready = catalog.loadManifest().then((result) => {
    if (!result.ok) throw result.error;
    return catalog;
  });
  // A staged caller joins at its original startup boundary.
  void ready.catch(() => {});
  return { catalog, ready };
}
