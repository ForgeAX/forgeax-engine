import type { Loader, NavigationMeshAsset } from '@forgeax/engine-types';
/** Load portable POD. Navigation validates geometric topology when constructing a query. */
export const navigationMeshLoader = {
  kind: 'navigation-mesh',
  load(payload) {
    if (
      payload.kind !== 'navigation-mesh' ||
      payload.version !== 'recast-poly/1' ||
      typeof payload.sourceDigest !== 'string' ||
      !payload.sourceDigest ||
      !Array.isArray(payload.vertices) ||
      !Array.isArray(payload.polygons) ||
      typeof payload.settings !== 'object' ||
      payload.settings === null
    )
      return undefined;
    return payload as unknown as NavigationMeshAsset;
  },
} satisfies Loader<NavigationMeshAsset>;
