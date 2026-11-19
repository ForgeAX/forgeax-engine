import { cookThreeSurface } from '@forgeax/engine/three/build';
import { targetSurfaceExample } from './target-surface.recipe.fixture';

export async function cookTargetSurface() {
  const example = targetSurfaceExample();
  try {
    return await cookThreeSurface(example.material);
  } finally {
    example.material.dispose();
    example.map.dispose();
  }
}
