import { definePhysicsPlugin } from '@forgeax/engine-physics';
import { createRapier2DPhysicsWorld, registerPhysicsSystems2D } from './rapier-physics-world-2d.js';
import { loadRapier2D } from './wasm-loader.js';

/** The selected module owns its backend; WASM initialization remains lazy until activation. */
export default /* @__PURE__ */ definePhysicsPlugin({
  name: 'rapier-2d',
  load: loadRapier2D,
  create: createRapier2DPhysicsWorld,
  registerSystems: registerPhysicsSystems2D,
});
