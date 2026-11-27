import type { ShaderRegistry, ShaderRegistryOptions } from '@forgeax/engine-shader';
import type { ImportTransport } from '@forgeax/engine-types';

/** Host publication inputs and program services forwarded into renderer assembly. */
export interface BundlerOptions {
  readonly importTransport?: ImportTransport | undefined;
  readonly shaderManifestUrl?: string | undefined;
  readonly readShaderManifest?: ShaderRegistryOptions['readText'];
  readonly prepareShaderProgramCompiler?: ShaderRegistryOptions['prepareProgramCompiler'];
  /** Exact checkout revision emitted by the build-tool adapter. */
  readonly build?: string | undefined;
}

/** CPU publication already admitted by this exact renderer realm. */
export interface RendererHostBundlerOptions extends BundlerOptions {
  readonly admittedShaderCatalog?: ShaderRegistry;
}
