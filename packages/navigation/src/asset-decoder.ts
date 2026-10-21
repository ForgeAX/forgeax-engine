import {
  type AssetDecoderContribution,
  AssetError,
  type AssetKind,
  err,
  type NavigationMeshAsset,
  ok,
} from '@forgeax/engine-types';
import { validateNavigationMesh } from './validate-navmesh';

export const navigationMeshContribution: AssetDecoderContribution<
  NavigationMeshAsset,
  'navigation-mesh'
> = {
  kind: { kind: 'navigation-mesh' } as AssetKind<NavigationMeshAsset, 'navigation-mesh'>,
  consumer: 'Navigation',
  decoder: {
    prepare(input) {
      const valid = validateNavigationMesh(input);
      return valid.ok
        ? ok(valid.value)
        : err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: valid.error.expected,
              hint: valid.error.hint,
            }),
          );
    },
    async decode({ envelope }) {
      const valid = validateNavigationMesh(envelope.payload);
      return valid.ok
        ? ok(valid.value)
        : err({
            code: 'asset-package-invalid',
            expected: valid.error.expected,
            hint: valid.error.hint,
            detail: { guid: envelope.guid, reason: 'invalid navigation mesh topology' },
          });
    },
  },
};
