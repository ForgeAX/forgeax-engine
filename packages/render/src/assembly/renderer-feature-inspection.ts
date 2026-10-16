import type { CloudLayerInspection } from '../cloud/inspection';
import type { RenderFeatureHost } from '../features/host';
import type { RenderInspection } from '../render-contract';

/** Project feature-host lifecycle facts without exposing the live host. */
export function projectRendererFeatureInspection(
  featureHost: RenderFeatureHost | undefined,
): Pick<RenderInspection, 'features' | 'featureDiagnostics' | 'featureHost' | 'cloudLayer'> {
  const featureDiagnostics = featureHost?.diagnostics() ?? Object.freeze([]);
  const cloudLayer = featureDiagnostics.find(
    (diagnostic) => diagnostic.identity === 'forgeax.cloud-layer',
  )?.inspection as Readonly<Record<string, CloudLayerInspection>> | undefined;
  return {
    features: Object.freeze((featureHost?.features ?? []).map((feature) => feature.identity)),
    featureDiagnostics,
    ...(cloudLayer === undefined ? {} : { cloudLayer }),
    ...(featureHost?.inspection === undefined ? {} : { featureHost: featureHost.inspection() }),
  };
}
