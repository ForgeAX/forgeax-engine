import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Renderer } from '@forgeax/engine-render';
import type { RendererHostAssembly } from '@forgeax/engine-render/internal/construct-renderer';

import type { createNativeSponzaRendererHost } from '../native-sponza-renderer.mjs';
import { inspectNativeSponzaGi } from '../native-sponza-renderer.mjs';

export function nativeGiInspectionUsesPublicUnion(
  inspection: ReturnType<Renderer['inspect']>['diffuseGi'],
): 'ray-query' | 'global-sdf' | undefined {
  return inspectNativeSponzaGi(inspection).traversal;
}

export function runtimeAssemblyOwnsSponzaAssets(host: RendererHostAssembly): AssetRegistry {
  return host.assets;
}

export function nativeSponzaHostUsesItsAssemblyAssets(
  host: Awaited<ReturnType<typeof createNativeSponzaRendererHost>>,
): AssetRegistry {
  return host.assets;
}

export function rendererDoesNotOwnTheSponzaRegistry(renderer: Renderer): void {
  // @ts-expect-error Runtime returns a Renderer; its host asset registry stays in the assembly.
  void renderer.assets;
}
