export { type WaterDependencyMeshView, waterDependencyMeshView } from './dependency-mesh.js';
export { requireWaterValue } from './required-value.js';
export {
  acceptWaterMeshViewForRenderer,
  buildWaterZoneMeshViewForRenderer,
  waterMeshCandidateViewsForRenderer,
  waterZoneMeshViewForRenderer,
} from './system-internal.js';
export { waterMeshFlatFarBoundaryMask } from './water-mesh.js';
export type { WaterMeshLayoutReceipt } from './water-mesh-abi.js';
export {
  createWaterMeshLayoutReceipt,
  isWaterMeshContinuityPayloadValid,
  isWaterMeshLayoutReceiptValid,
  WATER_MESH_INSTANCE_LAYOUT,
  WATER_MESH_INSTANCE_LAYOUT_HASH,
  WATER_MESH_INSTANCE_SCHEMA_VERSION,
  WATER_MESH_INSTANCE_STRIDE_BYTES,
} from './water-mesh-abi.js';
export { isWaterBakedSourceAvailable } from './waves.js';
