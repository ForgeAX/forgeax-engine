import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';

export { declaredMaterialVertexInputs as declaredVertexInputs } from '@forgeax/engine-shader';

import { declaredMaterialVertexInputs, type MaterialShaderProgram } from '@forgeax/engine-shader';

/**
 * WebGPU rejects a render pipeline whose vertex entry reads a location that no
 * vertex buffer supplies, and an invalid pipeline invalidates the whole frame
 * command buffer. Check that rule before the pipeline exists so only the draw
 * that pairs this material with this mesh layout is skipped.
 */
export function validateVertexInputLayout(
  materialShaderId: string,
  source: string | MaterialShaderProgram,
  entry: string,
  vertexBuffers: readonly GPUVertexBufferLayout[],
): Result<void, RhiError> {
  const provided = new Set<number>();
  for (const buffer of vertexBuffers)
    for (const attribute of buffer.attributes) provided.add(attribute.shaderLocation);
  const missing = (
    typeof source === 'string'
      ? declaredMaterialVertexInputs(source, entry)
      : (source.vertexInputs[entry] ?? [])
  ).filter((input) => !provided.has(input.location));
  if (missing.length === 0) return ok(undefined);
  const names = missing.map((input) => `@location(${input.location}) ${input.name}`).join(', ');
  return err(
    new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: `mesh vertex layout supplies every input of material shader '${materialShaderId}' entry '${entry}'; missing ${names}; mesh provides locations [${[...provided].sort((a, b) => a - b).join(', ')}]`,
      hint: 'the draw pairing this mesh with this material is skipped; author the missing mesh attribute (createMeshBuilder completes normal/uv/tangent for triangle-list meshes) or pick a material whose vertex stage does not read it',
    }),
  );
}
