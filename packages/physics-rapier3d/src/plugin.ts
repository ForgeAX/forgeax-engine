import { definePhysicsPlugin } from '@forgeax/engine-physics';
import { registerPhysicsSystems } from './physics-sync.js';
import { createRapier3DPhysicsWorld } from './rapier-physics-world-3d.js';
import { loadRapier3D } from './wasm-loader.js';

/** The selected module owns its backend; WASM initialization remains lazy until activation. */
export default /* @__PURE__ */ definePhysicsPlugin({
  name: 'rapier-3d',
  load: loadRapier3D,
  create: createRapier3DPhysicsWorld,
  registerSystems: registerPhysicsSystems,
});
