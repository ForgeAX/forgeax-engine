import {
  definePack,
  definePackageId,
  type PackageId,
  type PackBuildContextWithoutParameters,
  type PackBuildResult,
} from '@forgeax/engine-pack/source';

/** Ordinary Pack declaration used by producer tests that do not define parameters. */
export function packDefinition(
  packageId: string | PackageId,
  build: (context: PackBuildContextWithoutParameters) => PackBuildResult,
) {
  return definePack({ schemaVersion: '2.0.0', packageId: definePackageId(packageId), build });
}
