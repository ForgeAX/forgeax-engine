import { MeshStandardNodeMaterial } from '@forgeax/engine/three';
import { cookThreeSurface } from '@forgeax/engine/three/build';
import { float } from '@forgeax/engine/three/tsl';
import { surfaceExpressionExample } from './surface-expression.recipe.fixture';

/** Producer-only fixture: both structural revisions are installed before player startup. */
export async function cookSurfaceExpression(kind: 'standard' | 'unlit' | 'roughness') {
  const initial = surfaceExpressionExample(kind);
  const rebound = surfaceExpressionExample(kind, undefined, undefined, true);
  const ground = new MeshStandardNodeMaterial({ color: 0x777777 });
  ground.roughnessNode = float(1);
  // The material cooker shares one bounded pool for these independent graphs.
  const cooks = [
    cookThreeSurface(initial.material),
    cookThreeSurface(rebound.material),
    kind === 'standard' ? cookThreeSurface(ground) : undefined,
  ] as const;
  try {
    const [first, second, receiver] = await Promise.all(cooks);
    return {
      ...first,
      reboundRecipe: second.recipe,
      groundRecipe: receiver?.recipe,
      publications: [
        first.publication,
        second.publication,
        ...(receiver ? [receiver.publication] : []),
      ],
    };
  } finally {
    await Promise.allSettled(cooks);
    initial.material.dispose();
    initial.image.dispose();
    rebound.material.dispose();
    rebound.image.dispose();
    ground.dispose();
  }
}
