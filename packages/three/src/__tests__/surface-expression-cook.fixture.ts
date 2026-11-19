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
  try {
    const first = await cookThreeSurface(initial.material);
    const second = await cookThreeSurface(rebound.material);
    const receiver = kind === 'standard' ? await cookThreeSurface(ground) : undefined;
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
    initial.material.dispose();
    initial.image.dispose();
    rebound.material.dispose();
    rebound.image.dispose();
    ground.dispose();
  }
}
