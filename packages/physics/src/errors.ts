// @forgeax/engine-physics — PhysicsError wrapper + re-exports from engine-types.
//
// PhysicsError, PhysicsErrorCode, PhysicsErrorDetail, and PHYSICS_ERROR_HINTS
// are registered in @forgeax/engine-types (SSOT, parallel to AssetError /
// AudioError / GltfError). This module re-exports them under the physics
// package namespace so AI users import from `@forgeax/engine-physics` without
// tracing to engine-types.

export type { PhysicsErrorCode, PhysicsErrorDetail } from '@forgeax/engine-types';
export { PHYSICS_ERROR_HINTS, PhysicsError } from '@forgeax/engine-types';
