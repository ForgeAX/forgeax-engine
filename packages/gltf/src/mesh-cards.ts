import { buildMeshCardLayout } from '@forgeax/engine-geometry';
import { AssetError, err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import type { GltfMaterialIr, GltfMeshIr } from './parse-gltf';

/** Opt-in derived geometry follows the ordinary mesh product, never the frame loop. */
export async function cookGltfMeshCards(
  mesh: MeshAsset,
  primitives: readonly GltfMeshIr[],
  materials: readonly GltfMaterialIr[],
  settings: unknown,
): Promise<Result<MeshAsset, AssetError>> {
  if (settings === undefined || settings === false) return ok(mesh);
  const fail = (reason: string) =>
    err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'meshCards settings and static triangle-list mesh geometry',
        hint: 'Repair meshCards in the source Meta and reimport the same mesh GUID.',
        detail: { field: 'meshCards', value: settings, reason },
      }),
    );
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings))
    return fail('use false or an object containing resolution and maxCards');
  const input = settings as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'resolution' && key !== 'maxCards'))
    return fail('unknown meshCards setting');
  const resolution = input.resolution === undefined ? 16 : input.resolution,
    maxCards = input.maxCards === undefined ? 24 : input.maxCards;
  if (typeof resolution !== 'number' || typeof maxCards !== 'number')
    return fail('resolution and maxCards must be numbers');
  const positions = mesh.attributes.position;
  if (
    !(positions instanceof Float32Array) ||
    mesh.morphTargets ||
    mesh.attributes.skinIndex ||
    primitives.length !== mesh.submeshes.length
  )
    return fail('cards require undeformed float32 positions and one primitive per submesh');
  const indices = mesh.indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  if (indices.length % 3 !== 0) return fail('cards require indexed triangles');
  const triangleSidedness = new Uint8Array(indices.length / 3);
  let indexEnd = 0;
  for (const [index, submesh] of mesh.submeshes.entries()) {
    if (submesh.topology !== 'triangle-list') return fail('cards require triangle-list topology');
    const primitive = primitives[index];
    if (!primitive) return fail('missing source primitive');
    // The merged glTF mesh producer owns one contiguous index range per section.
    const count = mesh.indices ? submesh.indexCount : submesh.vertexCount;
    const offset = mesh.indices ? submesh.indexOffset : indexEnd;
    if (offset !== indexEnd || count < 3 || count % 3 !== 0 || offset + count > indices.length)
      return fail('mesh sections must partition the triangle index buffer');
    if (primitive.materialIndex !== null && materials[primitive.materialIndex] === undefined)
      return fail('missing source material');
    if (
      primitive.materialIndex !== null &&
      materials[primitive.materialIndex]?.alphaMode === 'BLEND'
    )
      return fail('translucent sections are not admitted by the static card producer');
    triangleSidedness.fill(
      primitive.materialIndex !== null && materials[primitive.materialIndex]?.doubleSided ? 1 : 0,
      offset / 3,
      (offset + count) / 3,
    );
    indexEnd += count;
  }
  if (indexEnd !== indices.length) return fail('mesh sections do not cover the entire geometry');
  const built = await buildMeshCardLayout(positions, indices, {
    resolution,
    maxCards,
    triangleSidedness,
  });
  return built.ok ? ok({ ...mesh, cardLayout: built.value }) : built;
}
