/** WebGPU primitive topology vocabulary shared by asset and render contracts. */
export type PrimitiveTopology = GPUPrimitiveTopology;

/** True for topologies that rasterize filled triangles (shadow casting, picking, UV charts). */
export function isTriangleTopology(topology: PrimitiveTopology): boolean {
  switch (topology) {
    case 'triangle-list':
    case 'triangle-strip':
      return true;
    case 'point-list':
    case 'line-list':
    case 'line-strip':
      return false;
  }
}

/** True for strip topologies: they need an index buffer and a pipeline `stripIndexFormat`. */
export function isStripTopology(topology: PrimitiveTopology): boolean {
  switch (topology) {
    case 'line-strip':
    case 'triangle-strip':
      return true;
    case 'point-list':
    case 'line-list':
    case 'triangle-list':
      return false;
  }
}
