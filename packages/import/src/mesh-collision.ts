import { buildMeshCollision } from '@forgeax/engine-geometry';
import { AssetError, err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';

/** Source Meta opts in; an ordinary mesh publication retains its GUID and reference closure. */
export function cookMeshCollision(
  mesh: MeshAsset,
  setting: unknown,
): Result<MeshAsset, AssetError> {
  if (setting === undefined || setting === false) return ok(mesh);
  if (setting !== true)
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'meshCollision is a boolean source import setting',
        hint: 'Set meshCollision to true or false in Meta and reimport the same GUID.',
        detail: {
          field: 'meshCollision',
          value: setting,
          reason: 'invalid collision cook setting',
        },
      }),
    );
  const collision = buildMeshCollision(mesh);
  return collision.ok ? ok({ ...mesh, collision: collision.value }) : collision;
}
