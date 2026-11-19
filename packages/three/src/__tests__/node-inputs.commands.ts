import { cookPhysicalMaterials } from '@forgeax/engine/three/build';
import type {} from 'vitest/browser';
import { cookSurfaceExpression } from './surface-expression-cook.fixture';
import { cookTargetSurface } from './target-surface-cook.fixture';

let publication: Promise<string> | undefined;
export function prepareThreeNodeInputMaterials(): Promise<string> {
  publication ??= cookPhysicalMaterials([['map', 'alphaMap']]);
  return publication;
}
export const threeNodeInputCommands = {
  prepareThreeNodeInputMaterials,
  prepareThreeTargetSurface() {
    return cookTargetSurface();
  },
  prepareThreeSurfaceExpression(_context: unknown, kind: 'standard' | 'unlit' | 'roughness') {
    return prepareThreeSurfaceExpression(kind);
  },
};
const surfacePublications = new Map<string, ReturnType<typeof cookSurfaceExpression>>();
export function prepareThreeSurfaceExpression(kind: 'standard' | 'unlit' | 'roughness') {
  let publication = surfacePublications.get(kind);
  if (publication === undefined) {
    publication = cookSurfaceExpression(kind);
    surfacePublications.set(kind, publication);
  }
  return publication;
}
declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareThreeTargetSurface(): ReturnType<typeof cookTargetSurface>;
    prepareThreeNodeInputMaterials(): Promise<string>;
    prepareThreeSurfaceExpression(
      kind: 'standard' | 'unlit' | 'roughness',
    ): ReturnType<typeof cookSurfaceExpression>;
  }
}
