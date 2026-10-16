// @forgeax/engine-geometry - single-import barrel.
//
// AI users get the procedural geometry factories under one namespace import,
// each returning `Result<MeshAsset, AssetError>` (charter F1 single-entry
// indexability; P3 explicit failure). Alongside them: the vertex attribute
// layout SSOT (deriveVertexBufferLayout / buildMeshAttributeMapForUvSets /
// GpuVertexBufferLayoutEntry) and the tangent helper (computeTangentVec4)
// consumed by the runtime pipeline + material layers.
//
// Attribute layout (all factories): position (3 floats) + normal (3 floats) +
// uv (2 floats), expanded to the 12-float runtime layout (adds tangent vec4)
// by meshFromInterleaved / PROCEDURAL_FLOATS_PER_VERTEX.

export type { VertexAttributePackDetail } from '@forgeax/engine-types';
export { decodeMeshBinary, normalizeMeshPayload } from './assets/mesh-binary';
export { meshAssetContribution, meshAssetDecoder, meshAssetKind } from './assets/mesh-decoder';
export {
  createPrimitiveMesh,
  createProceduralMesh,
  type PrimitiveMeshKind,
} from './assets/primitive-mesh';
export {
  createBoxGeometry,
  meshFromInterleaved,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from './box';
export { createCapsuleGeometry } from './capsule';
export { createConeGeometry } from './cone';
export type { PolygonShape } from './contour';
export { createCylinderGeometry } from './cylinder';
export { createDecalGeometry, type DecalGeometryOptions } from './decal';
export {
  compute2dBounds,
  create2dGeometry,
  create2dRingGeometry,
  type Shape2d,
  type Shape2dBounds,
  type Shape2dMeshOptions,
  type Shape2dPose,
  type Vec2,
} from './dim2';
export type {
  DistanceFieldError,
  DistanceFieldPolicy,
  FieldBounds,
  FieldVec3,
  GeometricDistanceField,
  MeshDistanceField,
} from './distance-field';
export {
  buildMeshDistanceField,
  distanceFieldMeshDigest,
  MESH_DISTANCE_FIELD_GENERATION_VERSION,
  sampleMeshDistanceField,
} from './distance-field';
export {
  decodeMeshDistanceField,
  encodeMeshDistanceField,
  validateMeshDistanceField,
} from './distance-field-artifact';
export { distanceFieldTexel } from './distance-field-bricks';
// Edge factories return Result<MeshAsset, AssetError>; threshold units are degrees.
export { createEdgesGeometry, createWireframeGeometry } from './edges';
export { createExtrusionGeometry, type ExtrusionOptions } from './extrusion';
export { withMeshAabb } from './mesh-aabb.js';
export {
  createMeshBuilder,
  type MeshBuilder,
  type MeshBuilderOptions,
  type MeshBuilderSubmesh,
} from './mesh-builder';
export {
  admitsMeshCardLayout,
  decodeMeshCardLayout,
  encodeMeshCardLayout,
  validateMeshCardLayout,
} from './mesh-card-artifact';
export {
  buildMeshCardLayout,
  type MeshCardLayout,
  type MeshCardProjection,
  meshCardSidednessDigest,
} from './mesh-card-layout';
export { buildMeshCollision, validateMeshCollisionAttachment } from './mesh-collision';
export {
  type MeshBinEncodeError,
  packMeshBin,
  prepareMeshData,
} from './mesh-data.js';
export * from './mesh-distance-field-product';
export { createPlaneGeometry } from './plane';
export {
  createRevolutionGeometry,
  createSweepGeometry,
  type Vec2Point,
  type Vec3Point,
} from './procedural';
export { createProfileSweepGeometry, type ProfileSweepOptions } from './profile-sweep';
export { createSphereGeometry } from './sphere';
export { computeTangentVec4, writeNormalPlaneTangent } from './tangent';
export {
  createTeapotGeometry,
  type TeapotMeshAsset,
  type TeapotProvenance,
} from './teapot';
export { createTerrainGrids } from './terrain-grid.js';
export { createTorusGeometry } from './torus';
export {
  buildMeshAttributeMapForUvSets,
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexBufferLayout,
  deriveVertexBufferLayoutFromProjection,
  deriveVertexCount,
  deriveVertexLayoutProjection,
  deriveVertexLayoutProjectionFromMask,
  type GpuVertexBufferLayoutEntry,
  type PackedVertexAttributes,
  packInterleavedVertexAttributes,
  SKIN_VERTEX_ATTRIBUTE_MAP,
  unpackInterleavedVertexAttributes,
  VertexAttributePackError,
  type VertexLayoutProjection,
  type VertexLayoutProjectionAttribute,
  type VertexLayoutProjectionMaskError,
} from './vertex-attribute-layout';
export {
  buildVisibilityDistanceField,
  visibilityDistanceFieldSourceDigest,
} from './visibility-distance-field';
