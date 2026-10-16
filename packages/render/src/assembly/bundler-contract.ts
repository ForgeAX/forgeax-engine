import type { ShaderRegistryOptions } from '@forgeax/engine-shader';
import type { ImportTransport } from '@forgeax/engine-types';

/** Build-tool inputs forwarded from the host into renderer assembly. */
export interface BundlerOptions {
  readonly importTransport?: ImportTransport | undefined;
  readonly shaderManifestUrl?: string | undefined;
  readonly readShaderManifest?: ShaderRegistryOptions['readText'];
  /** Exact checkout revision emitted by the build-tool adapter. */
  readonly build?: string | undefined;
}
