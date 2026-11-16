import type { CloudCompletedAdoption, CloudLayerInspection } from '../cloud/inspection';
import type { RenderFeatureHost } from '../features/host';
import type { RenderInspection } from '../render-contract';

/** Project feature-host lifecycle facts without exposing the live host. */
export function projectRendererFeatureInspection(
  featureHost: RenderFeatureHost | undefined,
  completedCloudAdoption?: (view: string) => CloudCompletedAdoption | undefined,
  fields?: readonly (keyof RenderInspection)[],
): Partial<
  Pick<RenderInspection, 'features' | 'featureDiagnostics' | 'featureHost' | 'cloudLayer'>
> {
  const featureDiagnostics =
    fields?.some((field) => field === 'featureDiagnostics' || field === 'cloudLayer') === false
      ? undefined
      : (featureHost?.diagnostics() ?? Object.freeze([]));
  const cloudLayer =
    fields?.includes('cloudLayer') === false
      ? undefined
      : (featureDiagnostics?.find((diagnostic) => diagnostic.identity === 'forgeax.cloud-layer')
          ?.inspection as Readonly<Record<string, CloudLayerInspection>> | undefined);
  let cloudLayerWithAdoption: Record<string, CloudLayerInspection> | undefined;
  if (cloudLayer !== undefined && completedCloudAdoption !== undefined) {
    for (const view of Object.keys(cloudLayer)) {
      const inspection = cloudLayer[view];
      const completedAdoption = completedCloudAdoption(view);
      if (inspection === undefined || completedAdoption === undefined) continue;
      cloudLayerWithAdoption ??= { ...cloudLayer };
      cloudLayerWithAdoption[view] = Object.freeze({ ...inspection, completedAdoption });
    }
  }
  return {
    ...(fields?.includes('features') === false
      ? {}
      : {
          features: Object.freeze((featureHost?.features ?? []).map((feature) => feature.identity)),
        }),
    ...(fields?.includes('featureDiagnostics') === false || featureDiagnostics === undefined
      ? {}
      : { featureDiagnostics }),
    ...(cloudLayer === undefined
      ? {}
      : {
          cloudLayer:
            cloudLayerWithAdoption === undefined
              ? cloudLayer
              : Object.freeze(cloudLayerWithAdoption),
        }),
    ...(fields?.includes('featureHost') === false || featureHost?.inspection === undefined
      ? {}
      : { featureHost: featureHost.inspection() }),
  };
}
