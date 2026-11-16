export const MAX_WATER_MESH_TREE_NODES = 131_071;
export const MAX_WATER_MESH_TEMPLATE_VERTICES = 66_049;
export const MAX_WATER_MESH_TEMPLATE_INDICES = 393_216;
export const MAX_WATER_MESH_TEMPLATE_SET_VERTICES = 88_416;
export const MAX_WATER_MESH_TEMPLATE_SET_INDICES = 524_292;

// Derive the accepted factor from the full-resolution template's configured allocation limits.
export const MAX_WATER_MESH_TESSELLATION_FACTOR = (() => {
  for (let factor = 0; ; factor++) {
    const quadsPerEdge = 2 ** factor;
    const vertexCount = (quadsPerEdge + 1) ** 2;
    const indexCount = quadsPerEdge * quadsPerEdge * 6;
    if (
      vertexCount > MAX_WATER_MESH_TEMPLATE_VERTICES ||
      indexCount > MAX_WATER_MESH_TEMPLATE_INDICES
    )
      return factor - 1;
  }
})();
