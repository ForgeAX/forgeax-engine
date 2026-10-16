// Keep literal specifiers visible to bundlers without pulling backend declarations into the physics TypeScript graph.
export function loadRapier3DBackend() {
  return import('@forgeax/engine-physics-rapier3d');
}

export function loadRapier2DBackend() {
  return import('@forgeax/engine-physics-rapier2d');
}
