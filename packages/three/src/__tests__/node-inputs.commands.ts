import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { cookPhysicalMaterials } from '@forgeax/engine/three/build';
import type {} from 'vitest/browser';
import { physicalSlotsForFeature } from './features.fixture';
import { cookSurfaceExpression } from './surface-expression-cook.fixture';
import { cookTargetSurface } from './target-surface-cook.fixture';

const nodeInputTextureSets = [['map', 'alphaMap']] as const;
let publication: Promise<string> | undefined;
export function prepareThreeNodeInputMaterials(): Promise<string> {
  publication ??= cookPhysicalMaterials(nodeInputTextureSets);
  return publication;
}

async function cookBrowserNodeInputMaterials(): Promise<string> {
  // This Browser child cooks one material. Own its cook in one Worker so the
  // existing compiler budget goes to program variants instead of idle material lanes.
  const build = import.meta.resolve('@forgeax/engine/three/build');
  const source = `
    import { parentPort } from 'node:worker_threads';
    import { cookPhysicalMaterials } from ${JSON.stringify(build)};
    parentPort.postMessage(await cookPhysicalMaterials(${JSON.stringify(nodeInputTextureSets)}));
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
  try {
    const [encoded] = await once(worker, 'message', { signal: AbortSignal.timeout(30_000) });
    if (typeof encoded !== 'string') throw new Error('Invalid Three Node input publication');
    return encoded;
  } finally {
    await worker.terminate();
  }
}

export async function cookPhysicalFeature(name: string): Promise<readonly string[]> {
  const slots = physicalSlotsForFeature(name);
  return slots === undefined ? [] : [await cookPhysicalMaterials([slots])];
}

let browserPublication: Promise<string> | undefined;
export const threeNodeInputCommands = {
  prepareThreePhysicalFeature(_context: unknown, name: string) {
    return cookPhysicalFeature(name);
  },
  prepareThreeNodeInputMaterials(): Promise<string> {
    browserPublication ??= cookBrowserNodeInputMaterials();
    return browserPublication;
  },
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
    prepareThreePhysicalFeature(name: string): Promise<readonly string[]>;
    prepareThreeTargetSurface(): ReturnType<typeof cookTargetSurface>;
    prepareThreeNodeInputMaterials(): Promise<string>;
    prepareThreeSurfaceExpression(
      kind: 'standard' | 'unlit' | 'roughness',
    ): ReturnType<typeof cookSurfaceExpression>;
  }
}
