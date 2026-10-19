import type { ShaderRegistry } from './index.js';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from './material-schemas.js';

/**
 * Register the engine-shipped `forgeax::pbr-skin` material after loading its
 * composed source. Device capabilities are resolved by the pipeline builder.
 * Duplicate identifiers fail through ShaderRegistry.installMaterialArtifact.
 */
export function registerDefaultStandardPbrSkin(
  registry: ShaderRegistry,
  composedWgsl: string,
): void {
  registry.installMaterialArtifact('forgeax::pbr-skin', {
    source: composedWgsl,
    paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
  });
}
