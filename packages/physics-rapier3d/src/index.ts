// @forgeax/engine-physics-rapier3d — Rapier 3D WASM backend barrel.
//
// Re-exports the RapierPhysicsWorld3D class, WASM loader, and three-phase tick
// systems.

export type { Rapier3DCollisionEvent } from './physics-entity-records.js';
export { registerPhysicsSystems } from './physics-sync.js';
export {
  createRapier3DPhysicsWorld,
  RapierPhysicsWorld3D,
} from './rapier-physics-world-3d.js';
export type { Rapier3DModule } from './wasm-loader.js';
export { loadRapier3D } from './wasm-loader.js';
