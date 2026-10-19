import type { ShaderRegistry } from './index.js';
import { DEFAULT_SPRITE_PARAM_SCHEMA } from './material-schemas.js';

/**
 * Register the engine-shipped `forgeax::sprite-lit` material after loading its
 * composed source. Device capabilities are resolved by the pipeline builder.
 * Duplicate identifiers fail through ShaderRegistry.installMaterialArtifact.
 */
export function registerDefaultSpriteLit(registry: ShaderRegistry, composedWgsl: string): void {
  registry.installMaterialArtifact('forgeax::sprite-lit', {
    source: composedWgsl,
    paramSchema: DEFAULT_SPRITE_PARAM_SCHEMA,
  });
}
